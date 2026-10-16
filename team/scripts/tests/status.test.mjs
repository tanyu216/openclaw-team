#!/usr/bin/env node
/**
 * status.test.mjs — `scripts/status.mjs`（状态词表模块）的单测 + **provider 词表对拍**。
 *
 * 两层：
 *   ① **本模块自证**（无 provider 也跑）：零依赖不变量、谓词表、两轴不相交、换算全表。
 *   ② **对拍**（有 provider 才跑）：provider 是**边界**上唯一写卡入口，其词表是写侧权威；本模块
 *      是仓内读侧断言面。两者一致性由本套件逐值钉死 —— provider 增删词（或本模块拼错一个词）
 *      会在这里**变红**，而不是让某类卡静默隐形（历史上 `todo` 就是这样隐形过一次，
 *      见 `samefile-guard.mjs` / `check-idem.mjs` 的注释）。
 *
 * provider 口径（同 claim-guard.test.mjs / samefile-guard.test.mjs）：ACL 库有意不随仓 ⇒ 本地
 * `resolveProviderRoot()` 依次尝试 `OPENCLAW_TASK_OPS_DIR` → `~/.openclaw/team/skills/task-ops`
 * → `~/.openclaw/skills/task-ops`；无 provider ⇒ **仅第 ② 层 SKIP**，第 ① 层照跑。
 *
 * 运行：node --test team/scripts/tests/status.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import * as S from '../status.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(HERE, '..', 'status.mjs'), 'utf8');

// ── 零依赖：本模块必须在任何上下文可装载（含未装 provider 的仓内 checkout、纯单测） ──────────
// 这是它作为「词表」的深度前提：接口是一组纯谓词，实现是词表本身；一旦它开始 import provider /
// lib.mjs / 读 env，装载它就重新带上「仓外依赖」，12 处 import 的收益随即消失。

test('0. 零依赖不变量：本模块不得 import 任何模块、不得读 env、不得做 I/O', () => {
  const code = SRC.split('\n').filter((l) => !/^\s*\*/.test(l)).join('\n'); // 剥掉块注释行
  for (const [re, why] of [
    [/^\s*import\s/m, '不得有顶层 import（含 `import type`/动态 import）'],
    [/\brequire\s*\(/, '不得用 require'],
    [/process\.env/, '不得读 env（读 env 就不可单测、且随宿主漂移）'],
    [/\b(fs|path)\s*\./, '不得做 I/O'],
  ]) {
    assert.ok(!re.test(code), `status.mjs ${why}`);
  }
});

// ── ① 词表与谓词 ────────────────────────────────────────────────────────────────

test('1. 规范 7 值 = PROTOCOL §⑯ 顺序；别名 5 词；ACCEPTED = 规范 ∪ 别名', () => {
  assert.deepEqual(S.CANONICAL_STATUSES, ['backlog', 'todo', 'in_progress', 'in_review', 'blocked', 'done', 'canceled']);
  assert.deepEqual(S.STATUS_ALIASES, ['ready', 'failed', 'in-review', 'in-progress', 'cancelled']);
  assert.deepEqual([...S.ACCEPTED_STATUSES].sort(), [...S.CANONICAL_STATUSES, ...S.STATUS_ALIASES].sort());
});

test('2. 读侧白名单**故意窄于** ACCEPTED（拼写别名不得漏进仓内卡面）', () => {
  assert.deepEqual(S.READ_STATUSES, ['backlog', 'todo', 'in_progress', 'in_review', 'blocked', 'done', 'canceled', 'ready', 'failed']);
  for (const s of ['in-review', 'in-progress', 'cancelled']) {
    assert.ok(S.ACCEPTED_STATUSES.has(s), `${s} 应在 provider 接受词表内`);
    assert.ok(!S.READ_STATUSES.includes(s), `${s} 是容忍拼写，不得进仓内读侧白名单`);
  }
});

test('3. normalizeCardStatus：别名映射到规范值，未知名/空值 ⇒ null（绝不猜）', () => {
  assert.equal(S.normalizeCardStatus('ready'), 'todo');
  assert.equal(S.normalizeCardStatus('failed'), 'canceled');
  assert.equal(S.normalizeCardStatus('cancelled'), 'canceled');
  assert.equal(S.normalizeCardStatus('in-review'), 'in_review');
  assert.equal(S.normalizeCardStatus('in-progress'), 'in_progress');
  assert.equal(S.normalizeCardStatus('  done  '), 'done', '应 trim');
  assert.equal(S.normalizeCardStatus('todo'), 'todo', '规范值恒等');
  for (const bad of ['', '   ', null, undefined, 'in_reviw', 'DONE', 'finished']) {
    assert.equal(S.normalizeCardStatus(bad), null, `${JSON.stringify(bad)} 不得被归一成任何已知词`);
  }
});

