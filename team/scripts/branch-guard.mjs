#!/usr/bin/env node
/**
 * branch-guard.mjs — 提交侧**分支守卫**（T-20261015-devbranch）
 *
 * 背景：开发统一集成在长期**集成分支**上（缺省 `dev`，`OPENCLAW_TEAM_INTEGRATION_BRANCH` 可改；
 * `PROTOCOL §⑥.4`）——每个开发任务在自己的**卡分支** `<card-id>` 上跑（配独立 worktree），产物并入
 * 集成分支，集成分支仅在显式集成/发布步骤并入**受保护分支**。**卡分支的提交不在集成分支上**，故本守卫
 * **不是**「只许集成分支」，而是「不许直接提交受保护分支」——直译前者会把全部正常工作拦掉。
 *
 * **受保护分支的名字不假定**：发布/默认分支随仓而异（`main` / `master` / `trunk` …）。缺省集 =
 * **仓的默认分支（本地探测 `refs/remotes/origin/HEAD`）∪ `main` ∪ `master`**；探测不到就只剩那两个
 * 通用名——探测失败**不缩小**保护面。要精确指定用 `OPENCLAW_PROTECTED_BRANCHES` / `--protected`。
 *
 * 判定（**只读 git**，绝不写仓 / 绝不改分支）：
 *   · 非 git 仓 ⇒ 拒绝 `not_a_git_repo`；
 *   · detached HEAD ⇒ 拒绝 `detached_head_commit`（开发须落在具名分支上）；
 *   · HEAD 分支 ∈ 受保护集 ⇒ 拒绝 `protected_branch_commit:<branch>`；`--allow-protected` 降级为
 *     告警 + `overridden:true`（集成/发布步骤的显式、留痕出口）；
 *   · 其余（卡分支 / 集成分支 / 其它）⇒ 放行。
 *
 * 用法：node branch-guard.mjs [--repo <dir>] [--protected <a,b>] [--allow-protected] [--json]
 * 输出：JSON（stdout，末行机读）；退出码 0=通过 / 1=发现违规 / 2=用法错误。
 *
 * 生效方式（如实）：本仓 `.git/hooks/` 为空，守卫与 `commit-guard.mjs` 同姿势——**靠 SOP 指示
 * worker 提交前主动运行**；要「提交即拦」须自行接 git `pre-commit` hook（本次不静默改写任何仓的
 * hooks）。单测由 check-all 慢段 `node --test tests/*.test.mjs` 纳入。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const PROTECTED_ENV = 'OPENCLAW_PROTECTED_BRANCHES';
/**
 * 缺省受保护集：`main` 与 `master` **都在**。
 * 发布/默认分支的名字**随仓而异**（`git init` 的历史默认是 `master`，新默认是 `main`，也可能被
 * 项目改成别的），故**不假定其一**：只写 `main` 会让 `master` 仓**静默失去保护**，而本守卫的全部
 * 价值就是「不许直接提交发布分支」——静默失效比误拦有害得多。
 */
export const PROTECTED_DEFAULTS = ['main', 'master'];

/**
 * 仓的**默认分支**（本地探测，不联网、不改仓）：`refs/remotes/origin/HEAD` 指向谁就是谁。
 * 这条腿盖住 `trunk` / `release` 这类自定义默认分支名。
 * 探不到（无远程 / 未 `set-head` / 非 git 仓）⇒ `null`，调用方回退 `PROTECTED_DEFAULTS`——
 * 于是探测失败**不缩小**保护面，只是少了那层加分。
 */
