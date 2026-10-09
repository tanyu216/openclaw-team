#!/usr/bin/env node
/**
 * commit-guard.mjs — 提交自检（同文件严格串行的提交侧护栏）
 *
 * 背景（T-20261009-211234-concurrencyharden）：`git commit -- <path>` 会把该文件**未暂存**的
 * 异卡 hunk 一并扫入（实证 952a001：linusstack 提交连带 labelspec hunk）。
 * 本脚本在提交前/后自检，两件事：
 *   1) 暂存集只含本卡文件（`git diff --cached --name-only` 与 --allowed 白名单比对）⇒ 异卡文件停手；
 *   2) 白名单内文件同时存在**未暂存**改动（`git diff --name-only -- <file>`）⇒ 同文件异卡 hunk 风险停手
 *      （`git commit -- <path>` 会连带扫入）。--allow-mixed 可降级为告警（明确知情时）。
 * 用法：
 *   node commit-guard.mjs --repo <dir> --allowed <p1,p2,...> [--mode staged|last] [--allow-mixed]
 * 输出：JSON；退出码 0=通过，1=发现异卡文件/同文件未暂存 hunk，2=用法错误。
 * 契约：只读 git（diff/show），绝不执行任何写/破坏性 git。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

function parseArgs(argv) {
  const o = { repo: process.cwd(), allowed: [], mode: 'staged', allowMixed: false, card: '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--repo' && argv[i + 1]) { o.repo = argv[++i]; }
    else if (a === '--allowed') { o.allowed = String(argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean); }
    else if (a === '--mode' && argv[i + 1]) { o.mode = argv[++i]; }
    else if (a === '--allow-mixed') { o.allowMixed = true; }
    else if (a === '--card' && argv[i + 1]) { o.card = argv[++i]; }
  }
  return o;
}

/** 只读 git：成功 ⇒ {ok:true, out}；失败 ⇒ {ok:false, error} */
function git(repo, ...args) {
  try {
    return { ok: true, out: execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim() };
  } catch (e) {
    return { ok: false, error: String(e.stderr || e.message || e).trim() };
  }
}

const split = (s) => (typeof s === 'string' && s ? s.split('\n').map((x) => x.trim()).filter(Boolean) : []);

function isAllowed(p, allowed) {
  for (const a of allowed) {
    if (a === '' || a === '.') return true; // 显式放行整树（慎用）
    if (p === a) return true;
    if (p.startsWith(a.endsWith('/') ? a : a + '/')) return true;
  }
  return false;
}

const normalizeRel = (p) => p.replace(/\\/g, '/').replace(/^\.\//, '');

function runCheck(o) {
  if (!fs.existsSync(path.join(o.repo, '.git'))) {
    return { ok: false, reason: 'not_a_git_repo', repo: o.repo };
  }
  if (o.allowed.length === 0) {
    return { ok: false, reason: 'missing_allowed', hint: '须 --allowed 给出本卡白名单（repo 相对路径，逗号分隔）' };
  }
  if (o.mode !== 'staged' && o.mode !== 'last') {
    return { ok: false, reason: `bad_mode:${o.mode}` };
  }

  const cmd = o.mode === 'staged'
    ? git(o.repo, 'diff', '--cached', '--name-only')
    : git(o.repo, 'show', '--stat', '--name-only', '--format=', 'HEAD');
  if (!cmd.ok) {
    return { ok: false, reason: `git_error(${o.mode})`, error: cmd.error, repo: o.repo };
  }

  const stagedFiles = split(cmd.out).map(normalizeRel);
  const foreign = stagedFiles.filter((p) => !isAllowed(p, o.allowed));

  const mixed = [];
  if (o.mode === 'staged') {
    for (const p of stagedFiles) {
      if (!isAllowed(p, o.allowed)) continue; // 异卡文件已在 foreign，不重复算 mixed
      const unstaged = git(o.repo, 'diff', '--name-only', '--', p);
      if (unstaged.ok && split(unstaged.out).length) mixed.push(p);
    }
  }

  const failForeign = foreign.length > 0;
  const failMixed = mixed.length > 0 && !o.allowMixed;
  const ok = !failForeign && !failMixed;
  const warnMixed = mixed.length > 0 && o.allowMixed;
  return {
    ok,
    card: o.card || '',
    mode: o.mode,
    repo: o.repo,
    staged: stagedFiles,
    foreign,
    mixed,
    message: [
      ok ? '提交自检通过：暂存集只含本卡文件' : '',
      failForeign ? `发现异卡暂存文件 ${foreign.length} 个，停手回报：${foreign.join(', ')}` : '',
      failMixed ? `本卡文件存在未暂存 hunk（git commit -- <path> 会连带扫入），停手：${mixed.join(', ')}` : '',
      warnMixed ? `告警（--allow-mixed 放行）：本卡文件有未暂存 hunk：${mixed.join(', ')}` : '',
      ok && !warnMixed ? '，无同文件未暂存 hunk。' : '',
    ].filter(Boolean).join('；'),
  };
}

function main() {
  const o = parseArgs(process.argv.slice(2));
  const r = runCheck(o);
  console.log(JSON.stringify(r, null, 2));
  process.exit(r.ok ? 0 : 1);
}

// main-guard：realpath 归一（与 lib.mjs 同口径）
try {
  const self = fs.realpathSync(new URL(import.meta.url));
  const arg = fs.realpathSync(path.resolve(process.argv[1]));
  if (arg === self) main();
} catch { /* realpath 失败 ⇒ 不执行 main */ }
