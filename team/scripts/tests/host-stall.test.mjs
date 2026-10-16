#!/usr/bin/env node
/**
 * host-stall.test.mjs — 「有界等待被击穿 ≠ 失败」的判别与重取（T-20261016-210926）
 *
 * 本套件锁死 `host-stall.mjs` 的契约，两个方向都要有齿：
 *   · **假红方向**（本卡要除掉的）：宿主被冻结时，一个**好的**子进程也会以 `status: null` /
 *     `ETIMEDOUT` 回来——这正是 11:03:45Z（`raw.status` **null !== 0**）与 12:22:36Z
 *     （`red.exit` **null !== 1**）两次慢段告警的读数。这里用**真冻结**复现它：一个**外部**进程
 *     把我们 `SIGSTOP` 住、扣住久于有界等待的期限、再 `SIGCONT`（冻结中的进程无法自救，故冻结者
 *     必须是另一个进程）。复现后同一调用在默认 `retries` 下**答得上**。
 *   · **假绿方向**（绝不能引入的）：**答案错**从不重取。非零退出、`ENOENT`、被外部 SIGKILL、
 *     成功 —— 一律一次定终身；两次皆击穿才判红。故 `attempts` 是要断言的对象，不是实现细节。
 *
 * 真冻结探针的可判性：子进程是**门控**的（只在 flag 文件出现后才应答），于是「冻结期间它一定还活着」
 * 是构造出来的而不是赌出来的——若用 `sleep 0.3` 这类定长子进程，「子进程已退出 vs 期限已过」谁先被
 * libuv 读到是一场比赛，断言会时而 null 时而 0。放行时刻由一个外部定时进程给出，故**重取那一次**
 * 也是在构造下成功的，不是撞运气。
 *
 * 真冻结探针自带**保险**：arm 时同时起一条「无条件 SIGCONT」的兜底（远晚于扣留时长），
 * 即使扣留/恢复的时序被击穿，本进程也不会永远停住。
 *
 * 运行：node --test team/scripts/tests/host-stall.test.mjs
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, execFileSync } from 'node:child_process';

import {
  STALL_OVERSHOOT_RATIO, describeBreach, withStallRetrySync, withStallRetry,
  timeoutBreachOf, execTimeoutBreachOf,
} from '../host-stall.mjs';
import { cliRunner } from '../board-adapter.mjs';

const scratch = [];
after(() => { for (const d of scratch) fs.rmSync(d, { recursive: true, force: true }); });

const mkTmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-stall-')); scratch.push(d); return d; };

// ── 真冻结装置 ────────────────────────────────────────────────────────────────

/**
 * **外部**冻结本进程：`afterMs` 后 `SIGSTOP`，扣住 `holdMs`，再 `SIGCONT`。
 * 必须是另一个进程——被冻结的进程跑不了自己的恢复代码。
 *
 * 同步 arm，不返回 promise：紧接着的那次调用本身就是**阻塞**的（`spawnSync`/`execFileSync`），
 * 它会横跨整个冻结窗口并自然等到 `SIGCONT`——这正是「冻结中的有界等待」的现场。
 */
function armFreeze({ afterMs = 100, holdMs = 2000 } = {}) {
  const me = process.pid;
  spawn('sh', ['-c', `sleep ${afterMs / 1000}; kill -STOP ${me}; sleep ${holdMs / 1000}; kill -CONT ${me}`],
    { detached: true, stdio: 'ignore' }).unref();
  // 兜底：无条件 CONT，远晚于扣留时长 ⇒ 上面的时序万一没走到，也不会把套件挂死。
  spawn('sh', ['-c', `sleep ${(afterMs + holdMs) / 1000 + 10}; kill -CONT ${me}`],
    { detached: true, stdio: 'ignore' }).unref();
}

/** 外部定时器：`afterMs` 后创建 `flag`（放行门控子进程）。 */
function armTouch(flag, afterMs) {
  spawn('sh', ['-c', `sleep ${afterMs / 1000}; : > ${JSON.stringify(flag)}`], { detached: true, stdio: 'ignore' }).unref();
}

/**
 * 门控假 CLI：只在 `flag` 出现后才打印版本腿信封。
 * 于是「冻结窗口内它一定还在跑」是**构造**出来的（见文件头「真冻结探针的可判性」）。
 */
