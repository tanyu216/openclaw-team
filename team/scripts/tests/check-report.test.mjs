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
 *   ⑥ `--no-baseline` 忽略两源；内容提示（A2 卡路径/hash、A5 退出码）**永远非阻断**；
 *   ⑦ **guide ↔ gate 契约**：guide §3 骨架逐字过判定 ⇒ 0 缺口 / 0 来源缺口 / 0 提示；
 *   ⑧+ **增补轮 Δ1/Δ2/Δ4**（Elon 2026-10-14T18:05:24Z kind=change）：
 *      Δ1 —— A4 状态词表 `met|partial|not_met`：未达成项而 A6 写「无残留」⇒ 提示（非阻断）；
 *      Δ2 —— 报告作者来源 `delivery`（默认）vs `import`（迁移/代收口）：import 须标注 author+source，
 *            且**一律不得当交付证据开门**（`in_review` ⇒ 判红）；含**判定变异自证**与登记豁免口径；
 *      Δ4 —— 轮次语义 warn-only：被退回后重新交付而 Report 未声明本轮时间/轮次 ⇒ 提示（非阻断）。
 *      两条新提示**只对生效截止之后的卡**生效（历史卡不制造噪声）。
 *   ⑨+ **v1.1 判定精度与词汇收口 D1–D5**（卡 T-20261015-025543，源缺陷票 T-20261015-010749-3 §T6）：
 *      D1 —— A4 词表扩为基座同款 4 值 `met|partial|not_met|not_applicable`，且 `not_applicable`
 *            **不**参与 A4→A6 耦合（`UNMET_STATUSES` 只含前两者）；
 *      D2 —— Δ1 耦合由**词级**改**行级**：A6 声明无残留 **且** 该未达成行未在 A6 交代才提示
 *            （正例 ≥2 / 反例 ≥2，含本腿 Report 的真实假报回归；含判定变异自证）；
 *      D3 —— A2 commit 判据收紧为「7–40 位小写 hex 或显式声明无提交」，大写 sha-1 真值不拒；
 *      D4 —— guide §6 边界语义（≤64 项/列表 · ≤64 KiB · `truncated`），门禁**不**校验（含理由）；
 *      D5 —— 豁免登记 `reason` **必填**且去空白后 ≥8 字符，缺失/过短 ⇒ 不放行并点名
 *            （含判定变异自证）。
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
const SCRIPTS = path.join(HERE, '..');

/**
 * 为「源级变异」副本备好同级依赖：把 `scripts/` 下除 `except` 外的所有 `*.mjs` 以**符号链接**
 * 引回真实目录（Node 默认按 realpath 解析 ⇒ 被链模块自身的相对 import 仍落在真实 `scripts/` 内，
 * 不必拷一整棵兄弟树）。`except` = 正在被变异的那份 ⇒ 绝不把真实模块写成变异体。
 *
 * 原先只硬编码链 `lib.mjs` 一个 ⇒ 模块每新增一个同级 import（如 `status.mjs`），变异用例就会
 * 因临时目录解不出该依赖而**莫名其妙地红**；改为全量链接后不再有此耦合。
 */
function linkSiblings(dir, except) {
  for (const f of fs.readdirSync(SCRIPTS)) {
    if (f.endsWith('.mjs') && f !== except) fs.symlinkSync(path.join(SCRIPTS, f), path.join(dir, f));
  }
}

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
  loadBaseline, loadExemptions, validExemption, MIN_EXEMPTION_REASON,
  reportOrigin, originGaps, roundHint, deliveryHints, couplingHint, a4UnmetRows, a6ClaimsNone,
  commitCoordinate, ACCEPTANCE_STATUSES, UNMET_STATUSES,
  ORIGIN_DELIVERY, ORIGIN_IMPORT, ORIGIN_UNKNOWN,
  GAP_ORIGIN_UNKNOWN, GAP_IMPORT_NO_PROVENANCE, GAP_IMPORT_NOT_DELIVERY;
if (PROVIDER) {
  process.env.OPENCLAW_TASK_OPS_DIR = PROVIDER;
  ({
    scanReports, slotGaps, slotRegex, reportBody, contentHints, REQUIRED_SLOTS,
    EFFECTIVE_AT, effectiveAt, BASELINE_PATH, RUNTIME_BASELINE_NAME, runtimeBaselinePath,
    loadBaseline, loadExemptions, validExemption, MIN_EXEMPTION_REASON,
    reportOrigin, originGaps, roundHint, deliveryHints, couplingHint, a4UnmetRows, a6ClaimsNone,
    commitCoordinate, ACCEPTANCE_STATUSES, UNMET_STATUSES,
    ORIGIN_DELIVERY, ORIGIN_IMPORT, ORIGIN_UNKNOWN,
    GAP_ORIGIN_UNKNOWN, GAP_IMPORT_NO_PROVENANCE, GAP_IMPORT_NOT_DELIVERY,
  } = await import('../check-report.mjs'));
}

after(() => { for (const r of TMP) fs.rmSync(r, { recursive: true, force: true }); });
beforeEach(() => {
  for (const f of fs.readdirSync(TASKS)) fs.rmSync(path.join(TASKS, f), { recursive: true, force: true });
});

