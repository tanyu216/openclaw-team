#!/usr/bin/env node
/**
 * check-shared-rules.mjs — owner-AGENTS-as-source 的反漂移门。
 *
 * 校验：
 *   · 每个 owner 块唯一、owner 与文件角色一致、marker 必填项完整；
 *   · 每个 carrier 块与 owner payload 字节一致，且角色在 carriers 集合内；
 *   · 每个角色的 generated 段恰好包含「它该携带的规则」；
 *   · team/SHARED-RULES.md 与 rule-id-registry.json 与 owner 块一致；
 *   · canonical=guide 的 detail 可解析；canonical=guide 的 owner 块不复制条款列表；
 *   · 块里不出现 PROTOCOL 引用；AGENTS 无 CRLF/BOM；
 *   · redline 块里出现的 R-* 都能解析。
 *
 * 只读。用法：node team/scripts/check-shared-rules.mjs [--repo <R> | --live] [--json]
 */
import fs from 'node:fs';
import path from 'node:path';
import { resolveMode, UsageError } from './host-paths.mjs';
import {
  ROLES, RULE_ID_RE,
  parseRuleBlocks, parseRedlineBlock, expandCarriers, renderIndex,
  roleAgentsPath, resolveDetailPath, sortRules, normalizeOwnerBlock, readJson,
} from './lib/agent-doc-blocks.mjs';

function readText(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch (e) {
    throw new Error(`不可读：${p}（${e && e.message ? e.message : e}）`);
  }
}

function indexAndRegistryPaths(mode) {
  const base = mode.mode === 'repo' ? path.join(mode.repo, 'team') : mode.team;
  return {
    index: path.join(base, 'SHARED-RULES.md'),
    registry: path.join(base, 'guides', 'rule-id-registry.json'),
  };
}

function hasSection(abs, detail) {
  const m = String(detail).match(/^(.*?)\s+§\s*(\d+(?:\.\d+)*)\s*$/);
  if (!m) return true;
  let text;
  try { text = fs.readFileSync(abs, 'utf8'); } catch { return false; }
  const num = m[2].replace(/\./g, '\\.');
  const re = new RegExp(`^#{2,6}\\s*(?:§)?${num}(?:\\.|\\s|$)`);
  return text.split('\n').some((l) => re.test(l));
}

