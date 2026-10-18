#!/usr/bin/env node
/**
 * check-relations.test.mjs — 关系不变量巡检测试（T-20261009-223400-parentcycle-fix）
 *
 * 重点：anc() 长环漏检修复的**红→绿负例**（A→B→A / A→B→C→A 均判 parent_cycle），
 * 并补齐依赖不变量 / 深链 / 扇入 / 环 / 链长 / 空 epic 等分支（驱动 branch 覆盖 ≥80%）。
 * 核心逻辑直接 import `checkRelations(dir)`（注入隔离目录）以获得行/分支覆盖；CLI 退出码另 spawn 子进程验证。
 */
import { test as nodeTest, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** 定位携带 ACL 库的 provider 安装目录（与 archive.test.mjs / check-idem.test.mjs 同口径）。 */
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

// provider 依赖为**条件动态 import**：缺 provider 时 check-relations.mjs/lib.mjs 在 import 期即硬红。
let checkRelations;
if (PROVIDER) {
  process.env.OPENCLAW_TASK_OPS_DIR = PROVIDER;
  ({ checkRelations } = await import('../check-relations.mjs'));
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHECK_RELATIONS = path.join(HERE, '..', 'check-relations.mjs');

const TMP = [];
after(() => { for (const r of TMP) fs.rmSync(r, { recursive: true, force: true }); });

/** 卡序列化：列表字段写数组；其余写原值 */
function card(fm) {
  const lines = ['---'];
  for (const [k, v] of Object.entries(fm)) {
    if (Array.isArray(v)) lines.push(`${k}: [${v.join(', ')}]`);
    else lines.push(`${k}: ${v}`);
  }
  lines.push('---', '', '## Report', '');
  return lines.join('\n');
}

/** 建隔离卡目录 → 跑 checkRelations → 返回 { bad, warn, ids, root } */
function run(cards, extraFiles = [], opts = undefined) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-rel-'));
  TMP.push(root);
  fs.mkdirSync(path.join(root, 'tasks'), { recursive: true });
  for (const c of cards) fs.writeFileSync(path.join(root, 'tasks', `${c.id}.md`), card(c), 'utf8');
  for (const f of extraFiles) fs.writeFileSync(path.join(root, 'tasks', f.name), f.content, 'utf8');
  const r = checkRelations(path.join(root, 'tasks'), opts);
  return { ...r, root };
}

const epic = (id, extra = {}) => ({ id, title: id, assignee: 'elon', status: 'ready', kind: 'epic', project: '__team__', ...extra });
const task = (id, extra = {}) => ({ id, title: id, assignee: 'linus', status: 'ready', kind: 'task', project: '__team__', ...extra });

// ---- 红→绿负例：anc() 任意长度父环 ----

test('父环 A→B→A ⇒ 判 parent_cycle（改前不报、改后报）', () => {
  const r = run([
    epic('A', { parent: 'B' }),
    epic('B', { parent: 'A' }),
  ]);
  assert.ok(r.bad.includes('A parent_cycle'), `A 应报 parent_cycle，实际 ${JSON.stringify(r.bad)}`);
  assert.ok(r.bad.includes('B parent_cycle'), `B 应报 parent_cycle，实际 ${JSON.stringify(r.bad)}`);
});

test('父环 A→B→C→A ⇒ 判 parent_cycle（改前不报、改后报）', () => {
  const r = run([
    epic('A', { parent: 'B' }),
    epic('B', { parent: 'C' }),
    epic('C', { parent: 'A' }),
  ]);
  for (const id of ['A', 'B', 'C']) {
    assert.ok(r.bad.includes(`${id} parent_cycle`), `${id} 应报 parent_cycle，实际 ${JSON.stringify(r.bad)}`);
  }
});

test('自指 par===id ⇒ self_ref(parent)，且不双重报 parent_cycle（环长1 与自指区分）', () => {
  const r = run([epic('A', { parent: 'A' })]);
  assert.ok(r.bad.includes('A self_ref(parent)'), `实际 ${JSON.stringify(r.bad)}`);
  assert.ok(!r.bad.includes('A parent_cycle'), '自指不应额外报 parent_cycle');
});

// ---- 依赖不变量 ----

test('依赖：self_ref(dep) / dep_missing / dep_on_ancestor / fanin_too_high', () => {
  const nine = Array.from({ length: 9 }, (_, i) => `d${i}`);
  const r = run([
    epic('E'),
    task('T', { parent: 'E' }),
    task('S', { depends_on: ['S'] }),                       // 依赖自指
    task('M', { depends_on: ['NOPE'] }),                    // 依赖缺失
    task('D', { parent: 'E', depends_on: ['E'] }),          // 依赖祖先（父）
    task('F', { depends_on: nine }),                        // 扇入 9 > 8
    ...nine.map((id) => task(id)),
  ]);
  assert.ok(r.bad.includes('S self_ref(dep)'), `实际 ${JSON.stringify(r.bad)}`);
  assert.ok(r.bad.includes('M dep_missing:NOPE'), `实际 ${JSON.stringify(r.bad)}`);
  assert.ok(r.bad.includes('D dep_on_ancestor:E'), `实际 ${JSON.stringify(r.bad)}`);
  assert.ok(r.bad.includes('F fanin_too_high'), `实际 ${JSON.stringify(r.bad)}`);
});

test('父缺失 parent_missing / 父非 epic parent_not_epic', () => {
  const r = run([
    task('O', { parent: 'GONE' }),        // 父不存在
    task('PT'),                            // 父是 task
    task('C', { parent: 'PT' }),
  ]);
  assert.ok(r.bad.includes('O parent_missing'), `实际 ${JSON.stringify(r.bad)}`);
  assert.ok(r.bad.includes('C parent_not_epic'), `实际 ${JSON.stringify(r.bad)}`);
});

test('依赖环 A→B, B→A ⇒ dep_cycle(detected)；依赖链长 9 ⇒ chain_too_long(9)', () => {
  const cyc = run([
    task('A', { depends_on: ['B'] }),
    task('B', { depends_on: ['A'] }),
  ]);
  assert.ok(cyc.bad.includes('dep_cycle(detected)'), `实际 ${JSON.stringify(cyc.bad)}`);

  const ids = Array.from({ length: 10 }, (_, i) => `n${i}`);
  const long = run(ids.map((id, i) => task(id, i === 0 ? {} : { depends_on: [ids[i - 1]] })));
  assert.ok(long.bad.some((b) => /^chain_too_long\(9\)$/.test(b)), `应报 chain_too_long(9)，实际 ${JSON.stringify(long.bad)}`);
});

test('依赖菱形（memo 复用）与 2 入度节点（Kahn --indeg≠0 分支）通过', () => {
  const r = run([
    task('A', { depends_on: ['B', 'C'] }),
    task('B', { depends_on: ['D'] }),
    task('C', { depends_on: ['D'] }),
    task('D'),
  ]);
  assert.equal(r.bad.length, 0, `菱形依赖应通过，实际 ${JSON.stringify(r.bad)}`);
});

// ---- 父链 / 深链 / 空 epic / 多层 ----

test('父链：>8 ⇒ parent_chain_too_long；≥5 软告警（不改 bad）；空 epic；多层不误报', () => {
  // 8 个 epic + 1 个 task 子卡 ⇒ task 链长 9 > 8
  const chain = [];
  let prev = '';
  for (let i = 0; i < 8; i++) { const id = `e${i}`; chain.push(epic(id, i === 0 ? {} : { parent: prev })); prev = id; }
  chain.push(task('e8', { parent: 'e7' }));
  const r = run(chain);
  assert.ok(r.bad.includes('e8 parent_chain_too_long'), `链长9 应报 parent_chain_too_long，实际 ${JSON.stringify(r.bad)}`);

  // 4 个 epic + 1 个 task 子卡 ⇒ task 链长 5 ⇒ 软告警，不报 hard
  const deep = [];
  let p = '';
  for (let i = 0; i < 4; i++) { const id = `f${i}`; deep.push(epic(id, i === 0 ? {} : { parent: p })); p = id; }
  deep.push(task('f4', { parent: 'f3' }));
  const d = run(deep);
  assert.equal(d.bad.length, 0, `深链(5) 不应报 hard，实际 ${JSON.stringify(d.bad)}`);
  assert.ok(d.warn.some((w) => /^f4\(5\)$/.test(w)), `应软告警 f4(5)，实际 ${JSON.stringify(d.warn)}`);

  // 空 epic ⇒ empty_epic
  const e = run([epic('G')]);
  assert.ok(e.bad.includes('G empty_epic'), `实际 ${JSON.stringify(e.bad)}`);

  // 三层 epic→epic→task 不误报（无 parent_cycle / 无告警）
  const m = run([epic('h0'), epic('h1', { parent: 'h0' }), task('h2', { parent: 'h1' })]);
  assert.equal(m.bad.length, 0, `多层应通过，实际 ${JSON.stringify(m.bad)}`);
  assert.equal(m.warn.length, 0, `多层(3) 不应告警，实际 ${JSON.stringify(m.warn)}`);
});

// ---- 读侧 ----

test('读侧：depends_on 字符串形态 / 无 id 用文件名 / 忽略非 .md / 空目录 / 不存在目录', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-rel-read-'));
  TMP.push(root);
  const T = path.join(root, 'tasks');
  fs.mkdirSync(T, { recursive: true });
  // 无 id 字段（用文件名兜底）；depends_on 带括号字符串形式
  fs.writeFileSync(path.join(T, 'noid.md'), '---\ntitle: noid\nkind: task\nassignee: linus\nstatus: ready\ndepends_on: "[D1, D2]"\n---\n正文\n', 'utf8');
  fs.writeFileSync(path.join(T, 'D1.md'), card(task('D1')), 'utf8');
  fs.writeFileSync(path.join(T, 'D2.md'), card(task('D2')), 'utf8');
  fs.writeFileSync(path.join(T, 'readme.txt'), 'not a card', 'utf8');
  const r = checkRelations(T);
  assert.ok(r.ids.includes('noid'), '无 id 卡应按文件名入 ids');
  assert.ok(r.ids.includes('D1') && r.ids.includes('D2'));
  assert.equal(r.bad.length, 0, `D1/D2 存在且非祖先 ⇒ 不报错，实际 ${JSON.stringify(r.bad)}`);

  const empty = checkRelations(path.join(root, 'empty'));
  assert.deepEqual(empty, { bad: [], warn: [], ids: [] });
  const missing = checkRelations(path.join(root, 'nope'));
  assert.deepEqual(missing, { bad: [], warn: [], ids: [] });
});

