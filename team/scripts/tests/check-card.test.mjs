#!/usr/bin/env node
/**
 * check-card.test.mjs — priority 枚举校验（T-20261009-035200-teambackfill-depfix）
 *                    + `project: __team__` 卡 target 必填（T-20261013-015831）
 *                    + 该规则域收窄为「非终态」（T-20261013-023535-2：终态历史卡 grandfather）
 *
 * 口径：priority 统一 low|medium|high|urgent（旧 p0–p3 弃用）。缺省/空不报错
 *   （REQUIRED 不含 priority，避免误伤）；非法值报错且 CLI 退出码 1。
 * 既直接调 checkOne（获得行/分支覆盖），又 spawn 子进程验证退出码。
 */
import { test as nodeTest, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

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

// provider 依赖为**条件动态 import**：缺 provider 时 check-card.mjs/lib.mjs 在 import 期即硬红。
let checkOne, PRIORITY, pathViolations, PATH_EFFECTIVE_AT;
if (PROVIDER) {
  process.env.OPENCLAW_TASK_OPS_DIR = PROVIDER;
  ({ checkOne, PRIORITY, pathViolations, PATH_EFFECTIVE_AT } = await import('../check-card.mjs'));
}
// 词表模块零依赖（不碰 provider）⇒ 无条件 import；词表本身由 tests/status.test.mjs 主测，
// 此处只钉「check-card 读侧白名单 = 该词表」这一条接线。
const { READ_STATUSES, TERMINAL } = await import('../status.mjs');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-cc-'));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const CHECK_CARD = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'check-card.mjs');
let seq = 0;
/**
 * 造一张合法卡（priority 行与 status 可变）；priorityLine 传 null ⇒ 不含 priority 字段。
 * 必须带 `target`：`project: __team__` 卡缺 target 是红（T-20261013-015831），
 * 不带会把「合法卡」造错，令无关用例误红。
 */
function mkCard(priorityLine, status = 'ready') {
  const id = `T-20260101-3000${String(seq++).padStart(2, '0')}-cc`;
  const lines = ['---', `id: ${id}`, 'title: t', 'assignee: linus', `status: ${status}`, 'goal: g', 'project: __team__', 'target: /repo/openclaw-team'];
  if (status === 'in_progress') lines.push('claimed_by: linus'); // in_progress 须带 claimed_by（否则另一分支误红）
  if (priorityLine) lines.push(priorityLine);
  lines.push('---', '## Report', '');
  const p = path.join(TMP, `${id}.md`);
  fs.writeFileSync(p, lines.join('\n'), 'utf8');
  return p;
}
const runCli = (cardPath) => spawnSync(process.execPath, [CHECK_CARD, cardPath], { encoding: 'utf8' });

/** 造一个隔离的 OPENCLAW_TEAM_ROOT（含 tasks/），返回 { root, dir } */
function mkRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-cc-root-'));
  const dir = path.join(root, 'tasks');
  fs.mkdirSync(dir, { recursive: true });
  return { root, dir };
}
function writeRaw(dir, id, body) {
  fs.writeFileSync(path.join(dir, `${id}.md`), body, 'utf8');
}

test('PRIORITY 枚举 = low|medium|high|urgent', () => {
  assert.deepEqual(PRIORITY, ['low', 'medium', 'high', 'urgent']);
});

test('STATUS 白名单 = canonical 7 ∪ 旧词别名 {ready, failed}（对齐 PROTOCOL.md §①）', () => {
  assert.deepEqual(READ_STATUSES, ['backlog', 'todo', 'in_progress', 'in_review', 'blocked', 'done', 'canceled', 'ready', 'failed']);
});

test('合法 status（canonical 7 + 别名 ready/failed）通过', () => {
  for (const s of READ_STATUSES) assert.deepEqual(checkOne(mkCard(null, s)), [], `${s} 应通过`);
});

test('非法 status（未知词 archived）报错', () => {
  assert.deepEqual(checkOne(mkCard(null, 'archived')), ['非法 status: archived']);
});

