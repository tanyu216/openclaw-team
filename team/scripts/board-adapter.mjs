#!/usr/bin/env node
/**
 * board-adapter.mjs — 基座适配器的 **team 侧 §8 投影**（薄调用 CLI；C 面，T-20261012-001338）
 *
 * 契约：`guides/task-interface.md §8`（Future-Swap Mapping）+ `§1`（**唯一访问点**）+ `§12`（ACL 绑定）。
 * 形状（与 provider 基座适配器同名同形，可互换）：
 *   `{ name:'task-panel', resolve(code) → { available, found?, metadata?, reason? } }`
 * 语义（与既有基座一致，调用方无需改动）：
 *   - `available:false` ⇒ 基座不可用（无 CLI / 板不可读 / **wire 漂移** / 超时），resolver 应走只读回退；
 *   - `available:true, found:false` ⇒ 板可读但无该 identity code；
 *   - `available:true, found:true, metadata` ⇒ 命中。
 *   **任何异常都不得抛到调用方**：统一降级为 `{available:false, reason}`。
 *
 * 与旧适配器的差别（本次改动的全部要点）：
 *   ① **取数经子进程走 CLI**（唯一访问点）：`taskctl project list --json` → 取 `data.projects[]` 中 id 命中者；
 *      **不再 import provider 内部**（不 import `bases/task-panel.mjs`）、**不再直连 sqlite**（不开 `node:sqlite`）；
 *   ② **以 board wire 为准对齐 schema**：字段口径对标 provider `src/shared/wire.mjs#projectToWire`
 *      （冻结进 `docs/contract.md` 的 contract snapshot，`shape:"project"`）；
 *   ③ **schema 漂移门（双腿）**：
 *      **版本腿**（本卡接通）＝ 每次解析先读**运行期 provider 版本**（`taskctl --version --json` ⇒
 *      `data.schema_version`），与适配器**声明所对标**的 `BOARD_WIRE_SCHEMA_VERSION` 比对；不一致 ⇒
 *      **响亮判红 + 降级**（不取数、不投影，直接 `available:false` 交回退）；该腿读不到（CLI 无该子命令
 *      / 信封里没有 `schema_version`）同样判红（版本级契约已冻结在 CLI，读不到即漂移）。
 *      **结构腿**＝ 对实取 board `project` wire 逐字段比对声明表；缺字段/改类型 ⇒ 不可用交回退；
 *      新增字段 ⇒ 告警但按可读继续。两腿**绝不静默 fallback**。
 *
 * **两 schema 显式映射、不合并**（边界）：本文件的映射只是 board `project` wire → §8 项目 metadata 的
 * **一次**投影；team 侧卡 frontmatter schema（`lib.mjs` 的 parseFrontmatter/serializeFrontmatter）**不动**，
 * provider 的物理 schema 知识仍属 provider。二者永不合并。
 *
 * 只读：子进程一律带 `TASKD_NO_AUTOSTART=1`（诊断/解析**不得**顺手拉起守护进程），且本模块不写任何文件。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { withStallRetrySync, timeoutBreachOf } from './host-stall.mjs';

/** §8 基座适配器身份（与 provider `bases/task-panel.mjs` 同名 ⇒ 可互换）。 */
export const name = 'task-panel';

/**
 * **声明的对标版本**：本适配器（含 `PROJECT_WIRE_FIELDS` 字段表）所对标的 board wire 契约快照
 * `schema_version`（provider `docs/contract.md`：“Bumping the snapshot's own layout (not a section)
 * bumps `schema_version`… It is **4**”；快照 `test/fixtures/contract/api.snapshot.json`）。
 *
 * **这是「期望值」，不是「真值」**：真值在运行期由 provider 给出——`taskctl --version --json` ⇒
 * `data.schema_version`（provider `CONTRACT_SCHEMA_VERSION`，与快照**同源**，见 T-20261012-015340）。
 * 每次解析都会读该运行期腿并与本常量比对（见 `readProviderSchemaVersion` / `resolveViaCli`）。
 *
 * 为什么不改用「共享契约常量」：那会把这一个数字变成**第二份拷贝**，provider 升版而 team 侧未跟版时
 * 两个拷贝各自为政、门禁静默失效——正是本卡要关掉的那类缺陷。运行期读取让该数字保持**单一真源**，
 * provider 升版 ⇒ 门禁自动变红，无需人工同步（本常量只在**本适配器改跟随新 wire**时才需人工复核）。
 */
