/**
 * host-paths.mjs — 宿主/仓 路径解析与「仓内模式 ↔ 实例模式」判定的唯一入口。
 *
 * 为什么单独一个模块、而不是复用 `lib.mjs`：`lib.mjs` 依赖 provider ACL 库
 * （`{team}/skills/task-ops/lib/team-paths.mjs`），**缺失即启动期硬失败**（process.exit(1)）。
 * 而本模块的消费方是纯 lint 组，必须在**没装实例、没装 provider 的空机器**上照常工作
 * （开源仓的默认场景）。故本模块**只依赖 node 内置**，不做任何顶层 exit/throw。
 *
 * 根解析优先级（刻意与 lib.mjs / provider 的 team-paths.mjs 同源，避免同一进程出现两个 team root）：
 *   teamRoot()       OPENCLAW_TEAM_ROOT → <OPENCLAW_HOME>/team → ~/.openclaw/team
 *   openclawHome()   OPENCLAW_HOME → <OPENCLAW_TEAM_ROOT 的父目录> → ~/.openclaw
 *                    第二项让 `OPENCLAW_TEAM_ROOT=<sandbox>/team` 时 workspace 落在 `<sandbox>/`：
 *                    沙箱内的两棵树始终同一个 home，绝不串到真 `~/.openclaw`（最坏的失败模式
 *                    正是「指向沙箱，却静默读到宿主真实的 live workspace」）。
 *   workspaceDir(r)  <openclawHome()>/workspace-<r>
 *
 * 已知的重复解析（本次**有意不合并**，免得下一个人再加第四个）：
 *   - `team/scripts/scan-deps.mjs`（env → ~/.openclaw/team）
 *   - provider 的 `skills/task-ops/lib/team-paths.mjs`（owns TEAM_ROOT/TASKS_DIR，认 OPENCLAW_TEAM_ROOT）
 *   - `team/automations/dispatch.mjs`（`{repo}` 解析，供 skills-update 用）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 团队角色清单（与 install.sh 的 ROLES、lib.mjs#AGENTS、check-card.mjs#ASSIGNEES 同源）。 */
export const ROLES = ['elon', 'jobs', 'linus', 'turing', 'assistant'];

/** OpenClaw home（`<home>/.openclaw` 的 `<home>`… 不，就是 `~/.openclaw` 本身）。 */
export function openclawHome(env = process.env) {
  if (env.OPENCLAW_HOME) return path.resolve(env.OPENCLAW_HOME);
  if (env.OPENCLAW_TEAM_ROOT) return path.dirname(path.resolve(env.OPENCLAW_TEAM_ROOT));
  return path.join(os.homedir(), '.openclaw');
}

/** 团队根目录（安装实例的 `~/.openclaw/team`）。 */
export function teamRoot(env = process.env) {
  if (env.OPENCLAW_TEAM_ROOT) return path.resolve(env.OPENCLAW_TEAM_ROOT);
  return path.join(openclawHome(env), 'team');
}

/** 某角色的 workspace（安装实例的 `~/.openclaw/workspace-<role>`）。 */
export function workspaceDir(role, env = process.env) {
  return path.join(openclawHome(env), `workspace-${role}`);
}

/**
 * 分发仓根的**标记文件集**（三者同时存在才算分发仓）。
 * 判据用这一组标记而不是某个 `roles/<r>/AGENTS.md`：后者在 roles/ 正在迁移时会误判，
 * 也会把「roles/ 不存在」与「处于实例模式」混为一谈。
 * 这是「这个目录是不是分发仓」的**唯一判据**——`repoRootFromScript()` 与
 * `team/scripts/tests/{check-all-repo-mode,no-maintainer-paths}.test.mjs` 的 live 守卫共用它，
 * 免得同一个问题在两处各写一份、日后各自漂移。
 */
export const REPO_MARKS = ['roles', 'team/PROTOCOL.md', 'install.sh'];

/** 该目录是否为一个分发仓根（标记齐全）。部署副本（`<team>/scripts/*.mjs`）的上一级是
 *  `~/.openclaw`，含运行期件但不含这些标记 ⇒ false。 */
export function isDistributionRepo(root) {
  return REPO_MARKS.every((m) => fs.existsSync(path.join(root, m)));
}

