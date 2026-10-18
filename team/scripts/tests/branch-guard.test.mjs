#!/usr/bin/env node
/**
 * branch-guard.test.mjs — 提交侧分支守卫（T-20261015-devbranch）
 *
 * 红（反证）：`scripts/branch-guard.mjs` 不存在 ⇒ import 失败（模块缺失即红）。
 * 绿：开发集成在 `dev` 上（`R-WORKTREE-1`）——lane 提交落在 `lane/*`、`dev` 上放行；
 *   **直接提交受保护分支（缺省 `main`）被拒**；detached HEAD 被拒；`--allow-protected` 放行为
 *   告警 + `overridden:true`（`dev→main` 集成步骤的显式出口）；自定义受保护集；
 *   非 git 仓被拒；CLI 末行 JSON 契约与退出码 0/1/2。
 *
 * 隔离：全部跑在 `os.tmpdir()` 下的临时 git 仓；只读该仓，不触网/不碰真实仓。
 * 运行：node --test scripts/tests/branch-guard.test.mjs
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MOD = path.join(HERE, '..', 'branch-guard.mjs');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-branchguard-'));
after(() => { fs.rmSync(ROOT, { recursive: true, force: true }); });

let seq = 0;
/** 建一个含 `main` + `dev` + `lane/x` 的临时仓，并停在 `dev` 上。 */
function makeRepo(name = `repo${++seq}`) {
  const dir = path.join(ROOT, name);
  fs.mkdirSync(dir, { recursive: true });
  const g = (...a) => {
    const r = spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
    assert.equal(r.status, 0, `git ${a.join(' ')} 失败: ${r.stderr}`);
    return r.stdout.trim();
  };
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@example.invalid');
  g('config', 'user.name', 'test');
  fs.writeFileSync(path.join(dir, 'README.md'), '# fixture\n');
  g('add', '--', 'README.md');
  g('commit', '-q', '-m', 'init');
  g('branch', 'dev');
  g('branch', 'lane/x');
  return { dir, g };
}

const mod = await import(MOD.url ?? MOD);
const { runCheck, parseArgs, protectedSet, PROTECTED_ENV } = mod;

// ── 契约：参数与受保护集解析 ────────────────────────────────────────────────

test('契约. parseArgs：--repo/--protected/--allow-protected/--json；未知参数与缺值报错', () => {
  const a = parseArgs(['--repo', '/r', '--protected', 'main,release', '--allow-protected', '--json']);
  assert.equal(a.repo, '/r');
  assert.deepEqual(a.protected, ['main', 'release']);
  assert.equal(a.allowProtected, true);
  assert.equal(a.json, true);
  assert.equal(parseArgs(['--nope']).error, 'unknown_arg:--nope');
  assert.equal(parseArgs(['--repo']).error, 'missing_value:--repo');
});

test('契约. protectedSet：CLI > env > 缺省集（探测到的默认分支 ∪ {main, master}）', () => {
  assert.deepEqual(protectedSet({ protected: ['a'] }, {}), ['a'], 'CLI 最优先');
  assert.deepEqual(protectedSet({ protected: [] }, { [PROTECTED_ENV]: 'dev, release' }), ['dev', 'release'], 'env 逗号分隔并 trim');
  // 缺省档**不假定单一名字**：见文件末 GENERALIZE 段（探测失败 ⇒ 只剩两个通用名）。
  const { dir } = makeRepoOn(`defaultset${++seq}`, 'dev');
  assert.deepEqual(protectedSet({ repo: dir, protected: [] }, {}).sort(), ['main', 'master'],
    '无远程可探测 ⇒ 回退 {main, master}');
});

// ── 放行 / 拒绝 ────────────────────────────────────────────────────────────

