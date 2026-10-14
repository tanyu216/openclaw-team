#!/usr/bin/env node
/**
 * check-idem.mjs — 建卡幂等巡检（同 idem 键的非终态卡 >1 ⇒ 报警；纳入 check-all）
 * 依据：PROTOCOL §㉙.8「巡检加『重复 key』校验」；guides/task-interface.md §14。
 *
 * 口径：按 `idem = <kind> | <assignee> | <source> | <target>`（source = review_of ‖ parent）
 * 对**非终态**（ready/in_progress/in_review/blocked）卡分组，仅处理组内 >1 的组。
 *
 * **无 source（无 review_of 且无 parent）⇒ 不产键**（`idemKey` 返回空串）⇒ 不参与机械判重、
 * 扫描时直接跳过（同项目同人不再误撞）；机械判重仅对「有 source」的卡兜底（review_of/子卡）。
 *
 * 判重路由（T-20261010-064006-2 收口）——机械键对「同 parent + 同 assignee + 空 target」的**兄弟卡**
 * 不含任何区分信息（三者相同恰是子卡常态），必然撞键（本轮 Elon 建 meerkat 改名卡实测触发）。故组内 >1
 * 时按「键是否携带真实区分信号」分两档：
 *   - duplicates（红，阻断）：组内**任一**卡有非空 `review_of`（显式复核同一张卡）或非空 `target`
 *     （同人同目标）⇒ 键有实义，判真重复，置退出码 1。
 *   - hints（非阻断）：组内**全部**卡由 parent 派键（review_of 空）且 target 空 ⇒ 兄弟卡弱信号，
 *     仅打印提示、**不影响退出码**（主闸仍是 LLM 语义判重；机械键只兜底，不该对子卡常态误报）。
 * 注：显式 idem 口径（把卡面 `idem` 并入键）需 create 路径写回卡面，属 provider（skills/task-ops/lib/task.mjs）
 * 职责；本脚本不改 provider，故取「子卡降级提示」一档。判据为 review_of/target 自身字段，不解析键字符串。
 *
 * **hints 的消费方（T-20261010-081140 裁定）**：`hints` 为**仅供人工**的提示（CLI stderr / 人工巡检），
 * **不接入任何自动化告警消费**——`patrol-scan`、月报等一律**不得**以 hints 为告警源或阻断依据。理由：hints
 * 的定义即「机械键无区分信号」的兄弟卡常态；一旦接入告警/阻断，等于回归 064006-2 已消除的误报。主闸始终是
 * LLM 语义判重，机械键只对 duplicates 兜底。未来若确需观测，仅可为**信息性计数**（不报警、不阻断），且须另立卡。
 *
 * **非空 target 的兄弟卡（同裁定）**：**不降级，维持 duplicates（红）**。同一 idem 键 ⇒ 同一 target 字符串；
 * 非空且相同的 target 本身即「同人同目标」的真实区分信号 ⇒ 命中即真重复倾向，应报警交人工/LLM。仅当组内**全部**
 * 卡 target 空且 review_of 空（纯 parent 派键、零区分信号）时才降 hints（见上「判重路由」）。
 *
 * 基线豁免（**机制保留、当前空/退役**）：`scripts/idem-baseline.json` 现为 `{ "groups": [] }`
 * （外加说明性 `retired:true` / `note`；`loadBaseline` 只读 `groups`，多余键不入判据）。
 * 机制：判据 = `key` 相同 **且** `ids` 排序后与该组卡 id 集合**完全一致** ⇒ 移入 `exempt`（不判红）；
 * 集合一旦变化（增卡/删卡/换卡）即**豁免失效**，重新报警（防「登记一次、永久放行」）。
 * 豁免仅对 duplicates（真重复档）生效；hints 本身已非阻断，无需登记。
 * 新增豁免须人工核对后追加；`--no-baseline` 可忽略基线（全部按 duplicates）。
 *
 * **部署 / provider 断言耦合（T-20261014-123216）**：本文件随 `install.sh` §1 的 `deploy_file` 部署到
 * 实例（默认 upgrade ⇒ **仓内副本覆盖实例副本**）⇒ 仓内副本是唯一权威；直接手改实例副本会在下次部署
 * 被覆盖，且在覆盖**之前**就会让 provider 契约测试 `skills/task-ops/tests/idem.test.mjs:483`
 * （断言本文件 `groups` 为空 = 退役态）失败 ⇒ check-all 慢段 fail-closed 转红。故登记豁免必须与该校验
 * **成对**落地（provider 侧由 task-ops 归属方改），否则慢段红会随每次登记复现。
 *
 * 退出码：0 无非豁免重复（含仅有 hints）；1 有非豁免 duplicates（报警）。
 * 隔离：OPENCLAW_TEAM_ROOT 覆盖（与 team-paths.mjs 同源），便于单测用 mkdtemp。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseFrontmatter, TASKS_DIR, TASK_OPS_DIR } from './lib.mjs';

// provider 依赖显式化（方案②启动期硬失败）：idemKey/NON_TERMINAL 来自 provider ACL 库
// skills/task-ops/lib/task.mjs（provider 拥有、有意不随仓）。缺失 ⇒ 明确错误 + 非零退出。
// 注：lib.mjs 已对 team-paths/projects 做启动硬失败；此处补齐 task.mjs（同族文件）的显式化。
const TASK_MJS = path.join(TASK_OPS_DIR, 'lib', 'task.mjs');
if (!fs.existsSync(TASK_MJS)) {
  console.error(
    `provider 未安装：check-idem 依赖 provider ACL 库，缺失 skills/task-ops/lib/task.mjs` +
    `（查找于 ${TASK_MJS}）。请安装 meerkat-taskpanel 或其它基座，或设 OPENCLAW_TASK_OPS_DIR。`
  );
  process.exit(1);
}
const { idemKey, NON_TERMINAL } = await import(pathToFileURL(TASK_MJS).href);

export const BASELINE_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'idem-baseline.json');

/** 兄弟卡降级理由（hints 的 reason 文案，单测/复核按此核对口径） */
export const SIBLING_HINT_REASON = '同 parent 兄弟卡（review_of/target 均空）⇒ 机械键无区分信息，降级为非阻断提示';