test('4. 谓词表：对每个规范值/别名逐格钉死（谓词各自具名，不复用取反）', () => {
  // [词, isTerminal, isNew, isInFlight, isDraft, isNonTerminal, isOpen]
  const TABLE = [
    // 规范 7 值
    ['backlog', false, false, false, false, false, true],
    ['todo', false, true, false, false, true, true],
    ['in_progress', false, false, true, true, true, true],
    ['in_review', false, false, true, false, true, true],
    ['blocked', false, false, false, true, true, true],
    ['done', true, false, false, false, false, false],
    ['canceled', true, false, false, false, false, false],
    // 兼容别名（必须与所映射的规范值同判）
    ['ready', false, true, false, false, true, true],
    ['failed', true, false, false, false, false, false],
    ['cancelled', true, false, false, false, false, false],
    ['in-review', false, false, true, false, true, true],
    ['in-progress', false, false, true, true, true, true],
    // 未知名 / 空值：一律 false（不猜、不放宽）
    ['', false, false, false, false, false, false],
    ['in_reviw', false, false, false, false, false, false],
  ];
  for (const [w, term, isNew, inFlight, draft, nonTerm, open] of TABLE) {
    const label = w === '' ? '(空)' : w;
    assert.equal(S.isTerminal(w), term, `isTerminal(${label})`);
    assert.equal(S.isNew(w), isNew, `isNew(${label})`);
    assert.equal(S.isInFlight(w), inFlight, `isInFlight(${label})`);
    assert.equal(S.isDraft(w), draft, `isDraft(${label})`);
    assert.equal(S.isNonTerminal(w), nonTerm, `isNonTerminal(${label})`);
    assert.equal(S.isOpen(w), open, `isOpen(${label})`);
  }
});

test('5. `isNonTerminal` **不是** `!isTerminal`：分界恰是未排期的 `backlog`', () => {
  // 这条是本次「谓词各自具名」设计的核心断言。取反口径会把 backlog 读成写者（放宽守卫），
  // 而 check-card 的「__team__ 缺 target」域又**必须**含 backlog（排除法）。两个业务问题，
  // 两个答案 —— 故模块不提供「非终态 = 取反」这种会二选一错的谓词。
  assert.equal(S.isNonTerminal('backlog'), false, 'backlog 未排期 ⇒ 不占写集');
  assert.equal(S.isOpen('backlog'), true, 'backlog 未收口 ⇒ SLA 门仍视其 open');
  assert.equal(S.isTerminal('backlog'), false);
});

test('6. 导出集合与同名谓词一致（防止集合被改动而谓词没跟上）', () => {
  for (const s of S.TERMINAL) assert.ok(S.isTerminal(s), `集合含 ${s} 但 isTerminal 为假`);
  for (const s of S.NEW_STATUSES) assert.ok(S.isNew(s), `集合含 ${s} 但 isNew 为假`);
  for (const s of S.IN_FLIGHT_STATUSES) assert.ok(S.isInFlight(s), `集合含 ${s} 但 isInFlight 为假`);
  for (const s of S.DRAFT_STATUSES) assert.ok(S.isDraft(s), `集合含 ${s} 但 isDraft 为假`);
  for (const s of S.NON_TERMINAL) assert.ok(S.isNonTerminal(s), `集合含 ${s} 但 isNonTerminal 为假`);
  for (const s of S.SESSION_TERMINAL_STATUSES) assert.ok(S.isSessionTerminal(s), `集合含 ${s} 但 isSessionTerminal 为假`);
});

// ── ② 两轴：用词故意不同，唯一换算处 ──────────────────────────────────────────────

test('7. 两轴终态用词不相交（卡面 canceled vs 会话 closed）—— 不是漂移，是设计', () => {
  assert.equal(S.isSessionTerminal('closed'), true);
  assert.equal(S.isTerminal('closed'), false, '会话词 closed 不是卡面终态');
  assert.equal(S.isTerminal('canceled'), true);
  assert.equal(S.isSessionTerminal('canceled'), false, '卡面词 canceled 不是会话终态');
  assert.equal(S.isSessionTerminal('running'), false, 'running 非终态');
});

