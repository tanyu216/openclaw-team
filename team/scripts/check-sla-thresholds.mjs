#!/usr/bin/env node
/**
 * check-sla-thresholds.mjs — SLA 阈值的 repo/live 双模式校验。
 *
 * 不依赖 provider（不 import lib.mjs），因此空机器 / 仓库模式也能跑。
 * 用法：node team/scripts/check-sla-thresholds.mjs [--repo <R> | --live] [--json]
 */
import { resolveMode, UsageError } from './host-paths.mjs';
import { loadThresholds, thresholdsPath, SLA_ROW_NAMES } from './sla-thresholds.mjs';

function main() {
  const json = process.argv.includes('--json');
  const mode = resolveMode({ argv: process.argv.slice(2), scriptUrl: import.meta.url });
  const { data, path: p, errors } = loadThresholds(mode);
  const result = {
    ok: errors.length === 0,
    mode: mode.mode,
    path: p,
    rows: Array.isArray(data.rows) ? data.rows.length : 0,
    liveness: data && data.liveness ? data.liveness.row : null,
    rowNames: Array.isArray(data.rows) ? data.rows.map((r) => r.row) : [],
    errors,
  };
  if (json) {
    console.log(JSON.stringify(result));
    process.exit(result.ok ? 0 : 1);
  }
  if (!result.ok) {
    for (const e of errors) console.error(`✗ ${e}`);
    console.error(`\nSLA thresholds invalid（${p}）`);
    process.exit(1);
  }
  console.log(`SLA thresholds: ${result.rows} rows + ${result.liveness}; JSON valid; 0 drift ✔（${mode.mode}）`);
  console.log(`  rows: ${SLA_ROW_NAMES.join(', ')}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try { main(); } catch (e) {
    if (e instanceof UsageError) { console.error(`✗ ${e.message}`); process.exit(2); }
    console.error(`✗ ${e && e.message ? e.message : e}`);
    process.exit(1);
  }
}
