#!/usr/bin/env node
/**
 * lane-policy.mjs — 交互 lane 的**本地策略引擎**（fail-closed）。
 *
 * 为什么存在：交互 lane 的 host 必须对后端的每一次权限请求做裁决，而不是把
 * “有宿主”当成“全放行”。策略是**第二道门**：Claude 的只读分类器/设置 allow、
 * Codex 的 workspace-write 沙箱先于本模块；只有落到 host 的请求才在这里裁决。
 *
 * 语义（与 `lane-policy.default.json` 配套）：
 *   · 规则按顺序**首个匹配**；无匹配 ⇒ `default`，且 `default` 必须是 `deny`。
 *   · `allow` = 放行；`deny` = 拒绝后继续本轮；`escalate` = 拒绝 + 写问题 + 置 blocked + 停 lane。
 *   · `shellMeta` 规则先于命令规则评估：命令含 `; && || | > < $( ) 反引号` 时不得靠前缀白名单绕过。
 *   · 路径规则解析 `..` 与最近存在祖先的 realpath；逃逸出允许前缀 ⇒ 不匹配。
 *
 * 出口：
 *   loadPolicy({policyPath, teamRoot, env}) -> {ok, policy, path, source, digest} | {ok:false, reason}
 *   normalizeRequest({backend, kind, tool, input, params}) -> request
 *   evaluatePolicy(policy, request, {cwd, wsDir, teamRoot, taskId, home}) -> {action, ruleId, reason, subject}
 *   redact(value) / policyDigest(policy) / hasShellMeta(command)
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const POLICY_ENV = 'OPENCLAW_LANE_POLICY';
export const DEFAULT_POLICY_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'lane-policy.default.json');

const ACTIONS = new Set(['allow', 'deny', 'escalate']);
const KINDS = new Set(['*', 'tool', 'command', 'file', 'permission', 'question']);
const BACKENDS = new Set(['*', 'claude', 'codex']);
const SHELL_META_RE = /(;|&&|\|\||\||>|<|\$\(|`)/;
const SECRET_KEY_RE = /token|secret|password|passwd|api[_-]?key|authorization|cookie|credential|private[_-]?key/i;
// 值级脱敏：命令/问题文本里常见的 `--token=…`、`Bearer …`、`sk-…` 形态。
const SECRET_VALUE_RES = [
  /((?:[A-Za-z0-9_-]*(?:token|secret|password|passwd|api[_-]?key|cookie|credential)[A-Za-z0-9_-]*)\s*[=:]\s*)([^\s'"]+)/gi,
  /(Bearer\s+)([A-Za-z0-9._~+/=-]+)/gi,
  /(Authorization\s*:\s*)(?!Bearer\b|Basic\b)([^\s'"]+)/gi,
  /\b(sk-[A-Za-z0-9_-]{8,})\b/g,
];

const asArray = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
const isStringArray = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string');

/** 命令里是否含可改变语义的 shell 元字符（`*`/`?` 属于通配展开，不算）。 */
export function hasShellMeta(command) {
  return SHELL_META_RE.test(String(command || ''));
}