function mkGatedCli(flag) {
  const dir = mkTmp();
  const bin = path.join(dir, 'taskctl');
  fs.writeFileSync(bin, `#!/bin/sh\nwhile [ ! -f ${JSON.stringify(flag)} ]; do sleep 0.05; done\nprintf '{"ok":true,"data":{"schema_version":4}}'\n`);
  fs.chmodSync(bin, 0o755);
  return bin;
}

/** 预热 exec 路径（丢弃结果）：macOS 上 sh+脚本的**首次**调用可以冷到秒级（实测 2490–3101ms）。 */
function warmup(bin) {
  spawnSync(bin, [], { encoding: 'utf8', timeout: 10_000 });
}

/**
 * 门控假 CLI，**整份文件共用一份**：exec 的首次冷启动在本机实测 2.5–3.1s，只该付一次。
 * `warmup` 必须在门开着时做——否则预热自己会一直等到超时（它拿到的是同一个门控子进程）。
 */
let GATED = null;
function gated() {
  if (GATED) return GATED;
  const flag = path.join(mkTmp(), 'go');
  const bin = mkGatedCli(flag);
  fs.writeFileSync(flag, '');
  warmup(bin);
  GATED = { flag, bin };
  return GATED;
}

// ── 诊断读数：两次实测分档必须落在阈值两侧 ────────────────────────────────────

test('describeBreach: 负载尖峰（1.005×）不判停，宿主休眠（19×）判停 —— 两次实测读数分开', () => {
  // 11:03:45Z：期限 5000ms，回来 5023/5025ms —— 执法钟没停，是子进程被饿死
  for (const ms of [5023, 5025]) {
    const b = describeBreach(ms, 5000);
    assert.equal(b.ratio, 1.005, `${ms}ms`);
    assert.equal(b.likelyStall, false, '刚好卡在期限上不是冻结');
  }
  // 12:22:36Z：期限 5000ms / 60000ms，回来 1135046ms / 1135929ms —— 执法钟被冻结
  assert.equal(describeBreach(1135046, 5000).likelyStall, true);
  assert.equal(describeBreach(1135929, 60000).likelyStall, true);
  assert.ok(describeBreach(1135929, 60000).ratio > 18, '越界倍数如实反映冻结时长');
  // 期限未知 ⇒ 只报用时，不臆断
  assert.deepEqual(describeBreach(1234, null), { elapsedMs: 1234, budgetMs: null, overshootMs: null, ratio: null, likelyStall: false });
  assert.ok(STALL_OVERSHOOT_RATIO > 1.005 && STALL_OVERSHOOT_RATIO <= 2, '阈值必须在两档之间');
});

// ── 判据：只有「被击穿」才算击穿 ──────────────────────────────────────────────

test('timeoutBreachOf: 只认超时；CLI 缺失（ENOENT）/ 非零退出 / 被外部 SIGKILL 都是**结论**', () => {
  assert.match(timeoutBreachOf({ status: null, signal: 'SIGTERM', error: { code: 'ETIMEDOUT' } }).reason, /ETIMEDOUT/);
  assert.match(timeoutBreachOf({ status: null, signal: 'SIGTERM' }).reason, /SIGTERM/);
  // 这些是**答案**，重取只会再失败一次 —— 放行它们就是把真失败洗成绿
  assert.equal(timeoutBreachOf({ status: null, signal: null, error: { code: 'ENOENT' } }), null, 'CLI 缺失');
  assert.equal(timeoutBreachOf({ status: 1, stdout: '' }), null, '非零退出');
  assert.equal(timeoutBreachOf({ status: 0, stdout: '{}' }), null, '成功');
  assert.equal(timeoutBreachOf({ status: null, signal: 'SIGKILL' }), null, '被外部 SIGKILL（那是别人的决定）');
  assert.equal(timeoutBreachOf(null), null);
});

