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
  for (const f of targets(M)) {
    const key = path.relative(M.mode === 'repo' ? M.repo : M.home, f);
    const bases = basesFor(f, M);
    const lines = fs.readFileSync(f, 'utf8').split('\n');
    let fence = false;
    lines.forEach((line, i) => {
      if (/^\s*```/.test(line)) { fence = !fence; return; }
      if (fence) return;
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
  return { bad, skipped, checked };
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function main() {
  let M;
  try { M = resolveMode(); } catch (e) {
    if (e instanceof UsageError) { console.error(`✗ ${e.message}`); process.exit(2); }
    throw e;
  }
  const { bad, skipped, checked } = lintDocRefs(M);
  const where = (p) => String(p).replace(M.home, '~').replace(M.repo || '\u0000', '<repo>');
  for (const { file, line, token } of bad) {
    console.log(`✗ ${where(file)}:${line} 断引用 ${token}`);
  }
  const skips = Object.entries(skipped).map(([k, v]) => `${k}:${v}`).join(' ');
  if (bad.length) {
    console.log(`\n断引用：${bad.length}（已检查 ${checked} 条；未判 ${skips}）`);
    process.exit(1);
  }
  console.log(`文档路径引用全部可解析 ✔（已检查 ${checked} 条；未判 ${skips}）`);
  process.exit(0);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
