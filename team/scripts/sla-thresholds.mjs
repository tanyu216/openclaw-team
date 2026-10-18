/**
 * sla-thresholds.mjs — SLA 阈值的纯加载/校验模块。
 *
 * 只依赖 node 内置与 host-paths；**不 import lib.mjs**（后者缺 provider 会硬退出）。
 * 单一数值源 = team/guides/sla-thresholds.json；sla-scan 与 check-sla-thresholds
 * 都从这里取数，避免「代码里的 SLA_ROWS」与「文档里的表」两套值。
 */
import fs from 'node:fs';
import path from 'node:path';

export const SLA_ROW_NAMES = [
  'blocked_clarification',
  'confirmation_gate',
  'defect_card_creation',
  'acceptance_card_creation',
  'heartbeat_stale',
  'leader_stalled',
];

export function thresholdsPath(mode) {
  return mode.mode === 'repo'
    ? path.join(mode.repo, 'team', 'guides', 'sla-thresholds.json')
    : path.join(mode.team, 'guides', 'sla-thresholds.json');
}

export function loadThresholds(mode) {
  const p = thresholdsPath(mode);
  let data;
  try { data = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) {
    throw new Error(`SLA 阈值不可读：${p}（${e && e.message ? e.message : e}）`);
  }
  return { data, path: p, errors: validateThresholds(data) };
}

export function validateThresholds(data) {
  const errors = [];
  if (!data || typeof data !== 'object' || Array.isArray(data)) return ['顶层必须是对象'];
  if (data.version !== 1) errors.push('version 必须为 1');
  const w = data.workingWindow;
  if (!w || typeof w !== 'object') errors.push('缺少 workingWindow');
  else {
    if (w.tz !== 'Asia/Shanghai') errors.push('workingWindow.tz 必须为 Asia/Shanghai');
    if (w.start !== '09:00') errors.push('workingWindow.start 必须为 09:00');
    if (w.end !== '23:00') errors.push('workingWindow.end 必须为 23:00');
  }
  if (!Array.isArray(data.rows)) errors.push('rows 必须是数组');
  else {
    if (data.rows.length !== 6) errors.push(`rows 必须恰好 6 行（当前 ${data.rows.length}）`);
    const seen = new Set();
    for (const r of data.rows) {
      if (!r || typeof r !== 'object') { errors.push('rows 含非对象项'); continue; }
      if (!SLA_ROW_NAMES.includes(r.row)) errors.push(`未知行名：${r.row}`);
      if (seen.has(r.row)) errors.push(`重复行名：${r.row}`);
      seen.add(r.row);
      if (!/^R-SLA-[1-9][0-9]*$/.test(String(r.slaRef || ''))) errors.push(`${r.row}: slaRef 必须是 R-SLA-N`);
      if (!/^R-SLA-[1-9][0-9]*\s+(?:clause|step)\s+[1-9][0-9]*$/.test(String(r.thresholdRef || ''))) errors.push(`${r.row}: thresholdRef 必须是 R-SLA-N clause M`);
      if (!Number.isInteger(r.normalMin) || r.normalMin <= 0) errors.push(`${r.row}: normalMin 必须是正整数`);
      if (!Number.isInteger(r.furtherMin) || r.furtherMin <= 0) errors.push(`${r.row}: furtherMin 必须是正整数`);
      if (Number.isInteger(r.normalMin) && Number.isInteger(r.furtherMin) && r.furtherMin <= r.normalMin) errors.push(`${r.row}: furtherMin 必须大于 normalMin`);
      if (typeof r.action !== 'string' || !r.action.trim()) errors.push(`${r.row}: action 不得为空`);
      if (typeof r.furtherAction !== 'string' || !r.furtherAction.trim()) errors.push(`${r.row}: furtherAction 不得为空`);
      if (r.furtherRef != null && !/^R-SLA-[1-9][0-9]*$/.test(String(r.furtherRef))) errors.push(`${r.row}: furtherRef 必须是 R-SLA-N`);
    }
    for (const name of SLA_ROW_NAMES) if (!seen.has(name)) errors.push(`缺少行：${name}`);
  }
  const l = data.liveness;
  if (!l || typeof l !== 'object') errors.push('缺少 liveness');
  else {
    if (l.row !== 'inspector_liveness') errors.push('liveness.row 必须为 inspector_liveness');
    if (l.normalMin !== null || l.furtherMin !== null) errors.push('liveness 不得有阈值（它不是协议 SLA 行）');
    if (typeof l.action !== 'string' || !l.action.trim()) errors.push('liveness.action 不得为空');
  }
  if (JSON.stringify(data).includes('PROTOCOL')) errors.push('阈值文件不得引用 PROTOCOL');
  return errors;
}

/** 供 sla-scan 使用的行数组（与 JSON 同序、同值）。 */
export function loadSlaRows(mode) {
  const { data, errors } = loadThresholds(mode);
  if (errors.length) throw new Error(`SLA 阈值非法：${errors.join('；')}`);
  return data.rows;
}

export function loadLivenessRow(mode) {
  const { data, errors } = loadThresholds(mode);
  if (errors.length) throw new Error(`SLA 阈值非法：${errors.join('；')}`);
  return data.liveness;
}
