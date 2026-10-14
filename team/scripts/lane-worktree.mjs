#!/usr/bin/env node
/**
 * lane-worktree.mjs — 同仓并发 lane 的 **worktree 隔离**入口（T-20261010-074754-2）
 *
 * 为什么存在（实证）：061638 Turing 复核 O2 —— 复核期间外部进程提交 b359780（卡 063151），其
 * 未提交改动一度出现在**共享 checkout**，R26 经镜像内容取证（container 内 contract.mjs 27,807B
 * ≠ 7bef38f 的 18,432B）检出混合树，被迫改用纯净快照重跑。多 worker 共用同一 checkout ⇒ 并发写
 * 污染。机制：**同仓存在并发非终态 lane 时，每 lane 一个独立 worktree**，卡 `target` 指向该
 * worktree（`spawn-lane` 由 project+target 解析 cwd ⇒ 该 lane 的写落在自己的树里）。
 *
 * 语义（契约）：
 *   入参：<repo> <lane> [--branch <b>] [--path <p>] [--base <ref>] [--dry-run] [--remove] [--help]
 *   ① `--dry-run`：只算 path/branch/action，**不落盘、不登记、不起进程、不改仓**；
 *   ② 幂等创建/复用：worktree 已在目标 path+A分支**且真在那里** ⇒ reuse（不重建）；path 被非 worktree 占用 ⇒ 拒绝（不覆盖）；
 *      lane 分支已检出在别处 ⇒ 拒绝（不劫持）；lane 分支存在且无检出 ⇒ 附着复用（`--remove` 保留分支后的可重入）；
 *      **「登记在册」≠「可用」**（T-20261014-053826-2）：注册仍在、工作目录已删（或 `.git` 链断裂）⇒ 拒绝
 *      `worktree_stale_registration(<why>)`，**绝不静默 `reused`** —— 那句 `reused` 会让调用方把 lane 的 cwd
 *      指向一个不存在的目录（`spawn-lane` 于是把会话起进虚空，而不是 fail-closed）。
 *   ③ `--remove`：**仅当该 worktree clean（无未提交）且分支匹配**才 `git worktree remove`；**绝不 `--force`**；
 *      **不删除分支**（分支可能承载已提交产物，如 rename/meerkat-taskpanel @ c6ead89）；
 *      残留注册（目录已消失）照摘 —— `git worktree remove` 对「目录已不在」的注册本就不需要 `--force`，
 *      这是 ② 拒绝态的规范恢复路径（`--remove` 遗忘注册、保留分支 ⇒ 重跑即附着重建）；但目录**还在**
 *      （哪怕 `.git` 链断）一律走脏检查守卫：绝不因「登记坏了」删掉一棵可能带未提交产物的树。
 *   命名：默认 path = `<主仓目录>-wt-<lane>`；默认 branch = `lane/<lane>`（命名空间化）。
 *   定基（T-20261014-112936）：`--base <ref>` 缺省 `HEAD` —— 这是**本入口**的默认。`spawn-lane` 的
 *   自动隔离路径在「续接上一 seg」时不再用 HEAD，改传**上一 seg 分支 tip**（`lane-isolation.mjs`
 *   的 `deriveLaneBase`）；本入口保持无卡面知识（不猜 seg 语义），仅照传入的 `base` 建树。
 *   既有手工实例 `/Users/tanyu/Documents/meerkat-taskpanel-wt-meerkat`（branch `rename/meerkat-taskpanel`）
 *   = 本机制的手工形状，脚本以 `--branch rename/meerkat-taskpanel` 复现同形状（增量、不改现流程）。
 *
 * 输出：末行 JSON `{ok,repo,lane,path,branch,created,dryRun,…}`（机读）；失败 exit≠0（用法 2 / 拒绝 1）。
 * 只读性：仅 git 内置命令；**不使用任何破坏性 git**（无 --force / reset / clean / stash / rm -r）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

/** lane 名：单段、不以 `.`/`-` 开头（禁路径穿越） */
const LANE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function validBranch(b) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(b)) return false;
  if (b.includes('..') || b.includes('//')) return false;
  if (b.endsWith('/') || b.endsWith('.') || b.endsWith('.lock')) return false;
  return true;
}