test('合法 priority（low/medium/high/urgent）通过', () => {
  for (const p of PRIORITY) assert.deepEqual(checkOne(mkCard(`priority: ${p}`)), [], `${p} 应通过`);
});

test('缺省 priority 不报错（REQUIRED 不含 priority，避免误伤）', () => {
  assert.deepEqual(checkOne(mkCard(null)), []);
});

test('非法 priority（p2/urgentt）报错', () => {
  assert.deepEqual(checkOne(mkCard('priority: p2')), ['非法 priority: p2']);
  assert.deepEqual(checkOne(mkCard('priority: urgentt')), ['非法 priority: urgentt']);
});

test('CLI 子进程：合法 ⇒ 退出码 0', () => {
  const r = runCli(mkCard('priority: high'));
  assert.equal(r.status, 0, `stdout=${r.stdout} stderr=${r.stderr}`);
});

test('CLI 子进程：非法 ⇒ 退出码 1 且输出含「非法 priority: p2」', () => {
  const r = runCli(mkCard('priority: p2'));
  assert.equal(r.status, 1, `stdout=${r.stdout} stderr=${r.stderr}`);
  assert.match(r.stdout, /非法 priority: p2/);
});

test('CLI 扫描全部模式：合法卡通过（退出码 0）+ 裸 id 参数（补 .md）', () => {
  const { root, dir } = mkRoot();
  const id = 'T-20260101-300090-scan';
  writeRaw(dir, id, `---\nid: ${id}\ntitle: t\nassignee: linus\nstatus: ready\npriority: urgent\ngoal: g\nproject: __team__\ntarget: /repo/openclaw-team\n---\n## Report\n`);
  const env = { ...process.env, OPENCLAW_TEAM_ROOT: root };
  const all = spawnSync(process.execPath, [CHECK_CARD], { env, encoding: 'utf8' });
  assert.equal(all.status, 0, `stdout=${all.stdout}`);
  assert.match(all.stdout, /卡校验通过/);
  const byId = spawnSync(process.execPath, [CHECK_CARD, id], { env, encoding: 'utf8' }); // 不含 .md ⇒ 走 id 分支
  assert.equal(byId.status, 0, `stdout=${byId.stdout}`);
  fs.rmSync(root, { recursive: true, force: true });
});