test('GREEN. dev 与 lane/* 上的提交放行（开发集成在 dev 上，lane 提交不在 dev 上）', () => {
  const { dir, g } = makeRepo();
  g('checkout', '-q', 'dev');
  const onDev = runCheck({ repo: dir, protected: [], allowProtected: false });
  assert.equal(onDev.ok, true, JSON.stringify(onDev));
  assert.equal(onDev.branch, 'dev');
  assert.equal(onDev.overridden, false);

  g('checkout', '-q', 'lane/x');
  const onLane = runCheck({ repo: dir, protected: [], allowProtected: false });
  assert.equal(onLane.ok, true, JSON.stringify(onLane));
  assert.equal(onLane.branch, 'lane/x');
});

test('REJECT. 受保护分支（缺省 main）⇒ 拒绝，且点名分支（不是「只许 dev」）', () => {
  const { dir, g } = makeRepo();
  g('checkout', '-q', 'main');
  const r = runCheck({ repo: dir, protected: [], allowProtected: false });
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal(r.reason, 'protected_branch_commit:main');
  assert.equal(r.branch, 'main');
  assert.ok(r.protected.includes('main'), `main 须在受保护集内，实际 ${JSON.stringify(r.protected)}`);
});

test('REJECT. detached HEAD ⇒ 拒绝（开发须落在具名分支上）', () => {
  const { dir, g } = makeRepo();
  g('checkout', '-q', '--detach', 'HEAD');
  const r = runCheck({ repo: dir, protected: [], allowProtected: false });
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal(r.reason, 'detached_head_commit');
});

test('OVERRIDE. --allow-protected ⇒ 放行 + overridden:true（dev→main 集成步骤的显式出口）', () => {
  const { dir, g } = makeRepo();
  g('checkout', '-q', 'main');
  const r = runCheck({ repo: dir, protected: [], allowProtected: true });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.branch, 'main');
  assert.equal(r.overridden, true, 'override 必须可见（留痕）');
});

test('GREEN. --protected 自定义受保护集：换掉 main ⇒ main 放行、新集被拒', () => {
  const { dir, g } = makeRepo();
  g('checkout', '-q', 'main');
  const free = runCheck({ repo: dir, protected: ['release'], allowProtected: false });
  assert.equal(free.ok, true, 'main 不在自定义集 ⇒ 放行');

  g('checkout', '-q', 'dev');
  const blocked = runCheck({ repo: dir, protected: ['release', 'dev'], allowProtected: false });
  assert.equal(blocked.ok, false, JSON.stringify(blocked));
  assert.equal(blocked.reason, 'protected_branch_commit:dev');
});

test('REJECT. 非 git 仓 ⇒ not_a_git_repo', () => {
  const plain = path.join(ROOT, 'notarepo');
  fs.mkdirSync(plain, { recursive: true });
  const r = runCheck({ repo: plain, protected: [], allowProtected: false });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'not_a_git_repo');
});

// ── CLI：末行 JSON 契约 + 退出码 ───────────────────────────────────────────

