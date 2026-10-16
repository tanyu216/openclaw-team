/**
 * check-all-repo-mode.test.mjs — 门禁的「仓内自证」模式（无实例机器）
 *
 * 验收口径（本套件即其机检）：**一台没有安装 OpenClaw 实例的机器上，`check-all.sh` 必须给出
 * 可用的判定**，而不是今天那样连脚本都加载不到（`MODULE_NOT_FOUND: <home>/.openclaw/team/scripts/…`
 * ⇒ ok:false）。做法：把仓的**真内容**拷进临时树，实例路径指向不存在的位置，然后跑门禁。
 *
 * 三个必须成立的行为：
 *   1. 无实例 ⇒ 自动落到 repo 模式，`--segment fast` 绿，信封带 `"mode":"repo"`；
 *   2. 显式 `--repo <R>` 在**本机有实例**时也必须是 repo 模式（绝不读本机实例）；
 *   3. 显式要求 live 而无实例 ⇒ exit 2 且给出指引（**绝不静默假绿**）。
 *
 * 夹具是**分发仓**的替身 ⇒ 非分发仓整体 skip（T-20261016-102552）：
 *   本文件随 install.sh 装到 `<team>/scripts/tests/`，此时 `../../..` 是 `~/.openclaw`——
 *   既没有 `roles/`（角色种子装在 `workspace-<role>/`，不在 `<home>/roles/`），也没有 `install.sh`，
 *   于是每一例都死在 `cpSync(<home>/roles)` 的 ENOENT 上，报的是 5 条**假红**；而且真到拷得动的那天
 *   它会去拷整棵实例树（参考机上 `<home>/team` ≈ 8 GB）。判据同 host-paths.mjs，绝不靠「有没有 roles」猜。
 *
 * 夹具必须是**完整的**仓副本（T-20261016-102552 顺带修的第 2 处）：
 *   原先只拷 `team/`+`roles/`+`install.sh`（注释里还写着「不拷庞大的 tools」——该判断早已过期，
 *   整仓才 ~3 MB）。可 repo 模式的 `lint-doc-refs` 是把 team/ roles/ 里的**路径引用按仓根解析**的，
 *   于是 `config/reconcile.mjs`、`docker/verify.sh`、`tools/ui-align/README.md` 全成了「断引用」，
 *   门禁在夹具里判红 ⇒ 本套件自己报 3 条假红（HEAD 上即可复现）。夹具少拷哪个目录，就等于
 *   悄悄改了被测门禁的输入；故改为「整仓副本，只排除 .git / node_modules」。
 *
 * Run: node --test team/scripts/tests/check-all-repo-mode.test.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REPO_MARKS, isDistributionRepo } from '../host-paths.mjs';

const SCRIPTS = path.dirname(fileURLToPath(import.meta.url));   // <repo>/team/scripts/tests
const REPO = path.resolve(SCRIPTS, '..', '..', '..');            // <repo>
// 逐例 `{ skip: SKIP }`（而不是 `SKIP ? nodeTest.skip : nodeTest` 别名）：别名会把 5 条用例
// 变成一行光秃秃的 `# SKIP`，**看不出为什么**——「实例上没有什么可自证的」正是这里唯一要说的事。
const SKIP = isDistributionRepo(REPO)
  ? false
  : `部署布局：${REPO} 不是分发仓（缺 ${REPO_MARKS.join(' / ')}）——本套件只对分发仓有意义`;

const scratch = [];
/** 只排除与门禁无关的重物；**其余整仓照拷**——夹具少拷一个目录，就是悄悄改掉被测门禁的输入。 */
const FIXTURE_SKIP = new Set(['.git', 'node_modules']);
function mkRepoCopy() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-repomode-'));
  scratch.push(root);
  // 逐顶层项拷（而不是 cpSync(REPO, root)）：后者的 dest 已存在时的嵌套语义易生歧义，
  // 而夹具根的**形状**正是被测对象（`../../..` 必须恰好等于夹具根）。
  for (const e of fs.readdirSync(REPO, { withFileTypes: true })) {
    if (FIXTURE_SKIP.has(e.name)) continue;
    fs.cpSync(path.join(REPO, e.name), path.join(root, e.name), { recursive: true });
  }
  return root;
}
process.on('exit', () => { for (const d of scratch) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } } });

/** 跑门禁；返回 { exit, envelope }（信封 = 末行 JSON）。 */
function runCheckAll(root, args, env = {}) {
  const sh = path.join(root, 'team/scripts/check-all.sh');
  const e = {
    ...process.env,
    // 实例指向不存在的位置 ⇒ 模式判定只能落到 repo（**不动 HOME**：本机有实例时正是要证明不被它吸引）。
    OPENCLAW_TEAM_ROOT: path.join(root, '.no-such-instance', 'team'),
    OPENCLAW_TEAM_REPO: '',
    ...env,
  };
  delete e.OPENCLAW_HOME;
  try {
    const out = execFileSync('bash', [sh, ...args], { encoding: 'utf8', env: e, timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'] });
    return { exit: 0, stdout: out, stderr: '', envelope: JSON.parse(out.trim().split('\n').filter(Boolean).pop()) };
  } catch (err) {
    const out = String(err.stdout || '');
    const last = out.trim().split('\n').filter(Boolean).pop();
    return { exit: err.status, stdout: out, stderr: String(err.stderr || ''), envelope: last ? JSON.parse(last) : null };
  }
}

test('无实例 ⇒ repo 模式，fast 段绿，信封带 mode:"repo"', { skip: SKIP }, () => {
  const root = mkRepoCopy();
  const r = runCheckAll(root, ['--segment', 'fast']);
  assert.equal(r.exit, 0, r.stdout);
  assert.equal(r.envelope.ok, true);
  assert.equal(r.envelope.mode, 'repo');
  // 实例面步骤必须显式 skip（而不是红，也不是静默通过）
  assert.match(r.stdout, /\(skip\) repo 模式/);
});

test('显式 --repo <R>：本机有实例时也走 repo 模式（不读本机）', { skip: SKIP }, () => {
  const root = mkRepoCopy();
  const r = runCheckAll(root, ['--segment', 'fast', '--repo', root], { OPENCLAW_TEAM_ROOT: path.join(os.homedir(), '.openclaw', 'team') });
  assert.equal(r.exit, 0, r.stdout);
  assert.equal(r.envelope.mode, 'repo');
  assert.doesNotMatch(r.stdout, new RegExp(os.homedir().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), '不得出现本机 home 路径');
});

test('显式要求 live 而无实例 ⇒ exit 2 + 指引（绝不静默假绿）', { skip: SKIP }, () => {
  const root = mkRepoCopy();
  const r = runCheckAll(root, ['--segment', 'fast', '--live']);
  assert.equal(r.exit, 2, '无实例的 --live 必须是用法错，不是绿');
  assert.equal(r.envelope, null, '不得产出 verdict 信封');
  assert.match(r.stdout + (r.stderr || ''), /live 模式：实例不可解析/);
});

test('OPENCLAW_TEAM_MODE=repo 与非法值：显式模式生效 / 非法值 exit 2', { skip: SKIP }, () => {
  const root = mkRepoCopy();
  const ok = runCheckAll(root, ['--segment', 'fast'], { OPENCLAW_TEAM_MODE: 'repo' });
  assert.equal(ok.exit, 0, ok.stdout);
  assert.equal(ok.envelope.mode, 'repo');

  const bad = runCheckAll(root, ['--segment', 'fast'], { OPENCLAW_TEAM_MODE: 'bogus' });
  assert.equal(bad.exit, 2);
  assert.match(bad.stdout + (bad.stderr || ''), /未知 OPENCLAW_TEAM_MODE/);
});

test('repo 模式不会调用实例面检查：输出里不得出现卡校验/契约测试/provider 全量', { skip: SKIP }, () => {
  const root = mkRepoCopy();
  const r = runCheckAll(root, ['--segment', 'fast']);
  assert.doesNotMatch(r.stdout, /── 卡 schema\/状态机 check-card/);
  assert.doesNotMatch(r.stdout, /── 契约测试/);
  assert.doesNotMatch(r.stdout, /── 归档预览/);
});