test('既有校验分支：缺必填/非法 status/非法 assignee/in_progress 缺 claimed_by', () => {
  const { root, dir } = mkRoot();
  const mk = (id, fm) => writeRaw(dir, id, `---\n${fm}\n---\n## Report\n`);
  const TGT = '\ntarget: /repo/openclaw-team'; // 各卡只留被测缺陷：target 齐备
  mk('T-20260101-300091-a', `id: T-20260101-300091-a\ntitle: t\nassignee: linus\nstatus: ready\nproject: __team__${TGT}`); // 缺 goal
  mk('T-20260101-300092-b', `id: T-20260101-300092-b\ntitle: t\nassignee: linus\nstatus: weird\ngoal: g\nproject: __team__${TGT}`);
  mk('T-20260101-300093-c', `id: T-20260101-300093-c\ntitle: t\nassignee: nobody\nstatus: ready\ngoal: g\nproject: __team__${TGT}`);
  mk('T-20260101-300094-d', `id: T-20260101-300094-d\ntitle: t\nassignee: linus\nstatus: in_progress\ngoal: g\nproject: __team__${TGT}`);
  mk('T-20260101-300095-e', 'id: T-20260101-300095-e\ntitle: t\ngoal: g'); // status/assignee/project 全缺 ⇒ 覆盖 && 假分支
  const env = { ...process.env, OPENCLAW_TEAM_ROOT: root };
  const r = spawnSync(process.execPath, [CHECK_CARD], { env, encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /缺必填字段 goal/);
  assert.match(r.stdout, /非法 status: weird/);
  assert.match(r.stdout, /非法 assignee: nobody/);
  assert.match(r.stdout, /in_progress 但缺 claimed_by/);
  assert.match(r.stdout, /缺必填字段 assignee/);
  assert.match(r.stdout, /缺必填字段 status/);
  fs.rmSync(root, { recursive: true, force: true });
});

// ── `project: __team__` 卡 target 必填（T-20261013-015831：防 spawn-lane 默认落 live） ──
test('__team__ 卡缺 target ⇒ 报红（含机读 [role] 归口，取自 created_by）', () => {
  const p = path.join(TMP, 'T-20260101-300080-notarget.md');
  fs.writeFileSync(p, '---\nid: T-20260101-300080-notarget\ntitle: t\nassignee: linus\nstatus: ready\ngoal: g\nproject: __team__\ncreated_by: elon\n---\n## Report\n', 'utf8');
  const errs = checkOne(p);
  assert.equal(errs.length, 1, JSON.stringify(errs));
  assert.match(errs[0], /project=__team__ 缺 target/);
  assert.match(errs[0], /\[role] elon/); // 机读标签 + 归口角色
});

test('__team__ 卡缺 target 且无 created_by ⇒ [role] 回落 elon', () => {
  const p = path.join(TMP, 'T-20260101-300081-notarget2.md');
  fs.writeFileSync(p, '---\nid: T-20260101-300081-notarget2\ntitle: t\nassignee: linus\nstatus: ready\ngoal: g\nproject: __team__\n---\n## Report\n', 'utf8');
  assert.deepEqual(checkOne(p), ['project=__team__ 缺 target [role] elon（carding 缺陷：spawn-lane 否则默认 cwd=live ~/.openclaw/team）']);
});

test('__team__ 卡有 target ⇒ 不误报；target 为空白 ⇒ 视为缺失', () => {
  const { root, dir } = mkRoot();
  const env = { ...process.env, OPENCLAW_TEAM_ROOT: root };
  const good = 'T-20260101-300082-has';
  writeRaw(dir, good, `---\nid: ${good}\ntitle: t\nassignee: linus\nstatus: ready\ngoal: g\nproject: __team__\ntarget: /live/team\n---\n## Report\n`);
  const blank = 'T-20260101-300083-blank';
  writeRaw(dir, blank, `---\nid: ${blank}\ntitle: t\nassignee: linus\nstatus: ready\ngoal: g\nproject: __team__\ntarget: "  "\n---\n## Report\n`);
  const okRun = spawnSync(process.execPath, [CHECK_CARD, path.join(dir, `${good}.md`)], { env, encoding: 'utf8' });
  assert.equal(okRun.status, 0, `stdout=${okRun.stdout} stderr=${okRun.stderr}`);
  const blankRun = spawnSync(process.execPath, [CHECK_CARD, path.join(dir, `${blank}.md`)], { env, encoding: 'utf8' });
  assert.equal(blankRun.status, 1);
  assert.match(blankRun.stdout, /project=__team__ 缺 target/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('非 __team__ 项目缺 target 不误报（规则仅限 project=__team__）', () => {
  const p = path.join(TMP, 'T-20260101-300084-otherproj.md');
  fs.writeFileSync(p, '---\nid: T-20260101-300084-otherproj\ntitle: t\nassignee: linus\nstatus: ready\ngoal: g\nproject: example-app\n---\n## Report\n', 'utf8');
  assert.deepEqual(checkOne(p), []);
});

test('CLI 子进程：__team__ 缺 target ⇒ 退出码 1 且 stdout 含机读 [role]', () => {
  const p = path.join(TMP, 'T-20260101-300085-cli.md');
  fs.writeFileSync(p, '---\nid: T-20260101-300085-cli\ntitle: t\nassignee: linus\nstatus: ready\ngoal: g\nproject: __team__\ncreated_by: elon\n---\n## Report\n', 'utf8');
  const r = runCli(p);
  assert.equal(r.status, 1, `stdout=${r.stdout} stderr=${r.stderr}`);
  assert.match(r.stdout, /缺 target \[role] elon/);
});

// ── 规则域收窄到「非终态」：终态历史卡 grandfather、不追溯转红（T-20261013-023535-2） ──
test('TERMINAL 枚举 = done|failed|canceled（非终态按排除法 = 其余全部；对齐 provider TERMINAL_STATUSES）', () => {
  assert.deepEqual(TERMINAL, ['done', 'failed', 'canceled']);
});

test('非终态卡缺 target ⇒ 报红（规则域 = 非终态：canonical todo / 旧词 ready / backlog 亦在域内）', () => {
  const { root, dir } = mkRoot();
  const statuses = ['backlog', 'todo', 'ready', 'in_progress', 'in_review', 'blocked'];
  for (const [i, s] of statuses.entries()) {
    const id = `T-20260101-3001${String(i).padStart(2, '0')}-nt`;
    const claim = s === 'in_progress' ? '\nclaimed_by: linus' : ''; // in_progress 另有 claimed_by 硬门，勿混入噪声
    writeRaw(dir, id, `---\nid: ${id}\ntitle: t\nassignee: linus\nstatus: ${s}${claim}\ngoal: g\nproject: __team__\ncreated_by: elon\n---\n## Report\n`);
    const errs = checkOne(path.join(dir, `${id}.md`));
    assert.equal(errs.length, 1, `${s}: ${JSON.stringify(errs)}`);
    assert.equal(errs[0], 'project=__team__ 缺 target [role] elon（carding 缺陷：spawn-lane 否则默认 cwd=live ~/.openclaw/team）');
  }
  fs.rmSync(root, { recursive: true, force: true });
});

test('终态卡（done/failed/canceled）缺 target ⇒ 不报红（grandfather：门禁捕获卡时缺陷，不追溯历史）', () => {
  const { root, dir } = mkRoot();
  const statuses = ['done', 'failed', 'canceled'];
  for (const [i, s] of statuses.entries()) {
    const id = `T-20260101-3002${String(i).padStart(2, '0')}-tm`;
    writeRaw(dir, id, `---\nid: ${id}\ntitle: t\nassignee: linus\nstatus: ${s}\ngoal: g\nproject: __team__\ncreated_by: elon\n---\n## Report\n`);
    assert.deepEqual(checkOne(path.join(dir, `${id}.md`)), [], `${s} 为终态 ⇒ target 规则不适用`);
  }
  fs.rmSync(root, { recursive: true, force: true });
});

test('grandfather 仅限 target 规则：终态卡其余 schema 校验照旧报红（非整体跳过）', () => {
  const { root, dir } = mkRoot();
  const id = 'T-20260101-300300-tm2';
  writeRaw(dir, id, `---\nid: ${id}\ntitle: t\nassignee: linus\nstatus: done\nproject: __team__\n---\n## Report\n`); // 缺 goal（+缺 target）
  assert.deepEqual(checkOne(path.join(dir, `${id}.md`)), ['缺必填字段 goal']);
  fs.rmSync(root, { recursive: true, force: true });
});

test('CLI 扫描全部：终态缺 target 不红；追加一张非终态缺 target 才转红', () => {
  const { root, dir } = mkRoot();
  const env = { ...process.env, OPENCLAW_TEAM_ROOT: root };
  writeRaw(dir, 'T-20260101-300310-hist', `---\nid: T-20260101-300310-hist\ntitle: t\nassignee: linus\nstatus: done\ngoal: g\nproject: __team__\n---\n## Report\n`);
  const okRun = spawnSync(process.execPath, [CHECK_CARD], { env, encoding: 'utf8' });
  assert.equal(okRun.status, 0, `stdout=${okRun.stdout} stderr=${okRun.stderr}`); // 历史终态卡不追溯
  writeRaw(dir, 'T-20260101-300311-live', `---\nid: T-20260101-300311-live\ntitle: t\nassignee: linus\nstatus: in_review\ngoal: g\nproject: __team__\ncreated_by: elon\n---\n## Report\n`);
  const badRun = spawnSync(process.execPath, [CHECK_CARD], { env, encoding: 'utf8' });
  assert.equal(badRun.status, 1, `stdout=${badRun.stdout}`);
  assert.match(badRun.stdout, /缺 target \[role] elon/);
  assert.doesNotMatch(badRun.stdout, /300310-hist/); // 终态卡不在红名单里
  fs.rmSync(root, { recursive: true, force: true });
});

test('CLI 扫描全部模式：tasks 目录不存在 ⇒ 0 张通过', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-cc-empty-'));
  const r = spawnSync(process.execPath, [CHECK_CARD], { env: { ...process.env, OPENCLAW_TEAM_ROOT: root }, encoding: 'utf8' });
  assert.equal(r.status, 0, `stdout=${r.stdout}`);
  assert.match(r.stdout, /0 张/);
  fs.rmSync(root, { recursive: true, force: true });
});

// ── 项目内路径 containment：非 __team__ 卡的 target/writes 须项目内相对（PROTOCOL §②.1） ──
const AFTER = '2026-12-01T00:00:00Z';  // 截止之后 ⇒ 规则生效
const BEFORE = '2026-01-01T00:00:00Z'; // 截止之前 ⇒ grandfather

/**
 * 造一张**非 `__team__`** 项目的卡（`mkCard` 硬编码 `project: __team__`、不写 created_at ⇒ 走不到
 * 本规则；此处另立 fixture，避免既有用例位移）。createdAt 传 null ⇒ 不含 created_at 字段。
 */
function mkProjCard({ id, project = 'example-app', target = '', writes = '', status = 'ready', createdAt = AFTER, createdBy = 'elon' } = {}) {
  const lines = ['---', `id: ${id}`, 'title: t', 'assignee: linus', `status: ${status}`, 'goal: g', `project: ${project}`];
  if (target) lines.push(`target: ${target}`);
  if (writes) lines.push(`writes: ${writes}`);
  if (createdAt) lines.push(`created_at: ${createdAt}`);
  if (createdBy) lines.push(`created_by: ${createdBy}`);
  if (status === 'in_progress') lines.push('claimed_by: linus');
  lines.push('---', '## Report', '');
  const p = path.join(TMP, `${id}.md`);
  fs.writeFileSync(p, lines.join('\n'), 'utf8');
  return p;
}
let pseq = 0;
const pid = () => `T-20260101-4${String(pseq++).padStart(5, '0')}-pth`;

test('§②.1 截止常量存在且可被 env 覆盖（非法值回退常量，绝不静默变严）', () => {
  assert.match(PATH_EFFECTIVE_AT, /^\d{4}-\d{2}-\d{2}T/);
  const p = mkProjCard({ id: pid(), target: '/repo/other' });
  process.env.OPENCLAW_TEAM_PATH_EFFECTIVE_AT = '2099-01-01T00:00:00Z'; // 截止推到未来 ⇒ 全部 grandfather
  assert.deepEqual(checkOne(p), [], '截止推到未来 ⇒ 不报（grandfather）');
  process.env.OPENCLAW_TEAM_PATH_EFFECTIVE_AT = 'not-a-date';           // 非法 ⇒ 回退常量 ⇒ 规则照常生效
  assert.equal(checkOne(p).length, 1, '非法 env 不得静默放宽规则');
  delete process.env.OPENCLAW_TEAM_PATH_EFFECTIVE_AT;
});

test('§②.1 非 __team__ 绝对 target（截止后）⇒ 报红 + 机读 [role]', () => {
  const errs = checkOne(mkProjCard({ id: pid(), target: '/repo/other-project', createdBy: 'elon' }));
  assert.equal(errs.length, 1, JSON.stringify(errs));
  assert.match(errs[0], /越出项目边界/);
  assert.match(errs[0], /\[role] elon/);
  assert.match(errs[0], /绝对路径/);
});

test('§②.1 逃逸形态逐一遍历：../ 开头 / 中段 ../ / ~ 本机锚 / 盘符 ⇒ 皆红', () => {
  const cases = [
    ['../other-project', /相对路径越界/],
    ['a/../../b', /相对路径越界/], // 关键：`..` 不在开头，只看前缀的正则会漏
    ['~/.openclaw/team', /本机锚路径/],
    ['C:\\work\\x', /盘符绝对路径/],
  ];
  for (const [target, re] of cases) {
    const errs = checkOne(mkProjCard({ id: pid(), target }));
    assert.equal(errs.length, 1, `${target}: ${JSON.stringify(errs)}`);
    assert.match(errs[0], re, target);
  }
});

test('§②.1 项目内相对 target ⇒ 不报（含 ./ 与深层相对）', () => {
  for (const target of ['team/scripts/x.mjs', './x', 'a/b/c', '.', 'src/']) {
    assert.deepEqual(checkOne(mkProjCard({ id: pid(), target })), [], `${target} 应合法`);
  }
});

test('§②.1 created_at 早于截止 ⇒ grandfather；缺 created_at ⇒ 同按 grandfather（保守）', () => {
  assert.deepEqual(checkOne(mkProjCard({ id: pid(), target: '/abs/x', createdAt: BEFORE })), []);
  assert.deepEqual(checkOne(mkProjCard({ id: pid(), target: '/abs/x', createdAt: null })), []);
});

test('§②.1 终态卡（done/failed/canceled）⇒ 规则不适用（不追溯历史）', () => {
  for (const status of ['done', 'failed', 'canceled']) {
    assert.deepEqual(checkOne(mkProjCard({ id: pid(), target: '/abs/x', status })), [], `${status} 应 grandfathered`);
  }
});

test('§②.1 project: __team__ 排除（其绝对 target 由 §⑩.4 硬门管辖）⇒ 本条不报', () => {
  const errs = checkOne(mkProjCard({ id: pid(), project: '__team__', target: '/repo/openclaw-team' }));
  assert.deepEqual(errs, []);
});

test('§②.1 writes 逐元素：只报越界那一项，合法项不连带', () => {
  const errs = checkOne(mkProjCard({ id: pid(), writes: '/abs/x, ./rel' }));
  assert.equal(errs.length, 1, JSON.stringify(errs));
  assert.match(errs[0], /writes 越出项目边界/);
  assert.match(errs[0], /\/abs\/x/);
});

test('§②.1 target 与 writes 各越界 ⇒ 各报一条（不合并、不吞）', () => {
  const errs = checkOne(mkProjCard({ id: pid(), target: '/abs/t', writes: '../w' }));
  assert.equal(errs.length, 2, JSON.stringify(errs));
  assert.match(errs[0], /target 越出项目边界/);
  assert.match(errs[1], /writes 越出项目边界/);
});

test('§②.1 pathViolations 可独立调用（缺 fm / 空值 ⇒ 空集，不抛）', () => {
  assert.deepEqual(pathViolations(null), []);
  assert.deepEqual(pathViolations({}), []);
  assert.deepEqual(pathViolations({ project: 'example-app', created_at: AFTER, target: '' }), []);
});

test('§②.1 既有 schema 分支零回归：合法非 __team__ 卡（无 target）仍通过', () => {
  assert.deepEqual(checkOne(mkProjCard({ id: pid(), createdAt: null })), []);
});

test('§②.1 CLI 子进程：非 __team__ 绝对 target ⇒ 退出码 1 且 stdout 含机读 [role]', () => {
  const r = runCli(mkProjCard({ id: pid(), target: '/repo/other', createdBy: 'linus' }));
  assert.equal(r.status, 1, `stdout=${r.stdout} stderr=${r.stderr}`);
  assert.match(r.stdout, /越出项目边界/);
  assert.match(r.stdout, /\[role] linus/);
});