test('缺省 kind / 无 frontmatter 兜底分支（覆盖 kind||task 与 fm&&fm.id 短路）', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-rel-kind-'));
  TMP.push(root);
  const T = path.join(root, 'tasks');
  fs.mkdirSync(T, { recursive: true });
  // 父卡无 kind ⇒ 默认 task ⇒ 子卡 parent_not_epic（覆盖 p.kind||task 短路假分支）
  fs.writeFileSync(path.join(T, 'PK.md'), '---\ntitle: pk\nassignee: linus\nstatus: ready\nproject: __team__\n---\n正文\n', 'utf8');
  fs.writeFileSync(path.join(T, 'CK.md'), card(task('CK', { parent: 'PK' })), 'utf8');
  // 无 frontmatter 的卡 ⇒ fm null ⇒ id 取文件名（覆盖 fm&&fm.id 短路假分支）
  fs.writeFileSync(path.join(T, 'nofm.md'), '纯正文，无 frontmatter\n', 'utf8');
  const r = checkRelations(T);
  assert.ok(r.bad.includes('CK parent_not_epic'), `父无 kind ⇒ 默认 task ⇒ parent_not_epic，实际 ${JSON.stringify(r.bad)}`);
  assert.ok(r.ids.includes('nofm'), '无 frontmatter 卡应按文件名入 ids');
});

