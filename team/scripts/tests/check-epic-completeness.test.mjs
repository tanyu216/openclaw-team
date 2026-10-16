#!/usr/bin/env node
/**
 * check-epic-completeness.test.mjs — 建卡完备性门禁测试（T-20261012-171026-2）
 *
 * 覆盖三层：
 *  ① 纯函数：`parseLedgerTables`（台账表识别）/ `extractCardIds` / `hasExplicitReason`；
 *  ② **RED→GREEN 变异**（本卡 Acceptance 明列）：对**每条硬规则**——**删除/破坏被断言的事实**
 *     （删掉被引用的卡 / 拆掉 parent 链接 / 抹掉「未建卡理由」）⇒ **必红**；**还原 ⇒ 绿**。
 *     另有**源级变异**：把判定行 `if (!cards.has(c))` 改成 `if (false)` 后，同一坏板**不再红**
 *     ⇒ 证明该断言承重（不是摆设）；未变异副本对同一坏板**必红**。
 *  ③ CLI：通过 ⇒ 退出 0；硬违例 ⇒ 退出 1；**软告警（含悬空路线图巡检）⇒ 退出 0**（不改退出码）。
 *
 * provider ACL 库有意不随仓（skills/PROVENANCE.md）⇒ 与本目录其它脚本测试同款条件 import：
 * 无 provider 时整文件 skip。核心逻辑直接 import `checkEpicCompleteness(...)`（注入隔离目录）。
 */
import { test as nodeTest, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** 定位携带 ACL 库的 provider 安装目录（与 check-relations.test.mjs 同口径）。 */
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

// provider 依赖为**条件动态 import**：缺 provider 时 lib.mjs 在 import 期即硬红。
let mod;
if (PROVIDER) {
  process.env.OPENCLAW_TASK_OPS_DIR = PROVIDER;
  mod = await import('../check-epic-completeness.mjs');
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, '..', 'check-epic-completeness.mjs');
/**
 * 把源码里**所有**相对 `./x.mjs` 依赖绝对化。源级变异会把副本写进临时目录，那里解不出相对依赖
 * （原先只硬编码改写 `./lib.mjs` ⇒ 每新增一个同级 import 都会让变异用例莫名其妙地红）。
 */
const absolutizeImports = (src) => src.replace(/from '(\.\/[^']+)'/g, (_m, rel) => `from '${path.join(HERE, '..', rel)}'`);

const TMP = [];
after(() => { for (const r of TMP) fs.rmSync(r, { recursive: true, force: true }); });

// 卡 id 形状归 task provider（本仓不再定义）；这里用 T- 形态只是「当前基座的样例数据」，
// 门禁的判据是「像某个**看板派生**命名空间下的 id」，不是形状。
const EPIC = 'T-20261012-171026';
const C1 = 'T-20261012-171026-2';
const C2 = 'T-20261012-171026-3';
const GHOST = 'T-20261012-171026-9';   // 合法形态但不存在

/** 卡序列化（与 check-relations.test.mjs 同形）：数组写 [a, b]，其余写原值。 */
function card(fm) {
  const lines = ['---'];
  for (const [k, v] of Object.entries(fm)) {
    if (Array.isArray(v)) lines.push(`${k}: [${v.join(', ')}]`);
    else lines.push(`${k}: ${v}`);
  }
  lines.push('---', '', '## Report', '');
  return lines.join('\n');
}
const epic = (id = EPIC, extra = {}) => ({ id, title: id, assignee: 'elon', status: 'ready', kind: 'epic', project: '__team__', target: '/x', ...extra });
const task = (id, extra = {}) => ({ id, title: id, assignee: 'linus', status: 'ready', kind: 'task', project: '__team__', target: '/x', ...extra });

/** 台账（阶段 | 卡 | 状态）；m2card 缺省 = 真子卡 C2（绿）；传 GHOST/''/'-' 造红。 */
const LEDGER = (m2card = C2, m2phase = 'M1 实现') => [
  '## 阶段台账（路线图 × 卡 对账）',
  '| 阶段 | 卡 | 状态 |',
  '|---|---|---|',
  `| M0 契约 | ${C1} | done |`,
  `| ${m2phase} | ${m2card} | todo |`,
  '',
].join('\n');