/** 简单通配：仅 `*`，用于 tool 名（`mcp__*` 等）。 */
export function matchGlob(pattern, value) {
  const p = String(pattern == null ? '' : pattern);
  const v = String(value == null ? '' : value);
  if (p === '*') return true;
  if (!p.includes('*')) return p === v;
  const re = new RegExp(`^${p.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
  return re.test(v);
}

function normalizeCommand(cmd) {
  return String(cmd == null ? '' : cmd).replace(/\s+/g, ' ').trim();
}

/**
 * 命令前缀匹配：允许 `ls`/`ls -la`，不把 `lsof` 误判为 `ls`。
 * 前缀以空格结尾时按字面 `startsWith`（规则可写 `"git add "` 强制子命令边界）。
 */
export function matchesCommandPrefix(command, prefix) {
  const c = normalizeCommand(command);
  const p = normalizeCommand(prefix);
  if (!p) return false;
  if (c === p) return true;
  if (p.endsWith(' ')) return c.startsWith(p);
  return c.startsWith(`${p} `);
}

/** 校验策略结构；返回错误数组（空 = 合法）。 */
export function validatePolicy(policy) {
  const errors = [];
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) return ['policy_must_be_object'];
  if (policy.version !== 1) errors.push('version_must_be_1');
  if (policy.default !== 'deny') errors.push('default_must_be_deny');
  if (policy.control_timeout_ms != null
    && (!Number.isInteger(policy.control_timeout_ms) || policy.control_timeout_ms <= 0)) {
    errors.push('control_timeout_ms_invalid');
  }
  if (!Array.isArray(policy.rules)) { errors.push('rules_must_be_array'); return errors; }
  policy.rules.forEach((r, i) => {
    const at = `rules[${i}]`;
    if (!r || typeof r !== 'object' || Array.isArray(r)) { errors.push(`${at}_not_object`); return; }
    if (typeof r.id !== 'string' || !r.id.trim()) errors.push(`${at}.id_missing`);
    if (!ACTIONS.has(r.action)) errors.push(`${at}.action_invalid`);
    if (r.backend != null && !BACKENDS.has(r.backend)) errors.push(`${at}.backend_invalid`);
    if (r.kind != null && !KINDS.has(r.kind)) errors.push(`${at}.kind_invalid`);
    for (const k of ['tool', 'commandPrefix', 'commandRegex', 'pathPrefix']) {
      if (r[k] != null && !isStringArray(asArray(r[k]))) errors.push(`${at}.${k}_invalid`);
    }
    for (const re of asArray(r.commandRegex)) {
      try { new RegExp(re); } catch { errors.push(`${at}.commandRegex_invalid:${re}`); }
    }
    if (r.shellMeta != null && typeof r.shellMeta !== 'boolean') errors.push(`${at}.shellMeta_invalid`);
    const hasMatcher = r.kind === '*' || r.shellMeta === true
      || r.tool != null || r.commandPrefix != null || r.commandRegex != null || r.pathPrefix != null;
    if (!hasMatcher) errors.push(`${at}.no_matcher`);
  });
  return errors;
}

/** 稳定序列化后的 sha256：审计里记的是“这份策略”，不是文件 mtime。 */
export function policyDigest(policy) {
  const stable = (v) => {
    if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
    if (v && typeof v === 'object') {
      return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
    }
    return JSON.stringify(v);
  };
  return crypto.createHash('sha256').update(stable(policy)).digest('hex');
}

/**
 * 加载策略。优先级：显式路径 > `OPENCLAW_LANE_POLICY` > `<TEAM>/lane-policy.json` > 随脚本默认。
 * 显式/env 路径**必须存在**；team 文件存在但非法 ⇒ 失败（不静默回退到默认）。
 */
export function loadPolicy({ policyPath = '', teamRoot = '', env = process.env } = {}) {
  const explicit = String(policyPath || '').trim();
  const envPath = String((env && env[POLICY_ENV]) || '').trim();
  const candidates = [];
  if (explicit) candidates.push({ path: path.resolve(explicit), source: 'explicit', required: true });
  if (envPath) candidates.push({ path: path.resolve(envPath), source: 'env', required: true });
  if (teamRoot) candidates.push({ path: path.join(teamRoot, 'lane-policy.json'), source: 'team', required: false });
  candidates.push({ path: DEFAULT_POLICY_FILE, source: 'default', required: true });

  for (const c of candidates) {
    if (!fs.existsSync(c.path)) {
      if (c.required) return { ok: false, reason: `not_found:${c.path}`, source: c.source };
      continue;
    }
    let policy;
    try {
      policy = JSON.parse(fs.readFileSync(c.path, 'utf8'));
    } catch (e) {
      return { ok: false, reason: `parse_failed:${c.path}:${e && e.message ? e.message : e}`, source: c.source };
    }
    const errors = validatePolicy(policy);
    if (errors.length) return { ok: false, reason: `invalid_policy:${errors.join(';')}`, source: c.source, path: c.path };
    return { ok: true, policy, path: c.path, source: c.source, digest: policyDigest(policy) };
  }
  return { ok: false, reason: 'no_policy', source: '' };
}

function commandOf(input = {}, params = {}) {
  const raw = input.command != null ? input.command : params.command;
  if (raw == null) return '';
  if (Array.isArray(raw)) return raw.map((x) => String(x)).join(' ');
  return String(raw);
}

function pathsOf(input = {}, params = {}) {
  const out = [];
  const push = (v) => {
    if (v == null) return;
    if (Array.isArray(v)) { v.forEach(push); return; }
    if (typeof v === 'string' && v.trim()) out.push(v);
  };
  push(input.file_path);
  push(input.path);
  push(params.grantRoot);
  push(params.file_path);
  push(params.path);
  if (params.fileChanges && typeof params.fileChanges === 'object') push(Object.keys(params.fileChanges));
  return [...new Set(out)];
}

function questionSubject(input = {}, params = {}) {
  const qs = input.questions || params.questions || params.question || [];
  const list = Array.isArray(qs) ? qs : [qs];
  return list.map((q) => (typeof q === 'string' ? q : q && q.question) || '').filter(Boolean).join(' | ').slice(0, 2000);
}

/** 把两种后端的请求归一成策略可匹配的形状。 */
export function normalizeRequest({ backend = '', kind = 'tool', tool = '', input = {}, params = {} } = {}) {
  if (kind === 'question') {
    return { backend, kind, tool: tool || 'AskUserQuestion', subject: questionSubject(input, params) };
  }
  if (kind === 'command') {
    const command = commandOf(input, params);
    return { backend, kind, tool: tool || 'Bash', command, subject: command.slice(0, 2000) };
  }
  if (kind === 'file') {
    const paths = pathsOf(input, params);
    return { backend, kind, tool: tool || 'Write', paths, subject: paths.join(', ').slice(0, 2000) };
  }
  if (kind === 'permission') {
    const subject = JSON.stringify(redact(params.permissions || input.permissions || {}));
    return { backend, kind, tool: tool || 'permission', subject: subject.slice(0, 2000) };
  }
  return { backend, kind: 'tool', tool, subject: tool };
}

/**
 * 把规则里的路径前缀解析为绝对路径；对不存在的路径，取**最近存在祖先**的 realpath 再拼回尾部，
 * 从而让 `..` 逃逸在“目标尚不存在”时也能被识别。
 */
function resolveForCompare(p, base) {
  const abs = path.isAbsolute(p) ? path.normalize(p) : path.resolve(base || process.cwd(), p);
  let probe = abs;
  const tail = [];
  for (;;) {
    try {
      const real = fs.realpathSync(probe);
      return path.join(real, ...tail.reverse());
    } catch {
      const parent = path.dirname(probe);
      if (parent === probe) return abs;
      tail.push(path.basename(probe));
      probe = parent;
    }
  }
}

function expandPrefix(prefix, ctx) {
  return String(prefix)
    .replace(/\{ws\}/g, ctx.wsDir || '')
    .replace(/\{team\}/g, ctx.teamRoot || '')
    .replace(/\{cwd\}/g, ctx.cwd || '')
    .replace(/\{home\}/g, ctx.home || '')
    .replace(/\{task_id\}/g, ctx.taskId || '');
}

function pathMatches(filePath, prefix, ctx) {
  const expanded = expandPrefix(prefix, ctx);
  if (!expanded) return false;
  const target = resolveForCompare(filePath, ctx.cwd);
  const root = resolveForCompare(expanded, ctx.cwd);
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** 首个匹配规则；无匹配 ⇒ policy.default（必须 deny）。 */
export function evaluatePolicy(policy, request, { cwd = '', wsDir = '', teamRoot = '', taskId = '', home = '' } = {}) {
  const ctx = { cwd, wsDir, teamRoot, taskId, home: home || process.env.HOME || '' };
  for (const rule of policy.rules || []) {
    if (rule.backend != null && rule.backend !== '*' && rule.backend !== request.backend) continue;
    if (rule.kind != null && rule.kind !== '*' && rule.kind !== request.kind) continue;

    if (rule.shellMeta === true) {
      if (request.kind !== 'command' || !hasShellMeta(request.command)) continue;
    }
    if (rule.tool != null) {
      if (!asArray(rule.tool).some((t) => matchGlob(t, request.tool))) continue;
    }
    if (rule.commandPrefix != null) {
      if (request.kind !== 'command') continue;
      if (!asArray(rule.commandPrefix).some((p) => matchesCommandPrefix(request.command, p))) continue;
    }
    if (rule.commandRegex != null) {
      if (request.kind !== 'command') continue;
      if (!asArray(rule.commandRegex).some((r) => new RegExp(r).test(request.command))) continue;
    }
    if (rule.pathPrefix != null) {
      if (request.kind !== 'file') continue;
      const prefixes = asArray(rule.pathPrefix);
      const hits = (request.paths || []).map((p) => prefixes.some((pre) => pathMatches(p, pre, ctx)));
      // allow 必须覆盖**全部**路径；deny/escalate 命中任意一条即可。
      if (rule.action === 'allow' ? !(hits.length && hits.every(Boolean)) : !hits.some(Boolean)) continue;
    }
    return { action: rule.action, ruleId: rule.id, reason: rule.reason || '', subject: request.subject };
  }
  return { action: policy.default, ruleId: '', reason: 'default', subject: request.subject };
}

/** 值级脱敏：遮蔽 `token=…` / `Bearer …` / `sk-…` 等常见秘密形态，其余文本保持可读。 */
export function redactText(value) {
  let s = String(value == null ? '' : value);
  for (const re of SECRET_VALUE_RES.slice(0, 3)) s = s.replace(re, '$1[redacted]');
  s = s.replace(SECRET_VALUE_RES[3], '[redacted]');
  return s;
}

/** 深度脱敏：键名命中秘密 ⇒ 整体遮蔽；其余字符串做值级脱敏 + 截断长串。 */
export function redact(value, { maxString = 2000, depth = 0 } = {}) {
  if (depth > 8) return '[depth]';
  if (typeof value === 'string') {
    const s = value.length > maxString ? `${value.slice(0, maxString)}…[truncated]` : value;
    return redactText(s);
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, { maxString, depth: depth + 1 }));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEY_RE.test(k) ? '[redacted]' : redact(v, { maxString, depth: depth + 1 });
    }
    return out;
  }
  return value;
}