test('execTimeoutBreachOf: 两种实际形态都认（status=null 与 status=0），其余一律不认', () => {
  assert.ok(execTimeoutBreachOf(Object.assign(new Error('x'), { code: 'ETIMEDOUT', status: null })));
  assert.ok(execTimeoutBreachOf(Object.assign(new Error('x'), { code: 'ETIMEDOUT', status: 0 })), '子进程其实已退出、但等待被判超时');
  assert.equal(execTimeoutBreachOf(Object.assign(new Error('x'), { status: 1 })), null);
  assert.equal(execTimeoutBreachOf(Object.assign(new Error('x'), { code: 'ENOENT' })), null);
  assert.equal(execTimeoutBreachOf(null), null);
});

// ── 重取驱动：两个方向 ────────────────────────────────────────────────────────

test('击穿后答得上 ⇒ 采纳答案（假红方向）；两次皆击穿 ⇒ 仍是击穿（真失败仍红）', () => {
  let n = 0;
  const flaky = withStallRetrySync(
    () => (++n === 1 ? { status: null, signal: 'SIGTERM', error: { code: 'ETIMEDOUT' } } : { status: 0, stdout: 'ok' }),
    { classify: timeoutBreachOf, budgetMs: 5 },
  );
  assert.equal(flaky.attempts, 2, '击穿必须重取');
  assert.equal(flaky.breached, false);
  assert.equal(flaky.value.status, 0, '采纳的是**后一次**的答案');
  assert.equal(flaky.audit.length, 1, '每次击穿进 audit（不静默）');
  assert.equal(flaky.audit[0].budgetMs, 5, 'audit 带越界读数所需的期限');

  const hung = withStallRetrySync(() => ({ status: null, signal: 'SIGTERM', error: { code: 'ETIMEDOUT' } }),
    { classify: timeoutBreachOf, budgetMs: 5 });
  assert.equal(hung.attempts, 2);
  assert.equal(hung.breached, true);
  assert.equal(hung.value.status, null, '真挂死 ⇒ 交回空结论，调用方照旧判红');
  assert.equal(hung.audit.length, 2, '两次击穿都留痕');
});

test('答案错**从不**重取 —— 非零退出 / ENOENT / 成功都一次定终身（假绿防线）', () => {
  for (const answer of [{ status: 1, stderr: 'boom' }, { status: null, signal: null, error: { code: 'ENOENT' } }, { status: 0, stdout: '{}' }]) {
    let n = 0;
    const r = withStallRetrySync(() => { n++; return answer; }, { classify: timeoutBreachOf, retries: 3 });
    assert.equal(n, 1, `不得重取：${JSON.stringify(answer)}`);
    assert.equal(r.attempts, 1);
    assert.equal(r.breached, false);
  }
});

test('retries=0 ⇒ 单次语义（探针/诊断用），且默认恰好重取一次', () => {
  const one = withStallRetrySync(() => ({ status: null, signal: 'SIGTERM' }), { classify: timeoutBreachOf, retries: 0 });
  assert.equal(one.attempts, 1);
  assert.equal(one.breached, true);
  const two = withStallRetrySync(() => ({ status: null, signal: 'SIGTERM' }), { classify: timeoutBreachOf });
  assert.equal(two.attempts, 2, '默认 retries=1 ⇒ 最多两次（残余的间歇性击穿风险有界）');
});

test('异步版逐点同义（轮询式等待用它）', async () => {
  let n = 0;
  const r = await withStallRetry(async () => { n++; return n === 1 ? 'timeout' : 'dead'; },
    { classify: (v) => (v === 'dead' ? null : { reason: v }), budgetMs: 20 });
  assert.equal(r.value, 'dead');
  assert.equal(r.breached, false);
  assert.equal(r.attempts, 2);

  const both = await withStallRetry(async () => 'timeout', { classify: (v) => (v === 'dead' ? null : { reason: v }) });
  assert.equal(both.breached, true);
  assert.equal(both.value, 'timeout', '两次皆观测不成 ⇒ 调用方拿到那个「没观测到」的原值');
});

// ── 真冻结：慢段两条读数在此复现，并被重取救回 ───────────────────────────────

// 冻结窗口与期限（只需满足「重取前的那次调用**一定**落在冻结里」，且放行门落在重取的新期限内）：
//   · 期限 700ms 在冻结中被越过（resume ≈ 1.1s）⇒ 空结论；
//   · 重取那一次在 resume 之后起跑，新期限 700ms，而放行门在 resume+300ms 打开 ⇒ 答得上。
// 余量：复现方向 400ms，重取方向 360ms。都只需满足不等式，故不随机器快慢而变（只会更宽松）。
const FREEZE = { afterMs: 100, holdMs: 1000 };
const BUDGET = 700;
const UNGATE_AFTER_MS = FREEZE.afterMs + FREEZE.holdMs + 300;

