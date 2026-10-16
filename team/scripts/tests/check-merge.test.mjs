#!/usr/bin/env node
/**
 * check-merge.test.mjs — scripts/check-merge.mjs（交付合并巡检）
 *
 * 覆盖本门禁的判定面与三条「不许误判」的守卫：
 *   ① 已并入 dev ⇒ 通过；未并入 + 卡 `done` ⇒ 红（退出码 1）
 *   ② **触发面只有 `done`**——作业中（`in_progress`/`in_review`/`blocked`）与 `canceled` 一律不判：
 *      作业中的卡天然持有未合并的隔离树，判它必令每条在跑的 lane 转红
 *   ③ **不敢判的三态一律 skip + warn，绝不转红**：仓解析不到 / 无 `.worktrees/` / **`dev` 解析不到**
 *      （最后一条是关键守卫：`merge-base --is-ancestor X dev` 在 `dev` 不存在时返回非零，
 *      不加守卫会与「未合并」不可区分 ⇒ 把无 dev 的仓全判红）
 *   ④ 归属判定：分支名即卡 id，亦接受 `<card-id>-<seg>`；归属不到 ⇒ 只出 unattributed 提示
 *   ⑤ 生效截止（`created_at` 早于截止 ⇒ 降 warn）+ 豁免登记（命中放行 / reason 不合格不放行）
 *
 * 隔离：`OPENCLAW_TEAM_ROOT` 必须在 **import check-merge.mjs 之前**设（`TASKS_DIR` 在 import 期固化）；
 * 仓用 mkdtemp 现造（真 git：`worktree add` + 真提交让分支**真的**不在 dev 上）。
 * provider 缺失即整体 skip（与 check-report.test.mjs 同款）——`lib.mjs` 对 provider 是硬依赖。
 *
 * Run: node --test team/scripts/tests/check-merge.test.mjs
 */
import { test as nodeTest, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));      // <repo>/team/scripts/tests
const SCRIPT = path.join(HERE, '..', 'check-merge.mjs');

const scratch = [];
after(() => { for (const d of scratch) fs.rmSync(d, { recursive: true, force: true }); });
function tmp(tag) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `oc-merge-${tag}-`));
  scratch.push(d);
  return d;
}

/** provider 解析：与 check-report.test.mjs 同口径（`OPENCLAW_TASK_OPS_DIR` > <repo>/team/skills/task-ops）。 */
function resolveProviderRoot() {
  const cand = [process.env.OPENCLAW_TASK_OPS_DIR, path.join(HERE, '..', '..', 'skills', 'task-ops')].filter(Boolean);
  for (const c of cand) if (fs.existsSync(path.join(c, 'lib', 'team-paths.mjs'))) return path.resolve(c);
  return '';
}
const PROVIDER = resolveProviderRoot();
const SKIP = !PROVIDER;
const test = SKIP ? nodeTest.skip : nodeTest;

// 隔离 root 必须在 import 之前设好（TASKS_DIR 在 import 期固化）
const ROOT = tmp('root');
const TASKS = path.join(ROOT, 'tasks');
fs.mkdirSync(TASKS, { recursive: true });
process.env.OPENCLAW_TEAM_ROOT = ROOT;
if (PROVIDER) process.env.OPENCLAW_TASK_OPS_DIR = PROVIDER;

const mod = PROVIDER ? await import('../check-merge.mjs') : null;
const { scanMerges, effectiveAt, EFFECTIVE_AT, INTEGRATION_BRANCH, WORKTREES_DIRNAME, cardOfBranch, validExemption } = mod || {};

// ---------- 夹具 ----------

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid',
  GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid',
};
const git = (cwd, argv) => execFileSync('git', ['-C', cwd, ...argv], { encoding: 'utf8', env: GIT_ENV }).trim();

/**
 * 造一个仓。`dev:true` ⇒ 默认分支即 `dev`；`dev:false` ⇒ 默认分支 `main` 且**从不建 `dev`**
 * （故意造「无 dev」的仓；不能先建再 `branch -D`——检出中的分支删不掉）。
 */
