#!/usr/bin/env node
/**
 * lint-doc-refs.mjs — 文档路径引用可解析（「方法库指针断了没人知道」的防复发门）。
 *
 * 为什么存在：`lint-refs.mjs` 只校验 `§①…§⑳` **编号**引用；而本仓另一类断引用是
 * **文件/目录路径**引用 —— 例如某角色 AGENTS.md 指向一个从未建立的方法库目录。
 * 历史实证（2026-10-16 侦察，三簇）：`PROTOCOL §⑥.1 #7/#8` 指向 `workspace-linus/skills/`
 * 的四个不存在的文件、`roles/turing/AGENTS.md` 指向从未存在的 `roles/turing/guides/`。
 * 这类断引用零成本复发、且没有任何门禁看得见 —— 本脚本是那道门。
 *
 * 设计取向：**宁可漏报，绝不误报**。一段散文里的“路径样 token”绝大多数不是路径引用
 * （`.md`（扩展名散文）、`providers.json`（裸文件名）、`workspace/T-…/x.md`（实例运行时）、
 * `skills/task-ops/…`（provider 侧，**有意不随仓**）。实测：松散规则下 466 条“断引用”里
 * 真问题只有 5 条。故本脚本**只检查有明确解析基座**的路径，其余一律不判（记入 skipped 计数）。
 *
 * 解析基座（按序，命中即通过）：
 *   1. 引用所在文件所在目录            —— `../AUTOMATIONS.md` 这类
 *   2. 该文件所属**层根**              —— repo: `<repo>/team` 或 `<repo>/roles/<role>`；
 *                                        live: `<team>` 或 `<home>/workspace-<role>`
 *                                        （`guides/x.md` 在角色 AGENTS.md 里指角色自己的 guides/）
 *   3. 扫描根                          —— repo: `<repo>`；live: `<home>`
 *
 * 不判（skip，附计数，绝不因此判红）：
 *   · URL / `^~` / `^/`（宿主·实例·绝对路径；repo 模式下不可判定）
 *   · 含 `< > { } * ? … $` 的占位/通配/变量
 *   · **basename 以 `.` 开头** —— 扩展名散文（`.md`）、运行时与本地点文件
 *     （`.claude/settings.json`、`.ui-align.json`、`.sla-scan-state.json`）
 *   · 首段不是已知仓内根的（`src/`、`tasks/`、`workspace/`、`plugins/` … ⇒ provider/运行时/外部）
 *   · `skills/**` —— 技能正文**有意不随仓**（`skills/PROVENANCE.md`），provider 拥有
 *   · ALLOW 表逐条登记的例外
 *
 * **第二腿 —— 跨文件章节锚（`<name>.md §N` / `§N.M`）**：同一类断引用还有一半藏在这里。
 * 规范来源：**`PROTOCOL §⑥.1` clause 11**（文档引用约定）—— 该条同时规定「章节内条目/步骤」
 * 的记法（`§N clause M` / `§N step M`），即本腿守的那条；改口径先改它。
 * `lint-refs.mjs` 只校验 `§①…§⑳` **编号**引用（且仅对 `PROTOCOL.md`），而**数字**形式
 * 的跨文件锚（`guides/task-interface.md §6.3`）此前无人校验 —— 实测三簇（2026-10-16）：
 * `PROTOCOL.md`→`task-interface.md §6.3`、`README.md` 两处→`spawn-lane-sop.md §3.3`，
 * 三条都是把「§N 里的第 M 条/步」写成了「子标题」记法（`§6.3` 在别的文件里**真是**子标题，
 * 例如 `sla-inspection-contract.md §6.3`），于是既断又不像断。
 * 判定：token 先按**与路径腿相同的基座**解析到具体文件；命中才查该文件有无对应的
 * `## N` / `### N.M` 标题（`§N` 视为「`N` 或任何 `N.*` 子标题」，即"这一节及其子节"）。
 * 解析不到文件 ⇒ 不判（那是路径腿的职责，此处不重复报）；目标无编号标题 ⇒ 不判。
 * **只做跨文件**：文件内 `§N`（如 `dependency-cve-gate.md` 里 "see §3.3" 指自己）编号可能
 * 有意变动，风险高，留待记法约定落地后再谈。
 *
 * 模式：`host-paths.mjs#resolveMode`（repo = 仓内自证，无需实例；live = 巡检安装实例）。
 * 退出码：0 全解析；1 有断引用；2 用法错或模式不可判定。
 * 用法：node lint-doc-refs.mjs [--repo <R> | --live]
 */
