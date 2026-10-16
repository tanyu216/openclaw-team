#!/usr/bin/env node
/**
 * tmp-gc.test.mjs — tmp-gc.mjs 回归测试（PROTOCOL §⑬.9 的回收作业）
 *
 * 本套件覆盖四类**安全**性质（它们正是这个作业唯一会伤人/伤数据的地方）：
 *   ① 年龄：只删 mtime 早于 N 天的**普通文件**，新的留着；
 *   ② 边界：根目录自身、根外的兄弟目录一律不动；已空的根留着不删；
 *   ③ 符号链接：不跟随、不删除（既不走出根，也不成环）；
 *   ④ 失败闭合：读不了 / 删不掉 ⇒ fire:true；正常清扫完 ⇒ fire:false。
 * 另加 CLI 输出契约（裸跑文本 / --json 信封）与 providers.json 接线。
 *
 * 无 provider 依赖：tmp-gc.mjs 不 import ACL 库，故本套件不需要 SKIP 分支。
 * 运行：node --test scripts/tests/tmp-gc.test.mjs
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { DEFAULT_DAYS, isExpired, defaultRoots, collectPlan, gc } from '../tmp-gc.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, '..', 'tmp-gc.mjs');
const PROVIDERS = path.join(HERE, '..', '..', 'automations', 'providers.json');

const sandboxes = [];
after(() => { for (const s of sandboxes) fs.rmSync(s, { recursive: true, force: true }); });

/** 造一个隔离的 OPENCLAW_HOME 沙箱（绝不触碰真实 ~/.openclaw） */
function mkHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tmp-gc-home-'));
  sandboxes.push(home);
  return home;
}

/** 每个 workspace 都要有 .tmp 才成为默认根 */
function mkWorkspaceTmp(home, name = 'workspace-linus') {
  const p = path.join(home, name, '.tmp');
  fs.mkdirSync(p, { recursive: true });
  return p;
}

/** 写一个文件并把 mtime 拨到 days 天前 */
function put(p, days, bytes = 1000) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, 'x'.repeat(bytes));
  const t = Date.now() / 1000 - days * 86400;
  fs.utimesSync(p, t, t);
  return p;
}

/** 独立进程跑真实 CLI；返回 stdout（默认 --json） */
function runCli(home, args = ['--days', '14', '--json']) {
  return execFileSync('node', [CLI, ...args], {
    env: { ...process.env, OPENCLAW_HOME: home },
    encoding: 'utf8',
  });
}
const lastJson = (out) => JSON.parse(out.trim().split('\n').pop());

// ── ① 年龄 ────────────────────────────────────────────────────────────────────────

test('isExpired：只看 mtime，与天数阈值严格比较', () => {
  const now = Date.now();
  assert.equal(isExpired(now - 15 * 86400 * 1000, now, 14), true);
  assert.equal(isExpired(now - 13 * 86400 * 1000, now, 14), false);
  assert.equal(DEFAULT_DAYS, 14);
});

test('只删过期文件：15 天前的删、当天的留', () => {
  const home = mkHome();
  const tmp = mkWorkspaceTmp(home);
  put(path.join(tmp, 'old.txt'), 15);
  put(path.join(tmp, 'new.txt'), 0);
  const env = lastJson(runCli(home));
  assert.equal(env.fire, false);
  assert.equal(env.deleted, 1);
  assert.equal(fs.existsSync(path.join(tmp, 'old.txt')), false);
  assert.equal(fs.existsSync(path.join(tmp, 'new.txt')), true);
});

// ── ② 边界 ────────────────────────────────────────────────────────────────────────

test('三个根族都覆盖：workspace-*/.tmp + $OH/tmp + $OH/team/tmp', () => {
  const home = mkHome();
  const ws = mkWorkspaceTmp(home);
  put(path.join(ws, 'old'), 20);
  put(path.join(home, 'tmp', 'old'), 20);
  put(path.join(home, 'team', 'tmp', 'old'), 20);
  put(path.join(home, 'tmp', 'fresh'), 1);
  const env = lastJson(runCli(home));
  assert.equal(env.deleted, 3);
  assert.equal(env.roots.length, 3);
  assert.equal(fs.existsSync(path.join(home, 'tmp', 'fresh')), true);
});

