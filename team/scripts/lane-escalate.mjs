#!/usr/bin/env node
/**
 * lane-escalate.mjs — 交互 lane 的**看板升级**：写问题产物 + 评论 + `blocked`。
 *
 * 设计约束：
 *   · provider 是唯一卡写入口；本模块只调用它已导出的 `comment` / `setStatus` /
 *     `appendProgress`，不直接改卡。
 *   · provider 的 `setStatus` 不写 `blocked_reason`（只写 `blocked_at`），所以
 *     `blocked_reason=clarify|decision` 必须落在**评论文本**里；`sla-scan` 的
 *     `trailEntries()` 能按 `· <kind> · <author>` 读到它。
 *   · 任何一步失败都不阻止 lane 停止：产物 + `lane-lifecycle.log` 是最后兜底。
 *
 * v1 不做“等人回答”：升级 = 记录 + 拒绝该工具 + 停止 lane；答案由 Elon/operator
 * 写回卡，owner 起**新分段**继续（handoff 已含 Comments）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { redact, redactText } from './lane-policy.mjs';

let providerCache = null;

/** 懒加载 provider；缺失/不可导入 ⇒ 抛错（调用方 catch 后降级）。 */
export async function loadProvider(env = process.env) {
  if (providerCache) return providerCache;
  const dir = env && env.OPENCLAW_TASK_OPS_DIR
    ? path.resolve(String(env.OPENCLAW_TASK_OPS_DIR))
    : path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'task-ops');
  const file = path.join(dir, 'lib', 'task.mjs');
  if (!fs.existsSync(file)) throw new Error(`provider_missing:${file}`);
  providerCache = await import(pathToFileURL(file).href);
  return providerCache;
}

function stamp(now = new Date()) {
  return now.toISOString().replace(/[:.]/g, '-');
}

function safeId(v) {
  return String(v == null ? '' : v).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80) || 'question';
}

/**
 * 原子写问题产物。
 * @returns {{ok:boolean, path?:string, artifact?:object, reason?:string}}
 */
export function writeQuestionArtifact({
  questionDir,
  owner = '',
  seg = 'seg1',
  backend = '',
  taskId = '',
  requestId = '',
  sessionId = '',
  threadId = '',
  kind = 'clarify',
  questions = [],
  context = {},
  now = new Date(),
} = {}) {
  if (!questionDir) return { ok: false, reason: 'question_dir_missing' };
  const artifact = redact({
    v: 1,
    task_id: taskId,
    seg,
    owner,
    backend,
    request_id: requestId,
    session_id: sessionId,
    thread_id: threadId,
    created_at: now.toISOString(),
    kind,
    questions,
    context,
    status: 'pending',
  });
  const file = path.join(questionDir, `${owner || 'lane'}-${seg}-${stamp(now)}-${safeId(requestId)}.json`);
  try {
    fs.mkdirSync(questionDir, { recursive: true });
    const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
    fs.writeFileSync(tmp, `${JSON.stringify(artifact, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, file);
    return { ok: true, path: file, artifact };
  } catch (e) {
    return { ok: false, reason: `artifact_write_failed:${e && e.message ? e.message : e}` };
  }
}

/** 升级评论的机器可读前缀 + 人类可读问题清单。 */
export function buildEscalationText({
  card = '',
  taskId = '',
  seg = 'seg1',
  owner = '',
  backend = '',
  kind = 'clarify',
  artifactPath = '',
  questions = [],
} = {}) {
  const reason = kind === 'decision' ? 'decision' : 'clarify';
  const qid = path.basename(artifactPath || '', '.json');
  const lines = [
    `[lane-host] blocked_reason=${reason}`,
    `task=${taskId} seg=${seg} owner=${owner} backend=${backend}`,
    `card=${card}`,
    `question artifact: ${artifactPath}`,
  ];
  (Array.isArray(questions) ? questions : []).forEach((q, i) => {
    const n = i + 1;
    const text = typeof q === 'string' ? q : (q && q.question) || '';
    lines.push(`Q${n}: ${text}`);
    const options = q && Array.isArray(q.options) ? q.options : [];
    if (options.length) {
      lines.push(`  options: ${options.map((o) => (o && o.label) || o).join(' | ')}`);
    }
    if (q && q.isOther) lines.push('  (free-form answer allowed)');
  });
  lines.push(
    `Reply on the card as the operator: \`task.comment ${card || taskId} operator ${reason === 'decision' ? 'decision' : 'discuss'} "<answer>" refs:question:${qid}\``
    + ` (or record Elon's decision), then return the card to todo so ${owner || 'the owner'} can spawn the next interactive segment.`,
  );
  return lines.join('\n');
}

/**
 * 记录升级并置 blocked。**绝不抛错**：所有失败都降级为返回值。
 * @returns {{ok:boolean, comment?:object, status?:object, fallback?:object, reason?:string}}
 */
export async function escalate({
  card,
  owner = '',
  kind = 'clarify',
  artifactPath = '',
  text = '',
  env = process.env,
} = {}) {
  const qid = path.basename(artifactPath || '', '.json');
  const commentKind = kind === 'decision' ? 'decision' : 'discuss';
  let comment = null;
  let status = null;
  let fallback = null;

  try {
    const p = await loadProvider(env);
    comment = p.comment(card, owner || 'lane-host', commentKind, redactText(text), `question:${qid}`);
  } catch (e) {
    comment = { ok: false, reason: `provider_unavailable:${e && e.message ? e.message : e}` };
  }

  if (!comment || !comment.ok) {
    try {
      const p = await loadProvider(env);
      fallback = p.appendProgress(card, `[lane-host] question artifact: ${artifactPath}`);
    } catch (e) {
      fallback = { ok: false, reason: `provider_unavailable:${e && e.message ? e.message : e}` };
    }
  }

  try {
    const p = await loadProvider(env);
    // provider 只写 blocked_at；blocked_reason 已在评论文本里。
    status = p.setStatus(card, 'blocked', { actor: owner || 'lane-host' });
  } catch (e) {
    status = { ok: false, reason: `provider_unavailable:${e && e.message ? e.message : e}` };
  }

  const ok = Boolean((comment && comment.ok) || (fallback && fallback.ok));
  const reason = ok ? '' : String((comment && comment.reason) || (fallback && fallback.reason) || 'escalation_failed');
  return { ok, comment, status, fallback, reason };
}