import fs from 'node:fs';
import path from 'node:path';
import { resolveMode, UsageError, ROLES } from './host-paths.mjs';

// ── 引用提取 ────────────────────────────────────────────────────────────────

/** 视为「文件路径候选」的扩展名（与 `lint-refs.mjs` 的 fence 处理保持一致）。 */
const EXT = /\.(md|mjs|sh|json|json5|yml|yaml)$/;

/** 只从这两种载体取引用：反引号片段、markdown 链接目标。散文里的裸路径**不取**（误报源）。 */
const CARRIERS = [/`([^`\n]+)`/g, /\[[^\]]*\]\(([^)\n]+)\)/g];

/** 仓内顶层目录（repo 模式）。首段命中者才可能被检查。 */
const REPO_BASES = ['team', 'roles', 'tools', 'config', 'docker', 'test'];
/** 仓内文档的简写约定：这些首段省略了「层根」前缀。 */
const CONVENTIONAL = ['guides', 'scripts', 'automations', 'tests'];
/** 有意不随仓 ⇒ 永不判红（技能正文由 provider 拥有）。 */
const EXTERNAL_PREFIXES = ['skills'];
/** 逐条登记的例外：键 = `<扫描根内相对路径>:<token>`，值 = 理由。 */
const ALLOW = {
  'team/guides/worktree-isolation-sop.md:scripts/verify/contract.mjs':
    '事故证据行引用的是**容器内**另一个项目的路径（`T-20261010-061638` 的取证明细），非本仓路径',
};

/**
 * 跨文件章节锚的逐条例外：键 = `<扫描根内相对路径>:<token>`，值 = 理由。
 * 只登记「确实指得没错、但不写成标题」的引用；能改引用就别登记。
 */
const SECTION_ALLOW = {};

/**
 * 从一行取「`<name>.md` 后紧跟的 `§N` / `§N.M` / `§N/§M` 列表」。
 * `§` 必须在文件名之后**紧邻**（只隔空白）—— 「见 `a.md`；另见 §3」这类句子里
 * `§3` 指自己所在文件，不取（那正是本腿有意不做的文件内一类）。
 */
export function extractSectionRefs(line) {
  const out = [];
  const re = /`?([A-Za-z0-9][\w./-]*\.md)`?[ \t]*(§[ \t]*\d+(?:\.\d+)*(?:[ \t]*\/[ \t]*§?[ \t]*\d+(?:\.\d+)*)*)/g;
  let m;
  while ((m = re.exec(line))) {
    const nums = m[2].split('/').map((s) => s.replace(/[§\s]/g, '')).filter(Boolean);
    if (nums.length) out.push({ file: m[1], nums });
  }
  return out;
}

/**
 * 一份 markdown 里出现的编号标题（`## 6.` / `### 6.3` / `#### 6.3.1` ⇒ `6` / `6.3` / `6.3.1`）。
 * `§N` 的判定语义是「`N` 这一节**及其子节**」，见 `sectionOk`。
 */
