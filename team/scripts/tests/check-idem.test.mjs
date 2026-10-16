#!/usr/bin/env node
/**
 * check-idem.test.mjs — 建卡幂等巡检口径收口测试（T-20261010-064006-2；T-20261014-214625 细化）
 *
 * 重点（红→绿负例）：**同 parent + 同 assignee + 同 target 的兄弟卡**在旧口径下机械键相同 ⇒ 被误判
 * duplicates；新口径判红依据收窄为「组内是否有非空 review_of」单一判据 ⇒ parent 派生组（含共享非空 target）
 * 降级为非阻断 hints（退出码 0）。真重复（组内有非空 review_of）仍判红。
 * 口径依据：scripts/check-idem.mjs 头部注释；PROTOCOL §㉙.8；guides/task-interface.md §14。
 *
 * 风格：核心逻辑直接 import `scanIdem(dir)`（注入 mkdtemp 隔离目录）取行/分支覆盖；退出码/输出另
 * spawn 子进程验证（OPENCLAW_TEAM_ROOT 指向隔离 root，**绝不碰真实看板**）。
 *
 * provider 依赖：`check-idem.mjs` 与 `skills/task-ops/lib/task.mjs` 均属 provider（有意不随仓，见
 * skills/PROVENANCE.md），只能在**已部署**布局下执行。缺 provider 时**整体 SKIP**（与
 * sched-vendored-poll.test.mjs 同契约），而非 import 期 ERR_MODULE_NOT_FOUND 硬红。
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHECK_IDEM = path.join(HERE, '..', 'check-idem.mjs');

/** 定位携带 ACL 库的 provider 安装目录（与 sched-vendored-poll.test.mjs 同口径）。 */
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

// provider 依赖为**条件动态 import**：仓内 team/skills 有意不 vendor，静态相对导入在缺 provider 时
// import 期即 ERR_MODULE_NOT_FOUND 硬红。仅当 PROVIDER 存在时加载，缺则保持 undefined（对应测试
// 全部 { skip: SKIP }，不会执行到）。顶层 await 合法（ESM）。
let scanIdem, SIBLING_HINT_REASON, idemKey, BASELINE_PATH, RUNTIME_BASELINE_NAME, loadBaseline, loadExemptions, runtimeBaselinePath;
if (PROVIDER) {
  // 先设 env：check-idem.mjs → lib.mjs 经 OPENCLAW_TASK_OPS_DIR 解析 provider，须在 import 前就位。
  process.env.OPENCLAW_TASK_OPS_DIR = PROVIDER;
  ({ scanIdem, SIBLING_HINT_REASON, BASELINE_PATH, RUNTIME_BASELINE_NAME, loadBaseline, loadExemptions, runtimeBaselinePath } = await import('../check-idem.mjs'));
  ({ idemKey } = await import(pathToFileURL(path.join(PROVIDER, 'lib', 'task.mjs')).href));
}

const TMP = [];
after(() => { for (const r of TMP) fs.rmSync(r, { recursive: true, force: true }); });

/** 卡序列化：列表写数组，其余写原值（空 target 写 `target: ` ⇒ 解析为 ''） */
function cardText(fm) {
  const lines = ['---'];
  for (const [k, v] of Object.entries(fm)) {
    if (Array.isArray(v)) lines.push(`${k}: [${v.join(', ')}]`);
    else lines.push(`${k}: ${v}`);
  }
  lines.push('---', '', '## Background', 'x', '## Report', '');
  return lines.join('\n');
}

/** 建隔离 root（tasks/ + workspace/）→ 返回 root 路径 */
function mkRoot(cards) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-idem-'));
  TMP.push(root);
  const T = path.join(root, 'tasks');
  fs.mkdirSync(T, { recursive: true });
  fs.mkdirSync(path.join(root, 'workspace'), { recursive: true });
  for (const c of cards) fs.writeFileSync(path.join(T, `${c.id}.md`), cardText(c), 'utf8');
  return root;
}

const tasksOf = (root) => path.join(root, 'tasks');

/** 卡工厂：默认非终态 task，assignee linus；target/review_of/parent 默认空 */
const card = (id, extra = {}) => ({
  id, title: `t-${id}`, assignee: 'linus', status: 'ready', kind: 'task', project: '__team__', ...extra,
});

