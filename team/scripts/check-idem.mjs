#!/usr/bin/env node
/**
 * check-idem.mjs — 建卡幂等巡检（同 idem 键的非终态卡 >1 ⇒ 报警；纳入 check-all）
 * 依据：PROTOCOL §29 clause 8「巡检加『重复 key』校验」；guides/task-interface.md §14。
 *
 * 口径：按 `idem = <kind> | <assignee> | <source> | <target>`（source = review_of ‖ parent）
 * 对**非终态**卡分组（判据 = `scripts/status.mjs#isNonTerminal`：todo/ready/in_progress/blocked/
 * in_review），仅处理组内 >1 的组。**行为变更**：修前取 provider 的 `NON_TERMINAL`，而该集用旧词
 * `ready` 且缺 canonical `todo` ⇒ `status: todo` 的卡对幂等巡检完全隐形。
 *
 * **无 source（无 review_of 且无 parent）⇒ 不产键**（`idemKey` 返回空串）⇒ 不参与机械判重、
 * 扫描时直接跳过（同项目同人不再误撞）；机械判重仅对「有 source」的卡兜底（review_of/子卡）。
 *
 * 判重路由（T-20261010-064006-2 收口；T-20261014-214625 细化）——机械键对「同 parent + 同 assignee +
 * 同 target」的**兄弟卡**不含任何区分信息（三者相同恰是 epic 子卡常态：同一项目的多个子任务），必然撞键。
 * 故组内 >1 时按「source 是显式复核（review_of）还是 parent 派生」分两档：
 *   - duplicates（红，阻断）：组内**任一**卡有非空 `review_of`（显式复核同一张卡）⇒ 键有实义，判真重复，置退出码 1。
 *   - hints（非阻断）：组内**全部**卡由 parent 派键（review_of 全空）⇒ 兄弟卡弱信号，仅打印提示、**不影响退出码**
 *     （主闸仍是 LLM 语义判重；机械键只兜底，不该对子卡常态误报）。
 * 注：显式 idem 口径（把卡面 `idem` 并入键）需 create 路径写回卡面，属 provider（skills/task-ops/lib/task.mjs）
 * 职责；本脚本不改 provider，故取「子卡降级提示」一档。判据为 review_of 自身字段，不解析键字符串。
 *
 * **hints 的消费方（T-20261010-081140 裁定；其「非空 target 不降级」部分已由 T-20261014-214625 取代，
 * 「hints 仅供人工」部分保留）**：`hints` 为**仅供人工**的提示（CLI stderr / 人工巡检），
 * **不接入任何自动化告警消费**——`patrol-scan`、月报等一律**不得**以 hints 为告警源或阻断依据。理由：hints
 * 的定义即「机械键无区分信号」的兄弟卡常态；一旦接入告警/阻断，等于回归 064006-2 已消除的误报。主闸始终是
 * LLM 语义判重，机械键只对 duplicates 兜底。未来若确需观测，仅可为**信息性计数**（不报警、不阻断），且须另立卡。
 *
 * **target 不再是 parent 派生组的区分信号（T-20261014-214625 细化，取代 081140 的「非空 target 不降级」）**：
 * 同一 parent 的子卡**共享 target 是常态**（同一项目的多个子任务），非空且相同的 target 对 parent 派生组**无区分
 * 信息** ⇒ **即便 target 非空也降 hints**。`target` 仍参与 idem 键本身（决定两组子卡是否同组）；它只在
 * **review_of 组**（显式复核同一张卡）里仍是「同人同目标 ⇒ 真重复倾向」的实义信号 ⇒ review_of 非空的组维持
 * duplicates。判红依据因此收窄为「组内是否有非空 review_of」单一判据。
 *
 * 基线豁免（**机制保留**）——**登记来源已解耦（T-20261014-131423）**：一个文件不能同时是「随 install
 * 部署的托管物」与「运行时可变数据」（T-20261014-123216 现场即此：登记被升级清回，且在清回前就令慢段
 * 转红），故拆成**两类来源**。判据（`key` 相同 **且** `ids` 排序后与该组卡 id 集合**完全一致** ⇒ 移入
 * `exempt`、不判红；集合一旦变化（增卡/删卡/换卡）即**豁免失效**，防「登记一次、永久放行」）与豁免
 * 语义**一字未动**，变的只是「从哪里读登记」：
 *   ① **托管模板** `BASELINE_PATH = <本目录>/idem-baseline.json`：随 `install.sh` §1 `deploy_file` 部署
 *      到实例（默认 upgrade ⇒ **仓内副本覆盖实例副本**）⇒ **只读**，仓内副本是唯一权威。provider 契约
 *      测试 `skills/task-ops/tests/idem.test.mjs:483` 断言它 `groups` 为空 ⇒「仓内不得夹带豁免」仍是
 *      被机械检查的不变量。**运行时登记一律不写此文件**（写了必被下次部署清回，且清回前即令慢段红）。
 *   ② **运行时登记** `runtimeBaselinePath(dir)` = `<被巡检的 tasks 目录>/.idem-baseline.json`
 *      （`RUNTIME_BASELINE_NAME`）：不属任何部署树（`install.sh` 不部署 `tasks/` ⇒ 升级不清回登记
 *      `tasks/`）⇒ 升级**不再清回**登记；且因随 `tasksDir` 派生，provider 契约测试（自设 `OPENCLAW_TEAM_ROOT`
 *      隔离 root）读到的是隔离目录内的空登记 ⇒ **登记不再可能令慢段转红**（结构性，而非靠约定）。
 *   生效登记 = ① ∪ ②（同键重复先命中者胜；`loadExemptions`）。新增豁免**只写 ②**并人工核对；豁免仅对
 *   duplicates（真重复档）生效，hints 本身已非阻断、无需登记；`--no-baseline` 忽略**两者**（全部按
 *   duplicates，用于核查真重复或登记是否已过期）。
 *   遗留归口：`idem.test.mjs:483` 解耦后断言的主体只是**托管模板**（「仓内不得夹带豁免」）；若要它进一步
 *   钉「运行时无豁免」，须由 provider 归属方另立卡（本脚本不改 provider，见卡 T-20261014-131423 ③）。
 *
 * 退出码：0 无非豁免重复（含仅有 hints）；1 有非豁免 duplicates（报警）。
 * 隔离：OPENCLAW_TEAM_ROOT 覆盖（与 team-paths.mjs 同源），便于单测用 mkdtemp。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseFrontmatter, TASKS_DIR, TASK_OPS_DIR } from './lib.mjs';
import { isNonTerminal } from './status.mjs';

// provider 依赖显式化（方案②启动期硬失败）：**仅** idemKey 来自 provider ACL 库
// skills/task-ops/lib/task.mjs（provider 拥有、有意不随仓）。缺失 ⇒ 明确错误 + 非零退出。
// 注：lib.mjs 已对 team-paths/projects 做启动硬失败；此处补齐 task.mjs（同族文件）的显式化。
// 非终态判据已不再取 provider 的集合（其陈旧：用旧词 ready 且缺 canonical todo），改用
// `status.mjs#isNonTerminal`（见文件头「行为变更」）。
const TASK_MJS = path.join(TASK_OPS_DIR, 'lib', 'task.mjs');
if (!fs.existsSync(TASK_MJS)) {
  console.error(
    `provider 未安装：check-idem 依赖 provider ACL 库，缺失 skills/task-ops/lib/task.mjs` +
    `（查找于 ${TASK_MJS}）。请安装 meerkat-taskpanel 或其它基座，或设 OPENCLAW_TASK_OPS_DIR。`
  );
  process.exit(1);
}
const { idemKey } = await import(pathToFileURL(TASK_MJS).href);

export const BASELINE_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'idem-baseline.json');

/** 运行时登记文件名：落在**被巡检的 tasks 目录**内（随 tasksDir 派生 ⇒ 非部署托管、单测自动隔离）。 */
export const RUNTIME_BASELINE_NAME = '.idem-baseline.json';

