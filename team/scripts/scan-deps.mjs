#!/usr/bin/env node
/**
 * scan-deps.mjs — dependency CVE scan for the team check-all layer.
 *
 * Mechanism: `team/guides/dependency-cve-gate.md` §3.2 (check-all: default warn,
 * optional block) + §4.1 (block threshold: Critical/High, CVSS >= 7.0).
 * Normative clause: `the rules §㉖ Dependency CVE Gate`.
 *
 * Semantics (deliberately conservative — check-all must never go red just because
 * this host has no scanner or no network):
 *   - default            : print findings + a summary, ALWAYS exit 0 (warn-only);
 *   - SCAN_STRICT=1      : exit 1 iff an un-waived Critical/High hit exists;
 *   - no scanner / offline / nothing to scan : print `SKIP (...)`, exit 0.
 *
 * Tool set (guide §2.2): `osv-scanner` is the unified primary entry; the
 * ecosystem-native scanners (`npm audit`, `pip-audit`) are the fallback, used
 * only when `osv-scanner` is unavailable.
 *
 * Offline & deterministic: node builtins only; no network of its own; no writes
 * outside an optional `--json` report path; same input => byte-identical stdout.
 *
 * Usage:
 *   node scan-deps.mjs [--json] [--strict] [target ...]
 *   (no target => scan the registered projects from $TEAM/projects.json)
 *
 * Exit codes: 0 ok / warn / skip; 1 strict block; 2 usage error.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// ── severity model (guide §4.1) ─────────────────────────────────────────────

export const SEVERITIES = ['critical', 'high', 'medium', 'low', 'unknown'];
export const BLOCK_SEVERITIES = ['critical', 'high']; // CVSS >= 7.0

/** Normalise a scanner's severity label to our vocabulary. */
export function classifySeverity(label) {
  const s = String(label ?? '').trim().toLowerCase();
  if (s === 'critical') return 'critical';
  if (s === 'high') return 'high';
  if (s === 'moderate' || s === 'medium') return 'medium';
  if (s === 'low') return 'low';
  return 'unknown';
}

/** Normalise a numeric CVSS score to our vocabulary (>= 7.0 blocks). */
export function scoreToSeverity(score) {
  const n = Number(score);
  if (!Number.isFinite(n)) return 'unknown';
  if (n >= 9.0) return 'critical';
  if (n >= 7.0) return 'high';
  if (n >= 4.0) return 'medium';
  return 'low';
}

// ── scanner output adapters ─────────────────────────────────────────────────
// Each adapter returns [{ id, severity, package, version }].

function osvSeverity(vuln) {
  const label = vuln?.database_specific?.severity;
  if (label) return classifySeverity(label);
  // osv-scanner may carry a numeric score alongside a CVSS vector; a vector string
  // is not scored here (no CVSS maths) — only a plain-number score is honoured.
  const entries = Array.isArray(vuln?.severity) ? vuln.severity : [];
  for (const e of entries) {
    if (e && typeof e.score === 'number') return scoreToSeverity(e.score);
  }
  return 'unknown';
}

/** `osv-scanner ... --format json` — { results: [{ packages: [{ package, vulnerabilities }] }] }. */
export function parseOsv(json) {
  const out = [];
  for (const r of Array.isArray(json?.results) ? json.results : []) {
    for (const p of Array.isArray(r?.packages) ? r.packages : []) {
      const name = p?.package?.name ?? '?';
      const version = p?.package?.version ?? '?';
      for (const v of Array.isArray(p?.vulnerabilities) ? p.vulnerabilities : []) {
        out.push({ id: v?.id ?? '?', severity: osvSeverity(v), package: name, version });
      }
    }
  }
  return out;
}

/** `npm audit --json` — { vulnerabilities: { <pkg>: { severity, range, via[] } } }. */
export function parseNpmAudit(json) {
  const out = [];
  const vulns = json?.vulnerabilities && typeof json.vulnerabilities === 'object' ? json.vulnerabilities : {};
  for (const [name, entry] of Object.entries(vulns)) {
    const via = Array.isArray(entry?.via) ? entry.via : [];
    const advisory = via.find((x) => x && typeof x === 'object' && (x.source || x.url));
    out.push({
      id: advisory?.source || advisory?.url || `${name} (npm audit)`,
      severity: classifySeverity(entry?.severity),
      package: name,
      version: entry?.range ?? '?',
    });
  }
  return out;
}

