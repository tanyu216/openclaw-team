#!/usr/bin/env node
/**
 * seed-projects.mjs — 把现役 identity code 幂等登记进 task-panel 基座 board
 *
 * 契约：guides/task-interface.md §8；规范：PROTOCOL.md §⑧。
 * 来源：`~/.openclaw/team/projects.json`（过渡期权威快照，只读）；跳过保留名 `__team__`。
 * 基座：用 task-panel 官方引导 `openBoard()` 建/迁移 DB（**不手抄 SQL**）。
 * board 落盘与只读适配器 bases/task-panel.mjs 同源（resolveBoardDataDir/DbPath）。
 *
 * 用法：node scripts/seed-projects.mjs   # 可重复执行（幂等）
 * 环境：TASKPANEL_REPO（task-panel 仓根；缺省取与 openclaw-team 同级的兄弟目录 ../task-panel）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PROJECTS_FILE, TASK_OPS_DIR } from './lib.mjs';

// provider 依赖显式化（方案②启动期硬失败）：board 路径解析来自 provider ACL 库
// skills/task-ops/bases/task-panel.mjs（provider 拥有、有意不随仓）。lib.mjs 已对
// team-paths/projects 做启动硬失败；此处把 bases/task-panel.mjs 改为显式动态导入。
const taskPanelBase = await import(pathToFileURL(path.join(TASK_OPS_DIR, 'bases', 'task-panel.mjs')).href);
const { resolveBoardDataDir, resolveBoardDbPath } = taskPanelBase;

// task-panel 仓默认位置：与 openclaw-team 同级的兄弟目录 ../task-panel（不硬绑本机绝对路径）。
// 解析顺序 opts.repo > TASKPANEL_REPO 环境变量 > 本缺省；三者皆无 ⇒ 下方 bootstrap 存在性检查
// 明确报错退出（沿用既有「task-panel 仓不存在或结构不符…」信息，绝不静默 no-op）。
const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..'); // <repo>/team/scripts/../../.. = <repo>
const DEFAULT_REPO = path.resolve(REPO_ROOT, '..', 'task-panel');

/**
 * 幂等登记：逐条 code —— 基座已存在 ⇒ updateProject，否则 ⇒ createProject。
 * @param {{repos: {projects: {get: Function}}, commands: {createProject: Function, updateProject: Function}}} board
 * @param {{projects?: Record<string, object>}|null} registry
 * @returns {Array<{code: string, root: string, kind: string, action: 'created'|'updated'}>}
 */
export function registerIdentityCodes(board, registry) {
  const projects = registry?.projects ?? {};
  const summary = [];
  for (const [code, entry] of Object.entries(projects)) {
    if (code === '__team__') continue; // 保留名：内置语义，不落基座
    const src = entry ?? {};
    const workspacePath = src.root;
    if (typeof workspacePath !== 'string' || !workspacePath.startsWith('/')) {
      throw new Error(`项目 ${code} 的 root 非法（须绝对路径）: ${String(workspacePath)}`);
    }
    const meta = {
      kind: src.kind,
      root: src.root,
      root_git: src.root_git,
      repos: src.repos ?? [],
      guides: src.guides ?? [],
      default_git_rules: src.default_git_rules ?? '',
      notes: src.notes,
      registered_at: src.registered_at ?? null,
    };
    const existing = board.repos.projects.get(code);
    if (existing) {
      board.commands.updateProject({ id: code, patch: { name: code, workspacePath, meta } });
      summary.push({ code, root: workspacePath, kind: meta.kind, action: 'updated' });
    } else {
      board.commands.createProject({ id: code, name: code, workspacePath, meta });
      summary.push({ code, root: workspacePath, kind: meta.kind, action: 'created' });
    }
  }
  return summary;
}

/**
 * 主流程（可注入，供测试覆盖）：解析 repo → 读 identity code 来源 → 经 openBoard 建/迁移 → 登记。
 * @param {{repo?: string, projectsFile?: string, dataDir?: string, dbPath?: string, logger?: Console}} [opts]
 */
export async function seedProjects(opts = {}) {
  const repo = opts.repo || process.env.TASKPANEL_REPO || DEFAULT_REPO;
  const projectsFile = opts.projectsFile || PROJECTS_FILE;
  const logger = opts.logger || console;

  const bootstrap = path.join(repo, 'src', 'core', 'bootstrap.mjs');
  if (!fs.existsSync(bootstrap)) {
    throw new Error(
      `task-panel 仓不存在或结构不符: ${bootstrap}（设 TASKPANEL_REPO=<task-panel 仓根> 后重试）`,
    );
  }
  if (!fs.existsSync(projectsFile)) {
    throw new Error(`未找到 identity code 来源: ${projectsFile}`);
  }

  const registry = JSON.parse(fs.readFileSync(projectsFile, 'utf8'));
  const dataDir = opts.dataDir || resolveBoardDataDir();
  const dbPath = opts.dbPath || resolveBoardDbPath();

  const { openBoard } = await import(pathToFileURL(bootstrap).href);
  const board = await openBoard({ dataDir, dbPath, pointer: false });
  try {
    const summary = registerIdentityCodes(board, registry);
    logger.log(`[seed-projects] board=${dbPath}`);
    for (const s of summary) logger.log(`  ${s.action.padEnd(7)} ${s.code}  root=${s.root}  kind=${s.kind}`);
    logger.log(`[seed-projects] 完成：${summary.length} 个项目（幂等，可重复执行）`);
    return { dbPath, summary };
  } finally {
    board.close();
  }
}

export async function main() {
  try {
    await seedProjects();
    return 0;
  } catch (e) {
    console.error(`[seed-projects] ${String(e?.message || e)}`);
    return 1;
  }
}

/**
 * 是否作为主模块直接运行（main-guard）：经 realpath 归一后比较，符号链接调用亦能命中。
 *
 * `import.meta.url` 是 **`file://…` 字符串**（非 URL 对象）：`fs.realpathSync('file://…')` 会抛
 * ENOENT ⇒ 必须先 `fileURLToPath` 再 realpath。同时兼容传入 URL 对象（测试用）与普通路径串。
 * 独立成函数以便单测（realpath 失败时视为「被 import」）。
 * @param {string|URL} selfUrl 本模块 URL（import.meta.url，file:// 串或 URL 对象）
 * @param {string} argv1 process.argv[1]
 */
export function isMainEntry(selfUrl, argv1) {
  try {
    let selfPath = selfUrl;
    if (typeof selfUrl === 'string' && selfUrl.startsWith('file:')) {
      selfPath = fileURLToPath(selfUrl); // file://… 串 → 文件路径（直接 realpathSync 会 ENOENT）
    }
    return fs.realpathSync(selfPath) === fs.realpathSync(path.resolve(argv1));
  } catch {
    return false;
  }
}

if (isMainEntry(import.meta.url, process.argv[1])) {
  // main 内部已兜底错误并返回退出码 ⇒ 以该码退出（0 = 成功）
  main().then((code) => process.exit(code));
}
