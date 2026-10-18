#!/usr/bin/env node
/**
 * sla-scan.test.mjs — SLA 巡检 `scripts/sla-scan.mjs` 回归测试（T-20261014-022254-3）。
 *
 * 契约：`team/guides/sla-inspection-contract.md`（C1 `T-20261014-022254-2`）。本套件逐条钉住卡面
 * Acceptance ①–⑤ 的可机检部分 + 契约 §11 的钩子 H1–H9：
 *   ① 六行覆盖 + 元组契约（§4）/ 信封（§10.1）
 *   ② 现态二次核对（§9.6）+ fail-safe（§6.5/§9.3：重核抛错保留原候选、起点不可读仍告警）
 *   ③ 零成本空转（§9.4：无跨档 ⇒ fire:false 且不写账本、不写卡）
 *   ④ 工作时段累计（§6.4）+ 去重记账（§8.3：同档不重报、升档是新键）
 *   ⑤ 只提示不自动改状态（§9.1）+ 升级目标恒 leader（H1）
 *   ⑥ 接线：providers.json / dispatch fail-closed / install.sh cadence 与 P 一致（§12 G-6）
 *   ⑦ 阈值单一来源（sla-thresholds.json，H6）
 *
 * 风格：**不做内部 mock 的判定**——fixture 是在 os.tmpdir() 里物化的**真卡文件**，判定走真实现
 * （`scanSla`/`recheckCandidates`/`decide`）。所有时间由显式 `nowMs` 固定（不看墙钟），
 * 所有写面（账本 / liveness 状态）由 `ledgerFile`/`stateFile` 落在临时目录 ⇒ 用例彼此隔离、可复现。
 * 无 provider 安装 ⇒ SKIP（与同目录既有套件同口径，不是失败）。
 *
 * Run: node --test team/scripts/tests/sla-scan.test.mjs
 */
