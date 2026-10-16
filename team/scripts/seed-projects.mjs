#!/usr/bin/env node
/**
 * seed-projects.mjs — 把现役 identity code 幂等登记进 meerkat-taskpanel 基座 board
 *
 * 契约：guides/task-interface.md §8；规范：PROTOCOL.md PROTOCOL §8。
 * 来源：`~/.openclaw/team/projects.json`（过渡期权威快照，只读）；跳过保留名 `__team__`。
 * 基座：用 meerkat-taskpanel 官方引导 `openBoard()` 建/迁移 DB（**不手抄 SQL**）。
 * board 落盘与下方只读适配器（provider 拥有，见动态导入处）同源（resolveBoardDataDir/DbPath）。
 *
 * 登记期**存在性守卫**（PROTOCOL §8 步骤 2 的机械落地）：root 须为绝对路径 / 存在 / 为目录，
 * 否则默认**拒绝整轮登记**（一条不写），绝不静默登记陈旧 root（事故链 R76→R79 的根因）。
 * 登记期**containment 守卫**（PROTOCOL §2.1）：每个 `repos[].rel_path` 须为项目内相对路径
 * （PROTOCOL §6 也是 cwd 锚点之一）⇒ 否则同样拒绝（见 invalidRepoReason）。
 * 不传惰性 `workspacePath`（O3 后 taskpanel 不读；基座 0012 已删该列）——目录锚点唯一经由 meta.root。
 *
 * 用法：node scripts/seed-projects.mjs   # 可重复执行（幂等）
 * 环境：MEERKAT_TASKPANEL_REPO（meerkat-taskpanel 仓根；缺省取与 openclaw-team 同级的兄弟目录 ../meerkat-taskpanel）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PROJECTS_FILE, TASK_OPS_DIR, escapeReason } from './lib.mjs';

// provider 依赖显式化（方案②启动期硬失败）：board 路径解析来自 provider ACL 库 skills/task-ops/
// （provider 拥有、有意不随仓）。lib.mjs 已对 team-paths/projects 做启动硬失败；此处把其中的
// board 基座适配器改为显式动态导入。**该适配器文件名随 provider 发布**（skills/task-ops，既非本仓、
// 也非 meerkat-taskpanel 产品仓），未随本次改名 ⇒ 保留旧名，避免跨仓破坏 provider ACL 库导入。
const taskPanelBase = await import(pathToFileURL(path.join(TASK_OPS_DIR, 'bases', 'task-panel.mjs')).href); // legacy-name-compat(provider-owned ACL adapter filename; not renamed upstream)
const { resolveBoardDataDir, resolveBoardDbPath } = taskPanelBase;

// meerkat-taskpanel 仓默认位置：与 openclaw-team 同级的兄弟目录（不硬绑本机绝对路径）。
// 解析顺序 opts.repo > MEERKAT_TASKPANEL_REPO（旧名仍接受，一次性告警，legacy-name-compat）环境变量 >
// 兄弟目录探测（新名优先，兼容尚未改名的旧检出）> 下方 bootstrap 存在性检查明确报错退出
// （沿用既有「…仓不存在或结构不符」信息，绝不静默 no-op）。
const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..'); // <repo>/team/scripts/../../.. = <repo>
const SIBLING_REPO_DIRS = ['meerkat-taskpanel', 'task-panel']; // legacy-name-compat(pre-rebrand sibling checkout dir)
const DEFAULT_REPO = SIBLING_REPO_DIRS.map((n) => path.resolve(REPO_ROOT, '..', n)).find((p) => fs.existsSync(p))
  || path.resolve(REPO_ROOT, '..', SIBLING_REPO_DIRS[0]);

// 旧 env 名仍接受（新名优先；见 naming map §4.2 兼容条款，legacy-name-compat）。
function legacyRepoEnv(env) {
  const v = env['TASKPANEL_REPO']; // legacy-name-compat(pre-rebrand env var name)
  if (v) process.stderr.write('[seed-projects] TASKPANEL_REPO 已弃用：请改用 MEERKAT_TASKPANEL_REPO\n'); // legacy-name-compat
  return v || '';
}

/**
 * root 存在性守卫（PROTOCOL §8 步骤 2「Elon 校验 root 存在」的机械落地点）。
 *
 * 缺陷背景（事故链复盘 R76→R79）：登记期只校验「绝对路径」，缺 root 的目录**仍被静默登记**，
 * 于是陈旧 root 进了基座 meta，后续解析拿它当工作目录 ⇒ 一路静默失败。
 *
 * 判据：`root` 须为 **绝对路径 / 存在 / 为目录**；任一不满足 ⇒ 返回人读原因（null = 合法）。
 * 只做只读 stat，不创建/不修正任何目录。
 * @param {unknown} root
 * @returns {string|null} 非法原因（null = 合法）
 */
export function invalidRootReason(root) {
  if (typeof root !== 'string' || root.trim() === '') return `缺失（root=${JSON.stringify(root)}）`;
  if (!path.isAbsolute(root)) return `非绝对路径（${root}）`;
  let st;
  try {
    st = fs.statSync(root);
  } catch {
    return `不存在（${root}）`;
  }
  if (!st.isDirectory()) return `非目录（${root}）`;
  return null;
}