/**
 * 建隔离 root（tasks/ + workspace/）→ 跑 checkEpicCompleteness。
 * @param {object[]} cards 卡 frontmatter
 * @param {object[]} [bodies] { id, body } 台账写这里（替换末尾 `## Report`）
 * @param {object[]} [docs]   { rel, text } workspace 文档（相对 workspace/）
 */
function run(cards, bodies = [], docs = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-epic-'));
  TMP.push(root);
  const T = path.join(root, 'tasks');
  const W = path.join(root, 'workspace');
  fs.mkdirSync(T, { recursive: true });
  fs.mkdirSync(W, { recursive: true });
  const bodyOf = new Map(bodies.map((b) => [b.id, b.body]));
  for (const c of cards) {
    const raw = bodyOf.has(c.id) ? card(c).replace(/## Report\n$/, `${bodyOf.get(c.id)}\n`) : card(c);
    fs.writeFileSync(path.join(T, `${c.id}.md`), raw, 'utf8');
  }
  for (const d of docs) {
    const p = path.join(W, d.rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, d.text, 'utf8');
  }
  const r = mod.checkEpicCompleteness({ tasksDir: T, workspaceDir: W, root });
  return { ...r, root, tasksDir: T, workspaceDir: W };
}

const hasBad = (r, frag) => r.bad.some((b) => b.includes(frag));
const hasWarn = (r, frag) => r.warn.some((w) => w.includes(frag));
const hasNote = (r, tag, frag = '') => r.notes.some((n) => n.tag === tag && (n.source || '').includes(frag));

// ─────────────────────────── ① 纯函数 ───────────────────────────

test('parseLedgerTables：识别「阶段+卡」台账；卡列可缺；无阶段列/无分隔行不成表', () => {
  const md = [
    '前言',
    '| 阶段 | 卡 | 状态 |',
    '|---|---|---|',
    `| M0 | ${C1} | done |`,
    '',
    '| 阶段 | 内容 | owner |',       // 有阶段列、无卡列 ⇒ 仍是路线图表，hasCardColumn=false
    '|---|---|---|',
    '| M1 | x | y |',
    '',
    '| 卡 | assignee |',             // 有卡列、无阶段列 ⇒ 非台账，忽略
    '|---|---|',
    `| ${C1} | linus |`,
  ].join('\n');
  const ts = mod.parseLedgerTables(md);
  assert.equal(ts.length, 2, `应识别 2 张含阶段列的表，实际 ${ts.length}`);
  assert.equal(ts[0].hasCardColumn, true);
  assert.equal(ts[0].rows.length, 1);
  assert.equal(ts[0].rows[0].card, C1);
  assert.equal(ts[1].hasCardColumn, false);
  assert.equal(mod.parseLedgerTables('| 阶段 | 卡 |\n| a | b |').length, 0, '缺分隔行不成表');
});

test('extractCardIds：从散文/多 id 单元抽卡引用（去重、保序）；非卡返回空', () => {
  // 判据不再是「命名形状」而是「像某个**看板派生**命名空间下的 id」⇒ 命名空间由调用方注入。
  const ns = new Set(['T-']);
  const sel = (t) => mod.extractCardIds(t, { namespaces: ns });
  assert.deepEqual(sel(`| ${C1} 与 ${C2} |`), [C1, C2]);
  assert.deepEqual(sel('（Elon 运维步骤）'), []);
  assert.deepEqual(sel(`${C1} / ${C1}`), [C1]);
  // 看板上不存在的卡（合法形态）仍须被识别 —— 否则 `ledger_dangling` 无从判起
  assert.deepEqual(sel(`| ${GHOST} |`), [GHOST]);
  // 不在本看板命名空间里的 token 不算卡
  assert.deepEqual(sel('not-a-card'), []);
});

test('hasExplicitReason：空/占位符 ⇒ false；写清理由 ⇒ true', () => {
  for (const no of ['', '  ', '-', '—', 'TBD', '待建', '待定', '- ']) {
    assert.equal(mod.hasExplicitReason(no), false, `「${no}」应判无理由`);
  }
  for (const ok of ['（Elon 运维步骤）', '（见下，本批新建）', 'deferred: awaiting design freeze', '待设计冻结后建卡']) {
    assert.equal(mod.hasExplicitReason(ok), true, `「${ok}」应判有理由`);
  }
});

// ─────────────────── ② RED→GREEN 变异：每条硬规则 ───────────────────

test('GREEN 基线：非终态 epic + 台账（引用的都是子卡、未建卡段有理由）⇒ 无硬违例', () => {
  const r = run(
    [epic(), task(C1, { parent: EPIC, status: 'done' }), task(C2, { parent: EPIC })],
    [{ id: EPIC, body: LEDGER('（等 M1 验收后新建）', 'M2 待定阶段') }],
  );
  assert.equal(r.bad.length, 0, `基线应绿，实际 ${JSON.stringify(r.bad)}`);
  assert.equal(r.ok, true);
  assert.equal(r.stats.ledgered, 1);
  assert.equal(r.stats.hardScoped, 1);
});

test('RED→GREEN ①ledger_dangling：**删除**被引用的卡 ⇒ 必红；还原 ⇒ 绿', () => {
  const broken = run([epic(), task(C1, { parent: EPIC, status: 'done' })], [{ id: EPIC, body: LEDGER() }]); // C2 被删
  assert.ok(hasBad(broken, `ledger_dangling:${C2}`), `删卡后应报 ledger_dangling，实际 ${JSON.stringify(broken.bad)}`);
  assert.equal(broken.ok, false);
  const restored = run(
    [epic(), task(C1, { parent: EPIC, status: 'done' }), task(C2, { parent: EPIC })],
    [{ id: EPIC, body: LEDGER() }],
  );
  assert.equal(restored.bad.length, 0, `还原后应绿，实际 ${JSON.stringify(restored.bad)}`);
});

test('RED→GREEN ②ledger_not_child：**拆掉 parent 链接** ⇒ 必红；还原 ⇒ 绿', () => {
  const broken = run([epic(), task(C1, { parent: EPIC, status: 'done' }), task(C2)], [{ id: EPIC, body: LEDGER() }]); // C2 无 parent
  assert.ok(hasBad(broken, `ledger_not_child:${C2}`), `台账引用非子卡应报 ledger_not_child，实际 ${JSON.stringify(broken.bad)}`);
  const restored = run(
    [epic(), task(C1, { parent: EPIC, status: 'done' }), task(C2, { parent: EPIC })],
    [{ id: EPIC, body: LEDGER() }],
  );
  assert.equal(restored.bad.length, 0, `还原后应绿，实际 ${JSON.stringify(restored.bad)}`);
});

test('RED→GREEN ③ledger_phase_no_card：**抹掉「未建卡理由」** ⇒ 必红；还原 ⇒ 绿', () => {
  const broken = run(
    [epic(), task(C1, { parent: EPIC, status: 'done' }), task(C2, { parent: EPIC })],
    [{ id: EPIC, body: LEDGER('', 'M2 待定阶段') }],
  );
  assert.ok(hasBad(broken, 'ledger_phase_no_card'), `空理由应报 ledger_phase_no_card，实际 ${JSON.stringify(broken.bad)}`);
  assert.ok(hasNote(broken, mod.SOFT_TAGS.PHASE_NO_CARD, `${EPIC}.md`), '应同时进悬空路线图巡检 notes');
  const restored = run(
    [epic(), task(C1, { parent: EPIC, status: 'done' }), task(C2, { parent: EPIC })],
    [{ id: EPIC, body: LEDGER('（等 M1 验收后新建）', 'M2 待定阶段') }],
  );
  assert.equal(restored.bad.length, 0, `还原后应绿，实际 ${JSON.stringify(restored.bad)}`);
});

test('RED ④ledger_self_ref：台账把 epic 自己列为阶段卡 ⇒ 红', () => {
  const r = run(
    [epic(), task(C1, { parent: EPIC, status: 'done' })],
    [{ id: EPIC, body: LEDGER(EPIC) }],
  );
  assert.ok(hasBad(r, 'ledger_self_ref'), `实际 ${JSON.stringify(r.bad)}`);
});

test('grandfather：**终态** epic 的同款违例 ⇒ 只告警、不判红（PROTOCOL §10.4 同款口径）', () => {
  const r = run(
    [epic(EPIC, { status: 'done' }), task(C1, { parent: EPIC, status: 'done' }), task(C2, { status: 'done' })], // C2 非子卡
    [{ id: EPIC, body: LEDGER() }],   // 台账引用非子卡 C2
  );
  assert.equal(r.bad.length, 0, `终态 epic 应 grandfather（不判红），实际 ${JSON.stringify(r.bad)}`);
  assert.ok(hasWarn(r, 'grandfather'), `应折叠为一条告警，实际 ${JSON.stringify(r.warn)}`);
  assert.ok(hasWarn(r, `ledger_not_child:${C2}`), `违例内容仍须可见，实际 ${JSON.stringify(r.warn)}`);
  assert.equal(r.stats.hardScoped, 0);
});

test('软告警：epic_no_roadmap / 子卡漏登折叠为一行 / 重复登记（均不改 bad）', () => {
  const noLedger = run([epic(), task(C1, { parent: EPIC })]);
  assert.equal(noLedger.bad.length, 0);
  assert.ok(hasWarn(noLedger, 'epic_no_roadmap'), `实际 ${JSON.stringify(noLedger.warn)}`);

  const extras = Array.from({ length: 8 }, (_, i) => task(`K${i}`, { parent: EPIC }));
  const many = run([epic(), task(C1, { parent: EPIC }), ...extras], [{ id: EPIC, body: LEDGER('（稍后建）', 'M1 实现') }]);
  const unlisted = many.warn.filter((w) => w.includes('ledger_unlisted_child'));
  assert.equal(unlisted.length, 1, `漏登应**折叠为一行**，实际 ${JSON.stringify(many.warn)}`);
  assert.match(unlisted[0], /未列入台账 8\/9/);

  const dup = run(
    [epic(), task(C1, { parent: EPIC })],
    [{ id: EPIC, body: `## 台账\n| 阶段 | 卡 | 状态 |\n|---|---|---|\n| M0 | ${C1} | done |\n| M1 | ${C1} | todo |\n` }],
  );
  assert.ok(hasWarn(dup, 'ledger_card_duplicate'), `实际 ${JSON.stringify(dup.warn)}`);
});

// ─────────────────── 悬空路线图巡检（机制 ⑤，软） ───────────────────

test('悬空路线图巡检：plan.md「有阶段无卡」⇒ phase_no_card；无卡列 ⇒ 每表一条 note；不改退出码', () => {
  const r = run(
    [epic(), task(C1, { parent: EPIC })],
    [{ id: EPIC, body: LEDGER('（等验后建）', 'M2 待定') }],
    [
      {
        rel: 'plan-x/plan.md',
        text: [
          '## 里程碑',
          '| 里程碑 | 内容 | 主 owner | 出口判据 |',   // 无卡列 ⇒ roadmap_no_card_column
          '|---|---|---|---|',
          '| M0 | 契约 | Jobs | 矩阵 |',
          '',
          '## 台账',
          '| 阶段 | 卡 | 状态 |',
          '|---|---|---|',
          `| M1 | ${C1} | done |`,
          '| M2 悬空 |  | todo |',                        // 有阶段无卡 + 无理由 ⇒ phase_no_card
        ].join('\n'),
      },
    ],
  );
  assert.equal(r.bad.length, 0, `巡检不得判红，实际 ${JSON.stringify(r.bad)}`);
  assert.ok(hasNote(r, mod.SOFT_TAGS.NO_CARD_COLUMN, 'plan-x/plan.md'), `实际 ${JSON.stringify(r.notes)}`);
  assert.ok(hasNote(r, mod.SOFT_TAGS.PHASE_NO_CARD, 'plan-x/plan.md'), `实际 ${JSON.stringify(r.notes)}`);
  assert.equal(r.stats.planFiles, 1);
  assert.equal(r.stats.noCardColumn, 1);
});

test('设计文档扫描：workspace/<card>/design/** 的路线图表同样入巡检（跳 assets/prototype）', () => {
  const r = run(
    [epic(), task(C1, { parent: EPIC })],
    [{ id: EPIC, body: LEDGER('（等验后建）', 'M2 待定') }],
    [{ rel: 'card-a/design/roadmap.md', text: '| 阶段 | 卡 |\n|---|---|\n| M0 悬空 |  |\n' }],
  );
  assert.equal(r.bad.length, 0);
  assert.equal(r.stats.designFiles, 1);
  assert.ok(hasNote(r, mod.SOFT_TAGS.PHASE_NO_CARD, 'card-a/design/roadmap.md'), `实际 ${JSON.stringify(r.notes)}`);
});

// ─────────────────── ② 源级变异：断言承重性 ───────────────────

test('源级变异：判定行改成 if (false) ⇒ 同一坏板不再红；未变异副本 ⇒ 必红', () => {
  const broken = run([epic(), task(C1, { parent: EPIC, status: 'done' })], [{ id: EPIC, body: LEDGER(GHOST) }]);
  assert.ok(hasBad(broken, `ledger_dangling:${GHOST}`), '前提：未变异时应红');
  const src = fs.readFileSync(SCRIPT, 'utf8');
  const target = 'if (!cards.has(c))';
  assert.ok(src.includes(target), `变异目标「${target}」未找到 —— 源码已改，请同步本测试（这正是「破坏断言 ⇒ 必红」）`);
  const mutated = absolutizeImports(src.replace(target, 'if (false)'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-epic-mut-'));
  TMP.push(dir);
  const mutPath = path.join(dir, 'check-epic-completeness.mjs');
  fs.writeFileSync(mutPath, mutated, 'utf8');
  const env = { ...process.env, OPENCLAW_TASK_OPS_DIR: PROVIDER, OPENCLAW_TEAM_ROOT: broken.root };
  const rMut = spawnSync(process.execPath, [mutPath], { env, encoding: 'utf8' });
  assert.equal(rMut.status, 0, `删除判定后坏板不该再红，stdout=${rMut.stdout} stderr=${rMut.stderr}`);
  const rOrig = spawnSync(process.execPath, [SCRIPT], { env, encoding: 'utf8' });
  assert.equal(rOrig.status, 1, `未变异副本对同一坏板必红，stdout=${rOrig.stdout} stderr=${rOrig.stderr}`);
});

// ─────────────────── ③ CLI（退出码 / 信封） ───────────────────

const cliEnv = (root) => ({ ...process.env, OPENCLAW_TASK_OPS_DIR: PROVIDER, OPENCLAW_TEAM_ROOT: root });

test('CLI：通过 ⇒ 退出 0；硬违例 ⇒ 退出 1 且打印违例；仅软告警 ⇒ 退出 0', () => {
  const green = run([epic(), task(C1, { parent: EPIC })], [{ id: EPIC, body: LEDGER('（等验后建）', 'M1 实现') }]);
  const ok = spawnSync(process.execPath, [SCRIPT], { env: cliEnv(green.root), encoding: 'utf8' });
  assert.equal(ok.status, 0, `stdout=${ok.stdout} stderr=${ok.stderr}`);
  assert.match(ok.stdout, /对账通过/);

  const red = run([epic(), task(C1, { parent: EPIC })], [{ id: EPIC, body: LEDGER(GHOST) }]);
  const bad = spawnSync(process.execPath, [SCRIPT], { env: cliEnv(red.root), encoding: 'utf8' });
  assert.equal(bad.status, 1, `stdout=${bad.stdout} stderr=${bad.stderr}`);
  assert.match(bad.stdout, new RegExp(`ledger_dangling:${GHOST}`));
  assert.match(bad.stdout, /违例：1/);

  // 仅软告警（无台账的 epic + 悬空 plan.md）⇒ 退出 0
  const soft = run(
    [epic(), task(C1, { parent: EPIC })],
    [],
    [{ rel: 'plan-y/plan.md', text: '| 里程碑 | 内容 |\n|---|---|\n| M0 | x |\n' }],
  );
  const warn = spawnSync(process.execPath, [SCRIPT], { env: cliEnv(soft.root), encoding: 'utf8' });
  assert.equal(warn.status, 0, `软告警不得改退出码，stdout=${warn.stdout} stderr=${warn.stderr}`);
  assert.match(warn.stdout, /epic_no_roadmap/);
  assert.match(warn.stdout, /路线图未含卡列/);

  const json = spawnSync(process.execPath, [SCRIPT, '--json'], { env: cliEnv(red.root), encoding: 'utf8' });
  assert.equal(json.status, 1);
  assert.equal(JSON.parse(json.stdout).ok, false);
});
