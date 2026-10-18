#!/usr/bin/env node
/**
 * lane-host-state.mjs — 交互 lane 的 sidecar（host 与 reaper 共用）。
 *
 * 为什么不写进卡/registry：provider 的 `sessionSet` 只接受
 * `seg/owner/backend/phase/pid/log/status/id`，`thread_id`/`interactive`/`control_log`
 * 会被忽略；卡行格式也归 provider 所有。于是 sidecar 成为交互元数据的**权威来源**：
 *   · host 在启动/就绪/结束时原子写；
 *   · reaper 在 host pid 死后读它清理残留后端。
 *
 * 形状见 `guides/interactive-lane-sop.md` §数据形状。
 */
import fs from 'node:fs';
import path from 'node:path';

/** 读 sidecar；不存在/坏 JSON ⇒ null（调用方按“无状态”处理，绝不猜）。 */
export function readState(file) {
  if (!file) return null;
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return j && typeof j === 'object' ? j : null;
  } catch {
    return null;
  }
}

/** 原子写（同目录 tmp + rename）；0600，因为控制面含命令/路径。 */
export function writeState(file, state) {
  if (!file) return state;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  return state;
}

/** 读-合并-写；缺失字段保留。 */
export function updateState(file, patch = {}) {
  return writeState(file, { ...(readState(file) || {}), ...patch });
}
