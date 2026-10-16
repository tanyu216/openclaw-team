/**
 * card-ids.mjs — 卡身份识别与看板枚举（**provider 无关**）。
 *
 * 问题：本仓自称 provider-agnostic（`guides/task-interface.md` 把卡 schema 与承载形态归给
 * task provider），却把**当前基座的卡文件名形状** `T-YYYYMMDD-HHMMSS` 写成了解析规则
 * （`lib.mjs#CARD_ID_RE`）。卡 id 及其存储形态属于 provider；team 侧只该做两件事：
 *   ① **结构性识别** —— 「`<tasksDir>` 下带 frontmatter `id` 的 `.md` 就是一张卡」；
 *   ② **显式路径安全** —— 「id 是单一路径段」这类安全性质，与命名规则无关。
 *
 * 本模块提供 ①；② 在 `lib.mjs#cardPathOf`。
 *
 * 为什么单独一个模块而不是塞进 `lib.mjs`：`lib.mjs` 顶部 import provider 的 `team-paths.mjs`，
 * **缺失即硬失败**；而本模块的消费方（poll / check-sessions / samefile-guard /
 * check-epic-completeness）本来就都在 provider 语境里，所以沿用同一前提，但把「枚举」这件事
 * 收成一处，免得 5 个脚本各写一遍、下次再分叉。依赖是**单向**的（本模块 → `lib.mjs`）；
 * `lib.mjs` **不**反向再导出本模块，否则成环。
 *
 * 已知边界（**本模块刻意不解决**，见 `T-...` 卡的 Report）：
 *   · 文件基座模型仍在 —— 平铺 `<tasksDir>/*.md`、`basename` 当锁键、`fs.readdir` 枚举；
 *   · ACL 没有「返回 path 的全量枚举」命令（`task.query` 只给 id/status/title，
 *     `task.pollCandidates` 只给候选），且 ACL 自身也形状耦合 ⇒ 真 provider-agnostic 需要
 *     provider 侧新增命令，属另一张卡。
 */
import fs from 'node:fs';
import path from 'node:path';
import { TASKS_DIR, parseFrontmatter } from './lib.mjs';

/** 卡文件的扩展名（文件基座的承载形态 —— 不是命名规则）。 */
const CARD_EXT = '.md';

/**
 * 枚举看板上的卡：`<tasksDir>` 下**带 frontmatter `id`** 的 `.md`。
 *
 * 与 `check-relations` / `patrol-scan` / `sla-scan` / `report-census` 等 10 处既有实现同一口径
 * （`.md` 过滤 + `fm.id || basename`），本函数是那套口径的**单一出处**。
 * 跳过点文件（`.idem-baseline.json` 之类不以 `.md` 结尾，本就被扩展名挡掉；点号**开头的 `.md`**
 * 是临时/scratch 文件，跳过 —— `endsWith('.md')` 挡不住它）。
 *
 * @param {{tasksDir?:string}} [opts]
 * @returns {Array<{id:string,cardPath:string,fm:object,body:string,raw:string}>}
 */
export function readBoardCards({ tasksDir = TASKS_DIR } = {}) {
  let names;
  try { names = fs.readdirSync(tasksDir); } catch { return []; }
  const out = [];
  for (const name of names) {
    if (!name.endsWith(CARD_EXT) || name.startsWith('.')) continue;
    const cardPath = path.join(tasksDir, name);
    let raw;
    try { if (!fs.statSync(cardPath).isFile()) continue; raw = fs.readFileSync(cardPath, 'utf8'); } catch { continue; }
    let parsed;
    try { parsed = parseFrontmatter(raw); } catch { continue; }
    const fm = parsed.fm || {};
    const id = String(fm.id || '').trim();
    if (!id) continue;                       // 结构性判据：没有 id 就不是卡（而非名字长得像）
    out.push({ id, cardPath, fm, body: parsed.body, raw });
  }
  return out;
}

/** 看板上全部卡 id（`readBoardCards` 的投影）。 */
export function listCardIds(opts = {}) {
  return new Set(readBoardCards(opts).map((c) => c.id));
}

/** 从一组 id 推出「命名空间」前缀（`T-20261012-171026` → `T-`）；无分隔符的 id 返回 ''。 */
function namespaceOf(id) {
  const m = /^([A-Za-z]+-)/.exec(String(id));
  return m ? m[1] : '';
}

/**
 * 看板**派生的**命名空间集合 —— 不是仓内自撰的规则，而是从看板上真实存在的 id 归纳出来的。
 *
 * 为什么需要它：台账/报告里的引用要能识别**不存在**的卡（否则「引用了不存在的卡」这一类
 * `ledger_dangling` 永远抓不到 —— 按定义它就不在成员集里）。所以判据是
 * 「**形状像某个已知命名空间的 id**」，而命名空间来自数据本身。
 *
 * 边界：对 id 不含分隔符的 provider 会退化为「精确成员判定」（此时识别不了不存在的卡）。
 * 精确解是 provider 侧声明卡 id 形态（另开卡），届时本函数被替换。
 */
export function boardNamespaces({ ids } = {}) {
  const set = ids instanceof Set ? ids : listCardIds();
  const ns = new Set();
  for (const id of set) { const n = namespaceOf(id); if (n) ns.add(n); }
  return ns;
}

/** 该 token 是否「像一张卡」：精确命中看板，或形如某个看板派生命名空间下的 id。 */
export function isCardId(value, { ids, allowAbsent = true } = {}) {
  const t = String(value ?? '').trim();
  if (!t) return false;
  const set = ids instanceof Set ? ids : listCardIds();
  if (set.has(t)) return true;
  if (!allowAbsent) return false;
  const ns = namespaceOf(t);
  if (!ns) return false;
  return boardNamespaces({ ids: set }).has(ns);
}

/**
 * 从自由文本里抽出卡引用（台账单元格、Report 槽位、散文）。
 *
 * 保序去重。**只**认「像卡」的 token —— 判据同 `isCardId`（含 allowAbsent），
 * 所以「引用了不存在的卡」能被识别出来并交给调用方判红。
 *
 * @param {string} text
 * @param {{ids?:Set<string>, namespaces?:Set<string>}} [opts] `namespaces` 优先（调用方已从自己的
 *   看板视图算好时直接传，避免重复枚举）；缺省由 `ids`（或本进程看板）派生。
 * @returns {string[]}
 */
export function extractCardIdRefs(text, { ids, namespaces } = {}) {
  const set = ids instanceof Set ? ids : (namespaces ? null : listCardIds());
  const ns = namespaces instanceof Set ? namespaces : boardNamespaces({ ids: set });
  if (!ns || ns.size === 0) return [];
  const out = [];
  const seen = new Set();
  // 卡 id 出现在散文里时，两侧常是标点/空白/反引号；按「非 id 字符」切词。
  for (const tok of String(text).split(/[\s`"'(),;|·、，。：:]+/)) {
    const t = tok.replace(/^[（(【\[<]+|[）)】\]>.,;:]+$/g, '');
    if (!t || seen.has(t)) continue;
    const n = namespaceOf(t);
    if (!n || !ns.has(n)) continue;
    // 命名空间命中后，还要求「体像 id」：至少含一个数字（`T-`、`PROJ-` 后必须有内容），
    // 否则 `T-` 本身、`PROJ-foo` 这类词会被误当卡。
    if (!/\d/.test(t.slice(n.length))) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}
