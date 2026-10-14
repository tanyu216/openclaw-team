#!/usr/bin/env node
/**
 * check-report.test.mjs — 卡面 Report 完备性巡检测试（T-20261015-010749-2 ⑦）
 *
 * 覆盖契约（口径依据 = scripts/check-report.mjs 头注；guides/worker-report-template.md）：
 *   ① 锚点语法自洽：REQUIRED_SLOTS = A1…A8，`A10` 不得命中 `A1`；
 *   ② **RED→GREEN 变异自证**：
 *      (a) 卡面变异 —— 删掉某个必需槽位（A5）⇒ 必红；还原 ⇒ 绿；
 *      (b) **判定变异** —— 把 `A5` 从判定表里摘掉（篡改判定）后，同一张缺 A5 的卡**不再被判缺**
 *          ⇒ 证明本套测试对「删/坏一个必需项判定」确实有杀伤力（不是只测 fixture）；
 *      (c) 事故型 —— `## Report` 段整个清空 ⇒ 必红；
 *   ③ 触发面：仅 `in_review` 硬触发；`done/failed/canceled` 终态一律不查（连 warn 都不报）；
 *      `in_progress/blocked` 的成稿半成品降 draft 提示（不置退出码）；`todo/ready/backlog` skip；
 *   ④ 生效截止：`created_at < EFFECTIVE_AT` ⇒ grandfather（warn、退出 0）；前缀截止（env）⇒ 转硬；
 *   ⑤ 豁免机制：① 托管模板（**仓内副本必须为空**，被本文件钉住）∪ ② 运行时登记（tasks 目录内）；
 *      判据 = id + 缺口集合全等 ⇒ 集合一变即失效（防「登记一次、永久放行」）；
 *   ⑥ `--no-baseline` 忽略两源；内容提示（A2 卡路径/hash、A5 退出码）**永远非阻断**。
 *
 * 隔离：`OPENCLAW_TEAM_ROOT` = mkdtemp（TASKS_DIR 于 lib.mjs 模块加载期读取，须先设 env 再 import）
 * ⇒ 绝不碰真实看板、绝不写仓内模板。
 * provider 依赖：check-report.mjs → lib.mjs 需 provider ACL 库（有意不随仓）；缺则**整体 SKIP**
 * （与 check-idem.test.mjs / check-handoff.test.mjs 同契约）。
 * 运行：node --test scripts/tests/check-report.test.mjs
 */
import { test as nodeTest, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHECK_REPORT = path.join(HERE, '..', 'check-report.mjs');

/** 定位携带 ACL 库的 provider 安装目录（与 check-idem.test.mjs 同口径）。 */
function resolveProviderRoot() {
  const candidates = [
    process.env.OPENCLAW_TASK_OPS_DIR,
    path.join(os.homedir(), '.openclaw', 'team', 'skills', 'task-ops'),
    path.join(os.homedir(), '.openclaw', 'skills', 'task-ops'),
  ].filter(Boolean);
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'lib', 'team-paths.mjs'))) return c;
  }
  return null;
}
const PROVIDER = resolveProviderRoot();
const SKIP = PROVIDER
  ? false
  : 'provider ACL library not installed (task-ops is intentionally not vendored); set OPENCLAW_TASK_OPS_DIR to run';
const test = SKIP ? nodeTest.skip : nodeTest;

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-report-'));
const TMP = [ROOT];
const TASKS = path.join(ROOT, 'tasks');
const WS = path.join(ROOT, 'workspace');
fs.mkdirSync(TASKS, { recursive: true });
fs.mkdirSync(WS, { recursive: true });
process.env.OPENCLAW_TEAM_ROOT = ROOT;

let scanReports, slotGaps, slotRegex, reportBody, contentHints, REQUIRED_SLOTS,
  EFFECTIVE_AT, effectiveAt, BASELINE_PATH, RUNTIME_BASELINE_NAME, runtimeBaselinePath,
  loadBaseline, loadExemptions;
if (PROVIDER) {
  process.env.OPENCLAW_TASK_OPS_DIR = PROVIDER;
  ({
    scanReports, slotGaps, slotRegex, reportBody, contentHints, REQUIRED_SLOTS,
    EFFECTIVE_AT, effectiveAt, BASELINE_PATH, RUNTIME_BASELINE_NAME, runtimeBaselinePath,
    loadBaseline, loadExemptions,
  } = await import('../check-report.mjs'));
}