/** 运行时登记路径（来源②）：与巡检目录同根；`install.sh` 不部署 `tasks/` ⇒ 升级不清回登记。 */
export function runtimeBaselinePath(tasksDir = TASKS_DIR) {
  return path.join(tasksDir, RUNTIME_BASELINE_NAME);
}

/** 兄弟卡降级理由（hints 的 reason 文案，单测/复核按此核对口径） */
export const SIBLING_HINT_REASON = '同 parent 兄弟卡（review_of 空；共享 target 属常态）⇒ 机械键无区分信息，降级为非阻断提示';

/** 读基线文件：缺失/损坏/形状不对 ⇒ 视为空组列表（**不报错**，退化为全量判红）。 */
export function loadBaseline(file = BASELINE_PATH) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(raw && raw.groups) ? raw.groups : [];
  } catch { return []; }
}

/**
 * 生效登记 = 托管模板（①，只读、由 provider 断言钉为空）∪ 运行时登记（②，tasks 目录内、不随部署）。
 * 两源参数可注入，便于单测在不触碰仓内模板文件的前提下覆盖合取行为。同键重复时先命中者胜（find 语义）。
 */
export function loadExemptions(tasksDir = TASKS_DIR, { template = BASELINE_PATH, runtime = runtimeBaselinePath(tasksDir) } = {}) {
  return [...loadBaseline(template), ...loadBaseline(runtime)];
}

