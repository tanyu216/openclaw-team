#!/usr/bin/env node
/**
 * report-census.test.mjs — `scripts/report-census.mjs` 回归测试（卡 `T-20261015-025543-2`，D6）。
 *
 * 契约 = 该脚本头注（口径三轴 + `--card-path` / `--include-archived` 两个单轴 + 只读保证 + 退出码）。
 * 本套件钉住「口径真的可参数化」与「读数真的可复跑」这件事本身——**不**钉任何绝对值（绝对值随看板漂移，
 * 正是 D6 的病根）：
 *   ① 样本轴 `--sample`：nonempty ⊂ section ⊂ board（fixture 各一张）
 *   ② 状态面 `--status`：all / nonterminal / terminal（含 terminal 用的 TERMINAL 同源）
 *   ③ 字面判定 `--criterion`：topic 与 shape **两档真的不同**，且**非包含关系**（A/B 族各半边）
 *   ④ 卡路径轴 `--card-path`：id ⊃ path ⊃ abs（三张 fixture 恰各命中一档）
 *   ⑤ CLI 端到端：真子进程 + 隔离 team root ⇒ 恰一行 JSON、exit 0、`params`/`asOf` 回显
 *   ⑥ fail-closed：`tasks/` 不可读 ⇒ exit 1 + `ok:false`（绝不读作「没有 Report」）
 *   ⑦ 参数非法 ⇒ exit 2（口径错拼不得静默降级成默认口径）
 *   ⑧ `--compare`：11 族逐行对照 + verdict ∈ {equal,near,diverged} + 每族都有机制解释
 *   ⑨ `--include-archived`：归档卡默认**不**并入分母，加开关才并入
 *   ⑩ 只读：源码不调用任何写卡/改状态 ACL 入口；CLI 跑完 fixture 树逐字节不变
 *   ⑪ `--slots` 过滤 + 未知名 ⇒ exit 2
 *   ⑫ 默认口径 = 头注承诺的那一组（nonempty / all / shape / path）
 *
 * 风格：真实现 + 真 fixture 卡文件（mkdtemp），不做内部 mock；无 provider 安装 ⇒ SKIP（与同目录
 * 既有套件同口径，不是失败）。
 *
 * Run: node --test team/scripts/tests/report-census.test.mjs
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

/** 定位携带 ACL 库的 provider 安装（与 sla-scan.test.mjs / patrol.test.mjs 同口径）。 */
function resolveProviderRoot() {
  const candidates = [
    process.env.OPENCLAW_TASK_OPS_DIR,
    path.join(os.homedir(), '.openclaw', 'team', 'skills', 'task-ops'),
    path.join(os.homedir(), '.openclaw', 'skills', 'task-ops'),
  ].filter(Boolean);
  for (const c of candidates) if (fs.existsSync(path.join(c, 'lib', 'team-paths.mjs'))) return c;
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
  S = await import('../report-census.mjs');
}

const scratchDirs = [];
after(() => {
  for (const d of scratchDirs) fs.rmSync(d, { recursive: true, force: true });
});

/** 新 fixture 根：`tasks/`（+ 可选 `tasks/archive/<ym>/`）。 */
function newRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'report-census-'));
  scratchDirs.push(dir);
  fs.mkdirSync(path.join(dir, 'tasks'), { recursive: true });
  return dir;
}

