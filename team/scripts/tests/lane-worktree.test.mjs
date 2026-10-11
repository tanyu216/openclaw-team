#!/usr/bin/env node
/**
 * lane-worktree.test.mjs — 同仓并发 lane 的 worktree 隔离（T-20261010-074754-2）
 *
 * 红（反证）：`scripts/lane-worktree.mjs` 不存在 ⇒ import 失败（模块缺失即红）。
 * 绿：幂等 create/reuse、两 lane 隔离（写不污染主 checkout）、复现既有手工 worktree 形状
 *   （`<repo>-wt-<lane>` + 显式 `--branch`）、`--dry-run` 零副作用、`--remove` 仅 clean 时清理、
 *   CLI 末行 JSON 契约、**绝不使用 `--force`**（自证）。
 *
 * 隔离：全部跑在 `os.tmpdir()` 下的临时 git 仓；不起子会话/不触网/不碰真实仓。
 * 运行：node --test scripts/tests/lane-worktree.test.mjs
 */
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MOD = path.join(HERE, '..', 'lane-worktree.mjs');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-lanewt-'));
after(() => { fs.rmSync(ROOT, { recursive: true, force: true }); });

/** 建一个只含一次提交的临时仓（不自造分支，让脚本用默认分支名） */
let seq = 0;
function makeRepo(name = `repo${++seq}`) {
  const dir = path.join(ROOT, name);
  fs.mkdirSync(dir, { recursive: true });
  const g = (...a) => {
    const r = spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
    assert.equal(r.status, 0, `git ${a.join(' ')} 失败: ${r.stderr}`);
    return r.stdout;
  };
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@example.invalid');
  g('config', 'user.name', 'test');
  fs.writeFileSync(path.join(dir, 'README.md'), '# fixture\n');
  fs.writeFileSync(path.join(dir, 'shared.txt'), 'shared\n');
  g('add', '--', 'README.md', 'shared.txt');
  g('commit', '-q', '-m', 'init');
  return { dir, g };
}

/** 该仓的 worktree 登记表（路径 → {branch,head,detached}） */
function wtList(dir) {
  const out = spawnSync('git', ['-C', dir, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' }).stdout;
  const map = new Map();
  let cur = null;
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) { cur = line.slice(9).trim(); map.set(cur, { path: cur }); }
    else if (line.startsWith('branch ') && cur) map.get(cur).branch = line.slice(7).trim();
    else if (line.startsWith('HEAD ') && cur) map.get(cur).head = line.slice(5).trim();
    else if (line.trim() === 'detached' && cur) map.get(cur).detached = true;
  }
  return map;
}
const porcelain = (dir) => spawnSync('git', ['-C', dir, 'status', '--porcelain'], { encoding: 'utf8' }).stdout.trim();

// 前置：模块必须在实现后存在（红阶段此处抛错即红）
const mod = await import(MOD.url ?? MOD);
const { laneWorktree, parseArgs } = mod;

// ── 契约：字段与纯函数 ──────────────────────────────────────────────────────

test('契约. parseArgs：位置参数 repo/lane + --branch/--path/--base/--dry-run/--remove/--help', () => {
  const a = parseArgs(['/r', 'meerkat', '--branch', 'rename/meerkat-taskpanel', '--dry-run']);
  assert.equal(a.ok, true, JSON.stringify(a));
  assert.equal(a.repo, '/r');
  assert.equal(a.lane, 'meerkat');
  assert.equal(a.branch, 'rename/meerkat-taskpanel');
  assert.equal(a.dryRun, true);
  assert.equal(parseArgs(['--nope']).ok, false);
  assert.equal(parseArgs(['--help']).help, true);
});

test('GREEN-1. --dry-run：算出 path/branch，但**零副作用**（不落盘、不登记、不写仓）', () => {
  const { dir } = makeRepo();
  const before = porcelain(dir);

  const r = laneWorktree({ repo: dir, lane: 'laneA', dryRun: true });

  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.dryRun, true);
  assert.equal(r.created, true, 'dry-run 下 created=计划视图（会创建）');
  assert.equal(r.branch, 'lane/laneA', '默认分支 = lane/<lane>（命名空间化，避免误撞既有分支）');
  assert.equal(r.path, `${dir}-wt-laneA`, '默认路径 = <主仓目录>-wt-<lane>');
  assert.equal(r.action, 'would_create');
  assert.equal(fs.existsSync(r.path), false, 'dry-run 不得落盘');
  assert.equal(wtList(dir).has(r.path), false, 'dry-run 不得登记 worktree');
  assert.equal(porcelain(dir), before, 'dry-run 不得改仓');
  assert.ok(Array.isArray(r.cmd) && r.cmd.includes('worktree') && r.cmd.includes('add'));
  assert.equal(r.cmd.includes('--force'), false, '绝不使用 --force');
});