test('8. sessionTerminalForCard：全表 + 恒为会话终态（总函数，绝不外泄非终态）', () => {
  const TABLE = [
    ['canceled', 'failed'], ['failed', 'failed'],
    ['done', 'done'], ['in_review', 'done'],
    ['backlog', 'closed'], ['todo', 'closed'], ['ready', 'closed'],
    ['in_progress', 'closed'], ['blocked', 'closed'],
  ];
  for (const [card, want] of TABLE) {
    assert.equal(S.sessionTerminalForCard(card), want, `sessionTerminalForCard(${card})`);
  }
  // 任意输入（含空值/未知名）都必须落在会话终态集内：调用方（lane-reaper）据此无条件收口。
  const WORDS = [...S.ACCEPTED_STATUSES, '', 'nonsense', null, undefined, '  '];
  for (const w of WORDS) {
    assert.ok(S.isSessionTerminal(S.sessionTerminalForCard(w)), `${JSON.stringify(w)} 换算后仍非会话终态`);
  }
});

// ── ③ provider 词表对拍（无 provider ⇒ SKIP） ───────────────────────────────────

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
const SKIP = PROVIDER ? false : 'provider ACL library not installed (task-ops is intentionally not vendored); set OPENCLAW_TASK_OPS_DIR to run';
const ptest = SKIP ? test.skip : test;

let P = null;
if (PROVIDER) P = await import(pathToFileURL(path.join(PROVIDER, 'lib', 'task.mjs')).href);

ptest('9. 对拍 provider：规范值 / 别名 / 接受词表 / 终态集 **逐值一致**', () => {
  assert.deepEqual(S.CANONICAL_STATUSES, P.CANONICAL_STATUSES, '规范 7 值须与 provider 逐值同序一致');
  assert.deepEqual(S.STATUS_ALIASES, P.STATUS_ALIASES, '兼容别名须与 provider 逐值一致');
  assert.deepEqual([...S.ACCEPTED_STATUSES].sort(), [...P.ACCEPTED_STATUSES].sort(), '接受词表须一致');
  assert.deepEqual([...S.TERMINAL].sort(), [...P.TERMINAL_STATUSES].sort(), '终态集须一致');
  // 终态集是**写保护**判据：它的成员必须是 provider 认识的词，且不得落在非终态。
  for (const s of S.TERMINAL) assert.ok(P.ACCEPTED_STATUSES.has(s), `终态词 ${s} 不在 provider 接受词表内`);
});

ptest('10. 对拍差异：provider `NON_TERMINAL` 陈旧（用旧词 ready、缺 canonical todo）—— 已知且有意', () => {
  // 本模块**故意**不取 provider 的 `NON_TERMINAL`：它用旧词 `ready` 顶替 canonical `todo`，
  // 与其自身 `CANONICAL_STATUSES` 自相矛盾。仓内读侧（samefile-guard / lane-isolation /
  // check-idem）一律取本模块的集合。此例把差异**固化成断言**：provider 侧修好后本例会红，
  // 提示把本条连同 status.mjs 文件头那段落注一起删掉 —— 而不是让差异静默漂移。
  const ours = new Set(S.NON_TERMINAL);
  const theirs = P.NON_TERMINAL;
  for (const s of theirs) {
    assert.ok(ours.has(s), `provider 非终态词 ${s} 不得在仓内集合里缺席（否则该类卡对写集判定隐形）`);
  }
  const extraInOurs = [...ours].filter((s) => !theirs.has(s)).sort();
  assert.deepEqual(extraInOurs, ['todo'],
    '仓内集合相对 provider 的唯一增量应恰为 canonical `todo`；若 provider 已修，请解除本断言并更新 status.mjs 文件头注');
  assert.ok(theirs.has('ready') && !theirs.has('todo'), 'provider 侧的陈旧形态变了 ⇒ 请复核本断言的措辞');
});

ptest('11. 对拍差异：终态集含旧词 `failed`（provider 亦然），故 `isTerminal` 须按别名归一后判定', () => {
  // provider `TERMINAL_STATUSES` 同时收 `failed` 与 `canceled` ⇒ 旧制仍把 `failed` 当终态。
  // 本模块的 `TERMINAL` 数组保持同一枚举（byte-stable，命名沿用仓内既有词汇）；而 `isTerminal`
  // 走别名归一 ⇒ `cancelled` 这类**拼写别名**亦判终态（provider 的集合未收它）。
  assert.ok(P.TERMINAL_STATUSES.has('failed') && P.TERMINAL_STATUSES.has('canceled'));
  assert.equal(S.isTerminal('failed'), true);
  assert.equal(S.isTerminal('canceled'), true);
  assert.equal(S.isTerminal('cancelled'), true, '拼写别名归一后同为终态');
  assert.equal(P.TERMINAL_STATUSES.has('cancelled'), false, 'provider 集合未收该拼写 ⇒ 差异存在但方向是「我们更宽」');
});