/** `pip-audit --format json` — [{ name, version, vulns: [{ id }] }]. pip-audit carries no severity. */
export function parsePipAudit(json) {
  const out = [];
  for (const pkg of Array.isArray(json) ? json : []) {
    for (const v of Array.isArray(pkg?.vulns) ? pkg.vulns : []) {
      out.push({ id: v?.id ?? '?', severity: 'unknown', package: pkg?.name ?? '?', version: pkg?.version ?? '?' });
    }
  }
  return out;
}

// ── scanner registry ────────────────────────────────────────────────────────

const LOCKFILES = [
  'package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock',
  'requirements.txt', 'poetry.lock', 'Pipfile.lock', 'Cargo.lock', 'go.sum', 'Gemfile.lock',
];
const NODE_LOCKFILES = ['package-lock.json', 'npm-shrinkwrap.json'];

export const SCANNERS = [
  { id: 'osv-scanner', bin: 'osv-scanner', args: (d) => ['scan', 'source', '-r', d, '--format', 'json'], parse: parseOsv },
  { id: 'npm-audit', bin: 'npm', args: () => ['audit', '--json'], cwd: true,
    applies: (d) => NODE_LOCKFILES.some((f) => fs.existsSync(path.join(d, f))), parse: parseNpmAudit },
  { id: 'pip-audit', bin: 'pip-audit', args: () => ['--format', 'json', '-r', 'requirements.txt'], cwd: true,
    applies: (d) => fs.existsSync(path.join(d, 'requirements.txt')), parse: parsePipAudit },
];

/** PATH lookup (node builtin only — mirrors `command -v`). */
export function which(bin, env = process.env) {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of String(env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = path.join(dir, bin + ext);
      try { fs.accessSync(p, fs.constants.X_OK); return p; } catch { /* keep looking */ }
    }
  }
  return null;
}

/** Scanners usable on this host, in registry order. */
export function discoverScanners(env = process.env) {
  return SCANNERS.filter((s) => which(s.bin, env));
}

// ── target discovery ────────────────────────────────────────────────────────

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'vendor', '.venv', 'venv']);

/** Directories at/below `root` (depth-bounded) that contain a lockfile, sorted. */
export function findTargets(root, maxDepth = 4) {
  const found = new Set();
  const walk = (dir, depth) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    if (entries.some((e) => e.isFile() && LOCKFILES.includes(e.name))) found.add(dir);
    if (depth >= maxDepth) return;
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (e.isDirectory() && !SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name), depth + 1);
    }
  };
  walk(path.resolve(root), 0);
  return [...found].sort();
}

/** Default roots: the registered projects' roots and repo paths (`$TEAM/projects.json`). */
export function registeredRoots(env = process.env) {
  const teamRoot = env.OPENCLAW_TEAM_ROOT || path.join(os.homedir(), '.openclaw', 'team');
  const file = path.join(teamRoot, 'projects.json');
  let data;
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return []; }
  const roots = [];
  for (const p of Object.values(data?.projects || {})) {
    if (!p || typeof p !== 'object') continue;
    if (typeof p.root === 'string') roots.push(p.root);
    for (const r of Array.isArray(p.repos) ? p.repos : []) {
      if (r && typeof r.rel_path === 'string' && typeof p.root === 'string') {
        roots.push(path.resolve(p.root, r.rel_path));
      }
    }
  }
  return [...new Set(roots)].sort();
}

// ── main ────────────────────────────────────────────────────────────────────

const SEV_RANK = { critical: 0, high: 1, medium: 2, low: 3, unknown: 4 };

/** Sort findings so output is stable regardless of scanner insertion order. */
function sortFindings(findings) {
  return [...findings].sort((a, b) =>
    (SEV_RANK[a.severity] - SEV_RANK[b.severity]) ||
    String(a.id).localeCompare(String(b.id)) ||
    String(a.package).localeCompare(String(b.package)) ||
    String(a.target).localeCompare(String(b.target)));
}