test('GREEN-2. 幂等：首次 created=true；同参重跑 created=false（reuse），登记与分支不变', () => {
  const { dir } = makeRepo();
  const base = spawnSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();

  const a = laneWorktree({ repo: dir, lane: 'laneA' });
  assert.equal(a.ok, true, JSON.stringify(a));
  assert.equal(a.created, true);
  assert.equal(a.action, 'created');
  assert.equal(fs.existsSync(a.path), true);
  assert.equal(fs.existsSync(path.join(a.path, 'README.md')), true, '工作树应检出到 base');
  assert.equal(wtList(dir).get(a.path).branch, 'refs/heads/lane/laneA');

  const b = laneWorktree({ repo: dir, lane: 'laneA' });
  assert.equal(b.ok, true, JSON.stringify(b));
  assert.equal(b.created, false, '第二次必须复用而非重建');
  assert.equal(b.action, 'reused');
  assert.equal(b.path, a.path);
  assert.equal(b.branch, a.branch);
  assert.equal(b.head, base, '复用时应报既有 HEAD');

  const l = wtList(dir);
  assert.equal(l.size, 2, `应恰为 main + 1 个 lane worktree，实际 ${[...l.keys()].join(',')}`);
});

test('GREEN-3. 两 lane 隔离：worktree 写不污染主 checkout，lane 之间互不可见', () => {
  const { dir } = makeRepo();
  const a = laneWorktree({ repo: dir, lane: 'laneA' });
  const b = laneWorktree({ repo: dir, lane: 'laneB' });
  assert.equal(a.ok && b.ok, true);
  assert.notEqual(a.path, b.path);

  // lane A 写一个跟踪文件 + 一个未跟踪文件
  fs.writeFileSync(path.join(a.path, 'shared.txt'), 'A-changed\n');
  fs.writeFileSync(path.join(a.path, 'onlyA.tmp'), 'A\n');

  // 主 checkout 与 lane B 都不受影响（这正是 061638 O2 混合树的成因）
  assert.equal(porcelain(dir), '', '主 checkout 必须干净（未被 lane 写污染）');
  assert.equal(fs.readFileSync(path.join(dir, 'shared.txt'), 'utf8'), 'shared\n');
  assert.equal(fs.readFileSync(path.join(b.path, 'shared.txt'), 'utf8'), 'shared\n');
  assert.equal(fs.existsSync(path.join(dir, 'onlyA.tmp')), false);
  assert.equal(fs.existsSync(path.join(b.path, 'onlyA.tmp')), false);

  // git worktree list 可见三个工作树
  const l = wtList(dir);
  assert.deepEqual(
    [...l.keys()].map((p) => path.basename(p)).sort(),
    [`${path.basename(dir)}`, `${path.basename(dir)}-wt-laneA`, `${path.basename(dir)}-wt-laneB`].sort()
  );
});