/**
 * 从脚本位置推出「分发仓根」（脚本须直接位于 `<repo>/team/scripts/`）。
 * 部署副本（`<team>/scripts/*.mjs`）的 ../../ 是 `~/.openclaw`，不含标记 ⇒ 天然返回 null。
 */
export function repoRootFromScript(scriptUrl = import.meta.url) {
  const root = path.resolve(path.dirname(fileURLToPath(scriptUrl)), '..', '..');
  return isDistributionRepo(root) ? root : null;
}

/** 用法错误（调用方自行决定退出码；本模块不 exit）。 */
export class UsageError extends Error {}

/**
 * 解析本脚本的 `--repo <R>` / `--live`（只识别这两个；其余 argv 原样留给调用方，例如
 * `lint-impl-names.mjs --report`）。返回 `{ repo, live }`，两者互斥。
 */
export function parseArgs(argv = process.argv.slice(2)) {
  let repo = '';
  let live = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--repo' && argv[i + 1]) repo = path.resolve(argv[++i]);
    else if (a.startsWith('--repo=')) repo = path.resolve(a.slice('--repo='.length));
    else if (a === '--live') live = true;
  }
  if (repo && live) throw new UsageError('--repo 与 --live 互斥');
  return { repo, live };
}

/**
 * 判定运行模式。
 *   1. `--live`                     ⇒ live（实例不可解析 ⇒ UsageError，绝不静默降级）
 *   2. `--repo <R>`                 ⇒ repo
 *   3. `OPENCLAW_TEAM_MODE=live|repo` ⇒ 该值
 *   4. `<teamRoot>/scripts` 存在     ⇒ live（今天的行为：实例在场就巡检实例）
 *   5. 分发仓根可解析                ⇒ repo
 *   6. 都不行                       ⇒ UsageError（**绝不回落 $HOME**，也绝不猜）
 * 返回 `{ mode, repo, team, home }`；repo 模式时 `repo` 必非空。
 */
export function resolveMode({ argv = process.argv.slice(2), env = process.env, scriptUrl = import.meta.url } = {}) {
  const { repo: cliRepo, live: cliLive } = parseArgs(argv);
  const home = openclawHome(env);
  const team = teamRoot(env);
  const repo = cliRepo || (env.OPENCLAW_TEAM_REPO ? path.resolve(env.OPENCLAW_TEAM_REPO) : '') || repoRootFromScript(scriptUrl) || '';
  const live = (m) => ({ mode: 'live', repo: '', team, home, ...(m ? { why: m } : {}) });

  if (cliLive) {
    if (!fs.existsSync(path.join(team, 'scripts'))) {
      throw new UsageError(`--live：实例不可解析（${path.join(team, 'scripts')} 不存在）。请设 OPENCLAW_TEAM_ROOT，或改用 --repo <repo> 跑仓内自证。`);
    }
    return live('--live');
  }
  if (cliRepo) return { mode: 'repo', repo: cliRepo, team, home };

  const envMode = String(env.OPENCLAW_TEAM_MODE || '').trim();
  if (envMode && envMode !== 'live' && envMode !== 'repo') {
    throw new UsageError(`OPENCLAW_TEAM_MODE=${envMode} 非法（应为 live|repo）`);
  }
  if (envMode === 'live') {
    if (!fs.existsSync(path.join(team, 'scripts'))) {
      throw new UsageError(`OPENCLAW_TEAM_MODE=live：实例不可解析（${path.join(team, 'scripts')} 不存在）。`);
    }
    return live('env');
  }
  if (envMode === 'repo') {
    if (!repo) throw new UsageError('OPENCLAW_TEAM_MODE=repo：未能定位分发仓根，请用 --repo <repo> 或 OPENCLAW_TEAM_REPO 指定。');
    return { mode: 'repo', repo, team, home };
  }

  if (fs.existsSync(path.join(team, 'scripts'))) return live('instance-present');
  if (repo) return { mode: 'repo', repo, team, home };
  throw new UsageError(
    `无法判定模式：既没有实例（${path.join(team, 'scripts')} 不存在），也没有分发仓根（${path.dirname(fileURLToPath(scriptUrl))}/../.. 缺 ${REPO_MARKS.join(' 或 ')}）。\n` +
    '  实例巡检：设 OPENCLAW_TEAM_ROOT（或装好实例后直接跑）；仓内自证：--repo <repo> 或 OPENCLAW_TEAM_REPO=<repo>。',
  );
}