// ---------- fixtures ----------

/** 合规 Report 正文（8 槽位齐备 + A0 delivery + A2 带卡路径/hash + A5 带退出码）。
 *  slot 省略 ⇒ 整行删掉（变异）；`report` 可整体替换（Δ2/Δ4 用）。 */
function goodReport(mutate = () => {}) {
  const lines = {
    A0: '- **A0 Report origin** — delivery.',
    A1: '- **A1 Conclusion** — acceptable; all Acceptance items met, gate exit 0.',
    A2: '- **A2 Delivery coordinates** — card: tasks/T-20261015-010749-2.md · commit: a1b2c3d4e5 · branch: lane/x (base 1c54cec) · pushed: no.',
    A3: '- **A3 Change surface** — 6 files; no implementation change; no out-of-bounds edits.',
    A4: '- **A4 Acceptance item-by-item**\n  | # | item | status | evidence |\n  |---|---|---|---|\n  | ① | guide | met | guides/worker-report-template.md |',
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

/** 把合规 Report 的第一行换成给定的 A0 声明（Δ2 用）。 */
const withOrigin = (a0) => [a0, ...goodReport().split('\n').slice(1)].join('\n');

const CUTOVER = '2026-10-15T00:00:00.000Z';   // 晚于 EFFECTIVE_AT ⇒ 硬触发
const ANCIENT = '2026-01-01T00:00:00.000Z';   // 早于 EFFECTIVE_AT ⇒ grandfather
/** 退回后重新交付的卡头（Δ4：blocked_at 有值 且 status_changed_at 晚于它）。 */
const SENT_BACK = { blocked_at: '2026-10-14T18:05:24.600Z', status_changed_at: '2026-10-15T01:30:00.000Z' };

function cardText({
  id, status = 'in_review', report = goodReport(), created_at = CUTOVER,
  title = 't', alreadyHasReportSection = true, blocked_at = '', status_changed_at = '',
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
  return `---\nid: ${id}\ntitle: ${title}\nassignee: linus\nstatus: ${status}\n`
    + `created_at: "${created_at}"\nblocked_at: "${blocked_at}"\nstatus_changed_at: "${status_changed_at}"\n`
    + `project: __team__\ntarget: /x\n---\n${body}`;
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
  linkSiblings(dir, 'check-report.mjs');
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
  registerRuntime([{ id: 'T-20261015-000011-e', gaps: ['A5'], reason: '登记测试用（人工核对过）' }]);

  const r = scan();
  assert.equal(r.violations.length, 0, '命中登记 ⇒ 不判红');
  assert.deepEqual(r.exempt.map((e) => [e.id, e.reason]), [['T-20261015-000011-e', '登记测试用（人工核对过）']]);
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
  registerRuntime([{ id: 'T-20261015-000012-e', gaps: ['REPORT_EMPTY'], reason: '不该被消耗（非硬档）' }]);
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
  fs.writeFileSync(tpl, JSON.stringify({ cards: [{ id: 'T-20261015-000014-f', gaps: ['A7'], reason: '模板登记理由（够长）' }] }), 'utf8');
  assert.equal(loadExemptions(TASKS, { template: tpl, runtime: rt }).length, 1, '仅模板有登记');
  fs.writeFileSync(rt, JSON.stringify({ cards: [{ id: 'x', gaps: [], reason: '运行时登记理由（够长）' }] }), 'utf8');
  const both = loadExemptions(TASKS, { template: tpl, runtime: rt });
  assert.equal(both.length, 2, '两源合取（模板 ∪ 运行时）');
  assert.deepEqual(both.map((g) => g.reason), ['模板登记理由（够长）', '运行时登记理由（够长）']);
  assert.deepEqual(loadExemptions(TASKS, { template: path.join(dir, 'nope.json'), runtime: path.join(dir, 'nope2.json') }), [], '缺失/损坏 ⇒ 视为空，不报错');

  // 注入模板（模块参数）⇒ 豁免；运行时登记（真实文件，②）⇒ CLI 也豁免
  assert.equal(scanReports(TASKS, { baseline: [{ id: 'T-20261015-000014-f', gaps: ['A7'], reason: '注入的登记理由（够长）' }] }).violations.length, 0);
  registerRuntime([{ id: 'T-20261015-000014-f', gaps: ['A7'], reason: '运行时登记的理由（够长）' }]);
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
  // 表格形态的 A5（列头含 `exit`、单元格为数字）不得误报——判据取宽（hint 是非阻断信号，宁可漏报）
  const tbl = goodReport((s) => s.set('A5', '- **A5 Re-run evidence**\n  | what | command | exit | artifact |\n  |---|---|---|---|\n  | unit | node --test x | 0 | out.txt |'));
  assert.deepEqual(contentHints(tbl), [], '表格形态 A5 不得误报');

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

// ---------- ⑦ guide ↔ gate 契约（Δ3：§3 骨架「填进去即合法报告」） ----------

const GUIDE = path.join(HERE, '..', '..', 'guides', 'worker-report-template.md');

/** 抽 guide §3 的 ```markdown 骨架（与 workspace/verify-guide-example.mjs 同取法）。 */
function guideSkeleton() {
  const md = fs.readFileSync(GUIDE, 'utf8');
  const start = md.indexOf('## 3. ');
  assert.ok(start >= 0, 'guide §3 必须存在');
  const fenceStart = md.indexOf('```markdown', start);
  const fenceEnd = md.indexOf('```', fenceStart + '```markdown'.length);
  assert.ok(fenceStart >= 0 && fenceEnd > fenceStart, 'guide §3 必须含 ```markdown 骨架');
  return md.slice(fenceStart + '```markdown'.length, fenceEnd);
}

test('⑦ guide↔gate：§3 骨架逐字过判定 ⇒ 0 缺口 / 0 来源缺口 / 0 提示（骨架即合法报告）', { skip: SKIP }, () => {
  const block = guideSkeleton();
  assert.deepEqual(slotGaps(block), [], 'guide 自己的骨架不得被判缺槽位');
  const origin = reportOrigin(block);
  assert.equal(origin.origin, ORIGIN_DELIVERY, '骨架声明的来源应为 delivery');
  assert.equal(origin.declared, true, '骨架应显式写出 A0（示范用法）');
  assert.deepEqual(originGaps(origin), []);
  assert.deepEqual(contentHints(block), [], '合规骨架不得产生 A2/A5 提示');
  // 未声明被退回 ⇒ 不应触发轮次提示；A4 有 partial 但 A6 已交代 ⇒ 不应触发耦合提示
  assert.deepEqual(deliveryHints(block, { status: 'in_review', blocked_at: '', status_changed_at: '' }), [],
    'guide 骨架必须是零提示的范例（否则标准本身在制造假信号）');
});

test('⑦ guide 文本钉住 Δ1/Δ2 口径与状态词表（标准与机检不能各说各话）', { skip: SKIP }, () => {
  const md = fs.readFileSync(GUIDE, 'utf8');
  assert.match(md, /met \| partial \| not_met/, 'guide 必须写死 A4 状态词表');
  assert.match(md, /A0 Report origin/, 'guide 必须给出 A0 槽位的可复制写法');
  assert.match(md, /import; author:/, 'guide 必须示范代收口的 author/source 标注');
  assert.match(md, /never invented/i, 'guide 必须写明「证据绝不臆造」');
  assert.match(md, /not_met/, 'guide 骨架默认值须可用 not_met');
});

// ---------- Δ1：A4 状态词表 + A4→A6 耦合（提示，非阻断） ----------

test('Δ1 耦合：A4 有 partial/not_met 而 A6 写「无残留」⇒ 提示；A6 有交代 ⇒ 无提示；均不阻断', { skip: SKIP }, () => {
  const partial = goodReport((s) => s.set('A4',
    '- **A4 Acceptance item-by-item**\n  | # | item | status | evidence |\n  |---|---|---|---|\n'
    + '  | ① | guide | partial | guides/x.md → A6 |'));
  const consistent = goodReport((s) => {
    s.set('A4', partial.split('\n').slice(0, 5).join('\n'));
    s.set('A6', '- **A6 Residuals** — ① guide is `partial` (no example yet) → owner: integration leg.');
  });
  // A4=partial 且 A6=none ⇒ 矛盾 ⇒ 提示（点名 A6）
  assert.deepEqual(deliveryHints(partial, { status: 'in_review' }).map((h) => h.slot), ['A6']);
  // A6 交代了 ⇒ 无提示
  assert.deepEqual(deliveryHints(consistent, { status: 'in_review' }), []);
  // 全 met ⇒ 无提示（goodReport 的 A6 正是「none outstanding」）
  assert.deepEqual(deliveryHints(goodReport(), { status: 'in_review' }), []);

  writeCard({ id: 'T-20261015-000018-i', report: partial });
  const r = scan();
  assert.equal(r.ok, true, 'Δ1 只是提示，绝不阻断');
  assert.equal(r.hints.filter((h) => h.slot === 'A6').length, 1);
  assert.equal(runCli().code, 0);
  assert.match(runCli().err, /A4 有未达成项/);
});

test('Δ1 提示只对生效截止之后的卡生效（历史卡不制造噪声）', { skip: SKIP }, () => {
  const partial = goodReport((s) => s.set('A4',
    '- **A4 Acceptance item-by-item**\n  | # | item | status | evidence |\n  |---|---|---|---|\n'
    + '  | ① | guide | not_met | none yet → A6 |'));
  writeCard({ id: 'T-20261015-000019-i', created_at: ANCIENT, report: partial });
  const r = scan();
  assert.equal(r.ok, true);
  assert.equal(r.hints.length, 0, 'grandfather 档不得被新口径回溯提示');
});

// ---------- Δ2：报告作者来源（delivery vs import/代收口） ----------

test('Δ2 来源解析：无 A0 ⇒ delivery；显式 delivery ⇒ delivery；import ⇒ 须交代 author+source', { skip: SKIP }, () => {
  // 无 A0 ⇒ 默认 delivery（正常情形：交付者本人写自己的 Report）
  assert.deepEqual(reportOrigin(goodReport((s) => s.remove('A0'))), { origin: ORIGIN_DELIVERY, declared: false, author: '', source: '' });
  // 显式 delivery（含中文等价写法）
  assert.equal(reportOrigin(goodReport()).origin, ORIGIN_DELIVERY);
  assert.equal(reportOrigin(withOrigin('- **A0 报告来源** — 交付者本人自写。')).origin, ORIGIN_DELIVERY);
  // import：交代齐 ⇒ 只剩「非交付证据」一条
  const full = reportOrigin(withOrigin('- **A0 Report origin** — import; author: elon; source: workspace/T-1/handoff.md'));
  assert.deepEqual(full, { origin: ORIGIN_IMPORT, declared: true, author: 'elon', source: 'workspace/T-1/handoff.md' });
  assert.deepEqual(originGaps(full), [GAP_IMPORT_NOT_DELIVERY]);
  // 中文写法同样识别
  const cn = reportOrigin(withOrigin('- **A0 报告来源** — 代收口补写；作者：elon；来源：workspace/T-1/handoff.md'));
  assert.equal(cn.origin, ORIGIN_IMPORT);
  assert.equal(cn.author, 'elon');
  assert.equal(cn.source, 'workspace/T-1/handoff.md');
  // import 缺 author/source ⇒ 两条缺口（交代 + 不开门）
  const bare = reportOrigin(withOrigin('- **A0 Report origin** — import; the owning session died.'));
  assert.equal(bare.author, '');
  assert.deepEqual(originGaps(bare), [GAP_IMPORT_NO_PROVENANCE, GAP_IMPORT_NOT_DELIVERY]);
  // 自报来源不可识别 ⇒ fail-closed（不得当交付证据开门）
  const odd = reportOrigin(withOrigin('- **A0 Report origin** — collected by whoever was around.'));
  assert.equal(odd.origin, ORIGIN_UNKNOWN);
  assert.deepEqual(originGaps(odd), [GAP_ORIGIN_UNKNOWN]);
  // delivery 槽位不是必需项：缺 A0 不进槽位缺口
  assert.deepEqual(slotGaps(goodReport((s) => s.remove('A0'))), []);
});

test('Δ2 硬判定：槽位齐备但来源=import ⇒ 仍判红、退出 1（代收口报告不得当交付证据开门）', { skip: SKIP }, () => {
  const imported = withOrigin('- **A0 Report origin** — import; author: elon; source: workspace/T-1/handoff.md');
  assert.deepEqual(slotGaps(imported), [], '前提：槽位本身齐备（这正是「看起来完整」的代收口报告）');
  writeCard({ id: 'T-20261015-000020-j', report: imported });

  const r = scan();
  assert.equal(r.ok, false, '代收口报告不得开门');
  assert.deepEqual(r.violations.map((v) => [v.id, v.gaps]), [['T-20261015-000020-j', [GAP_IMPORT_NOT_DELIVERY]]]);
  assert.equal(r.violations[0].origin, ORIGIN_IMPORT);
  const cli = runCli();
  assert.equal(cli.code, 1);
  assert.match(cli.err, /代收口/);
  assert.match(cli.err, /origin=import/);

  // 交付者本人补写 ⇒ 恢复绿（同一张卡、唯一变量是 A0 那一行）
  writeCard({ id: 'T-20261015-000020-j', report: goodReport() });
  assert.equal(scan().ok, true);
  assert.equal(runCli().code, 0);

  // 缺 author/source ⇒ 两条缺口（登记集合必须全等，不能只登记一条蒙混）
  for (const f of fs.readdirSync(TASKS)) fs.rmSync(path.join(TASKS, f));
  writeCard({ id: 'T-20261015-000021-j', report: withOrigin('- **A0 Report origin** — import; no provenance recorded.') });
  assert.deepEqual(scan().violations.map((v) => v.gaps), [[GAP_IMPORT_NO_PROVENANCE, GAP_IMPORT_NOT_DELIVERY]]);

  // 来源自称不可识别 ⇒ 同样判红（fail-closed）
  for (const f of fs.readdirSync(TASKS)) fs.rmSync(path.join(TASKS, f));
  writeCard({ id: 'T-20261015-000022-j', report: withOrigin('- **A0 Report origin** — someone collected it, unclear who.') });
  assert.deepEqual(scan().violations.map((v) => v.gaps), [[GAP_ORIGIN_UNKNOWN]]);
});

test('Δ2 判定变异：摘掉来源判定后「import 报告」不再被测出 ⇒ 证明上一条有杀伤力', { skip: SKIP }, async () => {
  const src = fs.readFileSync(CHECK_REPORT, 'utf8');
  const patched = src.replace('const hardGaps = [...gaps, ...originGaps(origin)];', 'const hardGaps = [...gaps];');
  assert.notEqual(patched, src, '变异必须真的改到判定（来源缺口不再并入硬缺口集），否则本测试无意义');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-report-mut2-'));
  TMP.push(dir);
  linkSiblings(dir, 'check-report.mjs');
  fs.writeFileSync(path.join(dir, 'check-report.mjs'), patched, 'utf8');
  const mut = await import(pathToFileURL(path.join(dir, 'check-report.mjs')).href);

  const imported = withOrigin('- **A0 Report origin** — import; author: elon; source: workspace/T-1/handoff.md');
  writeCard({ id: 'T-20261015-000023-k', report: imported });
  assert.equal(mut.scanReports(TASKS, { baseline: [] }).violations.length, 0, '判定被摘掉 ⇒ import 报告不再判红（= 变异存活）');
  assert.equal(scanReports(TASKS, { baseline: [] }).violations.length, 1, '真实判定必须测出该缺口');
});

test('Δ2 与既有机制的边界：grandfather 优先 / 软档不消费 / 登记可豁免（人工核对后）', { skip: SKIP }, () => {
  const imported = withOrigin('- **A0 Report origin** — import; author: elon; source: workspace/T-1/handoff.md');
  // ① 截止前的卡：来源规则也不追溯转红
  writeCard({ id: 'T-20261015-000024-k', created_at: ANCIENT, report: imported });
  let r = scan();
  assert.equal(r.ok, true, 'grandfather 优先于来源判定（历史卡不翻旧账）');
  assert.deepEqual(r.grandfathered.map((g) => [g.id, g.gaps]), [['T-20261015-000024-k', [GAP_IMPORT_NOT_DELIVERY]]]);
  assert.equal(runCli().code, 0);

  // ② 软触发档（in_progress）：来源判定只作用于 in_review
  for (const f of fs.readdirSync(TASKS)) fs.rmSync(path.join(TASKS, f));
  writeCard({ id: 'T-20261015-000025-k', status: 'in_progress', report: imported });
  r = scan();
  assert.equal(r.violations.length, 0, '草稿态不因来源判红');
  assert.equal(r.ok, true);

  // ③ 人工核对后的登记（迁移期一次性补写）⇒ 豁免；缺口集合一变即失效
  for (const f of fs.readdirSync(TASKS)) fs.rmSync(path.join(TASKS, f));
  writeCard({ id: 'T-20261015-000026-k', report: imported });
  registerRuntime([{ id: 'T-20261015-000026-k', gaps: [GAP_IMPORT_NOT_DELIVERY], reason: '迁移期一次性补写' }]);
  r = scan();
  assert.deepEqual(r.exempt.map((e) => [e.id, e.reason]), [['T-20261015-000026-k', '迁移期一次性补写']]);
  assert.equal(runCli().code, 0);
  assert.equal(runCli(['--no-baseline']).code, 1, '--no-baseline 下露出真违规（登记不掩盖）');
  fs.rmSync(runtimeBaselinePath(TASKS), { force: true });
});

// ---------- Δ4：轮次语义（warn-only，防复用旧轮报告） ----------

test('Δ4 轮次：被退回后重新交付且 Report 未声明本轮时间 ⇒ 提示（不阻断）；声明了 ⇒ 无提示', { skip: SKIP }, () => {
  writeCard({ id: 'T-20261015-000027-l', ...SENT_BACK });
  let r = scan();
  assert.equal(r.ok, true, '轮次提示绝不阻断');
  assert.deepEqual(r.hints.map((h) => h.slot), ['A2']);
  assert.match(r.hints[0].hint, /复用旧轮报告/);
  assert.equal(runCli().code, 0);
  assert.match(runCli().err, /复用旧轮报告/);

  // A2 声明了本轮交付时间/轮次 ⇒ 无提示
  writeCard({ id: 'T-20261015-000027-l', ...SENT_BACK, report: goodReport((s) => s.set('A2',
    '- **A2 Delivery coordinates** — card: tasks/T-20261015-010749-2.md · commit: a1b2c3d4e5 · branch: lane/x · pushed: no · round 2 delivered 2026-10-15.') )});
  assert.deepEqual(scan().hints, []);

  // 未被退回的卡（无 blocked_at）⇒ 无提示（零噪声）
  writeCard({ id: 'T-20261015-000028-l', status_changed_at: SENT_BACK.status_changed_at });
  assert.deepEqual(scan().hints, []);

  // 非 in_review ⇒ 不判（轮次只对交付待验收态有意义）
  writeCard({ id: 'T-20261015-000029-l', status: 'in_progress', ...SENT_BACK });
  assert.deepEqual(scan().hints, []);

  // 截止前的被退回卡 ⇒ 不提示（历史卡不制造噪声）
  writeCard({ id: 'T-20261015-000030-l', created_at: ANCIENT, ...SENT_BACK });
  assert.deepEqual(scan().hints, []);
});

test('Δ4 直连判定：roundHint 只在「in_review + 被退回 + 无时间/轮次声明」时出提示', { skip: SKIP }, () => {
  const body = goodReport();
  assert.ok(roundHint({ status: 'in_review', ...SENT_BACK }, body));
  assert.equal(roundHint({ status: 'in_review', blocked_at: '', status_changed_at: SENT_BACK.status_changed_at }, body), null, '无 blocked_at ⇒ 不是退回后重交付');
  assert.equal(roundHint({ status: 'in_progress', ...SENT_BACK }, body), null);
  assert.equal(roundHint({ status: 'in_review', ...SENT_BACK }, `${body}\n- delivered 2026-10-15T01:30Z`), null, '有日期 ⇒ 不提示');
  assert.equal(roundHint({ status: 'in_review', ...SENT_BACK }, `${body}\n- round 3`), null, '有轮次 ⇒ 不提示');
});

// ---------- D1–D5（v1.1 判定精度与词汇收口，卡 T-20261015-025543） ----------

/** 单行 A4 表（`A4` 槽位正文）：状态词钉在**独立单元格**里——这正是判定所要求的形态。 */
const A4_ROW = (n, status, name = 'an acceptance item with no owner yet') =>
  '- **A4 Acceptance item-by-item**\n  | # | item | status | evidence |\n  |---|---|---|---|\n'
  + `  | ${n} | ${name} | ${status} | workspace/<id>/evidence.txt |`;
const A6_NONE_TEXT = '- **A6 Residuals** — none outstanding.';

test('D1 词表：ACCEPTANCE_STATUSES = 基座同款 4 值；UNMET_STATUSES 只含 partial/not_met', { skip: SKIP }, () => {
  assert.deepEqual(ACCEPTANCE_STATUSES, ['met', 'partial', 'not_met', 'not_applicable']);
  assert.deepEqual(UNMET_STATUSES, ['partial', 'not_met']);
  assert.equal(ACCEPTANCE_STATUSES.includes('not_applicable'), true, 'not_applicable 是**合法**状态，不属「其它词」');
  assert.equal(UNMET_STATUSES.includes('not_applicable'), false, 'not_applicable 不是未达成项（对齐基座 leftovers 规则）');
  const md = fs.readFileSync(GUIDE, 'utf8');
  assert.match(md, /met \| partial \| not_met \| not_applicable/, 'guide 词表必须与基座逐值对齐');
});

test('D1 判定：`not_applicable` 行 + A6「无残留」⇒ 0 提示 / exit 0（口径不再未声明）', { skip: SKIP }, () => {
  // 直连判据：同形状换 partial 必须提示，换 not_applicable 必须不提示
  assert.equal(couplingHint(A4_ROW('②', 'not_applicable'), A6_NONE_TEXT), null,
    'not_applicable 不是未达成项 ⇒ 即便 A6 声明无残留也不得提示');
  assert.equal(couplingHint(A4_ROW('②', 'partial'), A6_NONE_TEXT).slot, 'A6',
    '同一形状的 partial 必须仍提示 —— 否则上一条可能只是判定整个失灵');
  // 卡面整链：not_applicable + A6 none ⇒ 0 缺口 / 0 提示 / 退出 0（D1 实测形态）
  writeCard({ id: 'T-20261015-000031-m', report: goodReport((s) => s.set('A4', A4_ROW('②', 'not_applicable'))) });
  const r = scan();
  assert.equal(r.ok, true);
  assert.deepEqual(r.violations, []);
  assert.deepEqual(r.hints, []);
  assert.equal(runCli().code, 0);
});

test('D2 正例（≥2，必须提示，不误漏）：A6 声明无残留且未交代该未达成项', { skip: SKIP }, () => {
  const cases = [
    ['partial', '- **A6 Residuals** — none outstanding.'],
    ['not_met', '- **A6 Residuals** — 无。'],                                  // 中文「无」——旧词表**漏报**
    ['partial', '- **A6 Residuals** — n/a'],                                  // 基座 token
    ['partial', '- **A6 Residuals** — nothing outstanding at this time.'],
    ['not_met', '- **A6 Residuals** — 无未决项。'],
  ];
  for (const [status, a6] of cases) {
    const h = couplingHint(A4_ROW('③', status), a6);
    assert.ok(h && h.slot === 'A6', `${status} + ${JSON.stringify(a6)} 必须提示（真实静默丢弃不得漏报）`);
  }
  // 卡面整链：提示非阻断
  writeCard({ id: 'T-20261015-000034-o', report: goodReport((s) => s.set('A4', A4_ROW('③', 'partial'))) });
  const r = scan();
  assert.equal(r.ok, true, 'Δ1 只是提示，绝不阻断');
  assert.deepEqual(r.hints.filter((h) => h.slot === 'A6').length, 1);
  assert.equal(runCli().code, 0);
});

test('D2 反例（≥2，不得提示，不误报）：A6 已交代该项 / 用限定语 / 图例非行', { skip: SKIP }, () => {
  const table = A4_ROW('③', 'partial', 'A/B before-after table');
  // 反例 1 = **本腿真实误报用例的回归**（T-20261015-010749-3 §T6 D2）：A6 写了 `none critical`
  // 但该 partial 行**已在 A6 逐项交代** ⇒ 旧口径（词级 `\bnone\b`）误报，新口径必须不报。
  const regression = '- **A6 Residuals** — ③ the A/B before-after table carries no pre-fix reading'
    + ' — none critical, deferring to round 2 → owner: integration leg.';
  assert.equal(couplingHint(table, regression), null, 'A6 已交代该行 ⇒ 不得因里面有 `none critical` 就误报');
  // 反例 2：A6 逐项交代、无任何「无残留」措辞
  assert.equal(couplingHint(table, '- **A6 Residuals** — ③ A/B table pending → owner: integration leg.'), null);
  // 反例 3：限定语本身**不是**「无残留」声明（`none critical` = 有残留、只是不严重）
  assert.equal(couplingHint(table, '- **A6 Residuals** — none critical; see the round-2 note → owner: Elon.'), null,
    '`none critical` 是限定语，不是「A6 说没有」⇒ 不构成 guide 写明的矛盾');
  // 反例 4：A4 段里的**词汇图例行**提到 partial，但表内每一行都 `met` ⇒ 行级判定不得被词级带偏
  const withLegend = '- **A4 Acceptance item-by-item** — status vocabulary: met | partial | not_met | not_applicable\n'
    + '  | # | item | status | evidence |\n  |---|---|---|---|\n  | ① | guide | met | guides/x.md |';
  assert.equal(couplingHint(withLegend, A6_NONE_TEXT), null, '图例里的 partial 不是一行未达成项（行级 > 词级）');
});

test('D2 判定变异：把行级抽取摘空 ⇒ 真实静默丢弃不再被测出（证明正例有杀伤力）', { skip: SKIP }, async () => {
  const src = fs.readFileSync(CHECK_REPORT, 'utf8');
  const patched = src.replace('? a4UnmetRows(a4).filter((r) => !a6AccountsFor(a6Text, r))', '? []');
  assert.notEqual(patched, src, '变异必须真的改到 A4 行级抽取，否则本测试无意义');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-report-mut4-'));
  TMP.push(dir);
  linkSiblings(dir, 'check-report.mjs');
  fs.writeFileSync(path.join(dir, 'check-report.mjs'), patched, 'utf8');
  const mut = await import(pathToFileURL(path.join(dir, 'check-report.mjs')).href);

  const a4 = A4_ROW('③', 'partial');
  assert.equal(mut.couplingHint(a4, A6_NONE_TEXT), null, '行级抽取被摘空 ⇒ 静默丢弃不再被测出（= 变异存活）');
  assert.equal(couplingHint(a4, A6_NONE_TEXT).slot, 'A6', '真实判定必须测出该矛盾');
});

test('D3：commit 判据收紧为「7–40 位小写 hex 或显式声明无提交」；大写 sha-1 真值不拒', { skip: SKIP }, () => {
  const A2 = (v) => goodReport((s) => s.set('A2',
    `- **A2 Delivery coordinates** — card: tasks/T-20261015-025543.md · ${v} · branch: lane/x · pushed: no.`));
  const a2Hints = (rep) => contentHints(rep).filter((h) => h.slot === 'A2');
  assert.deepEqual(a2Hints(A2('commit: a1b2c3d')), [], '7 位小写 hex 合规');
  assert.deepEqual(a2Hints(A2('commit: 0123456789abcdef0123456789abcdef01234567')), [], '40 位小写 sha-1 合规');
  assert.deepEqual(a2Hints(A2('commit: 0123456789ABCDEF0123456789ABCDEF01234567')), [], '**大写 sha-1 真值不得被拒**');
  assert.deepEqual(a2Hints(A2('commit: none')), [], '显式声明无提交 ⇒ 合规');
  assert.deepEqual(a2Hints(A2('commit: 无')), [], '中文显式声明无提交 ⇒ 合规');
  assert.deepEqual(a2Hints(A2('无提交（本卡只读）')), [], '整段短语声明无提交 ⇒ 合规');
  // 旧口径的逃生口已关：槽位里有 `commit` 字样而**没有值**不再放行
  assert.equal(a2Hints(A2('commit:')).length, 1, '裸 `commit:`（无值）⇒ 必须提示');
  assert.equal(a2Hints(A2('commit: abcd')).length, 1, '6 位缩写不足 7 位 ⇒ 必须提示');
  // 收紧不等于逼人改写法：不标注直接写 hash 仍然放行
  assert.deepEqual(a2Hints(A2('a1b2c3d4e5')), [], '不标注直接写 hash ⇒ 仍合规');
  // **线上实测形状**（2026-10-15 全库只读扫描：按「值须恰为 sha」判会误报 12/12）⇒ 必须放行
  assert.deepEqual(a2Hints(A2('commit: `270cce9` (7 files, +2956/−133)')), [], 'hash + 注记（线上真实形状）⇒ 合规');
  assert.deepEqual(a2Hints(A2('commit: `cf3a45c` (docs) + `f5b3e76` (cli)')), [], '多段 hash + 注记 ⇒ 合规');
  assert.deepEqual(a2Hints(A2('commit: `a825bf6` (base `9e4c1aa`)')), [], 'hash + base 括注 ⇒ 合规');
  assert.deepEqual(a2Hints(A2('commit: 无（写面 tasks/*.md 不在任何 git 仓）')), [],
    '「无（…）」式显式无提交（线上真实形状）⇒ 合规');
  // 但「值里有 sha」不等于放行一切：裸字段 / 6 位缩写仍须提示（见上）
  // 直连判据
  assert.deepEqual(commitCoordinate('commit: a1b2c3d'), { ok: true });
  assert.equal(commitCoordinate('commit:').ok, false);
  assert.equal(commitCoordinate('commit:').reason, 'commit 字段为空');
  assert.match(commitCoordinate('commit: abcd').reason, /不是合法 sha/);
});

test('D4：guide §6 写明边界语义（≤64 项/列表 · ≤64 KiB · truncated）并说明门禁**不**校验', { skip: SKIP }, () => {
  const md = fs.readFileSync(GUIDE, 'utf8');
  assert.match(md, /## 6\. Bounds/, 'guide 必须有 §6 边界节');
  assert.match(md, /64 items per list/, '必须写明项数上限');
  assert.match(md, /64 KiB/, '必须写明字节上限');
  assert.match(md, /truncated/, '必须写明超限截断语义');
  assert.match(md, /does not validate/, '必须写明门禁不校验（含理由）');
  // 门禁确实不设限：超长但槽位齐备的 Report ⇒ 0 缺口 / 0 提示（只读 + 存在性判据）
  const huge = goodReport((s) => s.set('A3', `- **A3 Change surface** — ${'x'.repeat(200000)}`));
  assert.deepEqual(slotGaps(huge), []);
  assert.deepEqual(contentHints(huge), []);
  assert.deepEqual(deliveryHints(huge, { status: 'in_review' }), []);
});

test('D5：豁免条目必须带 reason（去空白后 ≥8 字符）；缺失/过短 ⇒ 不放行（判红）并点名', { skip: SKIP }, () => {
  assert.equal(MIN_EXEMPTION_REASON, 8);
  assert.equal(validExemption({ id: 'x', gaps: ['A5'], reason: '八个字符的理由啊' }), true, '恰 8 字符 ⇒ 有效');
  assert.equal(validExemption({ id: 'x', gaps: ['A5'], reason: '太短了' }), false, '过短 ⇒ 无效');
  assert.equal(validExemption({ id: 'x', gaps: ['A5'] }), false, '缺失 ⇒ 无效');
  assert.equal(validExemption({ id: 'x', gaps: ['A5'], reason: '        ' }), false, '纯空白 ⇒ trim 后 0 字符 ⇒ 无效');
  assert.equal(validExemption({ id: 'x', gaps: ['A5'], reason: 12345678 }), false, '非字符串 ⇒ 无效（fail-closed）');
  assert.equal(validExemption({ id: '', gaps: ['A5'], reason: '八个字符的理由啊' }), false, '无 id ⇒ 无效');

  writeCard({ id: 'T-20261015-000032-n', report: goodReport((s) => s.remove('A5')) });
  registerRuntime([{ id: 'T-20261015-000032-n', gaps: ['A5'] }]);        // 旧口径：无 reason 即「登记一次、永久放行」
  let r = scan();
  assert.deepEqual(r.exempt, [], '无 reason ⇒ **不放行**（退出豁免面）');
  assert.deepEqual(r.violations.map((v) => [v.id, v.gaps]), [['T-20261015-000032-n', ['A5']]]);
  assert.deepEqual(r.invalidExemptions.map((e) => e.id), ['T-20261015-000032-n'], '必须点名，供人工补写登记');
  let cli = runCli();
  assert.equal(cli.code, 1, '无 reason 的登记不得放行 ⇒ 仍红');
  assert.match(cli.err, /invalid-exempt/);

  registerRuntime([{ id: 'T-20261015-000032-n', gaps: ['A5'], reason: '短' }]);
  assert.deepEqual(scan().violations.map((v) => v.id), ['T-20261015-000032-n'], '过短 ⇒ 仍不放行');
  assert.equal(runCli().code, 1);

  registerRuntime([{ id: 'T-20261015-000032-n', gaps: ['A5'], reason: '人工核对：该槽位由基座覆盖' }]);
  r = scan();
  assert.deepEqual(r.exempt.map((e) => e.id), ['T-20261015-000032-n'], '理由合规 ⇒ 恢复放行');
  assert.deepEqual(r.invalidExemptions, []);
  assert.deepEqual(r.violations, []);
  assert.equal(runCli().code, 0);
  fs.rmSync(runtimeBaselinePath(TASKS), { force: true });
});

test('D5 判定变异：摘掉 validExemption 过滤 ⇒ 无 reason 的登记又放行（证明上一条有杀伤力）', { skip: SKIP }, async () => {
  const src = fs.readFileSync(CHECK_REPORT, 'utf8');
  const patched = src.replace('candidates.find(validExemption)', 'candidates[0]');
  assert.notEqual(patched, src, '变异必须真的改到放行判定，否则本测试无意义');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-report-mut3-'));
  TMP.push(dir);
  linkSiblings(dir, 'check-report.mjs');
  fs.writeFileSync(path.join(dir, 'check-report.mjs'), patched, 'utf8');
  const mut = await import(pathToFileURL(path.join(dir, 'check-report.mjs')).href);

  writeCard({ id: 'T-20261015-000033-n', report: goodReport((s) => s.remove('A5')) });
  registerRuntime([{ id: 'T-20261015-000033-n', gaps: ['A5'] }]);
  const inj = [{ id: 'T-20261015-000033-n', gaps: ['A5'] }];            // 形状对、无 reason
  assert.equal(mut.scanReports(TASKS, { baseline: inj }).violations.length, 0, '变异后无 reason 的登记又放行（= 变异存活）');
  assert.equal(scanReports(TASKS, { baseline: inj }).violations.length, 1, '真实判定必须拦下无 reason 的登记');
  fs.rmSync(runtimeBaselinePath(TASKS), { force: true });
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