// ---- `R-DAG-1` 分批登记软护栏（T-20261013-010610）：epic 已放行一批 + 长期占位子卡 ⇒ 软告警（不改退出码）----

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const ago = (ms) => new Date(Date.now() - ms).toISOString();
const epicWarns = (r) => r.warn.filter((w) => w.includes('epic_child_todo_stale'));

test('分批登记：epic 已放行一批 + 有 >48h 的 todo 子卡 ⇒ 软告警（不改 bad）', () => {
  const r = run([
    epic('E', { status: 'ready' }),
    task('C1', { parent: 'E', status: 'done', status_changed_at: ago(10 * DAY) }),
    task('C2', { parent: 'E', status: 'todo', status_changed_at: ago(5 * DAY) }),
  ]);
  assert.equal(r.bad.length, 0, `不应有硬违例，实际 ${JSON.stringify(r.bad)}`);
  assert.ok(epicWarns(r).some((w) => w.includes('C2')), `应软告警 C2，实际 ${JSON.stringify(r.warn)}`);
});

test('分批登记：epic in_progress + 全部子卡长期 todo ⇒ 软告警（覆盖卡片原文「in_progress」判据）', () => {
  const r = run([
    epic('E', { status: 'in_progress' }),
    task('C1', { parent: 'E', status: 'todo', created_at: ago(9 * DAY) }),
  ]);
  assert.equal(r.bad.length, 0, `实际 ${JSON.stringify(r.bad)}`);
  assert.ok(epicWarns(r).length > 0, `实际 ${JSON.stringify(r.warn)}`);
});

