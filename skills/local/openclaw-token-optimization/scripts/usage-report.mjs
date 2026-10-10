// OpenClaw token-usage report from local state.
// Usage: node usage-report.mjs 2026-10-09[,2026-10-10]   (TZOFF=0 for UTC; default +480 = Asia/Shanghai)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';

const OPENCLAW = process.env.OPENCLAW_DIR || path.join(os.homedir(), '.openclaw');
const AGENTS = path.join(OPENCLAW, 'agents');
const TZ_OFFSET_MIN = Number(process.env.TZOFF ?? 480);
const DAYS = (process.argv[2] || new Date(Date.now() + TZ_OFFSET_MIN * 60000).toISOString().slice(0, 10)).split(',');

const localDay = (iso) => {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : new Date(t + TZ_OFFSET_MIN * 60000).toISOString().slice(0, 10);
};

const recs = [];
const seen = new Set(); // agent|messageId
const keyBySession = new Map();
const add = (agent, sessionId, ev) => {
  if (ev.type !== 'message') return;
  const m = ev.message;
  if (!m || m.role !== 'assistant' || !m.usage) return;
  const day = localDay(ev.timestamp);
  if (!day) return;
  const id = `${agent}|${ev.id || `${sessionId}:${ev.timestamp}`}`;
  if (seen.has(id)) return;
  seen.add(id);
  const u = m.usage;
  recs.push({ agent, sessionId, day, provider: m.provider || '?', model: m.model || '?',
    inp: u.input || 0, out: u.output || 0, cr: u.cacheRead || 0, cw: u.cacheWrite || 0,
    tot: u.totalTokens || 0, cost: (u.cost && u.cost.total) || 0 });
};
const feed = (agent, sessionId, text) => {
  for (const line of text.split('\n')) {
    if (!line.trim() || line[0] !== '{') continue;
    try { add(agent, sessionId, JSON.parse(line)); } catch {}
  }
};

// Copy a SQLite DB (with its -wal/-shm) to a temp dir, then read it.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-usage-'));
const copyDb = (src) => {
  const dst = path.join(tmp, path.basename(src));
  for (const suffix of ['', '-wal', '-shm']) if (fs.existsSync(src + suffix)) fs.copyFileSync(src + suffix, dst + suffix);
  return dst;
};

const agentNames = fs.existsSync(AGENTS) ? fs.readdirSync(AGENTS) : [];
for (const agent of agentNames) {
  const src = path.join(AGENTS, agent, 'agent', 'openclaw-agent.sqlite');
  if (fs.existsSync(src)) {
    try {
      const db = new DatabaseSync(copyDb(src), { readOnly: true });
      try { for (const r of db.prepare('select session_id, session_key from session_windows').all()) keyBySession.set(`${agent}|${r.session_id}`, r.session_key); } catch {}
      for (const r of db.prepare('select session_id, event_json, event_zstd from transcript_events').all()) {
        if (r.event_json) feed(agent, r.session_id, r.event_json);
        else if (r.event_zstd) { try { feed(agent, r.session_id, zlib.zstdDecompressSync(r.event_zstd).toString('utf8')); } catch {} }
      }
      db.close();
    } catch (e) { console.error('db error', agent, e.message); }
  }
  const sdir = path.join(AGENTS, agent, 'sessions');
  if (fs.existsSync(sdir)) for (const f of fs.readdirSync(sdir)) {
    if (!f.endsWith('.zst')) continue;
    try { feed(agent + '(deleted)', f.split('.')[0], zlib.zstdDecompressSync(fs.readFileSync(path.join(sdir, f))).toString('utf8')); } catch {}
  }
}
fs.rmSync(tmp, { recursive: true, force: true });

const inDay = recs.filter((r) => DAYS.includes(r.day));
const sum = (a, f) => a.reduce((s, r) => s + f(r), 0);
const fmt = (n) => n.toLocaleString('en-US');

console.log(`TZ offset=${TZ_OFFSET_MIN}min  days=${DAYS.join(',')}  events(all)=${recs.length}  in-range=${inDay.length}`);
console.log('\n== per-day totals ==');
for (const d of [...new Set(recs.map((r) => r.day))].sort()) {
  const a = recs.filter((r) => r.day === d);
  console.log(`${d} turns=${a.length} in=${fmt(sum(a, r => r.inp))} out=${fmt(sum(a, r => r.out))} cacheRead=${fmt(sum(a, r => r.cr))} TOTAL=${fmt(sum(a, r => r.tot))} $${sum(a, r => r.cost).toFixed(2)}`);
}

console.log(`\n== ${DAYS.join(',')} by agent ==`);
const ag = new Map();
for (const r of inDay) {
  const g = ag.get(r.agent) || { t: 0, inp: 0, out: 0, cr: 0, tot: 0, cost: 0, ctx: 0 };
  g.t++; g.inp += r.inp; g.out += r.out; g.cr += r.cr; g.tot += r.tot; g.cost += r.cost; g.ctx += r.inp + r.cr;
  ag.set(r.agent, g);
}
for (const [k, g] of [...ag].sort((a, b) => b[1].tot - a[1].tot))
  console.log(`${k} turns=${g.t} avgPrompt=${Math.round(g.ctx / g.t)} in=${fmt(g.inp)} out=${fmt(g.out)} cacheRead=${fmt(g.cr)} TOTAL=${fmt(g.tot)} (${(100 * g.tot / sum(inDay, r => r.tot)).toFixed(1)}%) $${g.cost.toFixed(2)}`);

console.log(`\n== top 25 sessions ==`);
const sm = new Map();
for (const r of inDay) {
  const k = `${r.agent}|${r.sessionId}`;
  const g = sm.get(k) || { t: 0, tot: 0, cr: 0, inp: 0, out: 0, cost: 0, first: r.day, last: r.day };
  g.t++; g.tot += r.tot; g.cr += r.cr; g.inp += r.inp; g.out += r.out; g.cost += r.cost;
  if (r.day < g.first) g.first = r.day; if (r.day > g.last) g.last = r.day;
  sm.set(k, g);
}
for (const [k, g] of [...sm].sort((a, b) => b[1].tot - a[1].tot).slice(0, 25)) {
  const [agent, sid] = k.split('|');
  console.log(`${agent} ${sid.slice(0, 8)} turns=${g.t} avgPrompt=${Math.round((g.cr + g.inp) / g.t)} cacheRead=${fmt(g.cr)} out=${fmt(g.out)} TOTAL=${fmt(g.tot)} $${g.cost.toFixed(3)} ${keyBySession.get(k) || ''}`);
}

console.log(`\n== prompt-size distribution (run turns; input+cacheRead per turn) ==`);
for (const [lo, hi] of [[0, 5e4], [5e4, 2e5], [2e5, 5e5], [5e5, 8e5], [8e5, 1e6], [1e6, 1e99]]) {
  const a = inDay.filter((r) => r.inp + r.cr >= lo && r.inp + r.cr < hi);
  console.log(`${(lo / 1e3).toFixed(0)}k-${hi > 1e11 ? 'inf' : (hi / 1e3).toFixed(0) + 'k'}: turns=${a.length} tokens=${fmt(sum(a, r => r.tot))}`);
}
const T = sum(inDay, r => r.tot);
if (T) console.log(`\nsplit: cacheRead=${(100 * sum(inDay, r => r.cr) / T).toFixed(1)}%  uncachedInput=${(100 * sum(inDay, r => r.inp) / T).toFixed(1)}%  output=${(100 * sum(inDay, r => r.out) / T).toFixed(2)}%  (total ${(T / 1e9).toFixed(2)}B)`);