/** 读基线文件：缺失/损坏/形状不对 ⇒ 视为空组列表（**不报错**，退化为全量判红）。 */
export function loadBaseline(file = BASELINE_PATH) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(raw && raw.groups) ? raw.groups : [];
  } catch { return []; }
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
      if (!NON_TERMINAL.has(fm.status)) continue;
      const key = idemKey({ ...fm, id });
      if (!key) continue; // 无 source ⇒ 不产键，跳过（不参与机械判重）
      if (!groups.has(key)) groups.set(key, { cards: [], genuine: false });
      const g = groups.get(key);
      g.cards.push({ id, status: fm.status, assignee: fm.assignee || '', title: fm.title || '' });
      // 区分信号：显式复核同一卡（review_of）或同人同目标（target）⇒ 键有实义；二者全空 ⇒ 兄弟卡弱信号
      if (str(fm.review_of) || str(fm.target)) g.genuine = true;
    }
  }
  const base = baseline === undefined
    ? loadBaseline()
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
      for (const g of r.duplicates) {
        console.error(`  · ${g.idem}`);
        for (const c of g.cards) console.error(`      ${c.id} [${c.status}] ${c.title}`);
      }
    }
    if (r.hints.length) {
      console.error(`建卡幂等提示：${r.hints.length} 组同 parent 兄弟卡（review_of/target 均空）—— 机械键无区分信息，非阻断、不置退出码（需区分请补 target 或经 LLM 语义判重）`);
      for (const g of r.hints) {
        console.error(`  · hint ${g.idem}`);
        for (const c of g.cards) console.error(`      ${c.id} [${c.status}] ${c.title}`);
      }
    }
    if (r.exempt.length) {
      console.error(`建卡幂等基线豁免：${r.exempt.length} 组（exempt）—— 既存良性组，登记于 scripts/idem-baseline.json；集合变化即失效`);
      for (const g of r.exempt) {
        console.error(`  · exempt ${g.key}${g.reason ? `（${g.reason}）` : ''}`);
        for (const c of g.cards) console.error(`      ${c.id} [${c.status}] ${c.title}`);
      }
    }
    if (r.duplicates.length) process.exitCode = 1; // 置退出码而非 process.exit：管道 stdout 不截断（调用方需解析 JSON）
  }
} catch { /* realpath 失败 ⇒ 不执行 main */ }