test('分批登记：占位子卡未超阈值 / 一批未开工 / epic 终态 ⇒ 均不告警', () => {
  // (a) 占位子卡仅停留 1h（未超 48h 阈值）
  const fresh = run([
    epic('E', { status: 'ready' }),
    task('C1', { parent: 'E', status: 'done', status_changed_at: ago(2 * DAY) }),
    task('C2', { parent: 'E', status: 'todo', status_changed_at: ago(1 * HOUR) }),
  ]);
  assert.equal(epicWarns(fresh).length, 0, `未超阈值不应告警，实际 ${JSON.stringify(fresh.warn)}`);
  // (b) 一批都未放行（全 todo、epic ready）⇒ 尚未开工，不算「第二批遗漏」
  const notStarted = run([
    epic('E', { status: 'ready' }),
    task('C1', { parent: 'E', status: 'todo', status_changed_at: ago(9 * DAY) }),
  ]);
  assert.equal(epicWarns(notStarted).length, 0, `未开工不应告警，实际 ${JSON.stringify(notStarted.warn)}`);
  // (c) epic 已终态 ⇒ 不告警
  const term = run([
    epic('E', { status: 'done' }),
    task('C1', { parent: 'E', status: 'done', status_changed_at: ago(9 * DAY) }),
    task('C2', { parent: 'E', status: 'todo', status_changed_at: ago(9 * DAY) }),
  ]);
  assert.equal(epicWarns(term).length, 0, `终态 epic 不应告警，实际 ${JSON.stringify(term.warn)}`);
});

test('分批登记：阈值可由 opts.epicTodoWarnMs 注入（大于停留时长 ⇒ 静默）', () => {
  const cards = () => [
    epic('E', { status: 'ready' }),
    task('C1', { parent: 'E', status: 'done', status_changed_at: ago(10 * DAY) }),
    task('C2', { parent: 'E', status: 'todo', status_changed_at: ago(2 * DAY) }),
  ];
  const strict = run(cards(), [], { epicTodoWarnMs: 1 * DAY, now: Date.now() });
  assert.ok(epicWarns(strict).length > 0, `阈值 1d ⇒ 2d 占位应告警，实际 ${JSON.stringify(strict.warn)}`);
  const loose = run(cards(), [], { epicTodoWarnMs: 30 * DAY, now: Date.now() });
  assert.equal(epicWarns(loose).length, 0, `阈值 30d ⇒ 2d 占位应静默，实际 ${JSON.stringify(loose.warn)}`);
});