function aggregate(findings) {
  const counts = Object.fromEntries(SEVERITIES.map((s) => [s, 0]));
  for (const f of findings) counts[f.severity] = (counts[f.severity] || 0) + 1;
  const total = findings.length;
  const blocking = findings.filter((f) => BLOCK_SEVERITIES.includes(f.severity)).length;
  return { counts, total, blocking };
}

export function main(argv = process.argv.slice(2), env = process.env) {
  const json = argv.includes('--json');
  const strict = argv.includes('--strict') || String(env.SCAN_STRICT || '') === '1';
  const args = argv.filter((a) => !a.startsWith('--'));

  const say = (line) => { if (!json) console.log(line); };

  // 1. targets
  const roots = args.length ? args : registeredRoots(env);
  const targets = [...new Set(roots.flatMap((r) => findTargets(r)))].sort();

  // 2. scanners
  const available = discoverScanners(env);
  const osv = available.find((s) => s.id === 'osv-scanner');
  const usable = osv ? [osv] : available.filter((s) => typeof s.applies === 'function');

  const finish = (result) => {
    if (json) console.log(JSON.stringify(result));
    return result.strict && result.blocking > 0 ? 1 : 0;
  };

  if (!available.length) return skip('no scanner available', { strict, scanner: null, targets }, say, finish);

  if (!targets.length) return skip('no lockfile target under registered projects', { strict, scanner: usable.map((s) => s.id), targets }, say, finish);

  // 3. run
  const findings = [];
  const scannerErrors = [];
  const scannersUsed = new Set();
  for (const target of targets) {
    for (const s of usable) {
      if (typeof s.applies === 'function' && !s.applies(target)) continue;
      const cwd = s.cwd ? target : undefined;
      const r = spawnSync(s.bin, s.args(target), { cwd, encoding: 'utf8', timeout: 120000, maxBuffer: 32 * 1024 * 1024 });
      const stdout = (r.stdout || '').trim();
      let parsed;
      try { parsed = JSON.parse(stdout); } catch { parsed = null; }
      if (parsed === null) {
        scannerErrors.push({ scanner: s.id, target, error: (r.error && r.error.code) || `exit ${r.status}` });
        continue;
      }
      scannersUsed.add(s.id);
      for (const f of s.parse(parsed)) findings.push({ ...f, scanner: s.id, target });
    }
  }

  // Nothing actually ran (e.g. the scanner binary exists but is offline/broken) => skip, warn-only.
  if (!scannersUsed.size) {
    return skip('scanner unavailable / offline', { strict, scanner: usable.map((s) => s.id), targets, scannerErrors }, say, finish);
  }

  const sorted = sortFindings(findings);
  const { counts, total, blocking } = aggregate(sorted);
  const ok = !(strict && blocking > 0);

  const result = { strict, scanner: [...scannersUsed].sort(), targets, counts, total, blocking, ok, findings: sorted };
  if (json) { finish(result); return ok ? 0 : 1; }

  console.log(`scan-deps: scanner=${[...scannersUsed].sort().join(',')} targets=${targets.length}`);
  for (const f of sorted) {
    console.log(`  [${f.severity.toUpperCase()}] ${f.id} ${f.package}@${f.version} (${f.scanner}, ${f.target})`);
  }
  console.log(`scan-deps: critical=${counts.critical} high=${counts.high} medium=${counts.medium} low=${counts.low} unknown=${counts.unknown} total=${total}`);
  if (blocking > 0) {
    console.log(`scan-deps: ${blocking} Critical/High hit(s) — block threshold CVSS >= 7.0 (dependency-cve-gate §4.1)`);
  }
  console.log(strict
    ? `scan-deps: STRICT — ${ok ? 'no blocking hit' : 'blocking hit => exit 1'}`
    : 'scan-deps: WARN (default; set SCAN_STRICT=1 to block on Critical/High)');
  return ok ? 0 : 1;
}

function skip(reason, base, say, finish) {
  say(`scan-deps: SKIP (${reason})`);
  return finish({ ...base, total: 0, blocking: 0, ok: true, skip: true, reason, findings: [] });
}

// ── direct-run guard ────────────────────────────────────────────────────────

const invokedDirectly = (() => {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch { return false; }
})();

if (invokedDirectly) process.exit(main());