after(() => { for (const r of TMP) fs.rmSync(r, { recursive: true, force: true }); });
beforeEach(() => {
  for (const f of fs.readdirSync(TASKS)) fs.rmSync(path.join(TASKS, f), { recursive: true, force: true });
});

// ---------- fixtures ----------

/** 合规 Report 正文（8 槽位齐备 + A2 带卡路径/hash + A5 带退出码）。slot 省略 ⇒ 整行删掉（变异）。 */
function goodReport(mutate = () => {}) {
  const lines = {
    A1: '- **A1 Conclusion** — acceptable; all Acceptance items met, gate exit 0.',
    A2: '- **A2 Delivery coordinates** — card: tasks/T-20261015-010749-2.md · commit: a1b2c3d4e5 · branch: lane/x (base 1c54cec) · pushed: no.',
    A3: '- **A3 Change surface** — 6 files; no implementation change; no out-of-bounds edits.',
    A4: '- **A4 Acceptance item-by-item**\n  | # | item | status | evidence |\n  |---|---|---|---|\n  | ① | guide | done | guides/worker-report-template.md |',
    A5: '- **A5 Re-run evidence** — cmd: node --test tests/x.test.mjs · exit: 0 · artifact: workspace/x/out.txt',
    A6: '- **A6 Residuals** — none outstanding.',
    A7: '- **A7 Out-of-literal handling** — none.',
    A8: '- **A8 Not pushed** — no push; branch lane/x @ a1b2c3d4e5; worktree reclaimable.',
  };
  const removed = new Set();
  const set = {
    remove: (id) => removed.add(id),
    set: (id, v) => { lines[id] = v; },
    blank: (id) => { lines[id] = `- **${id}** —`; },
  };
  mutate(set);
  return Object.entries(lines).filter(([k]) => !removed.has(k)).map(([, v]) => v).join('\n');
}

const CUTOVER = '2026-10-15T00:00:00.000Z';   // 晚于 EFFECTIVE_AT ⇒ 硬触发
const ANCIENT = '2026-01-01T00:00:00.000Z';   // 早于 EFFECTIVE_AT ⇒ grandfather

