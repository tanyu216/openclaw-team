/**
 * check-all-repo-mode.test.mjs — 门禁的「仓内自证」模式（无实例机器）
 *
 * 验收口径（本套件即其机检）：**一台没有安装 OpenClaw 实例的机器上，`check-all.sh` 必须给出
 * 可用的判定**，而不是今天那样连脚本都加载不到（`MODULE_NOT_FOUND: <home>/.openclaw/team/scripts/…`
 * ⇒ ok:false）。做法：把仓的**真内容**（team/** + roles/** + install.sh）拷进临时树，实例路径指向
 * 不存在的位置，然后跑门禁。
 *
 * 三个必须成立的行为：
 *   1. 无实例 ⇒ 自动落到 repo 模式，`--segment fast` 绿，信封带 `"mode":"repo"`；
 *   2. 显式 `--repo <R>` 在**本机有实例**时也必须是 repo 模式（绝不读本机实例）；
 *   3. 显式要求 live 而无实例 ⇒ exit 2 且给出指引（**绝不静默假绿**）。
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

const SCRIPTS = path.dirname(fileURLToPath(import.meta.url));   // <repo>/team/scripts/tests
const REPO = path.resolve(SCRIPTS, '..', '..', '..');            // <repo>

const scratch = [];
function mkRepoCopy() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-repomode-'));
  scratch.push(root);
  // 只拷仓内自证需要的面（不拷 .git / workspace / 庞大的 tools）。
  for (const rel of ['team', 'roles']) fs.cpSync(path.join(REPO, rel), path.join(root, rel), { recursive: true });
  fs.copyFileSync(path.join(REPO, 'install.sh'), path.join(root, 'install.sh'));
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

test('无实例 ⇒ repo 模式，fast 段绿，信封带 mode:"repo"', () => {
  const root = mkRepoCopy();
  const r = runCheckAll(root, ['--segment', 'fast']);
  assert.equal(r.exit, 0, r.stdout);
  assert.equal(r.envelope.ok, true);
  assert.equal(r.envelope.mode, 'repo');
  // 实例面步骤必须显式 skip（而不是红，也不是静默通过）
  assert.match(r.stdout, /\(skip\) repo 模式/);
});

test('显式 --repo <R>：本机有实例时也走 repo 模式（不读本机）', () => {
  const root = mkRepoCopy();
  const r = runCheckAll(root, ['--segment', 'fast', '--repo', root], { OPENCLAW_TEAM_ROOT: path.join(os.homedir(), '.openclaw', 'team') });
  assert.equal(r.exit, 0, r.stdout);
  assert.equal(r.envelope.mode, 'repo');
  assert.doesNotMatch(r.stdout, new RegExp(os.homedir().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), '不得出现本机 home 路径');
});

test('显式要求 live 而无实例 ⇒ exit 2 + 指引（绝不静默假绿）', () => {
  const root = mkRepoCopy();
  const r = runCheckAll(root, ['--segment', 'fast', '--live']);
  assert.equal(r.exit, 2, '无实例的 --live 必须是用法错，不是绿');
  assert.equal(r.envelope, null, '不得产出 verdict 信封');
  assert.match(r.stdout + (r.stderr || ''), /live 模式：实例不可解析/);
});

test('OPENCLAW_TEAM_MODE=repo 与非法值：显式模式生效 / 非法值 exit 2', () => {
  const root = mkRepoCopy();
  const ok = runCheckAll(root, ['--segment', 'fast'], { OPENCLAW_TEAM_MODE: 'repo' });
  assert.equal(ok.exit, 0, ok.stdout);
  assert.equal(ok.envelope.mode, 'repo');

  const bad = runCheckAll(root, ['--segment', 'fast'], { OPENCLAW_TEAM_MODE: 'bogus' });
  assert.equal(bad.exit, 2);
  assert.match(bad.stdout + (bad.stderr || ''), /未知 OPENCLAW_TEAM_MODE/);
});

test('repo 模式不会调用实例面检查：输出里不得出现卡校验/契约测试/provider 全量', () => {
  const root = mkRepoCopy();
  const r = runCheckAll(root, ['--segment', 'fast']);
  assert.doesNotMatch(r.stdout, /── 卡 schema\/状态机 check-card/);
  assert.doesNotMatch(r.stdout, /── 契约测试/);
  assert.doesNotMatch(r.stdout, /── 归档预览/);
});