import { test as nodeTest, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS = path.join(HERE, '..');
const TEAM_DIR = path.join(SCRIPTS, '..');

/**
 * `<repo>` = 拥有 `install.sh` 的框架检出。**install.sh 从不部署**（它住在仓里、驱动部署），故对
 * §12 G-6 cadence / sla-scan 注册形态的断言必须读**仓**而非实例。两种布局下 `<team>/..` 指代不同：
 *   - 仓检出：  TEAM_DIR = <repo>/team ⇒ <team>/.. = <repo>（有 install.sh）；
 *   - 部署实例：TEAM_DIR = ~/.openclaw/team ⇒ <team>/.. = $OPENCLAW_HOME（无 install.sh）。
 * 显式解析（口径同 team/automations/dispatch.mjs 的 {repo} 解析）：先 $OPENCLAW_TEAM_REPO，再读
 * `<team>/.install-state.json.repoPath`；都没有再回退到 `<team>/..`。
 */
function resolveRepoRoot() {
  let recorded = null;
  try {
    recorded = JSON.parse(fs.readFileSync(path.join(TEAM_DIR, '.install-state.json'), 'utf8')).repoPath;
  } catch { /* 无状态文件 / 不可读 ⇒ 忽略 */ }
  const guess = path.join(TEAM_DIR, '..');
  for (const c of [process.env.OPENCLAW_TEAM_REPO, recorded, guess].filter(Boolean)) {
    if (fs.existsSync(path.join(c, 'install.sh'))) return c;
  }
  return guess;
}
const REPO = resolveRepoRoot();

/** 定位携带 ACL 库的 provider 安装（与 patrol.test.mjs / frontmatter.test.mjs 同口径）。 */
function resolveProviderRoot() {
  const candidates = [
    process.env.OPENCLAW_TASK_OPS_DIR,
    // 部署布局相对候选：<team>/skills/task-ops（自 tests/ 上溯两级）—— 不读宿主 ~/.openclaw
    path.resolve(import.meta.dirname, '..', '..', 'skills', 'task-ops'),
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

// provider 依赖为条件动态 import：缺 provider 时 lib.mjs 在 import 期硬红（见 lib.mjs 顶部）。
let S;
if (PROVIDER) {
  process.env.OPENCLAW_TASK_OPS_DIR = PROVIDER;
  S = await import('../sla-scan.mjs');
}

const scratchDirs = [];
after(() => {
  for (const d of scratchDirs) fs.rmSync(d, { recursive: true, force: true });
});

// ── fixture ────────────────────────────────────────────────────────────────────
/** 固定时钟：2026-01-05T03:00:00Z = Asia/Shanghai 11:00（**工作时段内**）。 */
const NOW = Date.parse('2026-01-05T03:00:00.000Z');
const CST = (iso) => Date.parse(iso); // 只用于可读性：fixture 时间一律写 UTC／带偏移

/** 新 fixture 根：tasks/ + workspace/ + 账本/状态落点（全部在临时目录内）。 */
function newRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sla-scan-'));
  scratchDirs.push(dir);
  fs.mkdirSync(path.join(dir, 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'workspace'), { recursive: true });
  return {
    dir,
    tasksDir: path.join(dir, 'tasks'),
    workspaceDir: path.join(dir, 'workspace'),
    ledgerFile: path.join(dir, '.ledger.json'),
    stateFile: path.join(dir, '.state.json'),
    peerFile: path.join(dir, '.peer.json'),
  };
}

/** 物化一张真卡：`fm` 走与 lib.serializeFrontmatter 同形的写法（值可按需引号）。 */
function writeCard(root, fm, body = '') {
  const order = Object.keys(fm);
  const lines = ['---'];
  for (const k of order) {
    const v = fm[k];
    if (v === undefined || v === null) continue;
    lines.push(`${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);
  }
  lines.push('---');
  fs.writeFileSync(path.join(root.tasksDir, `${fm.id}.md`), lines.join('\n') + '\n' + body, 'utf8');
}

/** 标准 in-progress 卡（心跳 / 会话证据可控）。 */
function progressCard(over = {}) {
  return {
    id: 'T-20260105-000001',
    title: 'fixture in-progress',
    assignee: 'linus',
    status: 'in_progress',
    kind: 'task',
    project: '__team__',
    created_by: 'elon',
    created_at: '2026-01-04T01:00:00.000Z',
    status_changed_at: '2026-01-05T02:00:00.000Z',
    claimed_by: 'linus',
    claimed_at: '2026-01-05T02:00:00.000Z',
    heartbeat_at: '2026-01-05T02:50:00.000Z',
    depends_on: '[]',
    ...over,
  };
}

const OPTS = (root, over = {}) => ({
  tasksDir: root.tasksDir,
  workspaceDir: root.workspaceDir,
  nowMs: NOW,
  ledgerFile: root.ledgerFile,
  stateFile: root.stateFile,
  ...over,
});

const rowsOf = (env) => env.alerts.map((a) => a.sla_row).sort();

// ── ④ 工作时段累计（契约 §6.4；纯函数）────────────────────────────────────────────
test('§6.4 工作时段累计：界外滚动（时钟停），跨日按累计分钟而非墙钟', () => {
  // 09:00 CST → 11:00 CST 同日 = 120 工作分钟（墙钟同为 120）
  assert.equal(S.workingMinutesBetween(CST('2026-01-05T01:00:00Z'), CST('2026-01-05T03:00:00Z')), 120);
  // 22:00 CST → 次日 10:00 CST：当日 22:00–23:00 = 60 + 次日 09:00–10:00 = 60
  assert.equal(S.workingMinutesBetween(CST('2026-01-05T14:00:00Z'), CST('2026-01-06T02:00:00Z')), 120);
  // 23:30 CST → 次日 08:00 CST 全在界外 = 0
  assert.equal(S.workingMinutesBetween(CST('2026-01-05T15:30:00Z'), CST('2026-01-06T00:00:00Z')), 0);
  // 一整日 = 14h
  assert.equal(S.workingMinutesBetween(CST('2026-01-05T00:00:00Z'), CST('2026-01-06T00:00:00Z')), 840);
  // 倒序 / 非法 ⇒ 0（不抛）
  assert.equal(S.workingMinutesBetween(CST('2026-01-05T03:00:00Z'), CST('2026-01-05T01:00:00Z')), 0);
  assert.equal(S.workingMinutesBetween(NaN, NOW), 0);
});

test('§6.4 due_at 在同一时间基上前推（工作时段投影，非墙钟）', () => {
  // 22:30 CST + 120 工作分钟 = 当日 30min + 次日 90min ⇒ 次日 10:30 CST = 02:30Z
  const due = S.addWorkingMinutes(CST('2026-01-05T14:30:00Z'), 120);
  assert.equal(new Date(due).toISOString(), '2026-01-06T02:30:00.000Z');
  // 逆运算与累计一致
  assert.equal(S.workingMinutesBetween(CST('2026-01-05T14:30:00Z'), due), 120);
});

// ── ④ 升档梯（契约 §5.2）────────────────────────────────────────────────────────
test('§5.2 升档梯：warn=L−P（钳 0）/ overdue=L / escalate=F；最高档胜出', () => {
  const row = { normalMin: 120, furtherMin: 1440 };
  assert.equal(S.verdictFor(row, 104, 15).severity, null);
  assert.equal(S.verdictFor(row, 105, 15).severity, 'warn');
  assert.equal(S.verdictFor(row, 119, 15).severity, 'warn');
  assert.equal(S.verdictFor(row, 120, 15).severity, 'overdue');
  assert.equal(S.verdictFor(row, 1439, 15).severity, 'overdue');
  assert.equal(S.verdictFor(row, 1440, 15).severity, 'escalate');
  // 钳 0：P > L 时 warn 界为 0（契约 §5.2 规则 1 明文），但默认 P 不会走到这里 —— 见 cadence 用例
  assert.equal(S.verdictFor({ normalMin: 10, furtherMin: null }, 0, 15).severity, 'warn');
  // noWarnLead（leader_stalled，规则 5）：无 −P 前导，无 overdue
  const ls = { normalMin: 60, furtherMin: 360, noWarnLead: true };
  assert.equal(S.verdictFor(ls, 59, 15).severity, null);
  assert.equal(S.verdictFor(ls, 60, 15).severity, 'warn');
  assert.equal(S.verdictFor(ls, 300, 15).severity, 'warn');
  assert.equal(S.verdictFor(ls, 360, 15).severity, 'escalate');
  // threshold_min = null（§5.3/§7.4）⇒ 只有 warn
  assert.equal(S.verdictFor({ normalMin: null, furtherMin: null }, 99999, 15).severity, 'warn');
});

test('§12 G-6 cadence 口径对齐：注册周期 P 必须小于最紧的 PROTOCOL §15 行 L（否则 warn 界塌到 0）', () => {
  const tightest = Math.min(...S.SLA_ROWS.map((r) => r.normalMin));
  assert.ok(
    S.CADENCE_PERIOD_MIN < tightest,
    `P=${S.CADENCE_PERIOD_MIN} 必须 < 最紧 L=${tightest}（否则该行 warn 界钳 0 ⇒ 每周期恒告警，违 §9.4）`,
  );
  // install.sh 声明的 interval 必须与运行期 P 同值（单一事实源：两侧默认都由这条断言钉住）
  const install = fs.readFileSync(path.join(REPO, 'install.sh'), 'utf8');
  const m = /OPENCLAW_TEAM_SLA_INTERVAL:-([0-9]+)([smhd])/.exec(install);
  assert.ok(m, 'install.sh 必须声明 OPENCLAW_TEAM_SLA_INTERVAL（sla-scan 的注册 cadence）');
  const declaredMin = m[2] === 'h' ? Number(m[1]) * 60 : Number(m[1]);
  assert.equal(declaredMin, S.CADENCE_PERIOD_MIN, 'install.sh 注册的 sla-scan cadence 必须等于运行期 P');
});

// ── ① 六行覆盖 + 元组（契约 §4 / §5）───────────────────────────────────────────
test('① blocked_clarification：blocked_at 为起点，T≥L ⇒ overdue；元组字段齐备', () => {
  const root = newRoot();
  // blocked_at = 08:30 CST（界外）⇒ 11:00 CST 时累计恰为 120 = L
  writeCard(root, progressCard({ status: 'blocked', blocked_at: '2026-01-05T00:30:00.000Z' }));
  const env = S.decide(OPTS(root)).envelope;
  const a = env.alerts.find((x) => x.sla_row === 'blocked_clarification');
  assert.ok(a, 'blocked 卡必须命中 blocked_clarification');
  assert.equal(a.severity, 'overdue');
  assert.equal(a.elapsed_working_min, 120);
  assert.equal(a.threshold_min, 120);
  assert.equal(a.measure_start_kind, 'blocked_at');
  assert.equal(a.measure_start_at, '2026-01-05T00:30:00.000Z');
  assert.equal(a.measure_start_source, 'frontmatter');
  assert.equal(a.confidence, 'high');
  assert.equal(a.elapsed_basis, 'working_hours');
  assert.equal(a.target, 'leader');
  assert.equal(a.mechanism, 'openclaw-cron');
  assert.equal(a.due_at, '2026-01-05T03:00:00.000Z'); // 工作时段投影
  assert.equal(a.alert_id, 'T-20260105-000001#blocked_clarification#overdue');
  assert.equal(a.dedup_key, 'T-20260105-000001#blocked_clarification#overdue@2026-01-05T00:30:00.000Z');
  // §4 evidence 键齐备 + 卡面草图别名
  for (const k of ['status', 'status_changed_at', 'has_sessions', 'has_workspace', 'threshold_ref', 'open_predicate']) {
    assert.ok(k in a.evidence, `evidence 缺 ${k}`);
  }
  assert.equal(a.kind, 'blocked_clarification');
  assert.equal(a.id, 'T-20260105-000001');
  assert.equal(a.ageMin, a.elapsed_working_min);
});

test('① heartbeat_stale：心跳起点 + 30min 界（PROTOCOL §15 Worker heartbeat stale）', () => {
  const root = newRoot();
  writeCard(root, progressCard({ heartbeat_at: '2026-01-05T02:30:00.000Z' })); // T=30
  const a = S.decide(OPTS(root)).envelope.alerts.find((x) => x.sla_row === 'heartbeat_stale');
  assert.ok(a);
  assert.equal(a.severity, 'overdue');
  assert.equal(a.elapsed_working_min, 30);
  assert.equal(a.threshold_min, 30);
  assert.equal(a.measure_start_kind, 'heartbeat_at');
});

test('① confirmation_gate：PROTOCOL §14 请求为起点，且被后续确认收口后不再告警', () => {
  const root = newRoot();
  const body = [
    '## Progress',
    '- 2026-01-04T01:00:00.000Z 阶段2.5 回发 Elon 待确认（3 项拍板）',
    '',
  ].join('\n');
  writeCard(root, progressCard({ status: 'in_review', status_changed_at: '2026-01-05T01:00:00.000Z' }), body);
  const env = S.decide(OPTS(root)).envelope;
  const a = env.alerts.find((x) => x.sla_row === 'confirmation_gate');
  assert.ok(a, '未答复的确认门请求必须告警');
  assert.equal(a.measure_start_kind, 'gate_at');
  assert.equal(a.measure_start_at, '2026-01-04T01:00:00.000Z');
  assert.equal(a.elapsed_working_min, 960); // 01-04 全日 840 + 01-05 09:00→11:00 120
  assert.equal(a.threshold_min, 240);
  assert.equal(a.severity, 'overdue');
  assert.equal(a.evidence.confirm_request_marker, false); // 形状兜底（G-5 标记尚未普及）
  // 收口：请求之后追加一条 kind=confirm
  const root2 = newRoot();
  writeCard(
    root2,
    progressCard({ status: 'in_review', status_changed_at: '2026-01-05T01:00:00.000Z' }),
    body + '- 2026-01-04T02:00:00.000Z · confirm · elon — Elon confirmed (dual-signed)\n',
  );
  assert.equal(
    S.decide(OPTS(root2)).envelope.alerts.filter((x) => x.sla_row === 'confirmation_gate').length,
    0,
    '已确认的请求不得再告警',
  );
  // 契约约定标记优先（§12 G-5）：`[confirm-request]` 命中即为 exact
  const root3 = newRoot();
  writeCard(
    root3,
    progressCard({ status: 'in_review', status_changed_at: '2026-01-05T01:00:00.000Z' }),
    '## Progress\n- 2026-01-04T01:00:00.000Z [confirm-request] plan.md 待复核\n',
  );
  const m = S.decide(OPTS(root3)).envelope.alerts.find((x) => x.sla_row === 'confirmation_gate');
  assert.equal(m.evidence.confirm_request_marker, true);
  assert.equal(m.confidence, 'high');
  // 「已回发」这类**收口**措辞不得被当成等待中的请求（否则制造永不收敛的误报）
  const root4 = newRoot();
  writeCard(
    root4,
    progressCard({ status: 'in_review', status_changed_at: '2026-01-05T01:00:00.000Z' }),
    '## Progress\n- 2026-01-04T01:00:00.000Z poll 巡检轮完成，已回发 Elon。\n',
  );
  assert.equal(
    S.decide(OPTS(root4)).envelope.alerts.filter((x) => x.sla_row === 'confirmation_gate').length,
    0,
  );
});

test('① acceptance_card_creation：in_review + flow A（缺省视为 A）+ 无 review_of 卡', () => {
  const root = newRoot();
  writeCard(root, progressCard({ status: 'in_review', status_changed_at: '2026-01-01T01:00:00.000Z' }));
  const a = S.decide(OPTS(root)).envelope.alerts.find((x) => x.sla_row === 'acceptance_card_creation');
  assert.ok(a);
  assert.equal(a.severity, 'escalate'); // 跨了 1440
  assert.equal(a.threshold_min, 1440);
  assert.equal(a.evidence.flow_effective, 'A'); // 缺省 ⇒ A（fail-safe）
  // 有 review_of 卡 ⇒ 等待被覆盖，不再告警
  const root2 = newRoot();
  writeCard(root2, progressCard({ status: 'in_review', status_changed_at: '2026-01-01T01:00:00.000Z' }));
  writeCard(root2, progressCard({ id: 'T-20260105-000002', status: 'todo', review_of: 'T-20260105-000001', heartbeat_at: '' }));
  assert.equal(
    S.decide(OPTS(root2)).envelope.alerts.filter((x) => x.sla_row === 'acceptance_card_creation').length,
    0,
  );
  // flow B ⇒ 不开逐卡 Jobs 卡（PROTOCOL §10.5）
  const root3 = newRoot();
  writeCard(root3, progressCard({ status: 'in_review', status_changed_at: '2026-01-01T01:00:00.000Z', flow: 'B' }));
  assert.equal(
    S.decide(OPTS(root3)).envelope.alerts.filter((x) => x.sla_row === 'acceptance_card_creation').length,
    0,
  );
});

test('① defect_card_creation：PROTOCOL §9 kind=defect 留痕 + 无修复卡 ⇒ 告警；有 category:bug 回指卡 ⇒ 收口', () => {
  const root = newRoot();
  const body = '## Comments\n- 2025-12-31T01:00:00.000Z · defect · turing — 缺陷票（复现/期望/实际）\n';
  writeCard(root, progressCard({ status: 'blocked', blocked_at: '2026-01-05T00:30:00.000Z' }), body);
  const env = S.decide(OPTS(root)).envelope;
  const a = env.alerts.find((x) => x.sla_row === 'defect_card_creation');
  assert.ok(a, '有缺陷留痕且无修复卡 ⇒ 必须告警');
  assert.equal(a.measure_start_kind, 'trail_event');
  assert.equal(a.measure_start_at, '2025-12-31T01:00:00.000Z'); // 早于 blocked_at ⇒ 取更早者（可多报方向）
  assert.equal(a.threshold_min, 1440);
  assert.equal(a.severity, 'escalate');
  // 同一张 blocked 卡同时命中 blocked_clarification（两条互不替代的等待）
  assert.ok(env.alerts.some((x) => x.sla_row === 'blocked_clarification'));
  // 修复卡到位（category:bug + 回指原卡）⇒ 收口
  const root2 = newRoot();
  writeCard(root2, progressCard({ status: 'blocked', blocked_at: '2026-01-05T00:30:00.000Z' }), body);
  writeCard(root2, {
    ...progressCard({ id: 'T-20260105-000009', status: 'todo', heartbeat_at: '' }),
    labels: '[category:bug]',
    title: 'fix for T-20260105-000001',
  }, '## Background\n修复 T-20260105-000001 的缺陷。\n');
  assert.equal(
    S.decide(OPTS(root2)).envelope.alerts.filter((x) => x.sla_row === 'defect_card_creation').length,
    0,
  );
});

test('① leader_stalled：条件规则 —— 有 leader 待动作才告警；安静看板不告警', () => {
  const root = newRoot();
  // 一张 in_review（leader 待验收）+ 一张 70min 前由 leader 建的卡 ⇒ warn（T≥L=60，无 −P 前导）
  writeCard(root, progressCard({ status: 'in_review', status_changed_at: '2026-01-05T01:00:00.000Z' }));
  writeCard(root, {
    ...progressCard({ id: 'T-20260105-000003', status: 'todo', heartbeat_at: '' }),
    created_at: '2026-01-05T01:50:00.000Z',
  });
  const env = S.decide(OPTS(root, { peerState: null })).envelope;
  const a = env.alerts.find((x) => x.sla_row === 'leader_stalled');
  assert.ok(a, '看板有 leader 待动作 ⇒ 必须告警');
  // F1（契约 §4 #7/#9）：最新 leader 事件 = leader **建卡** ⇒ kind 随事件而定（`created_at`，不是 `trail_event`），
  // source 只写**读取位置**（`created_at` 是 frontmatter 字段 ⇒ `frontmatter`）。修复前两者都写成了 kind 词汇。
  assert.equal(a.measure_start_kind, 'created_at');
  assert.equal(a.measure_start_source, 'frontmatter');
  assert.equal(a.measure_start_at, '2026-01-05T01:50:00.000Z');
  assert.equal(a.elapsed_working_min, 70);
  assert.equal(a.severity, 'warn');
  assert.equal(a.threshold_min, 60);
  assert.equal(a.confidence, 'high'); // 起点在回溯窗内（§6.3-D）
  // 最新 leader 事件是**轨迹条目** ⇒ kind=trail_event，source=该条目所在小节（§4 #9）
  const root1 = newRoot();
  writeCard(
    root1,
    progressCard({ status: 'in_review', status_changed_at: '2026-01-05T01:00:00.000Z' }),
    '## Comments\n- 2026-01-05T01:45:00.000Z · change · elon — leader 改了点什么\n',
  );
  const b = S.decide(OPTS(root1, { peerState: null })).envelope.alerts.find((x) => x.sla_row === 'leader_stalled');
  assert.equal(b.measure_start_kind, 'trail_event');
  assert.equal(b.measure_start_source, 'comments');
  assert.equal(b.measure_start_at, '2026-01-05T01:45:00.000Z');
  // 安静看板（无任何 leader 待动作）⇒ 该行不产生条目（零成本空转，§5.1 条件规则）
  const root2 = newRoot();
  writeCard(root2, progressCard({ heartbeat_at: '2026-01-05T02:55:00.000Z' }));
  assert.equal(S.decide(OPTS(root2)).envelope.alerts.filter((x) => x.sla_row === 'leader_stalled').length, 0);
});

// F5（契约 v1.1 §6.3-D / §12 G-10 ⑥）：回溯窗只决定 confidence，**不**决定起点有无。
test('①/F5 leader_stalled：起点早于回溯窗 ⇒ 照发真实起点 + confidence:low（不丢起点、不降成 warn）', () => {
  const root = newRoot();
  // 注意：验收等待卡**不是** leader 事件（created_by 非 leader、非终态），唯一 leader 事件 = 下方建卡
  writeCard(
    root,
    progressCard({ status: 'in_review', created_by: 'linus', created_at: '2025-12-20T01:00:00.000Z', status_changed_at: '2026-01-05T01:00:00.000Z' }),
  );
  writeCard(root, {
    ...progressCard({ id: 'T-20260105-000003', status: 'todo', heartbeat_at: '' }),
    created_at: '2025-12-28T01:00:00.000Z', // 8 天前 > LEADER_LOOKBACK_DAYS(7)
  });
  const decided = S.decide(OPTS(root, { peerState: null }));
  const a = decided.envelope.alerts.find((x) => x.sla_row === 'leader_stalled');
  assert.ok(a, '窗外的真实起点必须照发（契约 §6.3-D：巡检必须说出来，不静默）');
  assert.equal(a.measure_start_at, '2025-12-28T01:00:00.000Z');
  assert.equal(a.measure_start_source, 'frontmatter');
  assert.equal(a.confidence, 'low'); // 窗外的唯一后果 = 降 confidence
  assert.equal(a.threshold_min, 60); // 阈值**不**被降成 null（修复前 origin:null ⇒ threshold_min:null）
  assert.equal(a.severity, 'escalate'); // 最深停摆（T=6840 ≥ F=360）仍能到 escalate；修复前只到 warn
  assert.equal(a.evidence.leader_event_in_lookback, false);
  assert.match(a.evidence.confidence_reason, /lookback/);
  // 现态重核也不得因「起点在窗外」而剔除它（drop 同样会丢掉起点）
  const rc = S.recheckCandidates(decided.envelope.alerts, OPTS(root, { peerState: null }));
  assert.ok(
    rc.kept.some((k) => (k.alert || k).sla_row === 'leader_stalled'),
    '窗外起点的 leader_stalled 必须通过现态重核',
  );
  // 看板**完全无** leader 事件 ⇒ 无起点可量 ⇒ §6.5 兜底（仍发、不假绿）
  const root2 = newRoot();
  writeCard(root2, progressCard({ status: 'in_review', created_by: 'linus', status_changed_at: '2026-01-05T01:00:00.000Z' }));
  const c = S.decide(OPTS(root2, { peerState: null })).envelope.alerts.find((x) => x.sla_row === 'leader_stalled');
  assert.ok(c, '无 leader 事件也必须说出来（绝不静默）');
  assert.equal(c.measure_start_kind, 'unverifiable');
  assert.equal(c.measure_start_source, 'missing');
  assert.equal(c.threshold_min, null);
  assert.equal(c.severity, 'warn');
  assert.equal(c.confidence, 'low');
  assert.equal(c.evidence.leader_event_in_lookback, null);
});

// F1（契约 §4 #9 / §12 G-10 ⑤）：`measure_start_source` 恒为**读取位置**枚举，与 `measure_start_kind` 不混用。
test('①/F1 measure_start_source 恒取 §4 #9 枚举；kind 与来源自洽（全行机检）', () => {
  const KINDS = ['blocked_at', 'status_changed_at', 'heartbeat_at', 'gate_at', 'trail_event', 'created_at', 'unverifiable'];
  const alerts = [];
  const root = newRoot();
  // 一张 blocked 卡同时命中 blocked_clarification + defect_card_creation（缺陷留痕在 Progress，足够老 ⇒ 跨档）
  writeCard(
    root,
    progressCard({ status: 'blocked', blocked_at: '2026-01-05T00:30:00.000Z', blocked_reason: 'defect' }),
    '## Progress\n- 2025-12-31T01:00:00.000Z · defect · turing — 缺陷票\n',
  );
  // 确认门（Comments 里的 PROTOCOL §14 请求）+ 验收等待（in_review，起点足够老 ⇒ 跨档）
  writeCard(
    root,
    progressCard({ id: 'T-20260105-000004', status: 'in_review', status_changed_at: '2026-01-01T01:00:00.000Z' }),
    '## Comments\n- 2026-01-04T02:00:00.000Z 阶段2.5 回发 Elon 待确认\n',
  );
  // 心跳陈旧（frontmatter 起点）
  writeCard(root, progressCard({ id: 'T-20260105-000005', heartbeat_at: '2026-01-05T02:30:00.000Z' }));
  alerts.push(...S.decide(OPTS(root, { peerState: null })).envelope.alerts);
  // 对端标记超界 ⇒ inspector_liveness（无起点 ⇒ missing）
  alerts.push(...S.decide(OPTS(root, { peerState: { last_ok: '2026-01-05T01:00:00.000Z' } })).envelope.alerts);

  const rows = new Set(alerts.map((a) => a.sla_row));
  for (const r of ['blocked_clarification', 'defect_card_creation', 'confirmation_gate', 'acceptance_card_creation', 'heartbeat_stale', 'leader_stalled', 'inspector_liveness']) {
    assert.ok(rows.has(r), `fixture 未覆盖 ${r}`);
  }
  for (const a of alerts) {
    assert.ok(
      S.MEASURE_START_SOURCES.includes(a.measure_start_source),
      `measure_start_source 越出 §4 #9 枚举：${a.sla_row} → ${a.measure_start_source}`,
    );
    assert.ok(KINDS.includes(a.measure_start_kind), `measure_start_kind 越界：${a.sla_row} → ${a.measure_start_kind}`);
    assert.notEqual(a.measure_start_source, a.measure_start_kind, `source 不得写成 kind（§4 #9）：${a.sla_row}`);
  }
  assert.ok(alerts.some((a) => a.sla_row === 'confirmation_gate' && a.measure_start_source === 'comments'));
  assert.ok(alerts.some((a) => a.sla_row === 'defect_card_creation' && a.measure_start_source === 'progress'));
  assert.ok(alerts.some((a) => a.sla_row === 'blocked_clarification' && a.measure_start_source === 'frontmatter'));
  assert.ok(alerts.some((a) => a.sla_row === 'inspector_liveness' && a.measure_start_source === 'missing'));
});

// F8（契约 §4 #19 / §12 G-10 ⑦）：`blocked_reason` 在**每一行**取卡当前值。
test('①/F8 §4 #19 blocked_reason 取卡当前值 —— 缺陷行不再恒 null；卡无该键则各行 null', () => {
  const root = newRoot();
  writeCard(
    root,
    progressCard({ status: 'blocked', blocked_at: '2026-01-05T00:30:00.000Z', blocked_reason: 'defect' }),
    '## Comments\n- 2025-12-31T01:00:00.000Z · defect · turing — 缺陷票\n',
  );
  const env = S.decide(OPTS(root, { peerState: null })).envelope;
  const blocked = env.alerts.find((x) => x.sla_row === 'blocked_clarification');
  const defect = env.alerts.find((x) => x.sla_row === 'defect_card_creation');
  assert.equal(blocked.blocked_reason, 'defect');
  assert.equal(defect.blocked_reason, 'defect'); // 修复前该行恒 null（越出 §4 #19「在每一行」）
  // leader_stalled 的承载卡也就是这张 blocked 卡 ⇒ 同样取到卡当前值
  assert.equal(env.alerts.find((x) => x.sla_row === 'leader_stalled').blocked_reason, 'defect');
  // 卡不带该键 ⇒ null（「null iff the card carries none」，绝不用行专属替身兜底）
  const root2 = newRoot();
  writeCard(root2, progressCard({ status: 'blocked', blocked_at: '2026-01-05T00:30:00.000Z' }), '## Comments\n- 2025-12-31T01:00:00.000Z · defect · turing — 缺陷票\n');
  const env2 = S.decide(OPTS(root2, { peerState: null })).envelope;
  assert.equal(env2.alerts.find((x) => x.sla_row === 'blocked_clarification').blocked_reason, null);
  assert.equal(env2.alerts.find((x) => x.sla_row === 'defect_card_creation').blocked_reason, null);
  // 非 blocked 行（in_review / heartbeat）同样取卡当前值：卡无 ⇒ null
  const root3 = newRoot();
  writeCard(root3, progressCard({ status: 'in_review', status_changed_at: '2026-01-05T01:00:00.000Z' }));
  writeCard(root3, progressCard({ id: 'T-20260105-000007', heartbeat_at: '2026-01-05T02:30:00.000Z' }));
  const env3 = S.decide(OPTS(root3, { peerState: null })).envelope;
  assert.ok(env3.alerts.length >= 2);
  for (const a of env3.alerts) assert.equal(a.blocked_reason, null, `${a.sla_row} 应取到 null（卡未携带该键）`);
});

// F1-23/24（契约 §4 #23/#24 + §4.1 + 钩子 H10；T-20261014-044112-2）：账本元数据**不随 alerts[] 发行**。
test('①/§4.1 §4 #23/#24 是账本元数据：发射元组不含、账本条目必含（负例断言 H10）', () => {
  const LEDGER_ONLY = ['first_seen', 'last_seen', 'observed_by'];
  // 契约 §4 的**发射面** = 行 #1–#22 + 行 #25（evidence）+ 三个建卡草图别名（kind/id/ageMin）
  const EMITTED_KEYS = [
    'action', 'ageMin', 'alert_id', 'blocked_reason', 'card_id', 'confidence', 'dedup_key', 'due_at',
    'elapsed_basis', 'elapsed_working_min', 'evidence', 'id', 'kind', 'measure_start_at',
    'measure_start_kind', 'measure_start_source', 'mechanism', 'mechanism_host', 'notify',
    'releasable', 'releasable_basis', 'severity', 'sla_ref', 'sla_row', 'target', 'threshold_min',
  ].sort();

  const root = newRoot();
  writeCard(root, progressCard({ status: 'blocked', blocked_at: '2026-01-05T00:30:00.000Z' }));
  const { envelope, record } = S.decide(OPTS(root, { peerState: null }));
  assert.ok(envelope.alerts.length >= 2, 'fixture 至少命中 blocked_clarification + leader_stalled');

  // 负例①：发射的每一条 alert 都**不得**携带 #23/#24，且发射面恰为 §4 的发射字段集
  for (const a of envelope.alerts) {
    for (const k of LEDGER_ONLY) {
      assert.ok(!(k in a), `发射元组不得携带账本元数据 ${k}（契约 §4.1）：${a.sla_row}`);
    }
    assert.deepEqual(Object.keys(a).sort(), EMITTED_KEYS, `发射面字段集必须是 §4 的 #1–#22+#25：${a.sla_row}`);
  }
  // 发射时该键必是**新键**（有键即被抑制）⇒ 回填只可能写成 first_seen=last_seen=发射瞬时（§4.1 理由②）
  assert.equal(fs.existsSync(root.ledgerFile), false, 'record() 之前不得落账本 ⇒ 被发射的键在发射时必为新键');

  // 正例：账本条目**必须**携带三者（#23/#24 的家）
  record();
  const led = JSON.parse(fs.readFileSync(root.ledgerFile, 'utf8'));
  for (const a of envelope.alerts) {
    const e = led.entries[a.dedup_key];
    assert.ok(e, `账本必须为该 dedup_key 落条目：${a.dedup_key}`);
    for (const k of LEDGER_ONLY) assert.ok(k in e, `账本条目必须携带 ${k}（契约 §4.1 / H10）`);
    assert.deepEqual(e.observed_by, [S.MECHANISM]);
    assert.equal(e.first_seen, e.last_seen);
    assert.equal(e.first_seen, '2026-01-05T03:00:00.000Z'); // = 该键首次被观测的瞬时（本 tick）
  }

  // 负例②：被抑制的重复（#24 存在的理由）同样不进 alerts[]，其审计面仍在账本
  const dup = S.decide(OPTS(root, { peerState: null })).envelope;
  assert.equal(dup.alerts.length, 0);
  for (const d of dup.dropped) {
    assert.equal(d.dropped_reason, 'duplicate');
    for (const k of LEDGER_ONLY) assert.ok(!(k in d), `被抑制项不得携带 ${k}（审计面在账本）`);
  }
});

// 文档不漂移：契约 §4/§4.1 的声明必须与实现同口径（否则本卡的裁定会被下一次编辑悄悄回退）。
test('①/§4.1 契约 §4 行 23/24 标 ledger、发射骨架不含 #23/#24、账本骨架必含、H10 已登记', () => {
  const doc = fs.readFileSync(path.join(TEAM_DIR, 'guides', 'sla-inspection-contract.md'), 'utf8');
  for (const n of [23, 24]) {
    const row = new RegExp(`^\\| ${n} \\|(.*)$`, 'm').exec(doc);
    assert.ok(row, `契约 §4 必须仍有序号 ${n} 的行`);
    assert.match(row[1], /\*\*ledger\*\*/, `§4 行 ${n} 必须标为 ledger（§4.1）`);
    assert.doesNotMatch(row[1], /\| ✅ \|/, `§4 行 ${n} 不得再标 ✅（那会把账本元数据说成发射字段）`);
  }
  const block = (label) => {
    const m = new RegExp(`\\*\\*${label}[^\\n]*\\*\\*\\n\\n\`\`\`json\\n([\\s\\S]*?)\`\`\``).exec(doc);
    assert.ok(m, `契约必须给出「${label}」骨架块`);
    return m[1];
  };
  const emitted = block('Emitted-tuple skeleton');
  const ledger = block('Ledger-entry skeleton');
  for (const k of ['first_seen', 'last_seen', 'observed_by']) {
    assert.ok(!emitted.includes(k), `发射骨架不得含 ${k}（§4.1）`);
    assert.ok(ledger.includes(k), `账本骨架必须含 ${k}（§4.1）`);
  }
  assert.match(doc, /\*\*H10\*\*/, '契约 §11 必须登记钩子 H10（发射面不含 #23/#24）');
});

test('① inspector_liveness：对端标记缺失 ⇒ 可见注记不告警；标记超界 ⇒ warn（threshold_min=null）', () => {
  const root = newRoot();
  // 对端未发布标记（C4 未落地）：不告警，但 state 里可见
  writeCard(root, progressCard({ heartbeat_at: '2026-01-05T02:55:00.000Z' }));
  const env = S.decide(OPTS(root)).envelope;
  assert.equal(env.alerts.filter((x) => x.sla_row === 'inspector_liveness').length, 0);
  assert.equal(env.state.peer.status, 'absent');
  assert.ok(env.state.notes.some((n) => n.includes('last_ok')));
  // 标记存在但超界（> k×P_peer = 90min）⇒ warn 且 threshold_min=null（§5.3：无 PROTOCOL §15 阈值）
  const env2 = S.decide(
    OPTS(root, { peerState: { mechanism: 'loop-patrol', last_ok: '2026-01-05T01:00:00.000Z' } }),
  ).envelope;
  const a = env2.alerts.find((x) => x.sla_row === 'inspector_liveness');
  assert.ok(a, '对端超界必须告警（否则巡检自身失联成为静默绿）');
  assert.equal(a.severity, 'warn');
  assert.equal(a.threshold_min, null);
  assert.equal(a.sla_ref.startsWith('PROTOCOL §15'), false); // 非 PROTOCOL §15 行，引用契约 §5.3
  assert.equal(a.target, 'leader');
});

// ── ② fail-safe（契约 §6.5 / §9.3 / 钩子 H4 H9）─────────────────────────────────
test('② fail-safe：心跳不可读 ⇒ unverifiable/warn/threshold_min=null（绝不静默假绿）', () => {
  const root = newRoot();
  writeCard(root, progressCard({ heartbeat_at: '', claimed_at: '2026-01-05T00:00:00.000Z' }));
  const a = S.decide(OPTS(root)).envelope.alerts.find((x) => x.sla_row === 'heartbeat_stale');
  assert.ok(a, '不可读心跳必须告警（不回归 patrol-scan 口径）');
  assert.equal(a.measure_start_kind, 'unverifiable');
  assert.equal(a.threshold_min, null);
  assert.equal(a.severity, 'warn');
  assert.equal(a.confidence, 'low');
  assert.equal(a.evidence.heartbeat_unparseable, true);
});

test('② fail-safe：claim→spawn 窗口内不误报（§10.4 既有行为不回归）', () => {
  const root = newRoot();
  // 领卡 10 分钟前、心跳尚未写出 ⇒ 正常在途，不告警
  writeCard(root, progressCard({ heartbeat_at: '', claimed_at: '2026-01-05T02:50:00.000Z' }));
  assert.equal(S.decide(OPTS(root)).envelope.alerts.length, 0);
});

test('② fail-safe：现态重核抛错 ⇒ 保留原候选照常告警（recheck:"failed"）', () => {
  const root = newRoot();
  writeCard(root, progressCard({ status: 'blocked', blocked_at: '2026-01-05T00:30:00.000Z' }));
  let n = 0;
  const flaky = (dir) => {
    if (++n === 1) return S.readBoard(dir);
    throw new Error('injected recheck failure');
  };
  const { envelope } = S.decide(OPTS(root, { readBoardImpl: flaky }));
  assert.equal(envelope.fire, true, '重核故障绝不能让真告警消失');
  assert.ok(envelope.alerts.some((x) => x.sla_row === 'blocked_clarification'));
  assert.equal(envelope.state.recheck, 'failed');
});

test('② 现态重核：候选发出前卡已收口 ⇒ 进 dropped（绝不静默丢）', () => {
  const root = newRoot();
  writeCard(root, progressCard({ status: 'blocked', blocked_at: '2026-01-05T00:30:00.000Z' }));
  let n = 0;
  const moving = (dir) => {
    const b = S.readBoard(dir);
    if (++n === 2) b.byId.get('T-20260105-000001').fm.status = 'done'; // 重核前卡已收口
    return b;
  };
  const { envelope } = S.decide(OPTS(root, { readBoardImpl: moving }));
  assert.equal(envelope.alerts.length, 0, '已收口的候选不得发出');
  assert.equal(envelope.fire, false);
  const d = envelope.dropped.find((x) => x.card_id === 'T-20260105-000001');
  assert.ok(d, '被剔除者必须出现在 dropped（带原因）');
  assert.equal(d.dropped_reason, 'live_status:done');
});

test('② H9 degrade：看板不可读 ⇒ fire:true（unconfirmed ⇒ alarm，绝不读作「无告警」）', () => {
  const root = newRoot();
  const { envelope, record } = S.decide(OPTS(root, { tasksDir: path.join(root.dir, 'nope') }));
  assert.equal(envelope.fire, true);
  assert.equal(envelope.state.reason, 'board-unreadable');
  assert.doesNotThrow(() => record());
});

// ── ③ 零成本空转（契约 §9.4 / 钩子 H8）──────────────────────────────────────────
test('③ 零成本空转：无跨档 ⇒ fire:false、alerts=[]、不写账本', () => {
  const root = newRoot();
  writeCard(root, progressCard({ heartbeat_at: '2026-01-05T02:55:00.000Z' })); // T=5 < warnAt(15)
  const { envelope, record } = S.decide(OPTS(root));
  assert.equal(envelope.fire, false);
  assert.deepEqual(envelope.alerts, []);
  record();
  assert.equal(fs.existsSync(root.ledgerFile), false, '零成本空转不得写账本');
  assert.equal(fs.existsSync(root.stateFile), true, 'liveness 标记仍须发布（§8.4）');
});

// ── ④ 去重记账（契约 §8.3 / 钩子 H3）────────────────────────────────────────────
test('④ 去重记账：同档重复观测不再告警；升档是新键（升级永不被去重）', () => {
  const root = newRoot();
  writeCard(root, progressCard({ status: 'blocked', blocked_at: '2026-01-05T00:30:00.000Z' }));
  const first = S.decide(OPTS(root));
  const firstBlocked = first.envelope.alerts.find((x) => x.sla_row === 'blocked_clarification');
  assert.ok(firstBlocked, 'blocked 卡必须命中 blocked_clarification');
  assert.equal(firstBlocked.severity, 'overdue');
  first.record();

  // 同一时点再扫 ⇒ 同档重复 ⇒ 不告警（且进 dropped/suppressed，审计可见）
  const second = S.decide(OPTS(root));
  assert.equal(second.envelope.alerts.length, 0);
  assert.equal(second.envelope.fire, false);
  assert.ok(second.envelope.dropped.some((d) => d.dropped_reason === 'duplicate'));
  assert.ok(second.envelope.state.counts.suppressed > 0);

  // 时钟推进到跨 escalate ⇒ **升档 = 新键** ⇒ 照常告警
  const later = Date.parse('2026-01-09T03:00:00.000Z');
  const third = S.decide(OPTS(root, { nowMs: later }));
  const a = third.envelope.alerts.find((x) => x.sla_row === 'blocked_clarification');
  assert.ok(a, '升档必须发新告警');
  assert.equal(a.severity, 'escalate');
  assert.notEqual(a.dedup_key, firstBlocked.dedup_key);
  assert.match(a.dedup_key, /#escalate@/);
});

test('④ 去重记账：状态变化（新等待）⇒ 新起点 ⇒ 重新告警（契约 §8.3 规则 1）', () => {
  const root = newRoot();
  writeCard(root, progressCard({ status: 'blocked', blocked_at: '2026-01-05T00:30:00.000Z' }));
  S.decide(OPTS(root)).record();
  // 卡被放行后重新 blocked（新的 blocked_at，同为 overdue 档）⇒ 新等待必须重新告警
  writeCard(root, progressCard({ status: 'blocked', blocked_at: '2026-01-05T00:00:00.000Z' }));
  const second = S.decide(OPTS(root));
  const a = second.envelope.alerts.find((x) => x.sla_row === 'blocked_clarification');
  assert.ok(a, '新等待必须重新告警（同档也不得被去重吞掉）');
  assert.equal(a.measure_start_at, '2026-01-05T00:00:00.000Z');
  assert.equal(a.severity, 'overdue');
});

// ── ⑤ 只提示 / 目标 leader / blocked_reason（契约 §7 / §9.1 / 钩子 H1）────────────
test('⑤ 升级目标恒为 leader；动作文案不含 operator 目标（H1）', () => {
  const root = newRoot();
  writeCard(root, progressCard({ status: 'blocked', blocked_at: '2025-12-31T01:00:00.000Z' })); // escalate
  const env = S.decide(OPTS(root)).envelope;
  assert.ok(env.alerts.length);
  for (const a of env.alerts) {
    assert.equal(a.target, 'leader');
    assert.ok(!/operator/i.test(a.action), `动作文案不得把 operator 当目标：${a.action}`);
  }
  assert.equal(env.alerts.find((x) => x.sla_row === 'blocked_clarification').severity, 'escalate');
});

test('⑤ §7.4 blocked_reason：dependency/external/resource ⇒ 只可见性（threshold_min=null, warn）', () => {
  const root = newRoot();
  writeCard(root, progressCard({ status: 'blocked', blocked_at: '2026-01-05T00:30:00.000Z', blocked_reason: 'dependency' }));
  const a = S.decide(OPTS(root)).envelope.alerts.find((x) => x.sla_row === 'blocked_clarification');
  assert.ok(a);
  assert.equal(a.threshold_min, null, 'PROTOCOL §15 无对应行 ⇒ 不造阈值');
  assert.equal(a.severity, 'warn');
  assert.equal(a.due_at, null);
  assert.equal(a.blocked_reason, 'dependency');
  // 未知枚举值 ⇒ 'unknown'（仍按 clarify 行告警，§7.3-3）
  const root2 = newRoot();
  writeCard(root2, progressCard({ status: 'blocked', blocked_at: '2026-01-05T00:30:00.000Z', blocked_reason: 'future_value' }));
  const b = S.decide(OPTS(root2)).envelope.alerts.find((x) => x.sla_row === 'blocked_clarification');
  assert.equal(b.blocked_reason, 'unknown');
  assert.equal(b.threshold_min, 120);
});

test('⑤ §7.4 可释放性提示：deps 全 done ⇒ releasable/deps_satisfied（仅提示）', () => {
  const root = newRoot();
  writeCard(root, progressCard({ status: 'blocked', blocked_at: '2026-01-05T00:30:00.000Z', blocked_reason: 'dependency', depends_on: '[T-20260101-000001]' }));
  writeCard(root, progressCard({ id: 'T-20260101-000001', status: 'done', heartbeat_at: '' }));
  const a = S.decide(OPTS(root)).envelope.alerts.find((x) => x.sla_row === 'blocked_clarification');
  assert.equal(a.releasable, true);
  assert.equal(a.releasable_basis, 'deps_satisfied');
  assert.match(a.action, /仅提示|不自动改状态/);
});

test('⑤ §9.1 只读：sla-scan.mjs 不调用任何写卡/改状态 ACL 入口', () => {
  const src = fs.readFileSync(path.join(SCRIPTS, 'sla-scan.mjs'), 'utf8');
  for (const banned of ['writeCardAtomic', 'claimCard', 'refreshHeartbeat', 'setStatus', 'serializeFrontmatter']) {
    assert.ok(!new RegExp(`[^a-zA-Z]${banned}\\s*\\(`).test(src), `巡检不得调用 ${banned}()（契约 §9.1）`);
  }
});

// ── ⑥ 接线（providers.json / dispatch fail-closed / trigger 形态）────────────────
test('⑥ providers.json：slaScan 指向 {team}/scripts/sla-scan.mjs（绝对路径 + {team} 占位）', () => {
  const p = JSON.parse(fs.readFileSync(path.join(TEAM_DIR, 'automations', 'providers.json'), 'utf8'));
  const entry = p['meerkat-taskpanel'].slaScan;
  assert.ok(entry, 'providers.json 必须声明 slaScan 入口');
  assert.match(entry, /\{team\}\/scripts\/sla-scan\.mjs$/);
});

test('⑥ dispatch：sla-scan 是 fail-closed 检测器（degrade ⇒ fire:true，§10.2）', async () => {
  const { firesOnDegrade, JOB_KEY } = await import('../../automations/dispatch.mjs').catch(() => ({}));
  const mod = await import('../../automations/dispatch.mjs');
  assert.equal(mod.firesOnDegrade('sla-scan'), true, '未确认的巡检必须告警，不得读作「无告警」');
  assert.equal(mod.firesOnDegrade('poll'), false);
  void firesOnDegrade;
  void JOB_KEY;
});

test('⑥ dispatch sla-scan 端到端：入口的 alerts 进 message；入口缺失 ⇒ fail-closed 告警', async () => {
  const mod = await import('../../automations/dispatch.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sla-dispatch-'));
  scratchDirs.push(dir);
  const entry = path.join(dir, 'entry.mjs');
  fs.writeFileSync(
    entry,
    'process.stdout.write(JSON.stringify({fire:true,alerts:[{sla_row:"blocked_clarification",card_id:"T-X"}],dropped:[],state:{job:"sla-scan"}})+"\\n");\n',
  );
  const EXIT = Symbol('exit');
  const run = (argv, env) => {
    const writes = [];
    const ow = process.stdout.write;
    const oe = process.exit;
    process.stdout.write = (c) => { writes.push(String(c)); return true; };
    process.exit = () => { throw EXIT; };
    try {
      mod.main(argv, env);
      assert.fail('main() 必须终止进程');
    } catch (e) {
      if (e !== EXIT) throw e;
    } finally {
      process.stdout.write = ow;
      process.exit = oe;
    }
    return JSON.parse(writes.join('').trim());
  };
  const fired = run(['sla-scan'], { OPENCLAW_TEAM_SLA_CMD: `node ${entry}` });
  assert.equal(fired.fire, true);
  assert.match(fired.message, /\[sla-scan\] SLA alerts/);
  assert.equal(fired.state.job, 'sla-scan');
  // 入口不可执行 ⇒ degrade，但检测器 fail-closed ⇒ fire:true（绝不读作「无告警」）
  const degraded = run(['sla-scan'], { OPENCLAW_TEAM_SLA_CMD: `node ${path.join(dir, 'nope.mjs')}` });
  assert.equal(degraded.fire, true);
  assert.equal(degraded.state.job, 'sla-scan');
  assert.match(degraded.message, /UNCONFIRMED/);
});

test('⑥ install.sh：注册 sla-scan（interval + trigger 形态），且 cadence 与 P 一致', () => {
  const install = fs.readFileSync(path.join(REPO, 'install.sh'), 'utf8');
  assert.match(install, /openclaw-team:sla-scan/, 'manifest 必须声明 sla-scan 的 declarationKey');
  assert.match(install, /sla-scan\)\s*register_automation[^\n]*--every "\$SLA_INTERVAL"/, 'sla-scan 走 interval 注册（沿用现形态）');
});

