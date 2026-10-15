#!/usr/bin/env node
/**
 * branch-guard.mjs — 提交侧**分支守卫**（T-20261015-devbranch）
 *
 * 背景：开发统一集成在长期分支 `dev` 上（`PROTOCOL §⑥.4`）——每个开发任务在自己的 lane 分支
 * `lane/<lane>` 上跑（并发条件下配独立 worktree），lane 产物并入 `dev`，`dev` 仅在显式集成/发布
 * 步骤并入受保护分支 `main`。**lane 的提交落在 `lane/*` 上、不在 `dev` 上**，故本守卫**不是**
 * 「只许 dev」，而是「不许直接提交受保护分支」——直译「只许 dev」会把全部正常工作拦掉。
 *
 * 判定（**只读 git**，绝不写仓 / 绝不改分支）：
 *   · 非 git 仓 ⇒ 拒绝 `not_a_git_repo`；
 *   · detached HEAD ⇒ 拒绝 `detached_head_commit`（开发须落在具名分支上）；
 *   · HEAD 分支 ∈ 受保护集（缺省 `main`；`OPENCLAW_PROTECTED_BRANCHES` / `--protected` 覆盖）
 *     ⇒ 拒绝 `protected_branch_commit:<branch>`；`--allow-protected` 降级为告警 + `overridden:true`
 *     （`dev→main` 集成步骤的显式、留痕出口）；
 *   · 其余（`lane/*` / `dev` / 其它）⇒ 放行。
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
export const PROTECTED_DEFAULT = 'main';

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

/** 受保护分支集：`--protected`（CLI）> `OPENCLAW_PROTECTED_BRANCHES` > 缺省 `main`。 */
export function protectedSet(o, env = process.env) {
  if (o.protected.length) return o.protected;
  const fromEnv = String(env[PROTECTED_ENV] || '').split(',').map((s) => s.trim()).filter(Boolean);
  return fromEnv.length ? fromEnv : [PROTECTED_DEFAULT];
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
  const protectedBranches = protectedSet(o);
  const branch = git(repo, 'symbolic-ref', '--short', '-q', 'HEAD');
  if (!branch.ok) {
    return {
      ok: false,
      reason: 'detached_head_commit',
      repo,
      protected: protectedBranches,
      hint: '开发须落在具名分支上（lane/<lane> 或 dev）；detached HEAD 不得提交',
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
      message: `分支守卫拒绝：不得直接提交受保护分支 ${b}——开发集成在 dev 上，提交请落在 lane/<lane> 或 dev（PROTOCOL §⑥.4）。确需集成为发布步骤时用 --allow-protected（留痕）。`,
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