test('真冻结 · 有界子进程等待交回空结论（复现 11:03 `raw.status null` 与 12:22 `red.exit null`）', () => {
  const { flag, bin } = gated();

  // 控制组：门开着时不冻结 ⇒ 两个 API 都正常答出（证明下面那两次空结论不是子进程的锅）
  const okSpawn = cliRunner(['--version', '--json'], { taskctl: bin, timeoutMs: BUDGET, retries: 0 });
  assert.equal(okSpawn.status, 0, `控制组（spawnSync）应成功：${okSpawn.stderr}`);
  const okExec = execFileSync(bin, [], { encoding: 'utf8', timeout: BUDGET, stdio: ['ignore', 'pipe', 'pipe'] });
  assert.equal(JSON.parse(okExec).data.schema_version, 4);

  // 门关上 + 冻结：子进程**一定**活到冻结结束 ⇒ 期限在冻结中被越过 ⇒ 空结论（不是「子进程失败」）
  fs.rmSync(flag, { force: true });
  armFreeze(FREEZE);
  const breached = cliRunner(['--version', '--json'], { taskctl: bin, timeoutMs: BUDGET, retries: 0 });
  assert.equal(breached.status, null, 'spawnSync 冻结 ⇒ `status: null`（告警里那条 `raw.status` null !== 0）');
  assert.equal(breached.error?.code, 'ETIMEDOUT', '形态必须是超时（不是别的失败）');

  // 同一冻结下的 execFileSync（check-all-gate 的 60s 腿形态）：`e.status` 同样是**空结论**
  armFreeze(FREEZE);
  let execErr = null;
  try { execFileSync(bin, [], { encoding: 'utf8', timeout: BUDGET, stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (e) { execErr = e; }
  assert.ok(execErr, '冻结下必须抛，而不是假装成功');
  assert.equal(execErr.code, 'ETIMEDOUT');
  assert.equal(execErr.status, null, '告警里那条 `red.exit` null !== 1 就是它');
  assert.ok(execTimeoutBreachOf(execErr), '必须被认成**击穿**（这才是能不能重取的前提）');
});

test('真冻结 · 一次击穿后带新期限重取 ⇒ 拿到子进程真正的答案（board-adapter 与 check-all-gate 两处）', () => {
  const { flag, bin } = gated();

  // 第一次调用落在冻结里（门关着 ⇒ 子进程必然活到冻结结束 ⇒ 击穿）；
  // 放行时刻由一个**外部**定时进程给出，落在重取的新期限**之内** ⇒ 第二次答得上。
  fs.rmSync(flag, { force: true });
  armFreeze(FREEZE);
  armTouch(flag, UNGATE_AFTER_MS);
  const recovered = cliRunner(['--version', '--json'], { taskctl: bin, timeoutMs: BUDGET });
  assert.equal(recovered.status, 0, `重取应答得上：${recovered.stderr} / exit=${recovered.status}`);
  assert.equal(JSON.parse(recovered.stdout).data.schema_version, 4);

  // execFileSync 侧同款（check-all-gate 的 runRaw/runGate 走的就是这条）
  const once = () => {
    try {
      return { exit: 0, stdout: execFileSync(bin, [], { encoding: 'utf8', timeout: BUDGET, stdio: ['ignore', 'pipe', 'pipe'] }), waitBreached: null };
    } catch (e) {
      return { exit: e.status, stdout: String(e.stdout || ''), waitBreached: execTimeoutBreachOf(e) };
    }
  };
  fs.rmSync(flag, { force: true });
  armFreeze(FREEZE);
  armTouch(flag, UNGATE_AFTER_MS);
  const r = withStallRetrySync(once, { classify: (v) => v.waitBreached, budgetMs: BUDGET });
  assert.equal(r.breached, false);
  assert.equal(r.attempts, 2, '第一次被冻结击穿，第二次拿到答案');
  assert.equal(r.value.exit, 0);
  assert.equal(JSON.parse(r.value.stdout).data.schema_version, 4);
});