test('⑥ AUTOMATIONS.md 记录了 sla-scan 与 G-6 cadence 口径对齐', () => {
  const doc = fs.readFileSync(path.join(TEAM_DIR, 'AUTOMATIONS.md'), 'utf8');
  assert.match(doc, /sla-scan/);
  assert.match(doc, /G-6|口径对齐|cadence/);
});

// ── ⑦ 阈值单一来源（契约 §11 钩子 H6）──────────────────────────────────────────
test('⑦ 运行期阈值表直接来自 sla-thresholds.json（代码里没有第二份数字）', () => {
  const json = JSON.parse(fs.readFileSync(path.join(REPO, 'team/guides/sla-thresholds.json'), 'utf8'));
  const pick = (r) => ({ row: r.row, slaRef: r.slaRef, thresholdRef: r.thresholdRef, normalMin: r.normalMin, furtherMin: r.furtherMin });
  assert.deepEqual(S.SLA_ROWS.map(pick), json.rows.map(pick));
  assert.equal(S.SLA_ROWS.length, 6);
  assert.deepEqual({ ...S.LIVENESS_ROW }, { ...json.liveness });
});

test('⑦ check-sla-thresholds：真文件绿；坏文件红；缺文件红（绝不假绿）', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sla-thr-'));
  scratchDirs.push(tmp);
  const dir = path.join(tmp, 'team', 'guides');
  fs.mkdirSync(dir, { recursive: true });
  const real = fs.readFileSync(path.join(REPO, 'team/guides/sla-thresholds.json'), 'utf8');
  const run = (root) => spawnSync(process.execPath, [path.join(SCRIPTS, 'check-sla-thresholds.mjs'), '--repo', root, '--json'], { encoding: 'utf8' });
  fs.writeFileSync(path.join(dir, 'sla-thresholds.json'), real, 'utf8');
  let r = run(tmp);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(JSON.parse(r.stdout).ok, true);
  const broken = JSON.parse(real);
  broken.rows[0].furtherMin = broken.rows[0].normalMin;
  fs.writeFileSync(path.join(dir, 'sla-thresholds.json'), JSON.stringify(broken), 'utf8');
  r = run(tmp);
  assert.equal(r.status, 1, 'furtherMin <= normalMin 必须红');
  fs.rmSync(path.join(dir, 'sla-thresholds.json'));
  r = run(tmp);
  assert.equal(r.status, 1, '缺文件必须红（绝不假绿）');
});