/** 物化真卡文件（frontmatter 写法与 lib.serializeFrontmatter 同形）。 */
function writeCard(dir, fm, body = '', sub = null) {
  const target = sub ? path.join(dir, 'tasks', sub) : path.join(dir, 'tasks');
  fs.mkdirSync(target, { recursive: true });
  const lines = ['---'];
  for (const [k, v] of Object.entries(fm)) lines.push(`${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);
  lines.push('---');
  fs.writeFileSync(path.join(target, `${fm.id}.md`), lines.join('\n') + '\n' + body, 'utf8');
}

const card = (id, over = {}) => ({
  id,
  title: 'fixture',
  assignee: 'linus',
  status: 'done',
  created_by: 'elon',
  created_at: '2026-01-05T00:00:00.000Z',
  ...over,
});
const report = (text) => `## Report\n${text}\n`;

// ── ① 样本轴（nonempty ⊂ section ⊂ board）─────────────────────────────────────
test('① --sample：nonempty（有段且非空）⊂ section（有段）⊂ board（全部带 frontmatter 的卡）', () => {
  const dir = newRoot();
  writeCard(dir, card('T-20260101-000001'), report('- A1 Conclusion — acceptable'));
  writeCard(dir, card('T-20260101-000002'), '## Report\n');
  writeCard(dir, card('T-20260101-000003'), '## Background\n无 Report 段\n');
  const cards = S.readBoard(path.join(dir, 'tasks')).cards;
  const n = (sample) => S.selectSample(cards, { sample, statuses: ['all'] }).counts;
  assert.deepEqual([n('nonempty').selected, n('section').selected, n('board').selected], [1, 2, 3]);
  assert.equal(n('nonempty').noReportSection, 1);
  assert.equal(n('nonempty').emptyReport, 1);
  // 段空 / 段缺 各归各的桶（口径自述要能在输出里回显，不是靠猜）
  assert.equal(cards.find((c) => c.id === 'T-20260101-000002').reportState, 'empty');
  assert.equal(cards.find((c) => c.id === 'T-20260101-000003').reportState, 'missing');
});

// ── ② 状态面（终态/非终态计入与否）────────────────────────────────────────────
test('② --status：all / nonterminal / terminal 三档，终态集合与 check-report 同源', () => {
  const dir = newRoot();
  writeCard(dir, card('T-20260101-000001', { status: 'done' }), report('- A1 Conclusion — acceptable'));
  writeCard(dir, card('T-20260101-000002', { status: 'in_progress' }), report('- A1 Conclusion — acceptable'));
  writeCard(dir, card('T-20260101-000003', { status: 'canceled' }), report('- A1 Conclusion — acceptable'));
  const cards = S.readBoard(path.join(dir, 'tasks')).cards;
  const n = (statuses) => S.selectSample(cards, { sample: 'nonempty', statuses }).counts;
  assert.equal(n(['all']).selected, 3);
  assert.equal(n(['nonterminal']).selected, 1); // canceled 是终态
  assert.equal(n(['terminal']).selected, 2);
  assert.equal(n(['done', 'in_progress']).selected, 2); // csv 面
  assert.deepEqual(S.TERMINAL, ['done', 'failed', 'canceled']);
  // byStatus 回显（分母的形状要看得见：本卡实测历史看板 ~98% 是终态卡）
  assert.deepEqual(n(['all']).byStatus, { done: 1, in_progress: 1, canceled: 1 });
});

// ── ③ 字面判定：两档真的不同，且非包含关系 ─────────────────────────────────────
test('③ --criterion：topic ≠ shape（acceptance 表形状 / A/B 两档各半边 ⇒ 非包含）', () => {
  const dir = newRoot();
  // acceptance：只提及（topic 命中、shape 不命中）
  writeCard(dir, card('T-20260101-000001'), report('- 看板验收已过，无异议'));
  // acceptance：表形状（两档都命中）
  writeCard(dir, card('T-20260101-000002'), report('| # | item |\n|---|---|\n| ① | 验收项 |'));
  // A/B：shape 命中（成对 before…after）、topic 不命中（无 A/B 记号、无 修前/修后）
  writeCard(dir, card('T-20260101-000003'), report('- before: exit 1, after: exit 0'));
  // A/B：topic 命中（有 A/B 记号）、shape 不命中（无成对词）
  writeCard(dir, card('T-20260101-000004'), report('- A/B 对照见 workspace/x/ab.txt'));
  const cards = S.readBoard(path.join(dir, 'tasks')).cards;
  const hits = (criterion, key) => {
    const { hitRates } = S.census(cards, { criterion, cardPath: 'path', slotKeys: [key] });
    return hitRates[key].total.hits;
  };
  assert.equal(hits('shape', 'acceptance-table'), 1);
  assert.equal(hits('topic', 'acceptance-table'), 2, '只提及的卡在 topic 档必须命中');
  assert.equal(hits('shape', 'ab-before-after'), 1, 'before…after 成对在 shape 档必须命中');
  assert.equal(hits('topic', 'ab-before-after'), 1, 'A/B 记号在 topic 档必须命中');
  // 非包含：两张卡各只命中一档 ⇒ 两档互不覆盖（头注承诺的独立性）
  const { hitRates: hr } = S.census(cards, { criterion: 'topic', cardPath: 'path', slotKeys: ['ab-before-after', 'acceptance-table'] });
  assert.equal(hr['ab-before-after'].levels, 'topic');
  const strict = S.census(cards, { criterion: 'shape', cardPath: 'path', slotKeys: ['ab-before-after'] });
  assert.equal(strict.hitRates['ab-before-after'].levels, 'shape');
});

// ── ④ 卡路径轴：id ⊃ path ⊃ abs ───────────────────────────────────────────────
test('④ --card-path：id / path / abs 三档各命中一张 ⇒ 该轴真的在决定结论', () => {
  const dir = newRoot();
  writeCard(dir, card('T-20260101-000001'), report('- A2 卡 T-20260101-000001 已完成'));
  writeCard(dir, card('T-20260101-000002'), report('- A2 卡 tasks/T-20260101-000002.md 已完成'));
  writeCard(dir, card('T-20260101-000003'), report('- A2 卡 /srv/board/tasks/T-20260101-000003.md 已完成'));
  const cards = S.readBoard(path.join(dir, 'tasks')).cards;
  const hits = (cardPath) => {
    const { hitRates } = S.census(cards, { criterion: 'shape', cardPath, slotKeys: ['card-path'] });
    return hitRates['card-path'].total.hits;
  };
  assert.equal(hits('id'), 3);
  assert.equal(hits('path'), 2);
  assert.equal(hits('abs'), 1);
});

// ── ⑤ CLI 端到端（真子进程 + 隔离 team root）──────────────────────────────────
test('⑤ CLI：恰一行 JSON、exit 0、params 与 asOf 回显（隔离 root 内取数）', { skip: SKIP }, () => {
  const dir = newRoot();
  writeCard(dir, card('T-20260101-000001'), report('- A1 Conclusion — acceptable\n- A2 卡 tasks/T-20260101-000001.md'));
  const r = spawnSync(process.execPath, [path.join(SCRIPTS, 'report-census.mjs'), '--sample=nonempty', '--criterion=topic', '--card-path=id', '--json'], {
    encoding: 'utf8',
    env: { ...process.env, OPENCLAW_TASK_OPS_DIR: PROVIDER, OPENCLAW_TEAM_ROOT: dir },
  });
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.trim().split('\n');
  assert.equal(lines.length, 1, 'stdout 恰一行 JSON');
  const env = JSON.parse(lines[0]);
  assert.equal(env.ok, true);
  assert.ok(!Number.isNaN(Date.parse(env.asOf)), `asOf 必须是可解析时间戳：${env.asOf}`);
  assert.deepEqual(env.params, {
    sample: 'nonempty',
    statuses: ['all'],
    criterion: 'topic',
    cardPath: 'id',
    slots: S.FAMILIES.map((f) => f.key),
    includeArchived: false,
    tasksDir: path.join(dir, 'tasks'),
  });
  assert.equal(env.census.n, 1);
  assert.equal(env.hitRates['card-path'].levels, 'card-path=id');
  assert.equal(env.hitRates['card-path'].byRole.linus.pct, 100);
});

// ── ⑥ fail-closed：看板不可读 ─────────────────────────────────────────────────
test('⑥ 看板不可读 ⇒ exit 1 + ok:false（绝不静默读作「没有 Report」）', { skip: SKIP }, () => {
  const dir = newRoot(); // 有 tasks/ 但…改用不存在的路径
  const r = spawnSync(process.execPath, [path.join(SCRIPTS, 'report-census.mjs'), '--json'], {
    encoding: 'utf8',
    env: { ...process.env, OPENCLAW_TASK_OPS_DIR: PROVIDER, OPENCLAW_TEAM_ROOT: path.join(dir, 'nope') },
  });
  assert.equal(r.status, 1);
  const env = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.equal(env.ok, false);
  assert.equal(env.reason, 'tasks-dir-unreadable');
  assert.match(r.stderr, /看板不可读/);
});

// ── ⑦ 参数非法 ⇒ exit 2 ───────────────────────────────────────────────────────
test('⑦ 口径错拼 ⇒ exit 2（不得静默降级成默认口径）', { skip: SKIP }, () => {
  const dir = newRoot();
  for (const bad of ['--criterion=maybe', '--sample=whatever', '--card-path=relative', '--slots=no-such-family']) {
    const r = spawnSync(process.execPath, [path.join(SCRIPTS, 'report-census.mjs'), bad], {
      encoding: 'utf8',
      env: { ...process.env, OPENCLAW_TASK_OPS_DIR: PROVIDER, OPENCLAW_TEAM_ROOT: dir },
    });
    assert.equal(r.status, 2, `${bad} 必须 exit 2（实测 ${r.status}）`);
    assert.match(r.stderr, /参数非法/);
  }
});

// ── ⑧ --compare：逐行对照 + 判词 + 机制 ───────────────────────────────────────
test('⑧ --compare：11 族都有对照行 / 判词 / 机制解释；公布值只作常量对照', { skip: SKIP }, () => {
  const dir = newRoot();
  writeCard(dir, card('T-20260101-000001'), report('- A1 Conclusion — acceptable'));
  const r = spawnSync(process.execPath, [path.join(SCRIPTS, 'report-census.mjs'), '--compare', '--json'], {
    encoding: 'utf8',
    env: { ...process.env, OPENCLAW_TASK_OPS_DIR: PROVIDER, OPENCLAW_TEAM_ROOT: dir },
  });
  assert.equal(r.status, 0, r.stderr);
  const env = JSON.parse(r.stdout.trim());
  const cmp = env.comparison;
  assert.equal(cmp.rows.length, S.FAMILIES.length, '每个家族都要有一行对照');
  assert.equal(cmp.publishedN, S.PUBLISHED_V1.n);
  assert.equal(cmp.publishedAsOf, null, '公布值无 as-of —— 这正是撤回理由，必须是 null 而非编造');
  for (const row of cmp.rows) {
    assert.ok(row.note && row.note.length >= 8, `${row.key} 缺机制解释`);
    assert.ok(['equal', 'near', 'diverged'].includes(row.bestVerdict), `${row.key} 判词越界：${row.bestVerdict}`);
    for (const c of row.cells) {
      // fixture 只有一个角色 ⇒ 另两格无实测值 ⇒ n/a（不是漏算，也不是 0）
      assert.ok(['equal', 'near', 'diverged', 'n/a'].includes(c.verdict), `${row.key}/${c.role} 判词越界：${c.verdict}`);
      assert.equal(typeof c.published, 'number');
    }
  }
  // 公布常量本身不得被就地篡改（撤回值 = 历史事实）
  assert.deepEqual(S.PUBLISHED_V1.rows['card-path'], { linus: 19, jobs: 16, turing: 16 });
});

// ── ⑨ --include-archived ──────────────────────────────────────────────────────
test('⑨ 归档卡默认不入分母；--include-archived 才并入（并单列计数）', () => {
  const dir = newRoot();
  writeCard(dir, card('T-20260101-000001'), report('- A1 Conclusion — acceptable'));
  writeCard(dir, card('T-20251201-000002'), report('- A1 Conclusion — acceptable'), 'archive/2025-12');
  const plain = S.readBoard(path.join(dir, 'tasks'));
  assert.equal(plain.cards.length, 1);
  assert.equal(plain.archivedFiles, 0);
  const withArc = S.readBoard(path.join(dir, 'tasks'), { includeArchived: true });
  assert.equal(withArc.cards.length, 2);
  assert.equal(withArc.archivedFiles, 1);
  assert.equal(withArc.cards.filter((c) => c.archived).length, 1);
});

// ── ⑩ 只读保证 ────────────────────────────────────────────────────────────────
test('⑩ 只读：源码无写卡/改状态 ACL 调用；跑一次 CLI 后 fixture 树逐字节不变', { skip: SKIP }, () => {
  const src = fs.readFileSync(path.join(SCRIPTS, 'report-census.mjs'), 'utf8');
  for (const banned of ['writeCardAtomic', 'claimCard', 'refreshHeartbeat', 'setStatus', 'serializeFrontmatter', 'writeFileSync', 'rmSync', 'mkdirSync']) {
    assert.ok(!new RegExp(`[^a-zA-Z]${banned}\\s*\\(`).test(src), `普查不得调用 ${banned}()`);
  }
  const dir = newRoot();
  writeCard(dir, card('T-20260101-000001'), report('- A1 Conclusion — acceptable'));
  const snap = () => {
    const out = [];
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const p = path.join(d, e.name);
        out.push(e.isDirectory() ? `d ${path.relative(dir, p)}` : `f ${path.relative(dir, p)} ${fs.readFileSync(p, 'utf8').length}:${fs.statSync(p).mtimeMs}`);
        if (e.isDirectory()) walk(p);
      }
    };
    walk(dir);
    return out;
  };
  const before = snap();
  for (const args of [[], ['--compare'], ['--sample=board', '--include-archived'], ['--json']]) {
    const r = spawnSync(process.execPath, [path.join(SCRIPTS, 'report-census.mjs'), ...args], {
      encoding: 'utf8',
      env: { ...process.env, OPENCLAW_TASK_OPS_DIR: PROVIDER, OPENCLAW_TEAM_ROOT: dir },
    });
    assert.equal(r.status, 0, r.stderr);
  }
  assert.deepEqual(snap(), before, '普查必须逐字节无副作用（不写卡、不写账本、不建目录）');
});