// ---- CLI（spawn：退出码 / 输出信封，同时覆盖 main() 与 main-guard arg===self 分支）----

test('CLI：通过 ⇒ 退出 0 且打印「关系校验通过」', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-rel-cli-'));
  TMP.push(root);
  fs.mkdirSync(path.join(root, 'tasks'), { recursive: true });
  fs.writeFileSync(path.join(root, 'tasks', 'A.md'), card(task('A')), 'utf8');
  const r = spawnSync(process.execPath, [CHECK_RELATIONS], { env: { ...process.env, OPENCLAW_TEAM_ROOT: root }, encoding: 'utf8' });
  assert.equal(r.status, 0, `stdout=${r.stdout} stderr=${r.stderr}`);
  assert.match(r.stdout, /关系校验通过/);
});

test('CLI：父环 ⇒ 退出 1 且打印 parent_cycle 与违例计数', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-rel-clibad-'));
  TMP.push(root);
  fs.mkdirSync(path.join(root, 'tasks'), { recursive: true });
  fs.writeFileSync(path.join(root, 'tasks', 'A.md'), card(epic('A', { parent: 'B' })), 'utf8');
  fs.writeFileSync(path.join(root, 'tasks', 'B.md'), card(epic('B', { parent: 'A' })), 'utf8');
  const r = spawnSync(process.execPath, [CHECK_RELATIONS], { env: { ...process.env, OPENCLAW_TEAM_ROOT: root }, encoding: 'utf8' });
  assert.equal(r.status, 1, `stdout=${r.stdout} stderr=${r.stderr}`);
  assert.match(r.stdout, /parent_cycle/);
  assert.match(r.stdout, /违例：/);
});

test('CLI：深链 ⇒ 打印 ⚠ 深链告警但退出 0（软护栏不改退出码）', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-rel-cliwarn-'));
  TMP.push(root);
  fs.mkdirSync(path.join(root, 'tasks'), { recursive: true });
  let p = '';
  for (let i = 0; i < 4; i++) {
    const id = `f${i}`;
    fs.writeFileSync(path.join(root, 'tasks', `${id}.md`), card(epic(id, i === 0 ? {} : { parent: p })), 'utf8');
    p = id;
  }
  fs.writeFileSync(path.join(root, 'tasks', 'f4.md'), card(task('f4', { parent: 'f3' })), 'utf8');
  const r = spawnSync(process.execPath, [CHECK_RELATIONS], { env: { ...process.env, OPENCLAW_TEAM_ROOT: root }, encoding: 'utf8' });
  assert.equal(r.status, 0, `stdout=${r.stdout} stderr=${r.stderr}`);
  assert.match(r.stdout, /深链告警/);
});

test('CLI：epic 有长期占位子卡 ⇒ 打印分批登记告警但退出 0（软护栏不改退出码）', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-rel-cliepic-'));
  TMP.push(root);
  fs.mkdirSync(path.join(root, 'tasks'), { recursive: true });
  fs.writeFileSync(path.join(root, 'tasks', 'E.md'), card(epic('E', { status: 'ready' })), 'utf8');
  fs.writeFileSync(path.join(root, 'tasks', 'C1.md'), card(task('C1', { parent: 'E', status: 'done', status_changed_at: ago(10 * DAY) })), 'utf8');
  fs.writeFileSync(path.join(root, 'tasks', 'C2.md'), card(task('C2', { parent: 'E', status: 'todo', status_changed_at: ago(5 * DAY) })), 'utf8');
  const r = spawnSync(process.execPath, [CHECK_RELATIONS], { env: { ...process.env, OPENCLAW_TEAM_ROOT: root }, encoding: 'utf8' });
  assert.equal(r.status, 0, `软告警不得改退出码，stdout=${r.stdout} stderr=${r.stderr}`);
  assert.match(r.stdout, /分批登记告警/);
  assert.match(r.stdout, /epic_child_todo_stale/);
});
