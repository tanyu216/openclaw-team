#!/usr/bin/env node
/**
 * doc-clause-diff.mjs — 文档改写的「零条款丢失」A/B 比对器。
 *
 * 为什么存在：本仓的文档层（`team/guides/` 与各角色 `AGENTS.md`）体量巨大且逐条累积，
 * 压缩表达时**唯一无法机检的风险是悄悄丢掉一条条款**。散文改写后句子必然不同 ⇒ 逐句比对
 * 会 100% 误报、毫无用处；本工具改为比对**规范性原子**（机器码、标识符、编号引用、阈值），
 * 它们在改写中应当**只换位置不消失**。原子消失即须逐条登记理由（`clause-allowlist.json`）。
 *
 * 设计取向（沿用 `team/scripts/lint-doc-refs.mjs` 的先例）：**宁可漏报，绝不误报** ——
 * 一个满屏假红的门会被立刻关掉，等于没有。故只取四类**高信噪比**原子：
 *   · `codes`   snake_case 机器码 / 字段名 / 拒绝码（`base_unresolved`、`review_of`、`not_met` …）
 *   · `tokens`  反引号内的标识符（`task.claim`、`OPENCLAW_TEAM_ROOT`、`spawn-lane.mjs` …）
 *   · `refs`    `§` 编号引用（`§⑮`、`§6.3` …）
 *   · `numbers` 带单位的阈值 / 量级（`64 KiB`、`14 days`、`6000 ms`、`×1.5` …）
 * 标题另作 `headings` 一轴**只报告不判红**（去重改名是预期行为，不是丢条款）。
 *
 * 判定：对每个文件取 `<base>:<path>` 与**工作树**两版，断言 `after ⊇ before`。
 * 缺失项须逐条进 allowlist（支持 `file:axis:atom` 精确登记与 `file.axis` 整轴登记 + 理由）。
 * 未被登记的缺失 ⇒ 退出 1。
 *
 * **已知盲区（本工具不覆盖，必须由独立逐条复核补上）**：
 *   · **整句删除而 token 在别处仍存在** —— 原子是词法级的，比对的是"这个词还在不在"，
 *     不是"这句话还在不在"。删掉一整条 `must not …` 而其中的名词/标识符在别处出现过，
 *     本工具**看不到**。这是它最大的一类假阴性。
 *   · **规范性动词本身不是原子** —— `must not` / `禁止` / `不得` 不进四轴；语气被削弱
 *     （"must" → "should"）不会被抓到。
 *   · 中文散文里的条款同样只按其中出现的 snake_case / 反引号 token 判定。
 *   故本工具是**必要条件不是充分条件**：它绿不等于没丢条款，它红则几乎一定丢了。
 *   配套的充分条件是改后由**另一条独立通道**对照 base 逐条核验。
 *
 * 用法：
 *   node test/docs/doc-clause-diff.mjs [--base <ref>] [--path <p> ...] [--json] [--quiet]
 * 退出码：0 无未登记缺失；1 有；2 用法错（如 base ref 不可解析）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const ALLOWLIST_PATH = path.join(HERE, 'clause-allowlist.json');

/** 参与「零丢失」判定的轴。 */
const AXES = ['codes', 'tokens', 'refs', 'numbers'];
/** 只报告不判红的轴。 */
const SOFT_AXES = ['headings'];

const FENCE = /^\s*```/;

// ── 原子抽取 ────────────────────────────────────────────────────────────────

/**
 * 从一段 markdown 抽取各轴原子（集合语义 —— 同文出现 N 次只算 1 个）。
 * 围栏**不跳过**：契约里的 JSON 骨架字段名（`first_seen` …）本身就是被钉死的条款；
 * 只有标题轴跳过围栏（避免把 shell 注释 `# …` 读成标题）。
 */
