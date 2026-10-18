#!/usr/bin/env node
/**
 * sync-shared-rules.mjs — owner-AGENTS-as-source 的同步器。
 *
 * 输入：每个角色 AGENTS.md 的 `## Shared rules (owner)` 标记块。
 * 输出：
 *   · 每个角色 AGENTS.md 的 `## Shared rules (generated)`（按 carriers 生成的字节一致副本）
 *   · team/SHARED-RULES.md（元数据索引，无正文）
 *   · team/guides/rule-id-registry.json（append-only ID 登记）
 *
 * 规则：owner 块由人写；generated 块永不手改；sync 只改 generated 段。
 *
 * 用法：
 *   node team/scripts/sync-shared-rules.mjs [--repo <R> | --live] [--dry-run] [--json]
 */
import fs from 'node:fs';
import path from 'node:path';
import { resolveMode, UsageError } from './host-paths.mjs';
import {
  ROLES, RULE_ID_RE, BlockError,
  parseRuleBlocks, renderCarrierBlock,
  replaceGeneratedSection, renderIndex, readJson, writeJson,
  roleAgentsPath, resolveDetailPath, sortRules, normalizeOwnerBlock,
} from './lib/agent-doc-blocks.mjs';

function readText(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch (e) {
    throw new Error(`不可读：${p}（${e && e.message ? e.message : e}）`);
  }
}

function writeTextIfChanged(p, text, dry) {
  let old = null;
  try { old = fs.readFileSync(p, 'utf8'); } catch { /* missing */ }
  if (old === text) return false;
  if (!dry) {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text);
  }
  return true;
}


function registryPath(mode) {
  return mode.mode === 'repo'
    ? path.join(mode.repo, 'team', 'guides', 'rule-id-registry.json')
    : path.join(mode.team, 'guides', 'rule-id-registry.json');
}

function indexPath(mode) {
  return mode.mode === 'repo' ? path.join(mode.repo, 'team', 'SHARED-RULES.md') : path.join(mode.team, 'SHARED-RULES.md');
}

function parseArgs(argv) {
  const out = { dry: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') out.dry = true;
    else if (a === '--json') out.json = true;
    else if (a === '--repo') { i++; /* value consumed by resolveMode */ }
    else if (a.startsWith('--repo=') || a === '--live') { /* consumed by resolveMode */ }
    else if (!a.startsWith('--')) throw new UsageError(`未知参数：${a}`);
  }
  return out;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const mode = resolveMode({ argv: process.argv.slice(2), scriptUrl: import.meta.url });
  const files = ROLES.map((role) => ({ role, path: roleAgentsPath(role, mode), text: readText(roleAgentsPath(role, mode)) }));

  const ownerRules = new Map();
  for (const f of files) {
    let blocks;
    try { blocks = parseRuleBlocks(f.text); } catch (e) {
      if (e instanceof BlockError) { console.error(`✗ ${f.path}: ${e.message}`); process.exit(2); }
      throw e;
    }
    for (const b of blocks) {
      if (b.kind !== 'owner') continue;
      if (ownerRules.has(b.id)) {
        console.error(`✗ 规则 ${b.id} 有多个 owner 块（${ownerRules.get(b.id).file} 与 ${f.path}）`);
        process.exit(2);
      }
      let rule;
      try { rule = normalizeOwnerBlock(f.role, b); } catch (e) { console.error(`✗ ${e.message}`); process.exit(2); }
      rule.file = f.path;
      ownerRules.set(b.id, rule);
    }
  }

  const rules = sortRules([...ownerRules.values()]);
  for (const r of rules) {
    if (r.canonical === 'guide') {
      const p = resolveDetailPath(r.detail, mode);
      if (!p || !fs.existsSync(p)) {
        console.error(`✗ ${r.id}: canonical=guide 的 detail 不可解析：${r.detail}`);
        process.exit(2);
      }
    }
  }

  // carrier 生成：owner 不给自己生成副本
  const carrierMap = new Map(ROLES.map((r) => [r, []]));
  for (const r of rules) {
    if (r.status !== 'active') continue;
    for (const c of r.carriers) {
      if (c !== r.owner) carrierMap.get(c).push(r);
    }
  }

  let changed = 0;
  let carrierBlocks = 0;
  for (const f of files) {
    const blocks = sortRules(carrierMap.get(f.role)).map(renderCarrierBlock);
    carrierBlocks += blocks.length;
    const next = replaceGeneratedSection(f.text, blocks);
    if (writeTextIfChanged(f.path, next, opts.dry)) {
      changed++;
      if (!opts.json) console.log(`  ${opts.dry ? 'would update' : 'updated'} ${f.path} (${blocks.length} carrier blocks)`);
    }
  }

  // registry：append-only；active 规则不得从 owner 块消失。
  const rpath = registryPath(mode);
  const oldReg = readJson(rpath, { version: 1, rules: {} });
  const reg = { version: 1, rules: { ...(oldReg.rules || {}) } };
  const today = new Date().toISOString().slice(0, 10);
  for (const r of rules) {
    const prev = reg.rules[r.id];
    if (prev && prev.status === 'retired' && r.status === 'active') {
      console.error(`✗ 规则 ID ${r.id} 已 retired，不得复用`);
      process.exit(2);
    }
    reg.rules[r.id] = prev
      ? { ...prev, status: r.status, owner: r.owner }
      : { status: r.status, firstSeen: today, owner: r.owner };
  }
  for (const id of Object.keys(reg.rules)) {
    const prev = reg.rules[id];
    if (prev.status === 'active' && !ownerRules.has(id)) {
      console.error(`✗ registry 中的 active 规则 ${id} 已从 owner 块消失（退役请改 status=retired，不要删除块）`);
      process.exit(2);
    }
  }
  if (writeTextIfChanged(rpath, `${JSON.stringify(reg, null, 2)}\n`, opts.dry)) changed++;

  const index = renderIndex(rules);
  if (writeTextIfChanged(indexPath(mode), index, opts.dry)) changed++;

  if (opts.json) {
    console.log(JSON.stringify({
      ok: true, mode: mode.mode, dryRun: opts.dry,
      roles: files.length, rules: rules.length, carrierBlocks, changed,
      index: indexPath(mode), registry: rpath,
    }));
  } else {
    console.log(`${opts.dry ? 'dry-run: ' : ''}synced ${files.length} roles; ${rules.length} rules; ${carrierBlocks} carrier blocks; ${changed} file(s) changed`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try { main(); } catch (e) {
    if (e instanceof UsageError) { console.error(`✗ ${e.message}`); process.exit(2); }
    console.error(`✗ ${e && e.message ? e.message : e}`);
    process.exit(1);
  }
}