// ── ⑪ --slots 过滤 ───────────────────────────────────────────────────────────
test('⑪ --slots：只算指定家族；未知 key ⇒ exit 2（见 ⑦）', () => {
  const dir = newRoot();
  writeCard(dir, card('T-20260101-000001'), report('- A2 卡 tasks/T-20260101-000001.md · exit 0'));
  const cards = S.readBoard(path.join(dir, 'tasks')).cards;
  const { hitRates } = S.census(cards, { criterion: 'shape', cardPath: 'path', slotKeys: ['card-path', 'command-exit'] });
  assert.deepEqual(Object.keys(hitRates).sort(), ['card-path', 'command-exit']);
  const args = S.parseArgs(['--slots=card-path,command-exit']);
  assert.deepEqual(args.slotKeys, ['card-path', 'command-exit']);
  assert.deepEqual(args.bad, []);
});

// ── ⑫ 默认口径 = 头注承诺的那一组 ─────────────────────────────────────────────
test('⑫ 无参默认：nonempty / all / shape / path / 全部家族 / 不含归档（口径可复跑的前提）', () => {
  const args = S.parseArgs([]);
  assert.deepEqual(args.bad, []);
  assert.equal(args.sample, 'nonempty');
  assert.deepEqual(args.statuses, ['all']);
  assert.equal(args.criterion, 'shape');
  assert.equal(args.cardPath, 'path');
  assert.equal(args.includeArchived, false);
  assert.deepEqual(args.slotKeys, S.FAMILIES.map((f) => f.key));
  assert.equal(args.compare, false);
  assert.equal(args.json, false);
});

test('⑬ 家族表自洽：key 唯一、两档规则都是函数、单层家族两档同源', () => {
  const keys = S.FAMILIES.map((f) => f.key);
  assert.equal(new Set(keys).size, keys.length);
  for (const f of S.FAMILIES) {
    assert.equal(typeof f.topic, 'function', `${f.key} 缺 topic 规则`);
    assert.equal(typeof f.shape, 'function', `${f.key} 缺 shape 规则`);
    assert.ok(f.label && f.label.length >= 3, `${f.key} 缺 label`);
    if (f.levels === 'single') assert.equal(f.topic, f.shape, `${f.key} 标为单层但两档规则不同`);
    else assert.notEqual(f.topic, f.shape, `${f.key} 未标单层却两档同源`);
  }
  assert.deepEqual(Object.keys(S.PUBLISHED_V1.rows).sort(), [...keys].sort(), '公布常量必须覆盖同一组家族');
  assert.deepEqual(Object.keys(S.PUBLISHED_V1.mechanism).sort(), [...keys].sort(), '每族都要有机制解释');
});