/**
 * `repos[].rel_path` containment 守卫（PROTOCOL §2.1「Containment (project metadata)」）。
 *
 * 缺陷背景：`invalidRootReason` 只管 `root` 自身；而 PROTOCOL §6 明写非 `__team__` 卡的 cwd = `root` +
 * 卡片的 `target`/**`repos[].rel_path`** ⇒ 一个登记成 `../sibling` 的 rel_path 会把该项目的
 * **所有** lane 导出自身，而**卡片层看不出任何缺陷**（`scan-deps.mjs` 也直接
 * `path.resolve(root, rel_path)`，两侧都不校验）。
 *
 * 判据：空/缺省 ⇒ 合法（等价 `.`）；非空须为**项目内相对路径** —— 绝对 / 本机锚 `~` / 盘符 /
 * 段归一越界一律非法。判据与卡级门禁共用同一个 `escapeReason`（一处口径，`lib.mjs` 持有）。
 * 只读，不触盘。
 * @param {unknown} relPath
 * @returns {string|null} 非法原因（null = 合法）
 */
export function invalidRepoReason(relPath) {
  if (relPath === undefined || relPath === null || String(relPath).trim() === '') return null;
  if (typeof relPath !== 'string') return `rel_path 非字符串（${JSON.stringify(relPath)}）`;
  const why = escapeReason(relPath);
  return why ? `rel_path 越出项目 root（${why}）：${relPath}` : null;
}

/**
 * 幂等登记：逐条 code —— 基座已存在 ⇒ updateProject，否则 ⇒ createProject。
 *
 * 登记前整体校验各 code 的 root（见 invalidRootReason）：默认**拒绝**（抛错、一条不写，
 * 绝不部分登记）；`allowInvalidRoot` 时改为**逐条显式告警并跳过**该条（其余照常登记，
 * summary 里以 action:'skipped' 显式回报）。两种模式下都不会静默登记陈旧 root。
 *
 * 不传 `workspacePath`：O3（T-20261009-190023）后 taskpanel 不再读 workspace_path，
 * 且基座 migration 0012 已删除该列（repos.projects.create/update 无此字段、静默忽略）。
 * 项目目录锚点唯一经由 `meta.root`；保留惰性 workspacePath 只会制造「看起来有、其实没人读」的假象。
 *
 * @param {{repos: {projects: {get: Function}}, commands: {createProject: Function, updateProject: Function}}} board
 * @param {{projects?: Record<string, object>}|null} registry
 * @param {{allowInvalidRoot?: boolean, logger?: {warn: Function}}} [opts]
 * @returns {Array<{code: string, root: string, kind: string, action: 'created'|'updated'|'skipped', reason?: string}>}
 */
export function registerIdentityCodes(board, registry, opts = {}) {
  const { allowInvalidRoot = false, logger = console } = opts;
  const projects = registry?.projects ?? {};
  const entries = Object.entries(projects).filter(([code]) => code !== '__team__'); // 保留名：内置语义，不落基座
  const resolved = [];

  // 先整体校验（fail-fast）：默认模式下任一非法 ⇒ 一条都不写，绝不部分登记
  const invalid = [];
  for (const [code, entry] of entries) {
    // root 自身 + 每个 repos[].rel_path 的 containment（PROTOCOL §2.1）：任一无理 ⇒ 该条整体非法
    const reasons = [invalidRootReason(entry?.root)];
    for (const r of Array.isArray(entry?.repos) ? entry.repos : []) reasons.push(invalidRepoReason(r?.rel_path));
    const reason = reasons.find((x) => x !== null) ?? null;
    if (reason === null) resolved.push({ code, src: entry ?? {} });
    else invalid.push({ code, root: entry?.root, reason });
  }
  if (invalid.length && !allowInvalidRoot) {
    const lines = invalid.map((i) => `${i.code}: ${i.reason}`).join('\n  - ');
    throw new Error(
      `项目 root/rel_path 校验未通过，登记中止（PROTOCOL §8 步骤 2 的机械落地面）：\n  - ${lines}`,
    );
  }

  const summary = [];
  for (const { code, root, reason } of invalid) {
    logger.warn?.(`[seed-projects] 跳过 ${code}：root 非法（${reason}）— 未登记，请 Elon 按 PROTOCOL §8 修正 registry`);
    summary.push({ code, root, kind: undefined, action: 'skipped', reason });
  }
  for (const { code, src } of resolved) {
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
      board.commands.updateProject({ id: code, patch: { name: code, meta } });
      summary.push({ code, root: src.root, kind: meta.kind, action: 'updated' });
    } else {
      board.commands.createProject({ id: code, name: code, meta });
      summary.push({ code, root: src.root, kind: meta.kind, action: 'created' });
    }
  }
  return summary;
}

/**
 * 主流程（可注入，供测试覆盖）：解析 repo → 读 identity code 来源 → 经 openBoard 建/迁移 → 登记。
 * @param {{repo?: string, projectsFile?: string, dataDir?: string, dbPath?: string, logger?: Console}} [opts]
 */
export async function seedProjects(opts = {}) {
  const repo = opts.repo || process.env.MEERKAT_TASKPANEL_REPO || legacyRepoEnv(process.env) || DEFAULT_REPO;
  const projectsFile = opts.projectsFile || PROJECTS_FILE;
  const logger = opts.logger || console;

  const bootstrap = path.join(repo, 'src', 'core', 'bootstrap.mjs');
  if (!fs.existsSync(bootstrap)) {
    throw new Error(
      `meerkat-taskpanel 仓不存在或结构不符: ${bootstrap}（设 MEERKAT_TASKPANEL_REPO=<meerkat-taskpanel 仓根> 后重试）`,
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
    for (const s of summary) {
      const tail = s.action === 'skipped' ? `  reason=${s.reason}` : `  root=${s.root}  kind=${s.kind}`;
      logger.log(`  ${s.action.padEnd(7)} ${s.code}${tail}`);
    }
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