function cardText({
  id, status = 'in_review', report = goodReport(), created_at = CUTOVER,
  title = 't', alreadyHasReportSection = true,
}) {
  const body = [
    '## Background', 'x',
    '## Acceptance', '- [ ] a',
    '## Progress', '',
    '## Comments', '',
    '## Sessions', '',
    ...(alreadyHasReportSection ? ['## Report', report] : []),
    '',
  ].join('\n');
  return `---\nid: ${id}\ntitle: ${title}\nassignee: linus\nstatus: ${status}\ncreated_at: "${created_at}"\nproject: __team__\ntarget: /x\n---\n${body}`;
}
function writeCard(opts) {
  fs.writeFileSync(path.join(TASKS, `${opts.id}.md`), cardText(opts), 'utf8');
}
const runCli = (args = [], env = {}) => {
  const r = spawnSync(process.execPath, [CHECK_REPORT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, OPENCLAW_TEAM_ROOT: ROOT, OPENCLAW_TASK_OPS_DIR: PROVIDER, ...env },
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
};
const scan = (opts) => scanReports(TASKS, opts);

// ---------- ① 锚点语法自洽 ----------

test('① 口径自洽：REQUIRED_SLOTS = A1…A8，锚点式不误命中 A10/词内', { skip: SKIP }, () => {
  assert.deepEqual(REQUIRED_SLOTS.map((s) => s.id), ['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8']);
  assert.equal(slotRegex('A1').test('\n- **A10 Other** — x'), false, 'A10 不得命中 A1');
  assert.equal(slotRegex('A1').test('\n- **A1 Conclusion** — x'), true);
  assert.equal(slotRegex('A1').test('\n- **A1 结论** — 可验收'), true);
  assert.equal(slotRegex('A1').test('\nXA1 is a symbol'), false, '词内 A1 不算槽位');
  assert.equal(reportBody('---\nid: x\n---\n## Report\nbody\n## Progress\nz'), 'body');
  assert.equal(reportBody('---\nid: x\n---\n## Progress\nz'), null, '无 Report 段 ⇒ null');
});

// ---------- ② RED→GREEN 变异自证 ----------

test('②(a) 红→绿：删掉必需槽位 A5 ⇒ 判缺 A5；还原 ⇒ 绿（completeness 判定真的在跑）', { skip: SKIP }, () => {
  const FULL = goodReport();
  const BROKEN = goodReport((s) => s.remove('A5'));

  // 绿：8 槽位齐备 ⇒ 无缺口、无违规、退出 0
  assert.deepEqual(slotGaps(FULL), []);
  writeCard({ id: 'T-20261015-000001-a', report: FULL });
  assert.equal(scan().ok, true);
  assert.equal(runCli().code, 0);

  // 红：删除 A5（一个必需项）⇒ 恰判缺 A5，且退出码 1、报文点名
  assert.deepEqual(slotGaps(BROKEN), ['A5']);
  writeCard({ id: 'T-20261015-000001-a', report: BROKEN });
  const r = scan();
  assert.equal(r.ok, false, '缺必需槽位必须判红');
  assert.deepEqual(r.violations.map((v) => [v.id, v.gaps]), [['T-20261015-000001-a', ['A5']]]);
  const cli = runCli();
  assert.equal(cli.code, 1, `缺必需项应 exit 1；stderr=${cli.err}`);
  assert.match(cli.err, /缺 A5/);
  assert.equal(JSON.parse(cli.out).violations.length, 1);

  // 还原 ⇒ 绿（同一 fixture，唯一变量是那一行）
  writeCard({ id: 'T-20261015-000001-a', report: FULL });
  assert.equal(scan().ok, true);
  assert.equal(runCli().code, 0);
});

test('②(b) 判定变异：摘掉 A5 判定项后「缺 A5」不再被测出 ⇒ 证明 ②(a) 有杀伤力', { skip: SKIP }, async () => {
  // 用**篡改后的模块副本**（判定表摘掉 A5）跑同一张缺 A5 的卡：应当**测不出**缺口（变异存活）
  const src = fs.readFileSync(CHECK_REPORT, 'utf8');
  const patched = src.replace(/\n  \{ id: 'A5'[^\n]*\n/, '\n');
  assert.notEqual(patched, src, '变异必须真的改到判定表（A5 行被摘掉），否则本测试无意义');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-report-mut-'));
  TMP.push(dir);
  // lib.mjs 用**符号链接**引回真实 scripts/（Node 默认按 realpath 解析 ⇒ lib.mjs 自身的相对
  // import 仍落在真实 scripts/ 内 ⇒ 不必把 board-adapter.mjs 等一整棵兄弟树拷过来）。
  fs.symlinkSync(path.join(HERE, '..', 'lib.mjs'), path.join(dir, 'lib.mjs'));
  fs.writeFileSync(path.join(dir, 'check-report.mjs'), patched, 'utf8');
  const mut = await import(pathToFileURL(path.join(dir, 'check-report.mjs')).href);

  const BROKEN = goodReport((s) => s.remove('A5'));
  assert.deepEqual(mut.slotGaps(BROKEN), [], '判定被摘掉后，缺 A5 不再被判缺（= 变异存活）');
  // 而真实模块在同一输入上判缺 ⇒ 本套测试会红（= 变异被杀）
  assert.deepEqual(slotGaps(BROKEN), ['A5'], '真实判定必须测出 A5 缺口');
});

test('②(c) 事故型复发：`## Report` 段清空 / 整段缺失 ⇒ 必红（2026-10-14 夜间 4 例同型）', { skip: SKIP }, () => {
  writeCard({ id: 'T-20261015-000002-b', report: '' });
  assert.deepEqual(slotGaps(''), ['REPORT_EMPTY']);
  assert.deepEqual(scan().violations.map((v) => v.gaps), [['REPORT_EMPTY']]);
  assert.equal(runCli().code, 1);

  writeCard({ id: 'T-20261015-000002-b', alreadyHasReportSection: false });
  assert.equal(reportBody(cardText({ id: 'x', alreadyHasReportSection: false })), null);
  assert.deepEqual(scan().violations.map((v) => v.gaps), [['REPORT_MISSING']]);
  assert.equal(runCli().code, 1);
});

test('②(d) 有壳无肉：标签在但标签后无正文 ⇒ 判缺（保守判据，中文标签只会漏报不误红）', { skip: SKIP }, () => {
  assert.deepEqual(slotGaps(goodReport((s) => s.blank('A6'))), ['A6']);
  // 中文标签 + 正文 ⇒ 在（canonical 英文名不同 ⇒ 只可能漏报，绝不误红）
  assert.deepEqual(slotGaps(goodReport((s) => s.set('A1', '- **A1 结论** — 可验收'))), []);
});

// ---------- ③ 触发面 ----------

test('③ 触发面：终态不查（连 warn 都不报）、in_review 硬触发、草稿降级、未开工 skip', { skip: SKIP }, () => {
  for (const st of ['done', 'canceled', 'failed']) writeCard({ id: `T-20261015-000003-${st}`, status: st, report: '' });
  let r = scan();
  assert.equal(r.ok, true);
  assert.equal(r.violations.length, 0, '终态不追溯转红');
  assert.equal(r.grandfathered.length, 0, '终态连 warn 都不报（不翻旧账）');
  assert.equal(r.skipped, 3);
  assert.equal(runCli().code, 0);

  for (const f of fs.readdirSync(TASKS)) fs.rmSync(path.join(TASKS, f));
  writeCard({ id: 'T-20261015-000004-c', status: 'in_progress', report: goodReport((s) => s.remove('A1')) });
  writeCard({ id: 'T-20261015-000005-c', status: 'todo', report: '' });
  writeCard({ id: 'T-20261015-000006-c', status: 'ready', report: '' });
  r = scan();
  assert.equal(r.ok, true, '草稿/未开工不置退出码');
  assert.deepEqual(r.drafts.map((d) => [d.id, d.status, d.gaps]), [['T-20261015-000004-c', 'in_progress', ['A1']]]);
  assert.equal(r.violations.length, 0);
  assert.equal(runCli().code, 0);
  assert.match(runCli().err, /在写草稿/);
});

test('③ in_progress 但 Report 段尚未动笔（空/缺失）⇒ skip，不制造噪声', { skip: SKIP }, () => {
  writeCard({ id: 'T-20261015-000007-c', status: 'in_progress', report: '' });
  writeCard({ id: 'T-20261015-000008-c', status: 'in_progress', alreadyHasReportSection: false });
  const r = scan();
  assert.equal(r.drafts.length, 0);
  assert.equal(r.violations.length, 0);
  assert.equal(r.ok, true);
});

// ---------- ④ 生效截止（grandfather） ----------

test('④ 生效截止：截止前的 in_review 缺项 ⇒ 降 warn、退出 0；截止后 ⇒ 硬红退出 1', { skip: SKIP }, () => {
  assert.equal(EFFECTIVE_AT, '2026-10-14T17:10:00Z', '默认截止 = 门禁落仓时刻（口径常量）');
  writeCard({ id: 'T-20261015-000009-d', status: 'in_review', created_at: ANCIENT, report: '' });
  let r = scan();
  assert.equal(r.ok, true, '截止前创建的卡不追溯转红');
  assert.equal(r.violations.length, 0);
  assert.deepEqual(r.grandfathered.map((g) => [g.id, g.gaps]), [['T-20261015-000009-d', ['REPORT_EMPTY']]]);
  let cli = runCli();
  assert.equal(cli.code, 0);
  assert.match(cli.err, /warn/);

  // 同一张卡：把截止推到它之前（env 开关）⇒ 转硬
  cli = runCli([], { OPENCLAW_TEAM_REPORT_EFFECTIVE_AT: '2025-01-01T00:00:00Z' });
  assert.equal(cli.code, 1, '前移生效截止 ⇒ 同一张卡转硬红（豁免开关 ① 可验证）');
  assert.equal(JSON.parse(cli.out).violations.length, 1);
  assert.equal(effectiveAt(), '2026-10-14T17:10:00Z', 'env 只在该进程生效，不影响默认常量');
  // 非法 env ⇒ 回退常量，绝不静默变严
  const bad = runCli([], { OPENCLAW_TEAM_REPORT_EFFECTIVE_AT: 'not-a-date' });
  assert.equal(bad.code, 0, '非法截止值 ⇒ 回退默认（保守），不得变严');
});

test('④ created_at 缺失/不可解析 ⇒ 按 grandfather 处理（绝不因缺字段转红）', { skip: SKIP }, () => {
  const raw = cardText({ id: 'T-20261015-000010-d', report: '' }).replace(/created_at: ".*"\n/, '');
  fs.writeFileSync(path.join(TASKS, 'T-20261015-000010-d.md'), raw, 'utf8');
  const r = scan();
  assert.equal(r.ok, true);
  assert.deepEqual(r.grandfathered.map((g) => g.id), ['T-20261015-000010-d']);
});

// ---------- ⑤ 豁免机制 ----------

const registerRuntime = (cards) => fs.writeFileSync(
  runtimeBaselinePath(TASKS), `${JSON.stringify({ cards }, null, 2)}\n`, 'utf8');

test('⑤ 豁免：① 托管模板必须为空（仓内不得夹带豁免）；运行时登记在 tasks 目录内、不在部署树', { skip: SKIP }, () => {
  assert.deepEqual(loadBaseline(BASELINE_PATH), [], '仓内托管模板必须保持 cards 空（只读）');
  assert.equal(RUNTIME_BASELINE_NAME, '.report-baseline.json');
  assert.equal(runtimeBaselinePath(TASKS), path.join(TASKS, '.report-baseline.json'));
  assert.ok(
    !path.resolve(runtimeBaselinePath(TASKS)).startsWith(`${path.resolve(path.dirname(BASELINE_PATH))}${path.sep}`),
    '运行时登记不得落在部署托管目录（本文件所在 scripts/）内'
  );
});

test('⑤ 豁免：运行时登记命中 ⇒ exempt、退出 0；缺口集合一变 ⇒ 豁免失效、仍红', { skip: SKIP }, () => {
  writeCard({ id: 'T-20261015-000011-e', report: goodReport((s) => s.remove('A5')) });
  registerRuntime([{ id: 'T-20261015-000011-e', gaps: ['A5'], reason: '登记测试' }]);

  const r = scan();
  assert.equal(r.violations.length, 0, '命中登记 ⇒ 不判红');
  assert.deepEqual(r.exempt.map((e) => [e.id, e.reason]), [['T-20261015-000011-e', '登记测试']]);
  const cli = runCli();
  assert.equal(cli.code, 0);
  assert.match(cli.err, /基线豁免/);

  // 集合变化：卡面又坏掉一个槽位（A5 已缺 + A6 也空）⇒ 登记失效、回到硬红（防「登记一次、永久放行」）
  writeCard({ id: 'T-20261015-000011-e', report: goodReport((s) => { s.remove('A5'); s.blank('A6'); }) });
  const drift = scan();
  assert.equal(drift.exempt.length, 0);
  assert.deepEqual(drift.violations.map((v) => v.gaps), [['A5', 'A6']]);
  assert.equal(runCli().code, 1);

  // 补齐到只剩 A5 缺失 ⇒ 集合回到登记值 ⇒ 豁免重新生效（登记按**当前**集合判定，不是「曾经」）
  writeCard({ id: 'T-20261015-000011-e', report: goodReport((s) => s.remove('A5')) });
  assert.equal(scan().exempt.length, 1);
  assert.equal(runCli().code, 0);
  fs.rmSync(runtimeBaselinePath(TASKS), { force: true });
});

test('⑤ 豁免只作用于硬触发档：grandfather warn / draft 不受登记影响，也不消耗登记', { skip: SKIP }, () => {
  writeCard({ id: 'T-20261015-000012-e', status: 'in_review', created_at: ANCIENT, report: '' });
  writeCard({ id: 'T-20261015-000013-e', status: 'blocked', report: goodReport((s) => s.remove('A2')) });
  registerRuntime([{ id: 'T-20261015-000012-e', gaps: ['REPORT_EMPTY'], reason: '不该被消耗' }]);
  const r = scan();
  assert.equal(r.exempt.length, 0, '非硬档不消费登记');
  assert.deepEqual(r.grandfathered.map((g) => g.id), ['T-20261015-000012-e']);
  assert.deepEqual(r.drafts.map((d) => d.id), ['T-20261015-000013-e']);
  assert.equal(r.ok, true);
  fs.rmSync(runtimeBaselinePath(TASKS), { force: true });
});

test('⑤/⑥ 两源合取 + `--no-baseline` 忽略两源（核查真违规）', { skip: SKIP }, () => {
  writeCard({ id: 'T-20261015-000014-f', report: goodReport((s) => s.remove('A7')) });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-report-src-'));
  TMP.push(dir);
  const tpl = path.join(dir, 'template.json');
  const rt = path.join(dir, 'runtime.json');
  fs.writeFileSync(tpl, JSON.stringify({ cards: [{ id: 'T-20261015-000014-f', gaps: ['A7'], reason: '模板' }] }), 'utf8');
  assert.equal(loadExemptions(TASKS, { template: tpl, runtime: rt }).length, 1, '仅模板有登记');
  fs.writeFileSync(rt, JSON.stringify({ cards: [{ id: 'x', gaps: [], reason: '运行时' }] }), 'utf8');
  const both = loadExemptions(TASKS, { template: tpl, runtime: rt });
  assert.equal(both.length, 2, '两源合取（模板 ∪ 运行时）');
  assert.deepEqual(both.map((g) => g.reason), ['模板', '运行时']);
  assert.deepEqual(loadExemptions(TASKS, { template: path.join(dir, 'nope.json'), runtime: path.join(dir, 'nope2.json') }), [], '缺失/损坏 ⇒ 视为空，不报错');

  // 注入模板（模块参数）⇒ 豁免；运行时登记（真实文件，②）⇒ CLI 也豁免
  assert.equal(scanReports(TASKS, { baseline: [{ id: 'T-20261015-000014-f', gaps: ['A7'], reason: '注入' }] }).violations.length, 0);
  registerRuntime([{ id: 'T-20261015-000014-f', gaps: ['A7'], reason: '运行时登记' }]);
  assert.equal(runCli().code, 0, '运行时登记生效 ⇒ 退出 0');
  // --no-baseline ⇒ 忽略①②两源 ⇒ 露出真违规
  assert.equal(runCli(['--no-baseline']).code, 1, '--no-baseline 忽略两源 ⇒ 露出真违规');
  assert.equal(runCli(['--no-baseline']).out.includes('"exempt": []'), true, '--no-baseline 下 exempt 必须为空');
  fs.rmSync(runtimeBaselinePath(TASKS), { force: true });
});

// ---------- ⑥ 内容提示（非阻断） ----------

test('⑥ 内容提示：A2 缺卡路径/hash、A5 缺退出码 ⇒ hint；齐备 ⇒ 无 hint；均不置退出码', { skip: SKIP }, () => {
  assert.deepEqual(contentHints(goodReport()), [], '合规 Report 不应产生任何提示');

  const noPath = goodReport((s) => s.set('A2', '- **A2 Delivery coordinates** — branch lane/x, pushed: no.'));
  const h2 = contentHints(noPath);
  assert.ok(h2.length >= 1 && h2.every((h) => h.slot === 'A2'), `A2 缺卡路径/hash 应产出 A2 提示：${JSON.stringify(h2)}`);
  assert.ok(h2.some((h) => /卡路径/.test(h.hint)), '应点名缺卡路径');

  const noExit = goodReport((s) => s.set('A5', '- **A5 Re-run evidence** — cmd: node --test tests/x.test.mjs · artifact: out.txt'));
  assert.deepEqual(contentHints(noExit).map((h) => h.slot), ['A5'], 'A5 缺退出码应生成单条 A5 提示');

  writeCard({ id: 'T-20261015-000015-g', report: noPath });
  const r = scan();
  assert.equal(r.ok, true, 'hint 永不阻断');
  assert.ok(r.hints.length >= 1 && r.hints.every((h) => h.slot === 'A2'), JSON.stringify(r.hints));
  const cli = runCli();
  assert.equal(cli.code, 0);
  assert.match(cli.err, /内容提示/);
  // 中文等价写法同样被识别为「有退出码」
  assert.deepEqual(contentHints(goodReport((s) => s.set('A5', '- **A5 复跑证据** — 命令: node x · 退出码 0'))), []);
});

// ---------- CLI 单卡模式 ----------

test('CLI 单卡模式：只报该卡，退出码只由该卡决定', { skip: SKIP }, () => {
  writeCard({ id: 'T-20261015-000016-h', report: '' });
  writeCard({ id: 'T-20261015-000017-h', report: goodReport() });
  const bad = runCli(['T-20261015-000016-h']);
  assert.equal(bad.code, 1);
  assert.deepEqual(JSON.parse(bad.out).violations.map((v) => v.id), ['T-20261015-000016-h']);
  const good = runCli(['T-20261015-000017-h']);
  assert.equal(good.code, 0);
  assert.match(good.err, /校验通过/);
});