function mkRepo(tag, { dev = true } = {}) {
  const repo = tmp(`repo-${tag}`);
  git(repo, ['init', '-q', '-b', dev ? 'dev' : 'main']);
  fs.writeFileSync(path.join(repo, 'README.md'), '# fixture\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'base']);
  return repo;
}

/**
 * 在仓内建一个 `.worktrees/<branchName>` 检出。
 * `merged:true` ⇒ 分支停在 dev 上（即已是 dev 的祖先）；`merged:false` ⇒ 加一个 dev 没有的提交。
 */
function mkWorktree(repo, branchName, { merged = true } = {}) {
  const wtPath = path.join(repo, WORKTREES_DIRNAME, branchName);
  git(repo, ['worktree', 'add', '-q', wtPath, '-b', branchName]);
  if (!merged) {
    fs.writeFileSync(path.join(wtPath, 'feature.txt'), `${branchName}\n`);
    git(wtPath, ['add', '-A']);
    git(wtPath, ['commit', '-q', '-m', `${branchName}: wip`]);
  }
  return wtPath;
}

function writeCard(id, { status = 'done', created = '2026-10-16T11:00:00Z' } = {}) {
  const fm = ['---',
    `id: ${id}`,
    `title: ${id}`,
    'assignee: linus',
    `status: ${status}`,
    'goal: fixture',
    'project: openclaw-team',
    `created_at: "${created}"`,
    '---',
    '', 'body', ''].join('\n');
  fs.writeFileSync(path.join(TASKS, `${id}.md`), fm);
}
function clearBoard() {
  for (const f of fs.readdirSync(TASKS)) if (f.endsWith('.md')) fs.rmSync(path.join(TASKS, f));
}

const AFTER = '2026-10-16T11:00:00Z';   // 晚于 EFFECTIVE_AT ⇒ 受硬判
const BEFORE = '2026-10-01T00:00:00Z';  // 早于 EFFECTIVE_AT ⇒ grandfather

// ---------------------------------------------------------------------------
// ① 判定面
// ---------------------------------------------------------------------------

test('已并入 dev 的 worktree ⇒ 通过（分支停在 dev 上，是它的祖先）', () => {
  clearBoard();
  const repo = mkRepo('ok');
  mkWorktree(repo, 'T-20261016-000001', { merged: true });
  writeCard('T-20261016-000001');
  const r = scanMerges(TASKS, { repo, baseline: [] });
  assert.equal(r.ok, true, JSON.stringify(r.violations));
  assert.deepEqual(r.violations, []);
  assert.equal(r.integrationResolved.length > 0, true, 'dev 必须解析到');
});

test('未并入 + 卡 done ⇒ 判红，且违例点名到卡 id 与分支', () => {
  clearBoard();
  const repo = mkRepo('red');
  mkWorktree(repo, 'T-20261016-000002', { merged: false });
  writeCard('T-20261016-000002', { created: AFTER });
  const r = scanMerges(TASKS, { repo, baseline: [] });
  assert.equal(r.ok, false);
  assert.equal(r.violations.length, 1);
  assert.equal(r.violations[0].id, 'T-20261016-000002');
  assert.equal(r.violations[0].branch, 'T-20261016-000002');
  assert.equal(r.violations[0].status, 'done');
});

test('触发面只有 done：in_progress / in_review / blocked / canceled 一律不判（作业中的树天然未合并）', () => {
  for (const status of ['in_progress', 'in_review', 'blocked', 'canceled']) {
    clearBoard();
    const repo = mkRepo(`st-${status}`);
    mkWorktree(repo, 'T-20261016-000003', { merged: false });
    writeCard('T-20261016-000003', { status, created: AFTER });
    const r = scanMerges(TASKS, { repo, baseline: [] });
    assert.equal(r.ok, true, `${status} 不应判红：${JSON.stringify(r.violations)}`);
    assert.deepEqual(r.violations, [], `${status} 不应产生违例`);
  }
});

// ---------------------------------------------------------------------------
// ② 不敢判的三态（绝不转红）
// ---------------------------------------------------------------------------

test('仓解析不到 ⇒ skip + note，不转红', () => {
  clearBoard();
  writeCard('T-20261016-000004', { created: AFTER });
  const r = scanMerges(TASKS, { repo: '', baseline: [] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.notes, ['repo-missing']);
});

test('无 .worktrees/ ⇒ skip + note，不转红', () => {
  clearBoard();
  const repo = mkRepo('nodir');
  writeCard('T-20261016-000005', { created: AFTER });
  const r = scanMerges(TASKS, { repo, baseline: [] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.notes, ['no-worktrees-dir']);
});

test('dev 解析不到 ⇒ skip + note，**绝不**把无 dev 的仓全判红（is-ancestor 非零会与「未合并」混淆）', () => {
  clearBoard();
  const repo = mkRepo('nodev', { dev: false });
  mkWorktree(repo, 'T-20261016-000006', { merged: false });
  writeCard('T-20261016-000006', { created: AFTER });
  const r = scanMerges(TASKS, { repo, baseline: [] });
  assert.equal(r.ok, true, '缺 dev 不得转红');
  assert.deepEqual(r.violations, []);
  assert.deepEqual(r.notes, [`integration-unresolved:${INTEGRATION_BRANCH}`]);
});

// ---------------------------------------------------------------------------
// ③ 归属判定
// ---------------------------------------------------------------------------

test('归属：<card-id>-<seg> 形状也能归到卡', () => {
  clearBoard();
  const repo = mkRepo('seg');
  mkWorktree(repo, 'T-20261016-000007-seg2', { merged: false });
  writeCard('T-20261016-000007', { created: AFTER });
  const r = scanMerges(TASKS, { repo, baseline: [] });
  assert.equal(r.violations.length, 1);
  assert.equal(r.violations[0].id, 'T-20261016-000007');
  assert.equal(r.violations[0].branch, 'T-20261016-000007-seg2');
});

test('归属不到（分支名不含卡 id）⇒ 只出 unattributed 提示，不转红', () => {
  clearBoard();
  const repo = mkRepo('unattr');
  mkWorktree(repo, 'some-adhoc-branch', { merged: false });
  writeCard('T-20261016-000008', { created: AFTER });
  const r = scanMerges(TASKS, { repo, baseline: [] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.violations, []);
  assert.equal(r.unattributed.length, 1);
  assert.equal(r.unattributed[0].why, 'no_card_for_branch');
});

test('cardOfBranch 是纯函数：id 命中 / seg 剥段 / 命中不了返回 null', () => {
  const ids = new Set(['T-20261016-000009', 'T-20261016-000010']);
  assert.equal(cardOfBranch('T-20261016-000009', ids), 'T-20261016-000009');
  assert.equal(cardOfBranch('T-20261016-000009-seg3', ids), 'T-20261016-000009');
  assert.equal(cardOfBranch('T-20261016-000009-seg3-container', ids), 'T-20261016-000009');
  assert.equal(cardOfBranch('nope', ids), null);
  assert.equal(cardOfBranch('', ids), null);
});

// ---------------------------------------------------------------------------
// ④ 生效截止 + 豁免
// ---------------------------------------------------------------------------

test('生效截止之前创建的卡 ⇒ 降 warn（grandfathered），不转红', () => {
  clearBoard();
  const repo = mkRepo('grand');
  mkWorktree(repo, 'T-20261016-000011', { merged: false });
  writeCard('T-20261016-000011', { created: BEFORE });
  const r = scanMerges(TASKS, { repo, baseline: [] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.violations, []);
  assert.equal(r.grandfathered.length, 1);
  assert.equal(r.grandfathered[0].id, 'T-20261016-000011');
});

test('created_at 缺失 ⇒ 保守按 grandfather（绝不因缺字段转红）', () => {
  clearBoard();
  const repo = mkRepo('nocreated');
  mkWorktree(repo, 'T-20261016-000012', { merged: false });
  writeCard('T-20261016-000012', { created: '' });
  const r = scanMerges(TASKS, { repo, baseline: [] });
  assert.equal(r.ok, true);
  assert.equal(r.grandfathered.length, 1);
});

test('豁免登记命中（id + 分支一致，reason ≥8 字符）⇒ 放行', () => {
  clearBoard();
  const repo = mkRepo('exempt');
  mkWorktree(repo, 'T-20261016-000013', { merged: false });
  writeCard('T-20261016-000013', { created: AFTER });
  const r = scanMerges(TASKS, {
    repo,
    baseline: [{ id: 'T-20261016-000013', branch: 'T-20261016-000013', reason: '人工核对：产物另行交付，分支保留' }],
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.violations, []);
  assert.equal(r.exempt.length, 1);
});

test('豁免登记 reason 过短 ⇒ 不放行，转红并点名 invalidExemptions', () => {
  clearBoard();
  const repo = mkRepo('badexempt');
  mkWorktree(repo, 'T-20261016-000014', { merged: false });
  writeCard('T-20261016-000014', { created: AFTER });
  const r = scanMerges(TASKS, { repo, baseline: [{ id: 'T-20261016-000014', reason: '短' }] });
  assert.equal(r.ok, false);
  assert.equal(r.violations.length, 1);
  assert.equal(r.invalidExemptions.length, 1);
});

test('豁免登记的 branch 与实际检出不一致 ⇒ 失效（防「登记一次、永久放行」）', () => {
  clearBoard();
  const repo = mkRepo('exemptdrift');
  mkWorktree(repo, 'T-20261016-000015', { merged: false });
  writeCard('T-20261016-000015', { created: AFTER });
  const r = scanMerges(TASKS, {
    repo,
    baseline: [{ id: 'T-20261016-000015', branch: '某个别的分支', reason: '人工核对：这条理由足够长' }],
  });
  assert.equal(r.ok, false, '分支不一致 ⇒ 豁免失效');
  assert.equal(r.violations.length, 1);
});

test('validExemption 是纯函数：reason 去空白后 ≥8 字符才算有效', () => {
  assert.equal(validExemption({ id: 'a', reason: '12345678' }), true);
  assert.equal(validExemption({ id: 'a', reason: '        ' + '12345678' }), true);
  assert.equal(validExemption({ id: 'a', reason: '1234567' }), false);
  assert.equal(validExemption({ id: 'a' }), false);
  assert.equal(validExemption({ reason: '12345678' }), false);
  assert.equal(validExemption(null), false);
});

// ---------------------------------------------------------------------------
// ⑤ CLI：退出码 + stdout 是完整 JSON（不得被截断）
// ---------------------------------------------------------------------------

test('CLI：未并入 ⇒ exit 1，且 stdout 仍是可解析的完整 JSON；已并入 ⇒ exit 0', () => {
  const repo = mkRepo('cli');
  const env = { ...process.env, OPENCLAW_TEAM_ROOT: ROOT, OPENCLAW_TASK_OPS_DIR: PROVIDER };

  clearBoard();
  mkWorktree(repo, 'T-20261016-000020', { merged: false });
  writeCard('T-20261016-000020', { created: AFTER });
  const red = spawnSync(process.execPath, [SCRIPT, '--repo', repo], { encoding: 'utf8', env });
  assert.equal(red.status, 1, red.stderr);
  const parsed = JSON.parse(red.stdout);                 // 断言 stdout 未被截断
  assert.equal(parsed.ok, false);
  assert.equal(parsed.violations.length, 1);
  assert.match(red.stderr, /交付合并违例/);
  assert.match(red.stderr, new RegExp(INTEGRATION_BRANCH));

  clearBoard();
  writeCard('T-20261016-000020', { created: AFTER });
  git(repo, ['-C', repo, 'merge', '-q', '--no-ff', '-m', 'merge fixture', 'T-20261016-000020']);
  const green = spawnSync(process.execPath, [SCRIPT, '--repo', repo], { encoding: 'utf8', env });
  assert.equal(green.status, 0, green.stderr);
  assert.equal(JSON.parse(green.stdout).ok, true);
});

test('CLI：--no-baseline 忽略登记，让被豁免的卡露出真违规', () => {
  clearBoard();
  const repo = mkRepo('nobase');
  mkWorktree(repo, 'T-20261016-000021', { merged: false });
  writeCard('T-20261016-000021', { created: AFTER });
  fs.writeFileSync(path.join(TASKS, '.merge-baseline.json'), JSON.stringify({
    cards: [{ id: 'T-20261016-000021', branch: 'T-20261016-000021', reason: '人工核对：一次性放行理由' }],
  }));
  const env = { ...process.env, OPENCLAW_TEAM_ROOT: ROOT, OPENCLAW_TASK_OPS_DIR: PROVIDER };
  const withBase = spawnSync(process.execPath, [SCRIPT, '--repo', repo], { encoding: 'utf8', env });
  assert.equal(withBase.status, 0, withBase.stderr);
  const without = spawnSync(process.execPath, [SCRIPT, '--repo', repo, '--no-baseline'], { encoding: 'utf8', env });
  assert.equal(without.status, 1, '--no-baseline 应让真违规露出');
  fs.rmSync(path.join(TASKS, '.merge-baseline.json'));
});

test('仓内托管模板必须保持零豁免（「仓内不得夹带豁免」）', () => {
  const tpl = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'merge-baseline.json'), 'utf8'));
  assert.deepEqual(tpl.cards, [], '仓内 merge-baseline.json 的 cards 必须为空');
  assert.equal(tpl.role, 'template');
});

test('resolveRepoDir：env 腿 → 状态文件腿 → ""（与 dispatch.mjs 同源；两腿都不通绝不留空继续跑）', () => {
  const { resolveRepoDir } = mod;
  const repo = mkRepo('resolver');

  // 腿 1：$OPENCLAW_TEAM_REPO 指向存在的目录
  assert.equal(resolveRepoDir({ OPENCLAW_TEAM_REPO: repo }), repo);
  // 腿 1 落空（路径不存在）⇒ 落到腿 2
  const stateFile = path.join(tmp('state'), 'install-state.json');
  fs.writeFileSync(stateFile, JSON.stringify({ repoPath: repo }));
  assert.equal(resolveRepoDir({ OPENCLAW_TEAM_REPO: '/nope/does/not/exist', OPENCLAW_TEAM_INSTALL_STATE: stateFile }), repo);
  // 腿 2 落空（repoPath 不存在）⇒ ""
  fs.writeFileSync(stateFile, JSON.stringify({ repoPath: '/nope/does/not/exist' }));
  assert.equal(resolveRepoDir({ OPENCLAW_TEAM_INSTALL_STATE: stateFile }), '');
  // 状态文件不存在 / 不可解析 ⇒ ""
  assert.equal(resolveRepoDir({ OPENCLAW_TEAM_INSTALL_STATE: path.join(tmp('nostate'), 'x.json') }), '');
});

test('默认生效截止是常量、可被 env 覆盖且非法值回退（绝不静默变严）', () => {
  const saved = process.env.OPENCLAW_TEAM_MERGE_EFFECTIVE_AT;
  delete process.env.OPENCLAW_TEAM_MERGE_EFFECTIVE_AT;
  assert.equal(effectiveAt(), EFFECTIVE_AT);
  process.env.OPENCLAW_TEAM_MERGE_EFFECTIVE_AT = '2026-01-01T00:00:00Z';
  assert.equal(effectiveAt(), '2026-01-01T00:00:00.000Z');
  process.env.OPENCLAW_TEAM_MERGE_EFFECTIVE_AT = '不是时间';
  assert.equal(effectiveAt(), EFFECTIVE_AT, '非法值必须回退常量');
  if (saved === undefined) delete process.env.OPENCLAW_TEAM_MERGE_EFFECTIVE_AT;
  else process.env.OPENCLAW_TEAM_MERGE_EFFECTIVE_AT = saved;
});