/** 两个 id 集合是否**完全一致**（排序后逐项相等；顺序无关，长度不同 ⇒ 否）。 */
function sameIdSet(a, b) {
  const x = [...a].sort();
  const y = [...b].sort();
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

/** frontmatter 值归一为去空白字符串（undefined/null/数字安全）。 */
function str(v) {
  return v == null ? '' : String(v).trim();
}

export function scanIdem(tasksDir = TASKS_DIR, { baseline } = {}) {
  const groups = new Map(); // key -> { cards: [...], genuine: boolean }
  if (fs.existsSync(tasksDir)) {
    for (const f of fs.readdirSync(tasksDir)) {
      if (!f.endsWith('.md')) continue;
      let fm;
      try { ({ fm } = parseFrontmatter(fs.readFileSync(path.join(tasksDir, f), 'utf8'))); } catch { continue; }
      if (!fm) continue;
      const id = fm.id || f.replace(/\.md$/, '');
      if (!isNonTerminal(fm.status)) continue;
      const key = idemKey({ ...fm, id });
      if (!key) continue; // 无 source ⇒ 不产键，跳过（不参与机械判重）
      if (!groups.has(key)) groups.set(key, { cards: [], genuine: false });
      const g = groups.get(key);
      g.cards.push({ id, status: fm.status, assignee: fm.assignee || '', title: fm.title || '' });
      // 区分信号：仅「显式复核同一卡」（review_of 非空）⇒ 键有实义；parent 派生的兄弟卡共享 target 属常态，
      // 非空 target 不再构成区分信号（T-20261014-214625），故不再并入判据。
      if (str(fm.review_of)) g.genuine = true;
    }
  }
  const base = baseline === undefined
    ? loadExemptions(tasksDir)
    : (Array.isArray(baseline) ? baseline : []);

  const duplicates = [];
  const exempt = [];
  const hints = [];
  for (const [key, g] of groups.entries()) {
    const { cards } = g;
    if (cards.length <= 1) continue;
    if (!g.genuine) { hints.push({ idem: key, cards, reason: SIBLING_HINT_REASON }); continue; }
    const ids = cards.map((c) => c.id);
    const hit = base.find((b) => b && b.key === key && sameIdSet(b.ids || [], ids));
    if (hit) exempt.push({ key, cards, reason: hit.reason || '' });
    else duplicates.push({ idem: key, cards });
  }
  return { ok: true, duplicates, exempt, hints };
}

// main-guard：经 realpath 归一后比较，符号链接调用亦能命中（与其它 scripts/* 同风格）
try {
  const self = fs.realpathSync(new URL(import.meta.url));
  const arg = fs.realpathSync(path.resolve(process.argv[1]));
  if (arg === self) {
    // --no-baseline：忽略基线豁免（用于核查「真实重复」或基线本身是否过期）
    const noBaseline = process.argv.includes('--no-baseline');
    const r = scanIdem(TASKS_DIR, { baseline: noBaseline ? [] : undefined });
    console.log(JSON.stringify(r, null, 2));
    if (r.duplicates.length) {
      console.error(`建卡幂等违例：${r.duplicates.length} 组同 idem 的非终态卡（>1）—— 机械键兜底命中，需人工裁定（LLM 语义判重为主闸）`);
      // 逃生口可发现性：登记处只报一次（人工核对后追加），免去「翻头注才知道登记在哪」
      console.error(`  如需登记良性豁免（人工核对后）：追加 ${RUNTIME_BASELINE_NAME} @ ${runtimeBaselinePath(TASKS_DIR)}（运行时不随部署；判据 = key + id 集合全等，集合变化即失效）`);
      for (const g of r.duplicates) {
        console.error(`  · ${g.idem}`);
        for (const c of g.cards) console.error(`      ${c.id} [${c.status}] ${c.title}`);
      }
    }
    if (r.hints.length) {
      console.error(`建卡幂等提示：${r.hints.length} 组同 parent 兄弟卡（review_of 空；共享 target 属常态）—— 机械键无区分信息，非阻断、不置退出码（需区分请经 LLM 语义判重）`);
      for (const g of r.hints) {
        console.error(`  · hint ${g.idem}`);
        for (const c of g.cards) console.error(`      ${c.id} [${c.status}] ${c.title}`);
      }
    }
    if (r.exempt.length) {
      console.error(`建卡幂等基线豁免：${r.exempt.length} 组（exempt）—— 既存良性组；登记处＝运行时 ${runtimeBaselinePath(TASKS_DIR)} ∪ 托管模板 ${BASELINE_PATH}（只读）；集合变化即失效`);
      for (const g of r.exempt) {
        console.error(`  · exempt ${g.key}${g.reason ? `（${g.reason}）` : ''}`);
        for (const c of g.cards) console.error(`      ${c.id} [${c.status}] ${c.title}`);
      }
    }
    if (r.duplicates.length) process.exitCode = 1; // 置退出码而非 process.exit：管道 stdout 不截断（调用方需解析 JSON）
  }
} catch { /* realpath 失败 ⇒ 不执行 main */ }