export const BOARD_WIRE_SCHEMA_VERSION = 4;

/** wire 形状名（contract snapshot 的 `shape` 名）。 */
export const BOARD_WIRE_SHAPE = 'project';

/**
 * 冻结的对标字段表 = board `project` wire 的字段名 → JSON 类型
 * （来源：provider `src/shared/wire.mjs#projectToWire`，经 contract snapshot `shape:"project"` 冻结）。
 * 该表是**声明**：运行时与实取对象逐字段比对，漂移即告警。
 *
 * `prefix`（project 有效前缀，如 `OPENCLAW-TEAM`）是 provider 卡 `T-20261014-030233` 新增的**只读**
 * wire 字段（`projectToWire` 增 `prefix: projectPrefix(project)`，contract snapshot wire fields
 * 116→117）；team 侧声明随之跟随（加性字段，`schema_version` 不变 —— 该号只随快照**布局**而非
 * 区块字段变动，见上文）。漏声明会让结构腿每次实跑都报 `wire_field_added(prefix)` 告警。
 */
export const PROJECT_WIRE_FIELDS = Object.freeze({
  archived_at: 'string',
  created_at: 'string',
  id: 'string',
  labels: 'array',
  meta: 'object',
  name: 'string',
  prefix: 'string',
  readme: 'string',
  task_count: 'number',
  updated_at: 'string',
});

