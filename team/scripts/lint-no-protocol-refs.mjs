#!/usr/bin/env node
/**
 * lint-no-protocol-refs.mjs — guides 不得反向引用退役的 PROTOCOL 两册。
 *
 * 默认只扫 guides（`team/guides/**` 与 `roles/*\/guides/**`）：这是硬规则。
 * `--all` 扫全部 shipped 文件（md/mjs/sh/json/json5/yml），用于迁移收尾；
 * 迁移期/测试夹具用 `test/docs/protocol-ref-allowlist.json` 的**精确**
 * `file:line:token` 或整文件登记放过，不做宽泛的目录豁免。
 *
 * 用法：
 *   node team/scripts/lint-no-protocol-refs.mjs [--repo <R> | --live]
 *   node team/scripts/lint-no-protocol-refs.mjs --all [--allowlist <p>] [--json]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveMode, UsageError } from './host-paths.mjs';
import { ROLES } from './lib/agent-doc-blocks.mjs';

const SELF = fileURLToPath(import.meta.url);

const HIT_RE = /PROTOCOL(?:-gates)?\.md|PROTOCOL\s*§/g;
const EXT = /\.(md|mjs|sh|json|json5|ya?ml)$/;
const SKIP_DIRS = new Set(['node_modules', '.git', 'tasks', 'workspace', 'memory', '.tmp', '.backups']);

function walk(dir, out, depth = 0) {
  if (depth > 10) return;
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(p, out, depth + 1); }
    else if (e.isFile() && EXT.test(e.name)) out.push(p);
  }
}

function scanFiles(mode, all) {
  const files = [];
  if (all) {
    if (mode.mode === 'repo') {
      for (const d of ['team', 'roles', 'docker', 'config', 'skills', 'test', '.github']) {
        const p = path.join(mode.repo, d);
        if (fs.existsSync(p)) walk(p, files);
      }
      for (const f of ['install.sh', 'README.md', 'README.zh-CN.md', 'CLAUDE.md']) {
        const p = path.join(mode.repo, f);
        if (fs.existsSync(p)) files.push(p);
      }
    } else {
      walk(mode.team, files);
      for (const role of ROLES) walk(path.join(mode.home, `workspace-${role}`), files);
    }
  } else {
    if (mode.mode === 'repo') walk(path.join(mode.repo, 'team', 'guides'), files);
    else walk(path.join(mode.team, 'guides'), files);
    for (const role of ROLES) {
      const p = mode.mode === 'repo' ? path.join(mode.repo, 'roles', role, 'guides') : path.join(mode.home, `workspace-${role}`, 'guides');
      walk(p, files);
    }
  }
  return [...new Set(files)].sort();
}

function loadAllowlist(p) {
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    return { files: new Set(j.files || []), entries: new Set(j.entries || []) };
  } catch {
    return { files: new Set(), entries: new Set() };
  }
}

function main() {
  const argv = process.argv.slice(2);
  const json = argv.includes('--json');
  const all = argv.includes('--all');
  const mode = resolveMode({ argv, scriptUrl: import.meta.url });
  const allowIndex = argv.indexOf('--allowlist');
  const allowPath = allowIndex >= 0 ? path.resolve(argv[allowIndex + 1])
    : path.join(mode.mode === 'repo' ? mode.repo : mode.repo || process.cwd(), 'test/docs/protocol-ref-allowlist.json');
  const allow = loadAllowlist(allowPath);

  const hits = [];
  for (const file of scanFiles(mode, all)) {
    if (path.resolve(file) === path.resolve(SELF)) continue;      // 本 lint 自己的注释/消息
    if (path.resolve(file) === path.resolve(allowPath)) continue;  // allowlist 自己
    const rel = path.relative(mode.mode === 'repo' ? mode.repo : mode.team, file).split(path.sep).join('/');
    if (allow.files.has(rel)) continue;
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      for (const m of lines[i].matchAll(HIT_RE)) {
        const key = `${rel}:${i + 1}:${m[0]}`;
        if (allow.entries.has(key)) continue;
        hits.push({ file: rel, line: i + 1, token: m[0] });
      }
    }
  }

  const result = { ok: hits.length === 0, mode: mode.mode, all, hits: hits.length, files: [...new Set(hits.map((h) => h.file))], allowlist: allowPath };
  if (json) {
    console.log(JSON.stringify({ ...result, samples: hits.slice(0, 200) }));
    process.exit(result.ok ? 0 : 1);
  }
  if (!result.ok) {
    for (const h of hits.slice(0, 80)) console.error(`✗ ${h.file}:${h.line}: ${h.token}`);
    if (hits.length > 80) console.error(`… 另有 ${hits.length - 80} 处`);
    console.error(`\n${hits.length} 处 PROTOCOL 引用（${result.files.length} 个文件；mode=${mode.mode}${all ? ', --all' : ''}）`);
    process.exit(1);
  }
  console.log(`0 PROTOCOL references ✔（${mode.mode}${all ? ', --all' : ', guides'}）`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try { main(); } catch (e) {
    if (e instanceof UsageError) { console.error(`✗ ${e.message}`); process.exit(2); }
    console.error(`✗ ${e && e.message ? e.message : e}`);
    process.exit(1);
  }
}