export function extractAtoms(text) {
  const out = { codes: new Set(), tokens: new Set(), refs: new Set(), numbers: new Set(), headings: new Set() };
  let fence = false;
  for (const line of text.split('\n')) {
    if (FENCE.test(line)) { fence = !fence; continue; }
    if (!fence) {
      const h = line.match(/^#{1,6}\s+(.*)$/);
      if (h) out.headings.add(h[1].trim());
    }
    for (const m of line.matchAll(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g)) out.codes.add(m[0]);
    for (const m of line.matchAll(/§[①-⑳\d]+(?:\.\d+)?/g)) out.refs.add(m[0]);
    for (const m of line.matchAll(/\d[\d\s]*(?:\.\d+)?\s*(?:KiB|KB|MB|GB|ms|min|hours?|days?|%)/g)) {
      out.numbers.add(m[0].replace(/\s+/g, ''));
    }
    for (const m of line.matchAll(/×\s*\d+(?:\.\d+)?/g)) out.numbers.add(m[0].replace(/\s+/g, ''));
    for (const m of line.matchAll(/`([^`\n]+)`/g)) {
      const t = m[1].trim();
      // 只收「像标识符」的：单一 token、含 `.`/`_`/`-` 或全大写段、长度 ≥3。
      if (!/^[A-Za-z_][A-Za-z0-9_.\-]*$/.test(t) || t.length < 3) continue;
      if (!/[._\-]|[A-Z]{2,}/.test(t)) continue;
      // 纯 snake_case 已由 codes 轴收取 ⇒ 不再重复记入 tokens（两轴保持不相交，报告不重报）。
      if (/^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/.test(t)) continue;
      out.tokens.add(t);
    }
  }
  return out;
}

// ── 文件与版本 ──────────────────────────────────────────────────────────────

function collectMarkdown(targets) {
  const files = [];
  const walk = (p, depth = 0) => {
    if (depth > 8) return;
    let st;
    try { st = fs.statSync(p); } catch { return; }
    if (st.isFile()) { if (p.endsWith('.md')) files.push(p); return; }
    for (const e of fs.readdirSync(p, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      walk(path.join(p, e.name), depth + 1);
    }
  };
  for (const t of targets) walk(path.resolve(REPO, t));
  return files.map((p) => path.relative(REPO, p).split(path.sep).join('/')).sort();
}

/**
 * `<ref>` 下这些目标里的 `.md` 清单（`git ls-tree`）。
 * 必须与工作树取**并集**：一个文件被整个删掉时，它在工作树里已不存在 ⇒ 只走工作树会让
 * 「整份文档消失」变成静默通过，而这是本工具最该抓住的一种丢条款。
 */
function collectMarkdownAt(ref, targets) {
  const out = execFileSync('git', ['-C', REPO, 'ls-tree', '-r', '--name-only', ref, '--', ...targets], {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  return out.split('\n').map((s) => s.trim()).filter((s) => s.endsWith('.md'));
}

/** `git show <ref>:<relPath>` ⇒ 文本；该版不存在该文件 ⇒ null；ref 本身不可解析 ⇒ 抛。 */
function readAt(ref, rel) {
  try {
    return execFileSync('git', ['-C', REPO, 'show', `${ref}:${rel}`], {
      encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    const err = String(e.stderr || '');
    if (/does not exist|exists on disk, but not in|Path .* does not exist|unknown revision|invalid object name/.test(err)) {
      if (/unknown revision|invalid object name|ambiguous argument/.test(err)) {
        const err2 = new Error(`base ref 不可解析：${ref}`);
        err2.usage = true;
        throw err2;
      }
      return null;
    }
    throw e;
  }
}

// ── 比对 ────────────────────────────────────────────────────────────────────

export function loadAllowlist(p = ALLOWLIST_PATH) {
  if (!fs.existsSync(p)) return { files: {}, atoms: {} };
  const j = JSON.parse(fs.readFileSync(p, 'utf8'));
  return { files: j.files || {}, atoms: j.atoms || {} };
}

/**
 * 单文件比对（纯函数，便于单测）：`afterText === null` = 该文件已被删除。
 * 返回 { entry, missingTotal, unaccountedTotal }。
 */
export function compareFile(rel, beforeText, afterText, allow) {
  const A = extractAtoms(beforeText);
  const B = afterText === null ? null : extractAtoms(afterText);
  const entry = { file: rel, deleted: afterText === null, missing: {}, unaccounted: {}, counts: {} };
  let missingTotal = 0;
  let unaccountedTotal = 0;

  for (const axis of [...AXES, ...SOFT_AXES]) {
    const a = A[axis];
    const b = B ? B[axis] : new Set();
    entry.counts[axis] = { before: a.size, after: b.size };
    const missing = [...a].filter((x) => !b.has(x)).sort();
    if (!missing.length) continue;
    entry.missing[axis] = missing;
    if (!AXES.includes(axis)) continue;                                // 软轴只报告
    const un = missing.filter((x) => {
      const wholeAxis = allow.files[rel] && allow.files[rel][axis];
      return !wholeAxis && !allow.atoms[`${rel}:${axis}:${x}`];
    });
    if (un.length) entry.unaccounted[axis] = un;
    missingTotal += missing.length;
    unaccountedTotal += un.length;
  }
  return { entry, missingTotal, unaccountedTotal };
}

export function diffDocs({ base, targets, allow = loadAllowlist() }) {
  const files = [...new Set([...collectMarkdownAt(base, targets), ...collectMarkdown(targets)])].sort();
  const report = { base, files: [], added: [], deleted: [], missingTotal: 0, unaccountedTotal: 0, counts: {} };

  for (const rel of files) {
    const before = readAt(base, rel);
    if (before === null) { report.added.push(rel); continue; }         // base 里没有 ⇒ 新增文件
    const abs = path.join(REPO, rel);
    const after = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
    if (after === null) report.deleted.push(rel);

    const { entry, missingTotal, unaccountedTotal } = compareFile(rel, before, after, allow);
    report.missingTotal += missingTotal;
    report.unaccountedTotal += unaccountedTotal;
    if (Object.keys(entry.missing).length) report.files.push(entry);
  }
  return report;
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function parseArgv(argv) {
  const o = { base: 'dev', targets: [], json: false, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--base') o.base = argv[++i];
    else if (a === '--path') { let v; while ((v = argv[i + 1]) !== undefined && !v.startsWith('--')) { o.targets.push(v); i++; } }
    else if (a === '--json') o.json = true;
    else if (a === '--quiet') o.quiet = true;
    else if (a === '--allowlist') o.allowlist = argv[++i];
    else { const e = new Error(`未知参数：${a}`); e.usage = true; throw e; }
  }
  if (!o.targets.length) o.targets.push('team/guides');
  if (o.base === undefined || o.targets.includes(undefined)) { const e = new Error('--base/--path 缺值'); e.usage = true; throw e; }
  return o;
}

function main() {
  let o;
  try { o = parseArgv(process.argv.slice(2)); } catch (e) { console.error(`✗ ${e.message}`); process.exit(2); }

  let allow;
  try { allow = loadAllowlist(o.allowlist); } catch (e) { console.error(`✗ allowlist 不可读：${e.message}`); process.exit(2); }

  let report;
  try { report = diffDocs({ base: o.base, targets: o.targets, allow }); }
  catch (e) {
    if (e.usage) { console.error(`✗ ${e.message}`); process.exit(2); }
    throw e;
  }

  if (o.json) { console.log(JSON.stringify(report, null, 2)); process.exit(report.unaccountedTotal ? 1 : 0); }

  const axisLabel = { codes: '机器码', tokens: '标识符', refs: '§引用', numbers: '阈值', headings: '标题（只报告）' };
  for (const f of report.files) {
    const head = f.deleted ? `✗ ${f.file}  —— 该文件在工作树中已删除（base 版全部原子视为缺失）` : `· ${f.file}`;
    console.log(head);
    for (const [axis, atoms] of Object.entries(f.missing)) {
      const un = (f.unaccounted && f.unaccounted[axis]) || [];
      const flag = AXES.includes(axis) && un.length ? '✗' : ' ';
      console.log(`  ${flag} ${axisLabel[axis] || axis}：缺失 ${atoms.length}${un.length ? `（未登记 ${un.length}）` : '（已登记）'}`);
      if (!o.quiet) {
        for (const x of atoms.slice(0, 12)) {
          const mark = un.includes(x) ? '✗' : ' ';
          console.log(`      ${mark} ${x}`);
        }
        if (atoms.length > 12) console.log(`      … 另有 ${atoms.length - 12} 条（--json 取全量）`);
      }
    }
  }
  if (report.added.length) console.log(`新增文件（base 中无）：${report.added.length} —— ${report.added.join(', ')}`);
  if (report.deleted.length) console.log(`删除文件（工作树中已无）：${report.deleted.length} —— ${report.deleted.join(', ')}`);

  if (report.unaccountedTotal) {
    console.log(`\n未登记的条款缺失：${report.unaccountedTotal} 条 / ${report.files.length} 个文件（base=${o.base}）`);
    console.log('登记理由请写入 test/docs/clause-allowlist.json（键 `file:axis:atom` 精确登记，或 `files[file][axis]` 整轴登记）。');
    process.exit(1);
  }
  console.log(`\n条款零丢失 ✔（base=${o.base}，${report.files.length} 个文件有缺失、已登记 ${report.missingTotal} 条有意移除）`);
  process.exit(0);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