/** 跑 CLI，返回 { code, out, err }（out/err 为字符串，不 throw） */
function runCli(root, args = []) {
  const r = spawnSync(process.execPath, [CHECK_IDEM, ...args], {
    encoding: 'utf8',
    env: { ...process.env, OPENCLAW_TEAM_ROOT: root, OPENCLAW_TASK_OPS_DIR: PROVIDER },
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

/**
 * 旧口径复现（**仅用于红→绿取证**）：按机械键分组、组内非终态 >1 即判 duplicates。
 * 与改前 check-idem 的 `scanIdem` 分组/判红逻辑等价（不解析键字符串之外任何字段）。
 */
function oldDuplicates(cards) {
  const groups = new Map();
  for (const c of cards) {
    const key = idemKey(c);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c.id);
  }
  return [...groups.entries()].filter(([, ids]) => ids.length > 1).map(([key, ids]) => ({ key, ids }));
}

const SIBLINGS = [
  card('T-20260101-100000-a', { parent: 'T-20260101-090000-epic' }),
  card('T-20260101-100001-b', { parent: 'T-20260101-090000-epic', status: 'in_progress' }),
];

// ---- 红→绿：同 parent 同 assignee 空 target 的兄弟卡 ----

test('红→绿：兄弟卡（同 parent/assignee、空 target）旧口径误报、新口径不判 duplicates', { skip: SKIP }, () => {
  // 旧口径复现：两卡机械键相同 ⇒ 旧代码会判 1 组 duplicates（= 误报的「红」）
  const red = oldDuplicates(SIBLINGS);
  assert.equal(red.length, 1, '旧口径应按机械键撞车判红（红条件复现）');
  assert.equal(idemKey(SIBLINGS[0]), idemKey(SIBLINGS[1]), '兄弟卡 mech key 必须相同');
  assert.equal(red[0].key, 'task | linus | T-20260101-090000-epic | ');

  // 新口径：不再判 duplicates，降级为非阻断 hint（= 修复后的「绿」）
  const r = scanIdem(tasksOf(mkRoot(SIBLINGS)));
  assert.equal(r.ok, true);
  assert.equal(r.duplicates.length, 0, `兄弟卡不应判红：${JSON.stringify(r.duplicates)}`);
  assert.equal(r.exempt.length, 0);
  assert.equal(r.hints.length, 1, '应降级为 1 组 hints（仍可见，非静默丢弃）');
  assert.equal(r.hints[0].idem, 'task | linus | T-20260101-090000-epic | ');
  assert.equal(r.hints[0].reason, SIBLING_HINT_REASON);
  assert.deepEqual(r.hints[0].cards.map((c) => c.id).sort(), ['T-20260101-100000-a', 'T-20260101-100001-b']);
});

test('红→绿：CLI 对兄弟卡退出 0（无违例报文），stdout 含 hints 明细', { skip: SKIP }, () => {
  const root = mkRoot(SIBLINGS);
  const { code, out, err } = runCli(root);
  assert.equal(code, 0, `兄弟卡不应置退出码 1；stderr=${err}`);
  const parsed = JSON.parse(out);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.duplicates.length, 0);
  assert.equal(parsed.hints.length, 1);
  assert.match(err, /建卡幂等提示/, '应打印非阻断提示');
  assert.doesNotMatch(err, /建卡幂等违例/, '不应打印违例');
});

test('兄弟卡数量扩充（3 张空 target）仍仅提示、不判红', { skip: SKIP }, () => {
  const r = scanIdem(tasksOf(mkRoot([
    ...SIBLINGS,
    card('T-20260101-100002-c', { parent: 'T-20260101-090000-epic', status: 'blocked' }),
  ])));
  assert.equal(r.duplicates.length, 0);
  assert.equal(r.hints.length, 1);
  assert.equal(r.hints[0].cards.length, 3);
});

// ---- 真重复（红）必须保持 ----

test('真重复：同 review_of + 同 assignee + 同 target ⇒ 仍判 duplicates（退出 1）', { skip: SKIP }, () => {
  const dup = [
    card('T-20260101-110000-a', { review_of: 'T-20260101-000000-src', target: '/x' }),
    card('T-20260101-110001-b', { review_of: 'T-20260101-000000-src', target: '/x', status: 'in_review' }),
  ];
  const root = mkRoot(dup);
  const r = scanIdem(tasksOf(root));
  assert.equal(r.hints.length, 0, 'review_of 有实义 ⇒ 不入 hints');
  assert.equal(r.duplicates.length, 1);
  assert.equal(r.duplicates[0].idem, 'task | linus | T-20260101-000000-src | /x');
  assert.equal(r.duplicates[0].cards.length, 2);

  const { code, out, err } = runCli(root);
  assert.equal(code, 1, `真重复应置退出码 1；stdout=${out}`);
  assert.equal(JSON.parse(out).duplicates.length, 1);
  assert.match(err, /建卡幂等违例/);
  // --no-baseline 对真重复等价（基线为空 ⇒ 不豁免）
  assert.equal(runCli(root, ['--no-baseline']).code, 1);
});

// ---- T-20261014-214625 细化：target 不再是 parent 派生组的区分信号 ----
// 同一 parent 的子卡共享 target 是常态（同一项目的多个子任务）⇒ 非空同 target 对 parent 派生组无区分信息
// ⇒ 即便 target 非空也降 hints。判红依据收窄为「组内是否有非空 review_of」。口径见 check-idem.mjs 头注
// 「target 不再是 parent 派生组的区分信号」。
// 本组取代 081140 的「非空 target 不降级」；081140 的「同人同目标 ⇒ 真重复倾向」在 **review_of 组**仍成立（见下 ③）。

test('回归①：同 parent + 同**非空** target 的兄弟卡 ⇒ hints（非阻断，exit 0）', { skip: SKIP }, () => {
  const root = mkRoot([
    card('T-20260101-120000-a', { parent: 'T-20260101-090000-epic', target: '/repo/meerkat' }),
    card('T-20260101-120001-b', { parent: 'T-20260101-090000-epic', target: '/repo/meerkat' }),
  ]);
  const r = scanIdem(tasksOf(root));
  assert.equal(r.duplicates.length, 0, 'parent 派生组共享 target 属常态 ⇒ 不得判红');
  assert.equal(r.hints.length, 1, '应降级为 1 组非阻断 hints');
  assert.equal(r.hints[0].idem, 'task | linus | T-20260101-090000-epic | /repo/meerkat');
  assert.equal(r.hints[0].reason, SIBLING_HINT_REASON);

  // 退出码契约：仅 hints ⇒ 0
  const { code, out, err } = runCli(root);
  assert.equal(code, 0, `parent 派生兄弟卡（非空同 target）应退出 0；stderr=${err}`);
  const parsed = JSON.parse(out);
  assert.equal(parsed.duplicates.length, 0);
  assert.equal(parsed.hints.length, 1);
  assert.doesNotMatch(err, /建卡幂等违例/, '不得打印违例');
  assert.match(err, /建卡幂等提示/, '应打印非阻断提示');
});

test('回归②：同 parent + 同 target + 同 review_of ⇒ duplicates（显式复核仍红，exit 1）', { skip: SKIP }, () => {
  const root = mkRoot([
    card('T-20260101-122000-a', { parent: 'T-20260101-090000-epic', review_of: 'T-20260101-090000-epic', target: '/repo/meerkat' }),
    card('T-20260101-122001-b', { parent: 'T-20260101-090000-epic', review_of: 'T-20260101-090000-epic', target: '/repo/meerkat', status: 'in_review' }),
  ]);
  const r = scanIdem(tasksOf(root));
  assert.equal(r.hints.length, 0, 'review_of 有实义 ⇒ 不入 hints');
  assert.equal(r.duplicates.length, 1);
  assert.equal(r.duplicates[0].idem, 'task | linus | T-20260101-090000-epic | /repo/meerkat');

  const { code, out, err } = runCli(root);
  assert.equal(code, 1, `显式复核同卡应置退出码 1；stderr=${err}`);
  assert.equal(JSON.parse(out).duplicates.length, 1);
  assert.match(err, /建卡幂等违例/);
});

test('回归③：非父子（review_of 派生，无 parent）+ 同人同 target ⇒ 维持 duplicates（不回归 081140 意图）', { skip: SKIP }, () => {
  const cards = [
    card('T-20260101-123000-a', { review_of: 'T-20260101-000000-rsrc', target: '/repo/meerkat' }),
    card('T-20260101-123001-b', { review_of: 'T-20260101-000000-rsrc', target: '/repo/meerkat', status: 'in_progress' }),
  ];
  // 非父子：无 parent 字段，source 完全由 review_of 派生 ⇒ 键的 source 段 = review_of 值
  assert.equal(idemKey(cards[0]), 'task | linus | T-20260101-000000-rsrc | /repo/meerkat');
  const r = scanIdem(tasksOf(mkRoot(cards)));
  assert.equal(r.hints.length, 0);
  assert.equal(r.duplicates.length, 1, 'review_of 组的「同人同目标 ⇒ 真重复倾向」不因 parent 组降级而回归（081140 意图保留）');
  assert.equal(r.duplicates[0].idem, 'task | linus | T-20260101-000000-rsrc | /repo/meerkat');
});

test('边界：同 parent 但**不同**非空 target ⇒ 键不同、不分组（target 仍参与键，决定是否同组）', { skip: SKIP }, () => {
  const r = scanIdem(tasksOf(mkRoot([
    card('T-20260101-121000-a', { parent: 'T-20260101-090000-epic', target: '/repo/meerkat' }),
    card('T-20260101-121001-b', { parent: 'T-20260101-090000-epic', target: '/repo/other' }),
  ])));
  assert.equal(r.hints.length, 0);
  assert.equal(r.duplicates.length, 0, '不同 target ⇒ 键不同 ⇒ 根本不分组');
});

test('边界：兄弟卡组内一张带 review_of ⇒ 整组升为真重复（任一卡有信号即红）', { skip: SKIP }, () => {
  const r = scanIdem(tasksOf(mkRoot([
    card('T-20260101-130000-a', { parent: 'T-20260101-090000-epic' }),
    card('T-20260101-130001-b', { parent: 'T-20260101-090000-epic', review_of: 'T-20260101-090000-epic' }),
  ])));
  assert.equal(r.hints.length, 0);
  assert.equal(r.duplicates.length, 1);
});

test('边界：同 assignee/空 target 但 parent 不同 ⇒ 键不同、不分组（既有无 source 口径不回退）', { skip: SKIP }, () => {
  const r = scanIdem(tasksOf(mkRoot([
    card('T-20260101-140000-a', { parent: 'T-20260101-090000-e1' }),
    card('T-20260101-140001-b', { parent: 'T-20260101-090000-e2' }),
  ])));
  assert.equal(r.duplicates.length, 0);
  assert.equal(r.hints.length, 0);
});

test('回归：无 source（无 review_of 且无 parent）不产键 ⇒ 同人同 target 两张也不判重', { skip: SKIP }, () => {
  const cards = [
    card('T-20260101-150000-a', { target: '/x' }),
    card('T-20260101-150001-b', { target: '/x' }),
  ];
  assert.equal(idemKey(cards[0]), '', '无 source 应返回空键');
  const r = scanIdem(tasksOf(mkRoot(cards)));
  assert.equal(r.duplicates.length, 0);
  assert.equal(r.hints.length, 0);
});

// ---- 基线豁免机制不受收口影响 ----

test('基线：review_of 真重复组注入匹配基线 ⇒ exempt、不判红（机制保留）', { skip: SKIP }, () => {
  const root = mkRoot([
    card('T-20260101-160000-a', { review_of: 'T-20260101-000000-bsrc', target: '/x' }),
    card('T-20260101-160001-b', { review_of: 'T-20260101-000000-bsrc', target: '/x', status: 'in_review' }),
  ]);
  const key = 'task | linus | T-20260101-000000-bsrc | /x';
  const r = scanIdem(tasksOf(root), { baseline: [{ key, ids: ['T-20260101-160001-b', 'T-20260101-160000-a'], reason: '注入组' }] });
  assert.equal(r.duplicates.length, 0, '命中基线 ⇒ 不判红');
  assert.equal(r.exempt.length, 1);
  assert.equal(r.exempt[0].key, key);
  // 集合变化（加第 3 张）⇒ 豁免失效、重判红
  fs.writeFileSync(path.join(tasksOf(root), 'T-20260101-160002-c.md'),
    cardText(card('T-20260101-160002-c', { review_of: 'T-20260101-000000-bsrc', target: '/x', status: 'blocked' })), 'utf8');
  const drift = scanIdem(tasksOf(root), { baseline: [{ key, ids: ['T-20260101-160001-b', 'T-20260101-160000-a'], reason: '注入组' }] });
  assert.equal(drift.exempt.length, 0);
  assert.equal(drift.duplicates.length, 1);
});

test('基线/hints 解耦：兄弟卡组不消耗基线豁免；同 root 内真重复组照常红', { skip: SKIP }, () => {
  const root = mkRoot([
    ...SIBLINGS,
    card('T-20260101-170000-a', { review_of: 'T-20260101-000000-csrc', target: '/y' }),
    card('T-20260101-170001-b', { review_of: 'T-20260101-000000-csrc', target: '/y' }),
  ]);
  const bkey = 'task | linus | T-20260101-000000-csrc | /y';
  // 只给真重复组登记基线 ⇒ 兄弟卡仍为 hint（非阻断，无需登记），真重复组豁免
  const r = scanIdem(tasksOf(root), { baseline: [{ key: bkey, ids: ['T-20260101-170000-a', 'T-20260101-170001-b'], reason: '注入组' }] });
  assert.equal(r.hints.length, 1);
  assert.equal(r.exempt.length, 1);
  assert.equal(r.duplicates.length, 0);
  // 不注入基线（等价空/退役基线）⇒ 真重复组判红，兄弟卡仍仅提示
  const plain = scanIdem(tasksOf(root), { baseline: [] });
  assert.equal(plain.hints.length, 1);
  assert.equal(plain.duplicates.length, 1);
  assert.equal(plain.duplicates[0].idem, bkey);
});

// ---- 登记来源解耦（T-20261014-131423）：托管模板 ① ∪ 运行时登记 ② ----
// 契约动机：一个文件不能同时是「install.sh 部署托管物」与「运行时可变登记处」——登记会被升级清回，
// 且在清回前就令 provider 契约测试 idem.test.mjs:483（钉实例模板 groups 空）fail-closed 转红。
// 解耦后：① 托管模板只读（仓内不得夹带豁免）；② 运行时登记落在**被巡检 tasks 目录**内（不随部署）。

const DUP_A = [
  card('T-20260101-200000-a', { review_of: 'T-20260101-000000-xsrc', target: '/x' }),
  card('T-20260101-200001-b', { review_of: 'T-20260101-000000-xsrc', target: '/x', status: 'in_review' }),
];
const KEY_A = 'task | linus | T-20260101-000000-xsrc | /x';
/** 把登记写进运行时登记文件（②）：位于被巡检 tasks 目录内 */
const registerRuntime = (root, groups) => fs.writeFileSync(
  runtimeBaselinePath(tasksOf(root)), `${JSON.stringify({ groups }, null, 2)}\n`, 'utf8');

test('解耦：运行时登记（tasks/.idem-baseline.json）经默认读生效 ⇒ exempt、不判红、CLI 退出 0', { skip: SKIP }, () => {
  const root = mkRoot(DUP_A);
  registerRuntime(root, [{ key: KEY_A, ids: ['T-20260101-200001-b', 'T-20260101-200000-a'], reason: '运行时登记' }]);

  const r = scanIdem(tasksOf(root));           // 不注入 baseline：走默认（① ∪ ②）
  assert.equal(r.duplicates.length, 0, '运行时登记应生效（豁免）');
  assert.equal(r.exempt.length, 1);
  assert.equal(r.exempt[0].key, KEY_A);
  assert.equal(r.exempt[0].reason, '运行时登记');

  const { code, out, err } = runCli(root);
  assert.equal(code, 0, `运行时登记后不应判红；stderr=${err}`);
  assert.equal(JSON.parse(out).exempt.length, 1);
  assert.match(err, /建卡幂等基线豁免/, '应打印豁免明细');
  assert.doesNotMatch(err, /建卡幂等违例/);

  // 解耦不变量（a）：托管模板保持退役空 —— 运行时登记**绝不**写仓内模板（写了必被下次部署清回）
  assert.deepEqual(loadBaseline(BASELINE_PATH), [], '托管模板必须保持 groups 空（只读）');
  // 解耦不变量（b）：运行时登记落在被巡检 tasks 目录内，且在部署托管的 scripts/ 之外
  assert.equal(RUNTIME_BASELINE_NAME, '.idem-baseline.json');
  assert.equal(runtimeBaselinePath(tasksOf(root)), path.join(tasksOf(root), '.idem-baseline.json'));
  assert.ok(
    !path.resolve(runtimeBaselinePath(tasksOf(root))).startsWith(`${path.resolve(path.dirname(BASELINE_PATH))}${path.sep}`),
    '运行时登记不得落在部署托管目录（本文件所在 scripts/）内'
  );
});

test('解耦：运行时登记集合漂移（加第 3 张）⇒ 豁免失效、仍判红退出 1', { skip: SKIP }, () => {
  const root = mkRoot(DUP_A);
  registerRuntime(root, [{ key: KEY_A, ids: ['T-20260101-200000-a', 'T-20260101-200001-b'], reason: '运行时登记' }]);
  assert.equal(scanIdem(tasksOf(root)).exempt.length, 1, '集合一致 ⇒ 豁免');
  fs.writeFileSync(path.join(tasksOf(root), 'T-20260101-200002-c.md'),
    cardText(card('T-20260101-200002-c', { review_of: 'T-20260101-000000-xsrc', target: '/x', status: 'blocked' })), 'utf8');
  const r = scanIdem(tasksOf(root));
  assert.equal(r.exempt.length, 0, 'id 集合变化 ⇒ 运行时登记同样失效（防「登记一次、永久放行」）');
  assert.equal(r.duplicates.length, 1);
  assert.equal(runCli(root).code, 1);
});

test('解耦区分力：一组已登记豁免的同时，**另一组**未登记真重复仍判红（exit 1）', { skip: SKIP }, () => {
  const root = mkRoot([
    ...DUP_A,
    card('T-20260101-210000-a', { review_of: 'T-20260101-000000-ysrc', target: '/y' }),
    card('T-20260101-210001-b', { review_of: 'T-20260101-000000-ysrc', target: '/y', status: 'in_progress' }),
  ]);
  registerRuntime(root, [{ key: KEY_A, ids: ['T-20260101-200000-a', 'T-20260101-200001-b'], reason: '运行时登记' }]);
  const r = scanIdem(tasksOf(root));
  assert.equal(r.exempt.length, 1, '已登记组豁免');
  assert.equal(r.duplicates.length, 1, '未登记组照常判红 —— 登记不放行全量');
  assert.equal(r.duplicates[0].idem, 'task | linus | T-20260101-000000-ysrc | /y');
  const { code, out } = runCli(root);
  assert.equal(code, 1, '有未登记的 duplicates ⇒ 退出码仍为 1');
  const parsed = JSON.parse(out);
  assert.equal(parsed.exempt.length, 1);
  assert.equal(parsed.duplicates.length, 1);
  // --no-baseline 忽略两源 ⇒ 两组都判红
  assert.equal(scanIdem(tasksOf(root), { baseline: [] }).duplicates.length, 2);
  assert.equal(runCli(root, ['--no-baseline']).code, 1);
});

test('解耦合取：① 托管模板 与 ② 运行时登记 双双参与（两源参数可注入，不触碰仓内模板）', { skip: SKIP }, () => {
  const root = mkRoot(DUP_A);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-idem-src-'));   // TMP 回收
  TMP.push(dir);
  const tpl = path.join(dir, 'template.json');
  const rt = path.join(dir, 'runtime.json');
  fs.writeFileSync(tpl, JSON.stringify({ groups: [{ key: KEY_A, ids: ['T-20260101-200000-a', 'T-20260101-200001-b'], reason: '模板' }] }), 'utf8');
  assert.equal(loadExemptions(tasksOf(root), { template: tpl, runtime: rt }).length, 1, '仅模板有登记');
  fs.writeFileSync(rt, JSON.stringify({ groups: [{ key: 'k2', ids: ['x', 'y'], reason: '运行时' }] }), 'utf8');
  const both = loadExemptions(tasksOf(root), { template: tpl, runtime: rt });
  assert.equal(both.length, 2, '两源合取（模板 ∪ 运行时）');
  assert.deepEqual(both.map((g) => g.reason), ['模板', '运行时']);
  // 两源皆缺/损坏 ⇒ 视为空（不报错）
  assert.deepEqual(loadExemptions(tasksOf(root), { template: path.join(dir, 'nope.json'), runtime: path.join(dir, 'nope2.json') }), []);
});

// ---- 终态卡不参与分组 ----

test('终态卡不入组：两张兄弟卡其中一张 done ⇒ 不产 hint、不判红', { skip: SKIP }, () => {
  const r = scanIdem(tasksOf(mkRoot([
    card('T-20260101-180000-a', { parent: 'T-20260101-090000-epic' }),
    card('T-20260101-180001-b', { parent: 'T-20260101-090000-epic', status: 'done' }),
  ])));
  assert.equal(r.duplicates.length, 0);
  assert.equal(r.hints.length, 0);
});