test('GREEN-4. 复现既有 rename 线手工形状：<repo>-wt-<lane> + 显式 --branch', () => {
  const { dir } = makeRepo('task-panel');
  const r = laneWorktree({
    repo: dir, lane: 'meerkat',
    branch: 'rename/meerkat-taskpanel',
    base: 'main',
    dryRun: true,
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.path, `${dir}-wt-meerkat`, '路径形状与 /Users/tanyu/Documents/meerkat-taskpanel-wt-meerkat 一致');
  assert.equal(r.branch, 'rename/meerkat-taskpanel', '分支形状与既有手工 worktree 一致');
});

// ── 拒绝分支（明确原因，绝不覆盖） ───────────────────────────────────────────

test('REJECT. 路径被非 worktree 目录占用 ⇒ 拒绝（不覆盖）', () => {
  const { dir } = makeRepo();
  const clash = `${dir}-wt-laneA`;
  fs.mkdirSync(clash);
  fs.writeFileSync(path.join(clash, 'keep.txt'), 'x');
  const r = laneWorktree({ repo: dir, lane: 'laneA' });
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.match(r.reason, /^path_exists_not_worktree/);
  assert.equal(fs.readFileSync(path.join(clash, 'keep.txt'), 'utf8'), 'x', '占用目录不得被动');
});

test('REJECT. lane 分支已被**另一个 worktree 检出** ⇒ 拒绝（不劫持在用的分支）', () => {
  const { dir, g } = makeRepo();
  const other = path.join(ROOT, `holder${++seq}`);
  g('worktree', 'add', '-b', 'lane/laneA', other);
  const r = laneWorktree({ repo: dir, lane: 'laneA' });
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.match(r.reason, /^branch_checked_out\(/);
  assert.equal(fs.existsSync(`${dir}-wt-laneA`), false, '拒绝时不得建树');
});

test('REJECT. 非 git 仓 / 非法 lane / 非法分支 ⇒ 拒绝', () => {
  const plain = path.join(ROOT, 'notarepo');
  fs.mkdirSync(plain, { recursive: true });
  assert.match(laneWorktree({ repo: plain, lane: 'a' }).reason, /^not_a_git_repo/);

  const { dir } = makeRepo();
  assert.equal(laneWorktree({ repo: dir, lane: '../evil' }).ok, false);
  assert.equal(laneWorktree({ repo: dir, lane: 'a/b' }).ok, false);
  assert.equal(laneWorktree({ repo: dir, lane: 'laneA', branch: 'has space' }).ok, false);
  assert.equal(laneWorktree({ repo: dir, lane: 'laneA', branch: '-lead' }).ok, false);
  assert.equal(laneWorktree({ repo: dir, lane: 'laneA', branch: 'a..b' }).ok, false);
});

test('GREEN-5. 幂等可重入：--remove（保留分支）后可再 create，附着既有 lane 分支', () => {
  const { dir } = makeRepo();
  const a = laneWorktree({ repo: dir, lane: 'laneA' });
  assert.equal(a.ok, true);
  const rm = laneWorktree({ repo: dir, lane: 'laneA', remove: true });
  assert.equal(rm.ok, true, JSON.stringify(rm));
  assert.equal(fs.existsSync(a.path), false);

  const again = laneWorktree({ repo: dir, lane: 'laneA' });
  assert.equal(again.ok, true, JSON.stringify(again));
  assert.equal(again.action, 'created');
  assert.equal(again.created, true);
  assert.equal(again.branchReused, true, '分支仍在 ⇒ 附着复用（不重建、不重置）');
  assert.equal(fs.existsSync(again.path), true);
  assert.equal(wtList(dir).get(again.path).branch, 'refs/heads/lane/laneA');
});

// ── 清理纪律 ────────────────────────────────────────────────────────────────

test('REMOVE. 脏工作树（未提交）⇒ 拒绝清理；clean ⇒ 清理 worktree 但**保留分支**', () => {
  const { dir } = makeRepo();
  const a = laneWorktree({ repo: dir, lane: 'laneA' });
  assert.equal(a.ok, true);

  // 脏：有未提交改动 ⇒ 拒绝（不 --force）
  fs.writeFileSync(path.join(a.path, 'shared.txt'), 'dirty\n');
  const dirty = laneWorktree({ repo: dir, lane: 'laneA', remove: true });
  assert.equal(dirty.ok, false, JSON.stringify(dirty));
  assert.match(dirty.reason, /^worktree_dirty/);
  assert.equal(fs.existsSync(a.path), true, '拒绝时不得删除');

  // 清掉未提交改动（前向编辑，非破坏性 git）后 ⇒ 可清理
  fs.writeFileSync(path.join(a.path, 'shared.txt'), 'shared\n');
  const dry = laneWorktree({ repo: dir, lane: 'laneA', remove: true, dryRun: true });
  assert.equal(dry.ok, true, JSON.stringify(dry));
  assert.equal(dry.action, 'would_remove');
  assert.equal(fs.existsSync(a.path), true, 'remove --dry-run 不得删除');

  const gone = laneWorktree({ repo: dir, lane: 'laneA', remove: true });
  assert.equal(gone.ok, true, JSON.stringify(gone));
  assert.equal(gone.action, 'removed');
  assert.equal(fs.existsSync(gone.path), false, 'clean 后应移除工作树');
  assert.equal(wtList(dir).has(gone.path), false, '登记应移除');
  // 分支保留（可能承载已提交产物，如既有 rename/meerkat-taskpanel @ c6ead89）
  const br = spawnSync('git', ['-C', dir, 'rev-parse', '--verify', '--quiet', 'refs/heads/lane/laneA'], { encoding: 'utf8' });
  assert.equal(br.status, 0, '清理 worktree 不得删除分支');
  assert.equal(gone.cmd.includes('--force'), false, '绝不使用 --force');
});

test('REMOVE. worktree 不存在 ⇒ 幂等成功（无需清理）', () => {
  const { dir } = makeRepo();
  const r = laneWorktree({ repo: dir, lane: 'ghost', remove: true });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.action, 'absent');
  assert.equal(r.created, false);
});

// ── CLI 末行 JSON 契约（机读，供 dispatch 消费） ─────────────────────────────

test('CLI. 末行 JSON 含 {ok,repo,lane,path,branch,created,dryRun}；退出码 0/1/2', () => {
  const { dir } = makeRepo();

  const ok = spawnSync(process.execPath, [MOD, dir, 'laneA', '--dry-run'], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  const j = JSON.parse(ok.stdout.trim().split('\n').pop());
  for (const k of ['ok', 'repo', 'lane', 'path', 'branch', 'created', 'dryRun']) {
    assert.ok(k in j, `末行 JSON 缺键 ${k}：${JSON.stringify(j)}`);
  }
  assert.equal(j.ok, true);
  assert.equal(j.lane, 'laneA');
  assert.equal(j.dryRun, true);

  const bad = spawnSync(process.execPath, [MOD], { encoding: 'utf8' });
  assert.equal(bad.status, 2, '用法错误 ⇒ 2');
  assert.equal(JSON.parse(bad.stdout.trim().split('\n').pop()).ok, false);
});
