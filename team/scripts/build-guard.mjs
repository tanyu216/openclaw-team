#!/usr/bin/env node
/**
 * build-guard.mjs — 构建-写互斥（整树快照类构建/验证不得与其它 lane 写并发）
 *
 * 背景（T-20261009-211234-concurrencyharden）：同仓 `docker build`（整树快照）与其它 lane 写并发
 * ⇒ 假失败（m6b-dreg1 首验 10 条假失败）。机制：
 *   1) build 锁（mkdir 串行 + 陈旧可清理）：`acquire` 拿锁 → 跑构建 → `release` 释放；
 *   2) dirty worktree 检测：`detect` 读 `git status --porcelain`，报告其它 lane 的未提交写（并发写信号）。
 * 契约：只读 git（status）；build 锁为目录锁，绝无破坏性 git。
 * 用法：
 *   node build-guard.mjs acquire --name <n>           # 抢 build 锁（{ok,held}）
 *   node build-guard.mjs release --name <n>           # 释放 build 锁
 *   node build-guard.mjs detect  --repo <dir>         # 检测 dirty worktree（并发写信号）
 *   node build-guard.mjs run --name <n> -- <cmd...>   # 抢锁 → 跑命令 → 释放（退出码透传）
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { LOCKS_DIR, STALE_LOCK_MS, nowMs } from './lib.mjs';

function lockDir(name) {
  return path.join(LOCKS_DIR, `build.${name}`);
}

function ageMs(p) {
  try {
    return nowMs() - fs.statSync(p).mtimeMs;
  } catch {
    return Infinity;
  }
}

export function acquire({ name } = {}) {
  if (!name) return { ok: false, reason: 'missing_name' };
  const dir = lockDir(name);
  try {
    fs.mkdirSync(LOCKS_DIR, { recursive: true });
  } catch {
    return { ok: false, reason: 'locks_dir_unavailable' };
  }
  try {
    fs.mkdirSync(dir, { recursive: false });
    return { ok: true, held: true, path: dir };
  } catch (e) {
    if (e.code !== 'EEXIST') return { ok: false, reason: `error:${e.code}`, path: dir };
    // 已持锁：陈旧（>STALE_LOCK_MS）⇒ 清理后重试一次
    if (ageMs(dir) > STALE_LOCK_MS) {
      try { fs.rmdirSync(dir); } catch { /* 竞态被清 */ }
      try { fs.mkdirSync(dir, { recursive: false }); return { ok: true, held: true, path: dir, recovered_stale: true }; }
      catch (e2) { return { ok: true, held: false, path: dir, reason: 'busy' }; }
    }
    return { ok: true, held: false, path: dir, reason: 'busy' };
  }
}

export function release({ name } = {}) {
  if (!name) return { ok: false, reason: 'missing_name' };
  const dir = lockDir(name);
  try {
    fs.rmdirSync(dir);
    return { ok: true, released: true, path: dir };
  } catch {
    return { ok: true, released: false, path: dir, reason: 'not_held' };
  }
}

/** 检测 dirty worktree（其它 lane 的未提交写 = 并发写信号）。只读 git status。 */
export function detect({ repo = process.cwd() } = {}) {
  if (!fs.existsSync(path.join(repo, '.git'))) return { ok: false, reason: 'not_a_git_repo', repo };
  let out;
  try {
    out = execFileSync('git', ['-C', repo, 'status', '--porcelain'], { encoding: 'utf8' });
  } catch (e) {
    return { ok: false, reason: 'git_error', error: String(e.stderr || e.message || e) };
  }
  const dirty = out.split('\n').map((l) => l.trim()).filter(Boolean);
  return { ok: true, repo, dirty, dirtyCount: dirty.length };
}

function parseArgs(argv) {
  const o = { cmd: null, name: '', repo: process.cwd(), run: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (i === 0) o.cmd = a;
    else if (a === '--name' && argv[i + 1]) o.name = argv[++i];
    else if (a === '--repo' && argv[i + 1]) o.repo = argv[++i];
    else if (a === '--') { o.run = argv.slice(i + 1); break; }
  }
  return o;
}

function main() {
  const o = parseArgs(process.argv.slice(2));
  switch (o.cmd) {
    case 'acquire': {
      const r = acquire({ name: o.name });
      console.log(JSON.stringify(r, null, 2));
      process.exit(r.ok && r.held ? 0 : 1);
      break;
    }
    case 'release': {
      const r = release({ name: o.name });
      console.log(JSON.stringify(r, null, 2));
      process.exit(r.ok ? 0 : 1);
      break;
    }
    case 'detect': {
      const r = detect({ repo: o.repo });
      console.log(JSON.stringify(r, null, 2));
      process.exit(r.ok ? 0 : 1);
      break;
    }
    case 'run': {
      const a = acquire({ name: o.name });
      if (!a.ok || !a.held) {
        console.log(JSON.stringify(a, null, 2));
        process.exit(1);
      }
      try {
        if (!o.run.length) {
          console.log(JSON.stringify({ ok: false, reason: 'run_needs_command' }, null, 2));
          process.exitCode = 2;
          return; // 走 finally 释放锁后再自然退出
        }
        const r = spawnSync(o.run[0], o.run.slice(1), { stdio: 'inherit' });
        console.log(JSON.stringify({ ok: r.status === 0, exitCode: r.status, signal: r.signal ?? null }, null, 2));
        // 注意：此处**不得**用 process.exit()——它不展开调用栈 ⇒ finally 不执行 ⇒ 每次 run 泄漏 build 锁
        //（锁要留到 STALE_LOCK_MS 才回收，后续前置重建恒读到 busy）。改用 exitCode + 自然返回。
        process.exitCode = r.status ?? 1;
      } finally {
        release({ name: o.name });
      }
      break;
    }
    default:
      console.error('用法: node build-guard.mjs <acquire|release|detect|run> [--name <n>] [--repo <dir>] [-- <cmd...>]');
      process.exit(2);
  }
}

// main-guard：realpath 归一（与 lib.mjs 同口径）
try {
  const self = fs.realpathSync(new URL(import.meta.url));
  const arg = fs.realpathSync(path.resolve(process.argv[1]));
  if (arg === self) main();
} catch { /* realpath 失败 ⇒ 不执行 main */ }