test('defaultRoots 用 glob：收所有 workspace-*/.tmp，忽略非 workspace 目录与缺 .tmp 的 workspace', () => {
  const home = mkHome();
  fs.mkdirSync(path.join(home, 'workspace-a', '.tmp'), { recursive: true });
  fs.mkdirSync(path.join(home, 'workspace-b', '.tmp'), { recursive: true });
  fs.mkdirSync(path.join(home, 'workspace-c'), { recursive: true });   // 无 .tmp ⇒ 不作为根
  fs.mkdirSync(path.join(home, 'not-a-workspace', '.tmp'), { recursive: true });
  fs.mkdirSync(path.join(home, 'tmp'), { recursive: true });
  const roots = defaultRoots(home).map((p) => path.relative(home, p));
  assert.deepEqual(roots, ['workspace-a/.tmp', 'workspace-b/.tmp', 'tmp']);
});

test('根目录自身与根外的文件绝不动；腾空的根留着不删', () => {
  const home = mkHome();
  const tmp = mkWorkspaceTmp(home);
  const outside = path.join(home, 'team', 'keep.jsonl');
  put(path.join(tmp, 'old'), 30);
  put(outside, 30);                                   // 不在任何根下 ⇒ 不是候选
  const env = lastJson(runCli(home));
  assert.equal(env.deleted, 1);
  assert.equal(fs.existsSync(tmp), true, '根目录必须存活');
  assert.equal(fs.existsSync(outside), true, '根外文件必须存活');
});

test('空目录修剪止步于根：删空后子目录被回收，根本身保留', () => {
  const home = mkHome();
  const tmp = mkWorkspaceTmp(home);
  put(path.join(tmp, 'sub', 'deep', 'old'), 30);
  assert.equal(lastJson(runCli(home)).state.prunedDirs, 2);
  assert.equal(fs.existsSync(path.join(tmp, 'sub')), false);
  assert.equal(fs.existsSync(tmp), true);
});

test('非空子目录不被修剪（只删按年龄该删的文件）', () => {
  const home = mkHome();
  const tmp = mkWorkspaceTmp(home);
  put(path.join(tmp, 'sub', 'old'), 30);
  put(path.join(tmp, 'sub', 'new'), 0);
  const env = lastJson(runCli(home));
  assert.equal(env.deleted, 1);
  assert.equal(env.state.prunedDirs, 0);
  assert.equal(fs.existsSync(path.join(tmp, 'sub', 'new')), true);
});

// ── ③ 符号链接 ────────────────────────────────────────────────────────────────────

test('符号链接既不删也不跟随：链与其目标都存活，且不递归进链指向的目录', () => {
  const home = mkHome();
  const tmp = mkWorkspaceTmp(home);
  const target = path.join(home, 'outside-target.txt');
  put(target, 60);
  fs.symlinkSync(target, path.join(tmp, 'link-to-file'));
  // 链指向一个**含过期文件**的目录：若跟随，就会删掉目标目录里的文件
  const linked = path.join(home, 'linked-dir');
  put(path.join(linked, 'should-survive'), 60);
  fs.symlinkSync(linked, path.join(tmp, 'link-to-dir'));

  const env = lastJson(runCli(home));
  assert.equal(env.deleted, 0, '软链不该被当作过期文件删除');
  assert.equal(env.state.symlinksSkipped, 2);
  assert.equal(fs.existsSync(path.join(tmp, 'link-to-file')), true);
  assert.equal(fs.existsSync(path.join(tmp, 'link-to-dir')), true);
  assert.equal(fs.existsSync(target), true);
  assert.equal(fs.existsSync(path.join(linked, 'should-survive')), true, '不得走过软链删目标');
});

// ── ④ 失败闭合 ────────────────────────────────────────────────────────────────────

test('根缺失不算失败（首次安装前 .tmp 尚不存在）⇒ fire:false', () => {
  const home = mkHome();
  const env = lastJson(runCli(home));
  assert.equal(env.fire, false);
  assert.equal(env.roots.length, 0);
  assert.equal(env.deleted, 0);
});