// ── CLI（端到端：真子进程、隔离 team root、恰一行 JSON、exit 0）────────────────────
test('CLI：真子进程跑一次巡检 —— exit 0、恰一行 JSON、信封键恰为 {fire,alerts,dropped,state}', () => {
  const root = newRoot();
  writeCard(root, progressCard({ status: 'blocked', blocked_at: '2026-01-05T00:30:00.000Z' }));
  const r = spawnSync(process.execPath, [path.join(SCRIPTS, 'sla-scan.mjs'), '--now', '2026-01-05T03:00:00.000Z'], {
    encoding: 'utf8',
    env: { ...process.env, OPENCLAW_TASK_OPS_DIR: PROVIDER, OPENCLAW_TEAM_ROOT: root.dir },
  });
  assert.equal(r.status, 0, `exit 0（「无告警」绝不是失败）：${r.stderr}`);
  const lines = r.stdout.trim().split('\n');
  assert.equal(lines.length, 1, 'stdout 恰一行 JSON');
  const env = JSON.parse(lines[0]);
  assert.deepEqual(Object.keys(env).sort(), ['alerts', 'dropped', 'fire', 'state']);
  assert.equal(env.fire, true);
  // 该卡命中 blocked_clarification（外加 board 级的 leader_stalled：看板确有 leader 待动作）
  assert.ok(env.alerts.some((a) => a.sla_row === 'blocked_clarification' && a.card_id === 'T-20260105-000001'));
  // 账本 / liveness 落在隔离 root 内（绝不写 repo 或 live team root）
  assert.equal(fs.existsSync(path.join(root.dir, '.sla-scan-ledger.json')), true);
  assert.equal(fs.existsSync(path.join(root.dir, '.sla-scan-state.json')), true);

  // --recheck：对在手信封按现态重核（快照不可读 ⇒ fire:true 而非静默）
  const snap = path.join(root.dir, 'snap.json');
  fs.writeFileSync(snap, JSON.stringify(env));
  const rc = spawnSync(process.execPath, [path.join(SCRIPTS, 'sla-scan.mjs'), '--recheck', snap, '--now', '2026-01-05T03:00:00.000Z'], {
    encoding: 'utf8',
    env: { ...process.env, OPENCLAW_TASK_OPS_DIR: PROVIDER, OPENCLAW_TEAM_ROOT: root.dir },
  });
  assert.equal(rc.status, 0);
  assert.ok(
    JSON.parse(rc.stdout.trim()).alerts.some((a) => a.sla_row === 'blocked_clarification'),
    '现态未变的快照必须存活',
  );
  const bad = spawnSync(process.execPath, [path.join(SCRIPTS, 'sla-scan.mjs'), '--recheck', path.join(root.dir, 'nope.json')], {
    encoding: 'utf8',
    env: { ...process.env, OPENCLAW_TASK_OPS_DIR: PROVIDER, OPENCLAW_TEAM_ROOT: root.dir },
  });
  assert.equal(JSON.parse(bad.stdout.trim()).state.reason, 'snapshot_unreadable');
});