const _sectionsCache = new Map();
function sectionsOf(abs) {
  if (_sectionsCache.has(abs)) return _sectionsCache.get(abs);
  let txt = '';
  try { txt = fs.readFileSync(abs, 'utf8'); } catch { /* 读不到 ⇒ 空集，调用方不判 */ }
  const nums = new Set();
  let fence = false;
  for (const line of txt.split('\n')) {
    if (/^\s*```/.test(line)) { fence = !fence; continue; }
    if (fence) continue;
    const h = line.match(/^#{2,6}\s*(?:§)?(\d+(?:\.\d+)*)/);
    if (h) nums.add(h[1]);
  }
  _sectionsCache.set(abs, nums);
  return nums;
}

/** `§N` 命中：存在编号 `N` 的标题，或任何 `N.*` 子标题（= 这一节及其子节）。 */
function sectionOk(nums, n) {
  for (const x of nums) if (x === n || x.startsWith(`${n}.`)) return true;
  return false;
}

/**
 * 从一行文本取出「像仓内相对路径」的 token。
 * 反引号内容可能是一条命令 ⇒ 按空白切词，只保留含 `/` 且带已知扩展名的词。
 */
export function extractPathRefs(line) {
  const out = [];
  for (const re of CARRIERS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(line))) {
      for (const word of m[1].trim().split(/\s+/)) {
        const t = word.replace(/^[("'<]|["')>,;:]+$/g, '').split('#')[0];
        if (EXT.test(t) && t.includes('/')) out.push(t);
      }
    }
  }
  return out;
}

/** 判定一个 token 是否在检查范围内；不在 ⇒ 返回原因字符串（用于计数，不判红）。 */
export function skipReason(token) {
  if (/^https?:|^mailto:/.test(token)) return 'url';
  if (/^~|^\//.test(token)) return 'host-path';
  if (/[<>{}*?…$]/.test(token)) return 'placeholder';
  // 任一路径段以 `.` 开头 ⇒ 扩展名散文（`.md`）或运行时/本地点文件（`.claude/settings.json`）。
  // 前导的 `./` / `../` 是相对导航前缀，先剥掉再判。
  const cleaned = token.replace(/^(?:\.\.?\/)+/, '');
  if (cleaned.split('/').some((s) => s.startsWith('.'))) return 'dotfile-or-extension';
  const head = cleaned.split('/')[0];
  if (EXTERNAL_PREFIXES.includes(head)) return 'not-vendored';
  if (token.startsWith('.')) return '';                       // ./ ../ 相对引用 —— 检查
  if (CONVENTIONAL.includes(head)) return '';                 // guides/ tests/ … —— 检查
  if (REPO_BASES.includes(head)) return '';                   // team/ roles/ … —— 检查
  return 'external';
}

/** 按扫描根计算某文件的解析基座（按序尝试）。 */
export function basesFor(file, M) {
  const roots = M.mode === 'repo'
    ? { scan: M.repo, team: path.join(M.repo, 'team'), role: (r) => path.join(M.repo, 'roles', r) }
    : { scan: M.home, team: M.team, role: (r) => path.join(M.home, `workspace-${r}`) };
  const dir = path.dirname(file);
  const rel = path.relative(roots.scan, file);
  const seg = rel.split(path.sep);
  let roleLayer = '';
  if (M.mode === 'repo') {
    if (seg[0] === 'roles' && ROLES.includes(seg[1])) roleLayer = roots.role(seg[1]);
  } else if (seg[0].startsWith('workspace-') && ROLES.includes(seg[0].slice('workspace-'.length))) {
    roleLayer = path.join(roots.scan, seg[0]);
  }
  // 基座按序：① 同目录（`../AUTOMATIONS.md`）② 角色层根（角色 AGENTS.md 的 `guides/x.md`
  // 指**自己的**方法库）③ team 层根（同一份文档也常指 team 的 guides/；两义并存，故都试）
  // ④ 框架脚本目录（`tests/x.test.mjs` 指 `team/scripts/tests/x`，本仓惯用简写）
  // ⑤ 扫描根（`team/guides/x.md` 这类全路径）。
  return [dir, roleLayer, roots.team, path.join(roots.team, 'scripts'), roots.scan]
    .filter((b) => b && fs.existsSync(b))
    .filter((b, i, a) => a.indexOf(b) === i);
}

// ── 扫描 ────────────────────────────────────────────────────────────────────

function walkMarkdown(dir, out = [], depth = 0) {
  if (depth > 8) return out;
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkMarkdown(p, out, depth + 1);
    else if (e.name.endsWith('.md')) out.push(p);
  }
  return out;
}

/** 扫描面：repo = `<repo>/team` + `<repo>/roles`；live = `<team>` + `<home>/workspace-<role>`。 */
function targets(M) {
  const roots = M.mode === 'repo'
    ? [path.join(M.repo, 'team'), path.join(M.repo, 'roles')]
    : [M.team, ...ROLES.map((r) => path.join(M.home, `workspace-${r}`))];
  return roots.flatMap((r) => (fs.existsSync(r) ? walkMarkdown(r) : []));
}

export function lintDocRefs(M) {
  const bad = [];
  const skipped = {};
  let checked = 0;
  let sectionChecked = 0;
  for (const f of targets(M)) {
    const key = path.relative(M.mode === 'repo' ? M.repo : M.home, f);
    const keyPosix = key.split(path.sep).join('/');
    const bases = basesFor(f, M);
    const lines = fs.readFileSync(f, 'utf8').split('\n');
    let fence = false;
    lines.forEach((line, i) => {
      if (/^\s*```/.test(line)) { fence = !fence; return; }
      if (fence) return;

      // ── 第二腿：跨文件章节锚 ──
      for (const { file: tgt, nums } of extractSectionRefs(line)) {
        const refWhy = skipReason(tgt);
        if (refWhy) { skipped[`secref-${refWhy}`] = (skipped[`secref-${refWhy}`] || 0) + 1; continue; }
        const abs = bases.map((b) => path.resolve(b, tgt)).find((p) => fs.existsSync(p));
        if (!abs || !abs.endsWith('.md')) continue;   // 解析不到 ⇒ 路径腿的职责，不重复报
        const secs = sectionsOf(abs);
        if (!secs.size) continue;                     // 目标无编号标题 ⇒ 不可判定，不判
        for (const n of nums) {
          if (SECTION_ALLOW[`${keyPosix}:${tgt} §${n}`]) continue;
          sectionChecked++;
          if (sectionOk(secs, n)) continue;
          bad.push({ file: key, line: i + 1, token: `${tgt} §${n}` });
        }
      }

      for (const t of extractPathRefs(line)) {
        // `~/…` 宿主/实例路径：repo 模式不可判定（记 skip）；**live 模式对真实 home 判定** ——
        // 这是唯一能抓住「引用实例上并不存在的方法库」（历史上 `workspace-linus/skills/plan-toolkit`）的腿。
        if (t.startsWith('~/')) {
          if (M.mode !== 'live') { skipped['host-path'] = (skipped['host-path'] || 0) + 1; continue; }
          checked++;
          if (fs.existsSync(path.join(M.home, t.slice(2)))) continue;
          bad.push({ file: key, line: i + 1, token: t });
          continue;
        }
        const why = skipReason(t);
        if (why) { skipped[why] = (skipped[why] || 0) + 1; continue; }
        if (ALLOW[`${key.split(path.sep).join('/')}:${t}`]) continue;
        checked++;
        if (bases.some((b) => fs.existsSync(path.resolve(b, t)))) continue;
        bad.push({ file: key, line: i + 1, token: t });
      }
    });
  }
  return { bad, skipped, checked, sectionChecked };
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function main() {
  let M;
  try { M = resolveMode(); } catch (e) {
    if (e instanceof UsageError) { console.error(`✗ ${e.message}`); process.exit(2); }
    throw e;
  }
  const { bad, skipped, checked, sectionChecked } = lintDocRefs(M);
  const where = (p) => String(p).replace(M.home, '~').replace(M.repo || '\u0000', '<repo>');
  for (const { file, line, token } of bad) {
    console.log(`✗ ${where(file)}:${line} 断引用 ${token}`);
  }
  const skips = Object.entries(skipped).map(([k, v]) => `${k}:${v}`).join(' ');
  const counts = `已检查 ${checked} 路径 + ${sectionChecked} 章节锚`;
  if (bad.length) {
    console.log(`\n断引用：${bad.length}（${counts}；未判 ${skips}）`);
    process.exit(1);
  }
  console.log(`文档引用全部可解析 ✔（${counts}；未判 ${skips}）`);
  process.exit(0);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