test('子目录读不了 ⇒ fire:true + message（评估未被确认必须告警）', { skip: process.getuid?.() === 0 ? 'root 无视权限位' : false }, () => {
  const home = mkHome();
  const tmp = mkWorkspaceTmp(home);
  const locked = path.join(tmp, 'locked');
  fs.mkdirSync(locked, { recursive: true });
  fs.chmodSync(locked, 0o000);
  try {
    const env = lastJson(runCli(home));
    assert.equal(env.fire, true);
    assert.match(env.message, /could not confirm/);
    assert.equal(env.state.unreadable.length, 1);
    assert.equal(env.state.unreadable[0].error, 'EACCES');
  } finally {
    fs.chmodSync(locked, 0o755);
  }
});

test('gc() 在正常清扫完时为 fire:false —— 删得多也是「作业在工作」，不是事件', () => {
  const home = mkHome();
  const tmp = mkWorkspaceTmp(home);
  for (let i = 0; i < 5; i++) put(path.join(tmp, `old-${i}`), 30);
  const env = gc({ roots: [tmp], days: 14, dryRun: false, deadlineMs: 6000 });
  assert.equal(env.deleted, 5);
  assert.equal(env.fire, false);
  assert.equal(env.message, undefined);
});

// ── 输出契约 ──────────────────────────────────────────────────────────────────────

test('--json 信封：顶层计数 + state 镜像（派发器只转发 state）', () => {
  const home = mkHome();
  const tmp = mkWorkspaceTmp(home);
  put(path.join(tmp, 'old'), 30, 2048);
  const env = lastJson(runCli(home));
  for (const k of ['fire', 'deleted', 'failed', 'bytes', 'roots', 'state']) assert.ok(k in env, `缺字段 ${k}`);
  assert.equal(env.bytes, 2048);
  assert.equal(env.state.deleted, env.deleted);
  assert.equal(env.state.bytes, env.bytes);
  assert.equal(env.state.job, 'tmp-gc');
  assert.equal(env.state.days, 14);
  assert.equal(env.state.deadlineHit, false);
});

test('裸跑输出一行人读文本（不是 JSON）', () => {
  const home = mkHome();
  put(path.join(mkWorkspaceTmp(home), 'old'), 30);
  const out = runCli(home, ['--days', '14']).trim();
  assert.match(out, /^deleted=1 failed=0 bytes=\d+ roots=1 \(days=14\)$/);
});

test('--dry-run 真只读：不删、不改 mtime，且计数与真跑一致', () => {
  const home = mkHome();
  const tmp = mkWorkspaceTmp(home);
  const f = put(path.join(tmp, 'old'), 30);
  const before = fs.statSync(f).mtimeMs;
  const dry = lastJson(runCli(home, ['--days', '14', '--json', '--dry-run']));
  assert.equal(dry.deleted, 1);
  assert.equal(fs.existsSync(f), true);
  assert.equal(fs.statSync(f).mtimeMs, before, 'dry-run 不得触碰 mtime');
  assert.equal(fs.existsSync(path.join(tmp, 'sub')), false);
  const real = lastJson(runCli(home, ['--days', '14', '--json']));
  assert.equal(real.deleted, dry.deleted);
  assert.equal(fs.existsSync(f), false);
});

// ── 内部截止 ──────────────────────────────────────────────────────────────────────

test('枚举截止：deadlineMs 用尽仍产出信封，只是 deadlineHit 且不删任何东西', () => {
  const home = mkHome();
  const tmp = mkWorkspaceTmp(home);
  put(path.join(tmp, 'old'), 30);
  // 直接测纯函数：负预算 ⇒ 一开始就超期（CLI 侧不接受非正数，避免把预算"加宽"的误用）
  const plan = collectPlan({ roots: [tmp], now: Date.now(), days: 14, deadlineMs: -1 });
  assert.equal(plan.deadlineHit, true);
  assert.equal(plan.targets.length, 0);
  assert.equal(fs.existsSync(path.join(tmp, 'old')), true);
});

// ── 接线 ──────────────────────────────────────────────────────────────────────────

test('providers.json 接线：tmpGc 指向 --json 入口', () => {
  const p = JSON.parse(fs.readFileSync(PROVIDERS, 'utf8'));
  assert.equal(p['meerkat-taskpanel'].tmpGc, 'node {team}/scripts/tmp-gc.mjs --json');
});

test('未知 job 的用法串包含 tmp-gc', () => {
  const out = execFileSync('node', [path.join(HERE, '..', '..', 'automations', 'dispatch.mjs'), 'bogus'], { encoding: 'utf8' });
  assert.match(lastJson(out).state.usage, /tmp-gc/);
});