function main() {
  const json = process.argv.includes('--json');
  const mode = resolveMode({ argv: process.argv.slice(2), scriptUrl: import.meta.url });
  const errors = [];
  const parsed = new Map();
  const texts = new Map();

  for (const role of ROLES) {
    const p = roleAgentsPath(role, mode);
    let text;
    try { text = readText(p); } catch (e) { errors.push(e.message); continue; }
    texts.set(role, text);
    if (text.includes('\r')) errors.push(`${p}: 含 CRLF（marker payload 必须 LF）`);
    if (text.charCodeAt(0) === 0xFEFF) errors.push(`${p}: 含 BOM`);
    try { parsed.set(role, parseRuleBlocks(text)); } catch (e) { errors.push(`${p}: ${e.message}`); }
  }

  const ownerRules = new Map();
  for (const [role, blocks] of parsed) {
    for (const b of blocks) {
      if (b.kind !== 'owner') continue;
      if (ownerRules.has(b.id)) {
        errors.push(`规则 ${b.id} 有多个 owner 块（${ownerRules.get(b.id).file} 与 ${roleAgentsPath(role, mode)}）`);
        continue;
      }
      try {
        const rule = normalizeOwnerBlock(role, b);
        rule.file = roleAgentsPath(role, mode);
        ownerRules.set(b.id, rule);
      } catch (e) { errors.push(e.message); }
    }
  }

  const rules = sortRules([...ownerRules.values()]);
  let carrierBlocks = 0;

  // per-role carrier validation
  for (const role of ROLES) {
    const blocks = parsed.get(role) || [];
    const actual = new Set();
    for (const b of blocks) {
      if (b.kind !== 'carrier') continue;
      carrierBlocks++;
      if (actual.has(b.id)) errors.push(`${role}: carrier 块 ${b.id} 重复`);
      actual.add(b.id);
      const owner = ownerRules.get(b.id);
      if (!owner) { errors.push(`${role}: carrier 块 ${b.id} 没有对应 owner 规则`); continue; }
      if (b.meta.generated !== '1') errors.push(`${role}: ${b.id} carrier 块缺少 generated=1`);
      if (b.meta.source !== `owner:${owner.owner}`) errors.push(`${role}: ${b.id} source=${b.meta.source || '-'}，应为 owner:${owner.owner}`);
      if (role === owner.owner) errors.push(`${role}: ${b.id} 的 owner 不应给自己生成 carrier 块`);
      if (!owner.carriers.includes(role)) errors.push(`${role}: 不在 ${b.id} 的 carriers 集合内`);
      if (b.payload !== owner.payload) errors.push(`${role}: ${b.id} carrier payload 与 owner 不一致（字节漂移）`);
    }

    const expected = new Set(rules.filter((r) => r.status === 'active' && r.carriers.includes(role) && r.owner !== role).map((r) => r.id));
    for (const id of expected) if (!actual.has(id)) errors.push(`${role}: 缺少 carrier 块 ${id}`);
    for (const id of actual) if (!expected.has(id)) errors.push(`${role}: 多出 carrier 块 ${id}（carriers 已变更或规则已退役）`);
  }

  // redline digest: identical across roles, IDs resolve
  const redlinePayloads = new Set();
  for (const role of ROLES) {
    const text = texts.get(role);
    if (!text) continue;
    let red;
    try { red = parseRedlineBlock(text); } catch (e) { errors.push(`${role}: ${e.message}`); continue; }
    if (!red) { errors.push(`${role}: 缺少 REDLINES:v1 块`); continue; }
    redlinePayloads.add(red.payload);
    for (const m of red.payload.matchAll(/(?<![A-Za-z0-9-])R-[A-Z][A-Z0-9]*-[0-9]+(?![0-9A-Za-z-])/g)) {
      if (!ownerRules.has(m[0])) errors.push(`${role}: redline 引用未知规则 ${m[0]}`);
    }
  }
  if (redlinePayloads.size > 1) errors.push('REDLINES:v1 块在角色之间不一致');

  // canonical/detail + no PROTOCOL in payload
  for (const r of rules) {
    if (/PROTOCOL(?:\.md|-gates\.md|\s*§)/.test(r.payload)) errors.push(`${r.id}: payload 含 PROTOCOL 引用`);
    if (r.canonical === 'guide') {
      if (/^\d{1,3}\.\s/m.test(r.payload)) errors.push(`${r.id}: canonical=guide 的 owner 块不得复制顶层条款列表`);
      const abs = resolveDetailPath(r.detail, mode);
      if (!abs || !fs.existsSync(abs)) errors.push(`${r.id}: detail 不可解析：${r.detail}`);
      else if (!hasSection(abs, r.detail)) errors.push(`${r.id}: detail 小节不存在：${r.detail}`);
    } else if (r.detail && r.detail !== '-') {
      const abs = resolveDetailPath(r.detail, mode);
      if (!abs || !fs.existsSync(abs)) errors.push(`${r.id}: detail 不可解析：${r.detail}`);
    }
  }

  // generated index + registry
  const { index, registry } = indexAndRegistryPaths(mode);
  const wantIndex = renderIndex(rules);
  let gotIndex = '';
  try { gotIndex = fs.readFileSync(index, 'utf8'); } catch { /* missing */ }
  if (gotIndex !== wantIndex) errors.push(`${index} 与 owner 块不一致（运行 sync-shared-rules）`);

  const gotReg = readJson(registry, null);
  if (!gotReg || typeof gotReg !== 'object' || !gotReg.rules) {
    errors.push(`${registry} 缺失或不可读（运行 sync-shared-rules）`);
  } else {
    for (const r of rules) {
      const e = gotReg.rules[r.id];
      if (!e) errors.push(`${registry}: 缺少 ${r.id}`);
      else {
        if (e.status !== r.status) errors.push(`${registry}: ${r.id} status=${e.status}，应为 ${r.status}`);
        if (e.owner !== r.owner) errors.push(`${registry}: ${r.id} owner=${e.owner}，应为 ${r.owner}`);
        if (!e.firstSeen) errors.push(`${registry}: ${r.id} 缺少 firstSeen`);
      }
    }
    for (const id of Object.keys(gotReg.rules)) {
      if (!ownerRules.has(id)) errors.push(`${registry}: ${id} 没有 owner 块（退役请保留块并置 status=retired）`);
    }
  }

  const result = { ok: errors.length === 0, mode: mode.mode, rules: rules.length, carrierBlocks, errors };
  if (json) {
    console.log(JSON.stringify(result));
    process.exit(result.ok ? 0 : 1);
  }
  if (!result.ok) {
    for (const e of errors) console.error(`✗ ${e}`);
    console.error(`\nshared rules: ${rules.length} rules, ${carrierBlocks} carrier blocks, ${errors.length} error(s)`);
    process.exit(1);
  }
  console.log(`shared rules: ${rules.length} rules, ${carrierBlocks} carrier blocks, 0 drift ✔（${mode.mode}）`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try { main(); } catch (e) {
    if (e instanceof UsageError) { console.error(`✗ ${e.message}`); process.exit(2); }
    console.error(`✗ ${e && e.message ? e.message : e}`);
    process.exit(1);
  }
}