export function defaultBranchOf(repo) {
  const r = git(repo, 'symbolic-ref', '--short', '-q', 'refs/remotes/origin/HEAD');
  if (!r.ok || !r.out) return null;
  // 形如 `origin/main`；未 set-head 时可能原样返回 `origin/HEAD` ⇒ 那不是分支名，弃之。
  const b = r.out.replace(/^origin\//, '').trim();
  return b && b !== 'HEAD' ? b : null;
}

export function parseArgs(argv) {
  const o = { repo: process.cwd(), protected: [], allowProtected: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--repo') { const v = argv[i + 1]; if (v == null || v.startsWith('--')) return { error: 'missing_value:--repo' }; o.repo = argv[++i]; }
    else if (a === '--protected') { const v = argv[++i]; if (v == null || v.startsWith('--')) return { error: 'missing_value:--protected' }; o.protected = String(v).split(',').map((s) => s.trim()).filter(Boolean); }
    else if (a === '--allow-protected') o.allowProtected = true;
    else if (a === '--json') o.json = true;
    else return { error: `unknown_arg:${a}` };
  }
  return o;
}

/**
 * 受保护分支集：`--protected`（CLI）> `OPENCLAW_PROTECTED_BRANCHES` >
 * **仓的默认分支（探测）∪ `main` ∪ `master`**。
 * 前两档是显式意图，**原样采用**（不并集）——写了就是写了；只有落到探测档时才并集，
 * 因为探测是「尽力而为」，不能让它*缩小*保护面。
 */
export function protectedSet(o, env = process.env, repo = o.repo) {
  if (o.protected.length) return o.protected;
  const fromEnv = String(env[PROTECTED_ENV] || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (fromEnv.length) return fromEnv;
  const detected = defaultBranchOf(repo);
  return [...new Set([...(detected ? [detected] : []), ...PROTECTED_DEFAULTS])];
}

/** 只读 git：成功 ⇒ {ok:true,out}；失败 ⇒ {ok:false,error} */
function git(repo, ...args) {
  try {
    return { ok: true, out: execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim() };
  } catch (e) {
    return { ok: false, error: String(e.stderr || e.message || e).trim() };
  }
}

export function runCheck(o) {
  const repo = path.resolve(o.repo);
  if (!fs.existsSync(path.join(repo, '.git'))) {
    return { ok: false, reason: 'not_a_git_repo', repo };
  }
  const protectedBranches = protectedSet(o, process.env, repo);
  const branch = git(repo, 'symbolic-ref', '--short', '-q', 'HEAD');
  if (!branch.ok) {
    return {
      ok: false,
      reason: 'detached_head_commit',
      repo,
      protected: protectedBranches,
      hint: '开发须落在具名分支上（你的卡分支 `<card-id>` 或集成分支）；detached HEAD 不得提交',
    };
  }
  const b = branch.out;
  const isProtected = protectedBranches.includes(b);
  if (isProtected && !o.allowProtected) {
    return {
      ok: false,
      reason: `protected_branch_commit:${b}`,
      branch: b,
      repo,
      protected: protectedBranches,
      message: `分支守卫拒绝：不得直接提交受保护分支 ${b}——开发落在你的卡分支（\`<card-id>\`）上，产物并入集成分支（PROTOCOL §⑥.4）。确需集成为发布步骤时用 --allow-protected（留痕）。`,
    };
  }
  return {
    ok: true,
    branch: b,
    repo,
    protected: protectedBranches,
    overridden: isProtected && o.allowProtected,
    message: isProtected
      ? `分支守卫告警（--allow-protected 放行）：直接落在受保护分支 ${b}——仅限显式集成/发布步骤（PROTOCOL §⑥.4）。`
      : `分支守卫通过：${b} 非受保护分支。`,
  };
}

function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.error) {
    console.error('用法: node branch-guard.mjs [--repo <dir>] [--protected <a,b>] [--allow-protected] [--json]');
    console.log(JSON.stringify({ ok: false, reason: o.error }));
    process.exit(2);
  }
  const r = runCheck(o);
  if (!r.ok) console.error(`✗ branch-guard 拒绝：${r.reason}`);
  console.log(JSON.stringify(r, null, o.json ? 0 : 2));
  process.exit(r.ok ? 0 : 1);
}

// main-guard：realpath 归一（与 commit-guard.mjs / lib.mjs 同口径）；被 import（单测）时不执行 CLI
try {
  const self = fs.realpathSync(new URL(import.meta.url));
  const arg = fs.realpathSync(path.resolve(process.argv[1]));
  if (arg === self) main();
} catch { /* realpath 失败 ⇒ 不执行 main */ }