test('CLI. 末行 JSON {ok,branch,...}；通过 0 / 违规 1 / 用法 2', () => {
  const { dir, g } = makeRepo();
  g('checkout', '-q', 'dev');
  const ok = spawnSync(process.execPath, [MOD, '--repo', dir, '--json'], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  const j = JSON.parse(ok.stdout.trim().split('\n').pop());
  assert.equal(j.ok, true);
  assert.equal(j.branch, 'dev');

  g('checkout', '-q', 'main');
  const bad = spawnSync(process.execPath, [MOD, '--repo', dir, '--json'], { encoding: 'utf8' });
  assert.equal(bad.status, 1, '受保护分支 ⇒ 1');
  assert.equal(JSON.parse(bad.stdout.trim().split('\n').pop()).ok, false);

  const usage = spawnSync(process.execPath, [MOD, '--nope'], { encoding: 'utf8' });
  assert.equal(usage.status, 2, '用法错误 ⇒ 2');
});

// ── 受保护分支名的**泛化**（T-20261016- 收口）─────────────────────────────────
//
// 发布/默认分支的名字**随仓而异**：`git init` 的历史默认是 `master`，新默认是 `main`，也可能被
// 项目改成 `trunk`。只认 `main` 会让 `master`/`trunk` 仓**静默失去保护**——而本守卫的全部价值就是
// 「不许直接提交发布分支」，静默失效比误拦有害得多。故缺省集 = 探测到的仓默认分支 ∪ {main, master}。

/** 造一个仓并把它停在 `branch` 上；`originHead` 非空时伪造 `refs/remotes/origin/HEAD` 指向它。 */
function makeRepoOn(name, branch, originHead = '') {
  const { dir, g } = makeRepo(name);
  if (originHead) {
    g('update-ref', `refs/remotes/origin/${originHead}`, 'HEAD');
    g('symbolic-ref', 'refs/remotes/origin/HEAD', `refs/remotes/origin/${originHead}`);
  }
  g('checkout', '-q', branch);
  return { dir, g };
}

test('GENERALIZE. master 仓：缺省即受保护（只写 main 会让它静默失去保护）', () => {
  const { dir, g } = makeRepo('masterrepo');
  g('branch', '-m', 'main', 'master');          // 仓的默认分支叫 master
  g('checkout', '-q', 'master');
  const r = runCheck({ repo: dir, protected: [], allowProtected: false });
  assert.equal(r.ok, false, 'master 必须被拒，否则等于没有保护');
  assert.equal(r.reason, 'protected_branch_commit:master');
  assert.ok(r.protected.includes('master'), `缺省集须含 master，实际 ${JSON.stringify(r.protected)}`);
  assert.ok(r.protected.includes('main'), 'main 仍在（另一个通用名）');
});

test('GENERALIZE. 探测仓默认分支：自定义默认分支名（trunk）也在保护内', () => {
  const { dir, g } = makeRepo('trunkrepo');
  g('branch', '-m', 'main', 'trunk');
  g('update-ref', 'refs/remotes/origin/trunk', 'HEAD');
  g('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk');
  g('checkout', '-q', 'trunk');
  const r = runCheck({ repo: dir, protected: [], allowProtected: false });
  assert.equal(r.ok, false, `trunk 是探测到的默认分支 ⇒ 须受保护，实际 ${JSON.stringify(r)}`);
  assert.equal(r.reason, 'protected_branch_commit:trunk');
  assert.ok(r.protected.includes('trunk'), `缺省集须含探测结果，实际 ${JSON.stringify(r.protected)}`);
});

test('GENERALIZE. 探测不到默认分支（无远程）⇒ 回退 {main,master}，**不缩小**保护面', () => {
  const { dir } = makeRepoOn('noremote', 'dev');
  const set = protectedSet({ repo: dir, protected: [] }, {}, dir);
  assert.deepEqual(set.sort(), ['main', 'master'], `实际 ${JSON.stringify(set)}`);
});

test('GENERALIZE. 显式集（env / --protected）**原样采用、不并集**——写了就是写了', () => {
  const { dir } = makeRepoOn('exactset', 'dev');
  assert.deepEqual(protectedSet({ repo: dir, protected: [] }, { [PROTECTED_ENV]: 'release' }, dir), ['release'],
    'env 显式指定 ⇒ 不掺入 main/master（否则无法把某个分支从保护集里拿掉）');
  assert.deepEqual(protectedSet({ repo: dir, protected: ['release'] }, {}, dir), ['release'],
    'CLI 同理，且优先级高于 env');
});

test('GENERALIZE. 集成分支/卡分支在探测到默认分支的仓里仍放行（保护的是发布分支，不是"只许 dev"）', () => {
  const { dir, g } = makeRepoOn('allowdev', 'dev', 'trunk');
  const onDev = runCheck({ repo: dir, protected: [], allowProtected: false });
  assert.equal(onDev.ok, true, `集成分支须放行，实际 ${JSON.stringify(onDev)}`);
  assert.ok(onDev.protected.includes('trunk'), '同时仍保护着探测到的发布分支');

  g('checkout', '-q', 'lane/x');
  const onLane = runCheck({ repo: dir, protected: [], allowProtected: false });
  assert.equal(onLane.ok, true, '卡分支须放行');
});