/** git 调用（同步；只读或显式非破坏子命令） */
function git(cwd, args) {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}
const reject = (reason, extra = {}) => ({ ok: false, code: 1, reason, ...extra });
const usage = (reason) => ({ ok: false, code: 2, reason });

/** 主仓根：由 `--git-common-dir` 反推（从 linked worktree 调用也稳定指向主 checkout） */
function mainRootOf(repo) {
  const r = git(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (r.code !== 0) return null;
  const common = r.stdout.trim();
  if (!common || path.basename(common) !== '.git') return null; // bare / 异常布局 ⇒ 拒绝
  try {
    if (!fs.statSync(common).isDirectory()) return null;
  } catch {
    return null;
  }
  return path.dirname(common);
}

/** 解析 `git worktree list --porcelain` → Map<absPath, {path,head,branch,detached,bare,prunable}> */
function worktreeList(repo) {
  const map = new Map();
  let cur = null;
  for (const line of git(repo, ['worktree', 'list', '--porcelain']).stdout.split('\n')) {
    if (line.startsWith('worktree ')) { cur = line.slice(9).trim(); map.set(cur, { path: cur }); }
    else if (!cur) continue;
    else if (line.startsWith('HEAD ')) map.get(cur).head = line.slice(5).trim();
    else if (line.startsWith('branch ')) map.get(cur).branch = line.slice(7).trim();
    else if (line.trim() === 'detached') map.get(cur).detached = true;
    else if (line.trim() === 'bare') map.get(cur).bare = true;
    // `prunable[ <原因>]` = git 自己判定该注册**已不可用**（gitdir 链断/目标不在）；保留原因串供点名
    else if (line.trim() === 'prunable' || line.startsWith('prunable ')) {
      map.get(cur).prunable = line.slice(8).trim() || true;
    }
  }
  return map;
}

/**
 * 「已登记」≠「可用」——注册仍在、但那里没有一棵可用工作树时返回**病因**（可用 ⇒ `null`）。
 * 三判（各覆盖一种真实形状，任一命中即不可复用）：
 *   ① 目录不在：`rm -rf` 掉工作目录 / 半完成的建树被杀（T-20261014-034118-2 的实证形状）；
 *   ② `.git` 链不在了（linked worktree 的 `.git` 是**文件**）：只剩一棵裸目录，`git -C` 在那里不可用；
 *   ③ git 自己标 `prunable`：兜住 ①② 之外的链断（如 `.git` 文件在、指向的 `<主仓>/.git/worktrees/<n>` 已不在）。
 * 为什么必须问这一句：`git worktree list` 对**残留注册照列不误**，只看注册表就会把「目录已删」读成 `reused`。
 */
function unusableWhy(wtPath, entry) {
  if (!fs.existsSync(wtPath)) return 'dir_missing';
  if (!fs.existsSync(path.join(wtPath, '.git'))) return 'gitlink_missing';
  if (entry.prunable) return 'registration_prunable';
  return null;
}

/** `refs/heads/<branch>` 的 tip（分支不存在 ⇒ null）。导出供 `lane-isolation.mjs` 做前驱 seg 定基探测。 */
export const branchHead = (repo, branch) => {
  const r = git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
  return r.code === 0 ? r.stdout.trim() : null;
};
/** 任意 ref 的 sha（不可解析 ⇒ null）。导出理由同上。 */
export const revParse = (repo, ref) => {
  const r = git(repo, ['rev-parse', '--verify', '--quiet', ref]);
  return r.code === 0 ? r.stdout.trim() : null;
};

/** 解析 CLI（位置：repo lane；flag：--branch/--path/--base 带值，--dry-run/--remove/--help 开关） */
export function parseArgs(argv) {
  const pos = [];
  const o = { dryRun: false, remove: false, help: false, branch: '', path: '', base: '' };
  const takes = { '--branch': 'branch', '--path': 'path', '--base': 'base' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') { o.dryRun = true; continue; }
    if (a === '--remove') { o.remove = true; continue; }
    if (a === '--help' || a === '-h') { o.help = true; continue; }
    if (a in takes) {
      const v = argv[++i];
      if (v == null || v.startsWith('--')) return { ok: false, reason: `missing_value:${a}` };
      o[takes[a]] = v;
      continue;
    }
    if (a.startsWith('--')) return { ok: false, reason: `unknown_flag:${a}` };
    pos.push(a);
  }
  o.repo = pos[0] || '';
  o.lane = pos[1] || '';
  return { ok: true, ...o };
}

/**
 * 幂等创建/复用/清理一个 lane 的隔离 worktree。
 * @param {{repo:string,lane:string,branch?:string,path?:string,base?:string,dryRun?:boolean,remove?:boolean}} opts
 */
export function laneWorktree(opts = {}) {
  const repo = String(opts.repo || '');
  const lane = String(opts.lane || '');
  const dryRun = !!opts.dryRun;
  const remove = !!opts.remove;

  if (!repo) return usage('missing_repo');
  if (!lane) return usage('missing_lane');
  if (!LANE_RE.test(lane)) return usage(`bad_lane:${lane}`);
  const branch = opts.branch ? String(opts.branch) : `lane/${lane}`;
  if (!validBranch(branch)) return usage(`bad_branch:${branch}`);
  const base = opts.base ? String(opts.base) : 'HEAD';

  const mainRoot = mainRootOf(repo);
  if (!mainRoot) return reject(`not_a_git_repo:${repo}`);

  const wtPath = opts.path
    ? path.resolve(String(opts.path))
    : path.join(path.dirname(mainRoot), `${path.basename(mainRoot)}-wt-${lane}`);

  const env = (extra) => ({ ok: true, repo: mainRoot, lane, path: wtPath, branch, dryRun, ...extra });
  const list = worktreeList(mainRoot);
  const entry = list.get(wtPath);
  const holders = [...list.values()].filter((e) => e.branch === `refs/heads/${branch}`);
  const bHead = branchHead(mainRoot, branch);

  // ── 清理路径 ────────────────────────────────────────────────────────────
  if (remove) {
    if (!entry) return env({ created: false, action: 'absent', note: 'worktree_not_registered_nothing_to_remove' });
    if (entry.detached) return reject(`worktree_detached:${wtPath}`);
    if (entry.branch && entry.branch !== `refs/heads/${branch}`) {
      return reject(`worktree_branch_mismatch(${entry.branch} != refs/heads/${branch})`);
    }
    if (!fs.existsSync(wtPath)) {
      // 残留注册（目录已消失）照摘：`git -C <不存在的目录> status` 必然失败，此处也没有任何工作树可脏，
      // 而 `git worktree remove` 对「目录已不在」的注册本就不需要 `--force`（分支照旧保留）。
      // **仅**「目录确实不在」走这条捷径 —— 目录还在（哪怕 `.git` 链断）一律落到下面的脏检查守卫，
      // 绝不因为「登记坏了」就删掉一棵可能带未提交产物的树。
      const args = ['worktree', 'remove', wtPath];
      const cmd = ['git', '-C', mainRoot, ...args];
      if (dryRun) return env({ created: false, action: 'would_remove', stale: true, cmd });
      const r = git(mainRoot, args);
      if (r.code !== 0) return reject(`worktree_remove_failed:${r.stderr.trim()}`, { cmd });
      return env({
        created: false,
        action: 'removed',
        stale: true,
        cmd,
        branch_kept: bHead !== null ? branch : null,
        note: 'stale_registration_removed(worktree_dir_already_gone)',
      });
    }
    const st = git(wtPath, ['status', '--porcelain']);
    if (st.code !== 0) return reject(`worktree_unreadable:${wtPath}`);
    if (st.stdout.trim()) {
      return reject(`worktree_dirty:${wtPath}`, { dirty_files: st.stdout.trim().split('\n').length });
    }
    const args = ['worktree', 'remove', wtPath];
    const cmd = ['git', '-C', mainRoot, ...args];
    if (dryRun) return env({ created: false, action: 'would_remove', cmd });
    const r = git(mainRoot, args);
    if (r.code !== 0) return reject(`worktree_remove_failed:${r.stderr.trim()}`, { cmd });
    return env({ created: false, action: 'removed', cmd, branch_kept: bHead !== null ? branch : null });
  }

  // ── 复用路径（幂等）─────────────────────────────────────────────────────
  if (entry) {
    if (entry.bare) return reject(`worktree_bare:${wtPath}`);
    if (entry.detached) return reject(`worktree_detached:${wtPath}`);
    if (entry.branch !== `refs/heads/${branch}`) {
      return reject(`worktree_path_occupied(branch=${entry.branch || '?'})`, { path: wtPath });
    }
    // 复用前**校验那棵树真在那里**（登记表只证明「登记过」，不证明「可用」）：残留注册 ⇒ 点名拒绝。
    // 决不落到 `reused` —— 调用方（`spawn-lane`）拿 `reused` 当「路径可用」，会把 lane 的 cwd 指向一个
    // 不存在的目录；而拒绝是 fail-closed（零副作用），恢复路径是同一入口的 `--remove` 再重跑（见头 ③）。
    const why = unusableWhy(wtPath, entry);
    if (why) {
      return reject(`worktree_stale_registration(${why}):${wtPath}`, {
        stale: true,
        stale_reason: why,
        dir_exists: fs.existsSync(wtPath),
        prunable: entry.prunable ?? null,
        note: 'stale_registration:--remove_then_recreate', // 恢复：本入口 --remove 遗忘注册（分支保留）后重跑
      });
    }
    return env({ created: false, action: dryRun ? 'would_reuse' : 'reused', head: entry.head, existed: true });
  }
  if (fs.existsSync(wtPath)) return reject(`path_exists_not_worktree:${wtPath}`);

  // ── 创建路径 ────────────────────────────────────────────────────────────
  if (holders.length) {
    return reject(`branch_checked_out(branch=${branch},path=${holders[0].path})`, { holder: holders[0].path });
  }
  const attach = bHead !== null; // 分支已存在且无检出 ⇒ 附着复用（不覆盖、不重置）
  const args = attach
    ? ['worktree', 'add', wtPath, branch]
    : ['worktree', 'add', '-b', branch, wtPath, base];
  const cmd = ['git', '-C', mainRoot, ...args];

  const plannedHead = attach ? bHead : revParse(mainRoot, base);
  if (!plannedHead) return reject(`base_unresolved:${base}`);

  if (dryRun) {
    return env({ created: true, action: 'would_create', head: plannedHead, existed: false, branchReused: attach, cmd });
  }
  const r = git(mainRoot, args);
  if (r.code !== 0) return reject(`worktree_add_failed:${r.stderr.trim()}`, { cmd });
  return env({
    created: true,
    action: 'created',
    head: revParse(wtPath, 'HEAD') || plannedHead,
    existed: false,
    branchReused: attach,
    cmd,
  });
}

const HELP = `用法: node scripts/lane-worktree.mjs <repo> <lane> [--branch <b>] [--path <p>] [--base <ref>] [--dry-run] [--remove]

同仓并发 lane 的 worktree 隔离（幂等创建/复用；--remove 仅 clean 时清理；绝不 --force）。
默认 path=<主仓目录>-wt-<lane>；默认 branch=lane/<lane>。见 guides/worktree-isolation-sop.md。

示例:
  node scripts/lane-worktree.mjs /path/to/repo laneA --dry-run            # 预演，零副作用
  node scripts/lane-worktree.mjs /path/to/repo laneA                     # 创建或复用
  node scripts/lane-worktree.mjs /path/to/repo laneA --remove            # clean 时才清理
  node scripts/lane-worktree.mjs /Users/tanyu/Documents/meerkat-taskpanel meerkat \\
       --branch rename/meerkat-taskpanel --base 5d99058 --dry-run        # 复现既有手工形状
`;

function main() {
  const a = parseArgs(process.argv.slice(2));
  if (!a.ok) { console.error(HELP); console.log(JSON.stringify({ ok: false, reason: a.reason })); process.exit(2); }
  if (a.help) { console.log(HELP); process.exit(0); }
  const r = laneWorktree(a);
  if (!r.ok) console.error(`✗ lane-worktree 拒绝：${r.reason}`);
  console.log(JSON.stringify(r));
  process.exit(r.ok ? 0 : r.code || 1);
}

// main-guard：realpath 归一；被 import（单测）时不执行 CLI
try {
  const self = fs.realpathSync(new URL(import.meta.url));
  const arg = fs.realpathSync(path.resolve(process.argv[1]));
  if (arg === self) main();
} catch { /* realpath 失败 ⇒ 不执行 main */ }