/** JSON 值类型（`null` 单列：wire 投影用 null 表达“无值”，不算类型漂移）。 */
export function jsonType(v) {
  if (v === null || v === undefined) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

/**
 * schema 漂移门：把实取的 board `project` wire 与声明表比对（纯函数，不触盘）。
 *
 * - 缺字段（`wire_field_missing`）/ 类型变化（`wire_type_changed`）⇒ **破坏性漂移**（`ok:false`）；
 * - 多字段（`wire_field_added`）⇒ 加性漂移：`ok:true` 但**仍列出**（可读继续，附告警）；
 * - 传入 `boardSchemaVersion` 且与声明不符 ⇒ `schema_version_mismatch`（破坏性）。
 * @param {unknown} wire
 * @param {{boardSchemaVersion?: number|string|null}} [opts]
 * @returns {{ok: boolean, findings: Array<{code: string, field?: string, expected?: string, actual?: string, declared?: number|string, got?: number|string}>}}
 */
export function detectWireDrift(wire, opts = {}) {
  const findings = [];
  if (jsonType(wire) !== 'object') {
    return { ok: false, findings: [{ code: 'wire_shape_invalid', expected: 'object', actual: jsonType(wire) }] };
  }
  const { boardSchemaVersion = null } = opts;
  if (boardSchemaVersion !== null && String(boardSchemaVersion) !== String(BOARD_WIRE_SCHEMA_VERSION)) {
    findings.push({
      code: 'schema_version_mismatch',
      declared: BOARD_WIRE_SCHEMA_VERSION,
      got: boardSchemaVersion,
    });
  }
  for (const [field, expected] of Object.entries(PROJECT_WIRE_FIELDS)) {
    if (!Object.prototype.hasOwnProperty.call(wire, field)) {
      findings.push({ code: 'wire_field_missing', field, expected });
      continue;
    }
    const actual = jsonType(wire[field]);
    // null = “无值”（projectToWire 对空值即输出 null）⇒ 不算类型漂移
    if (actual !== 'null' && actual !== expected) {
      findings.push({ code: 'wire_type_changed', field, expected, actual });
    }
  }
  for (const field of Object.keys(wire)) {
    if (!Object.prototype.hasOwnProperty.call(PROJECT_WIRE_FIELDS, field)) {
      findings.push({ code: 'wire_field_added', field, actual: jsonType(wire[field]) });
    }
  }
  return { ok: findings.every((f) => f.code === 'wire_field_added'), findings };
}

/**
 * board `project` wire → §8 项目 metadata（**显式映射一次**）。
 * 目录锚点只取 `meta.root`：board migration 0012 已删除旧 `root`/`workspace_path` 列，board 归 provider。
 * @param {object} wire
 * @returns {object} §8 metadata（与既有基座 `metadataFromRow` 同形）
 */
export function projectFromWire(wire) {
  const meta = wire?.meta && typeof wire.meta === 'object' ? wire.meta : {};
  return {
    name: wire?.id,
    kind: meta.kind ?? 'code',
    root: meta.root ?? null,
    root_git: meta.root_git,
    repos: meta.repos ?? [],
    guides: meta.guides ?? [],
    default_git_rules: meta.default_git_rules ?? meta.git_rules ?? '',
    notes: meta.notes,
    registered_at: meta.registered_at ?? null,
  };
}

/**
 * 默认 runner：`taskctl <args>` 子进程（只读；禁止 autostart）。可注入（单测）。
 * CLI 位置：`opts.taskctl` > `$OPENCLAW_TEAM_TASKCTL`（未装全局命令时指向 CLI 入口的**可执行**路径）> `taskctl`。
 *
 * **有界等待的击穿不是 CLI 的结论**（T-20261016-210926）：`timeoutMs` 到点没拿到结果，只说明
 * **我们没问出答案**，不说明 CLI 失败——宿主休眠/负载尖峰会连有界等待的执法钟一起停掉，返回一个
 * `status:null` 的空结论。故一次击穿后带**新期限重跑一次**（`retries`，默认 1）；两次皆击穿才把
 * 那个空结论交回调用方（照旧降级判红）。**真失败不重取**：CLI 缺失（`ENOENT`）、非零退出都是
 * **答案**，一次定终身（判据见 `host-stall.mjs#timeoutBreachOf`）。
 *
 * 于是 `taskctl` 真挂死时最坏用时 = `timeoutMs × (retries + 1)`（默认 10s）——只发生在这条链
 * 已经不可信的时候，而已有的只读回退不受影响。
 */
export function cliRunner(args, { taskctl = process.env.OPENCLAW_TEAM_TASKCTL || 'taskctl', timeoutMs = 5000, retries = 1, env = process.env } = {}) {
  const { value } = withStallRetrySync(
    () =>
      spawnSync(taskctl, args, {
        encoding: 'utf8',
        timeout: timeoutMs,
        maxBuffer: 8 * 1024 * 1024,
        env: { ...env, TASKD_NO_AUTOSTART: '1' }, // 解析路径只读：不得顺手拉起守护进程
      }),
    { classify: timeoutBreachOf, retries, budgetMs: timeoutMs },
  );
  return value;
}

/**
 * **版本腿（运行期）**：`taskctl --version --json` ⇒ `data.schema_version`。
 *
 * 该子命令是 provider 侧为「版本号级漂移门」专门补强的**板无关**应答（在 token/board/data-dir 之前
 * 即返回，见 T-20261012-015340），故本适配器读它不触碰板、不写盘。同样带 `TASKD_NO_AUTOSTART=1`。
 *
 * 失败语义：读不到 ⇒ `{ok:false, reason}`（**不抛**）。调用方（`resolveViaCli`）据此判红。
 * @param {{runner?: Function, taskctl?: string, timeoutMs?: number, env?: object}} [opts]
 * @returns {{ok: true, schemaVersion: number|string} | {ok: false, reason: string}}
 */
export function readProviderSchemaVersion(opts = {}) {
  const { runner = cliRunner } = opts;
  let res;
  try {
    res = runner(['--version', '--json'], opts);
  } catch (err) {
    return { ok: false, reason: `taskctl --version 调用异常: ${err?.message ?? err}` };
  }
  if (!res || res.status !== 0) {
    const detail =
      String(res?.stderr ?? '').trim().split('\n')[0] ||
      String(res?.error?.message ?? '').trim() ||
      `exit=${res?.status}`;
    return { ok: false, reason: `taskctl --version --json 失败（${detail}）` };
  }
  let envelope;
  try {
    envelope = JSON.parse(String(res.stdout ?? ''));
  } catch {
    return { ok: false, reason: 'taskctl --version --json 输出不可解析（非 JSON 信封）' };
  }
  const v = envelope?.ok === true ? envelope?.data?.schema_version : undefined;
  if (v === undefined || v === null || v === '') {
    return { ok: false, reason: 'taskctl --version --json 未暴露 data.schema_version（版本级契约已冻结在 CLI，读不到即漂移）' };
  }
  return { ok: true, schemaVersion: v };
}

/**
 * 薄调用：`taskctl project list --json` → 选 id 命中行 → 漂移门 → §8 投影。
 *
 * 注：投影取数用 `project list --json`（`project show` 目前**不存在**于 CLI；list 的每个元素即
 * `projectToWire` 输出，含 `meta`，等价且无信息损失）。
 *
 * **顺序**（版本腿在前，短路径）：① 空 code 快速返回 → ② **版本腿**：读运行期 `schema_version`，
 * 读不到或与本适配器声明不符 ⇒ **立刻判红**（不取数、不投影）；③ 取数 → ④ 结构腿 → ⑤ 投影。
 * 版本腿放在取数之前：版本不一致时整条链都不可信，连读都不该读（且与「板里有没有该 code」无关，
 * 判红不受 `found` 影响）。
 *
 * @param {string} code identity code
 * @param {{taskctl?: string, runner?: Function, timeoutMs?: number, boardSchemaVersion?: number|string|null,
 *          warn?: (msg: string) => void}} [opts] `opts.boardSchemaVersion` 是**显式覆盖位**
 *          （测试/降级演练用）；不传即走运行期版本腿。
 * @returns {{available: boolean, found?: boolean, metadata?: object, reason?: string, drift?: object,
 *            providerSchemaVersion?: number|string}}
 */
export function resolveViaCli(code, opts = {}) {
  const { runner = cliRunner, warn = (msg) => process.stderr.write(`${msg}\n`) } = opts;
  if (typeof code !== 'string' || code.trim() === '') return { available: false, reason: 'identity code 为空' };

  // ---- ② 版本腿：运行期 provider schema_version vs 本适配器声明 ----
  let providerSchemaVersion = opts.boardSchemaVersion ?? null;
  if (providerSchemaVersion === null) {
    const leg = readProviderSchemaVersion(opts);
    if (!leg.ok) {
      warn(`[board-adapter] 版本腿不可读（对标 schema_version=${BOARD_WIRE_SCHEMA_VERSION}）：${leg.reason}`);
      return {
        available: false,
        reason: `board 版本腿不可读（对标 schema_version=${BOARD_WIRE_SCHEMA_VERSION}）：${leg.reason}`,
        drift: { ok: false, findings: [{ code: 'version_leg_unavailable', declared: BOARD_WIRE_SCHEMA_VERSION, actual: leg.reason }] },
      };
    }
    providerSchemaVersion = leg.schemaVersion;
  }
  if (String(providerSchemaVersion) !== String(BOARD_WIRE_SCHEMA_VERSION)) {
    const findings = [{ code: 'schema_version_mismatch', declared: BOARD_WIRE_SCHEMA_VERSION, got: providerSchemaVersion }];
    warn(
      `[board-adapter] board wire 版本漂移（对标 schema_version=${BOARD_WIRE_SCHEMA_VERSION}, shape=${BOARD_WIRE_SHAPE}）：` +
        `provider 运行期 schema_version=${providerSchemaVersion}`,
    );
    return {
      available: false,
      reason: `board wire 版本漂移（对标 schema_version=${BOARD_WIRE_SCHEMA_VERSION}）：${JSON.stringify(findings)}`,
      drift: { ok: false, findings },
      providerSchemaVersion,
    };
  }

  let res;
  try {
    res = runner(['project', 'list', '--json'], opts);
  } catch (err) {
    return { available: false, reason: `taskctl 调用异常: ${err?.message ?? err}` };
  }
  if (!res || res.status !== 0) {
    // 注意：spawnSync 未找到可执行文件时 status 为 null（且带 error）—— 必须按失败处理，
    // 不能用 `Number(null) === 0` 把它当成功（否则“CLI 缺失”会退化成“板里没有该项目”）。
    const detail =
      String(res?.stderr ?? '').trim().split('\n')[0] ||
      String(res?.error?.message ?? '').trim() ||
      `exit=${res?.status}`;
    return { available: false, reason: `taskctl project list 失败（${detail}）` };
  }

  let envelope;
  try {
    envelope = JSON.parse(String(res.stdout ?? ''));
  } catch {
    return { available: false, reason: 'taskctl --json 输出不可解析（非 JSON 信封）' };
  }
  const projects = envelope?.ok === true && Array.isArray(envelope?.data?.projects) ? envelope.data.projects : null;
  if (projects === null) {
    return { available: false, reason: 'taskctl --json 信封形状不符（缺 ok:true / data.projects[]）' };
  }

  const wire = projects.find((p) => p?.id === code);
  if (wire === undefined) return { available: true, found: false };

  // 版本腿已在上方核过（此处传运行期版本是做一次纵深的等价复核：detectWireDrift 是纯函数，可直调）
  const drift = detectWireDrift(wire, { boardSchemaVersion: providerSchemaVersion });
  if (drift.findings.length) {
    warn(
      `[board-adapter] board wire 漂移（对标 schema_version=${BOARD_WIRE_SCHEMA_VERSION}, shape=${BOARD_WIRE_SHAPE}）：` +
        drift.findings.map((f) => `${f.code}${f.field ? `(${f.field})` : ''}`).join(', '),
    );
  }
  if (!drift.ok) {
    // 破坏性漂移 ⇒ 显式降级为不可用（交回退），绝不静默按旧 schema 读
    return {
      available: false,
      reason: `board wire 漂移（对标 schema_version=${BOARD_WIRE_SCHEMA_VERSION}）：${JSON.stringify(drift.findings)}`,
      drift,
      providerSchemaVersion,
    };
  }
  return { available: true, found: true, metadata: projectFromWire(wire), drift, providerSchemaVersion };
}

/** §8 基座入口（默认走 CLI；`opts` 全量透传给 resolveViaCli）。 */
export const resolve = (code, opts = {}) => resolveViaCli(code, opts);

/** 只读回退：读 projects.json（过渡期权威快照；缺失/无该 code ⇒ null）。 */
export function readFallback(file, code) {
  if (typeof file !== 'string' || file.trim() === '') return null;
  try {
    if (!fs.existsSync(file)) return null;
    const registry = JSON.parse(fs.readFileSync(file, 'utf8'));
    return registry?.projects?.[code] ?? null;
  } catch {
    return null;
  }
}

/**
 * ACL 解析顺序（与接口契约一致）：内置保留名 → 基座（CLI）→ 只读回退 projects.json → 未注册抛错。
 * @param {string} code
 * @param {{base?: Function, builtin?: object|null, fallbackFile?: string, baseOpts?: object}} [opts]
 * @returns {{metadata: object, source: 'builtin'|'base'|'fallback'}}
 */
export function resolveProject(code, opts = {}) {
  if (opts.builtin && code === opts.builtin.name) return { metadata: opts.builtin, source: 'builtin' };

  const base = opts.base ?? resolve;
  let res;
  try {
    res = base(code, opts.baseOpts ?? {});
  } catch (err) {
    res = { available: false, reason: `基座适配器异常: ${err?.message ?? err}` };
  }
  if (res?.available && res.found) return { metadata: { name: code, ...(res.metadata ?? {}) }, source: 'base' };

  const entry = readFallback(opts.fallbackFile, code);
  if (entry) return { metadata: { name: code, ...entry }, source: 'fallback' };

  throw new Error(`项目未注册: ${code}（请 Elon 按 PROTOCOL ⑧ 登记后再建卡）`);
}

/** resolveProject 的 metadata 快捷式（未注册 ⇒ 抛错）。 */
export function getProject(code, opts = {}) {
  return resolveProject(code, opts).metadata;
}

export function main(argv = process.argv.slice(2)) {
  const code = argv.find((a) => !a.startsWith('--'));
  if (!code) {
    console.log('用法: node board-adapter.mjs <identity-code>   # §8 解析（经 taskctl CLI 取数 + wire 漂移门）');
    return 0;
  }
  try {
    console.log(JSON.stringify(resolveProject(code), null, 2));
    return 0;
  } catch (e) {
    console.error(`[board-adapter] ${String(e?.message ?? e)}`);
    return 1;
  }
}

// main-guard：经 realpath 归一后比较（与 lib.mjs 同口径），符号链接调用亦能命中。
// 注意：**判定**包在 try 里，main() **不在** try 里 —— 否则 main 的错误会被静默吞掉（H1 类静默失效）。
let isMain = false;
try {
  isMain = fs.realpathSync(new URL(import.meta.url)) === fs.realpathSync(new URL(`file://${process.argv[1]}`));
} catch { /* realpath 失败 ⇒ 视为被 import */ }
if (isMain) process.exit(main());
