#!/usr/bin/env node
/**
 * board-adapter.test.mjs — team 侧 §8 基座适配器（薄调用 CLI + schema 漂移门）回归（C 面，T-20261012-001338）
 *
 * 断言四组：
 *   ① 取数只经 CLI 子进程（`project list --json`），**不 import provider 内部、不直连 sqlite**（源码级守卫）；
 *   ② §8 投影：board `project` wire → 项目 metadata（kind 默认 / root 只在 meta.root / repos·guides 默认）；
 *   ③ **漂移门**：缺字段·改类型 ⇒ 红（不可用 + 显式告警）；多字段 ⇒ 告警但可读；一致 ⇒ 绿；
 *      声明版本 vs 注入版本不符 ⇒ 红；
 *   ④ 解析链：builtin → 基座(CLI) → 只读回退 projects.json → 未注册抛错；任何异常不逃逸。
 *
 * 运行：node --test scripts/tests/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  name as adapterName,
  BOARD_WIRE_SCHEMA_VERSION,
  PROJECT_WIRE_FIELDS,
  jsonType,
  detectWireDrift,
  projectFromWire,
  resolveViaCli,
  resolveProject,
  getProject,
  cliRunner,
  main,
} from '../board-adapter.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODULE = path.join(HERE, '..', 'board-adapter.mjs');

/** 一份与声明表对齐的 board project wire（null = 无值，不算漂移） */
function wire(over = {}) {
  return {
    id: 'demo',
    name: 'demo',
    labels: [],
    meta: { kind: 'code', root: '/abs/dir', repos: [{ path: 'src' }], guides: [] },
    readme: null,
    archived_at: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}
const envelope = (projects) => ({ ok: true, data: { projects } });
/** 注入 runner（记录调用参数） */
function runnerOf(stdout, status = 0, stderr = '') {
  const calls = [];
  const runner = (args, opts) => {
    calls.push({ args, opts });
    return { status, stdout: typeof stdout === 'string' ? stdout : JSON.stringify(stdout), stderr };
  };
  return { runner, calls };
}
function spyWarn() {
  const warns = [];
  return { warns, warn: (m) => warns.push(String(m)) };
}

// ---- ① 只经 CLI 取数（源码级守卫）-------------------------------------------

test('取数纪律：模块源码不含 node:sqlite、不 import provider 内部（skills/task-ops）', () => {
  const src = fs.readFileSync(MODULE, 'utf8');
  // 只查**真实 import/require 行**（文档注释里提到 "node:sqlite" / `bases/task-panel` 是说明「不再使用」）
  const codeLines = src.split('\n').filter((l) => /^\s*(import|export)\b|require\(/.test(l));
  const offenders = codeLines.filter((l) => /node:sqlite|skills\/task-ops|bases\/task-panel/.test(l));
  assert.deepEqual(offenders, [], '代码里不得直连 sqlite、不得 import provider 内部（task-ops / 旧基座适配器）');
  assert.equal(/spawnSync/.test(src), true, '取数应经子进程');
});

test('取数纪律：resolveViaCli 只调 `project list --json`，且子进程禁 autostart', () => {
  const { runner, calls } = runnerOf(envelope([wire()]));
  const res = resolveViaCli('demo', { runner, warn: () => {} });
  assert.equal(res.available, true);
  assert.deepEqual(calls[0].args, ['project', 'list', '--json']);
});

test('取数纪律：真实 spawnSync 路径带 TASKD_NO_AUTOSTART=1（不得顺手拉起守护进程）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-boardadapter-'));
  const bin = path.join(dir, 'taskctl');
  // 假 CLI：只回报它看到的 TASKD_NO_AUTOSTART（证明 env 注入生效）
  fs.writeFileSync(bin, '#!/bin/sh\nprintf \'{"ok":true,"data":{"projects":[],"seen":"%s"}}\' "$TASKD_NO_AUTOSTART"\n');
  fs.chmodSync(bin, 0o755);
  try {
    const res = cliRunner(['project', 'list', '--json'], { taskctl: bin });
    assert.equal(res.status, 0, String(res.stderr));
    assert.match(String(res.stdout), /"seen":"1"/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- ② §8 投影 -------------------------------------------------------------

test('投影：meta → §8 metadata（kind 默认 code / root 只在 meta.root / repos·guides 默认 []）', () => {
  assert.deepEqual(projectFromWire(wire()), {
    name: 'demo',
    kind: 'code',
    root: '/abs/dir',
    root_git: undefined,
    repos: [{ path: 'src' }],
    guides: [],
    default_git_rules: '',
    notes: undefined,
    registered_at: null,
  });
  // 无 meta / 空 meta ⇒ 不炸，root 为 null（board 0012 后无 root 列，锚点只在 meta）
  assert.equal(projectFromWire({ id: 'x', meta: {} }).root, null);
  assert.equal(projectFromWire({ id: 'x' }).kind, 'code');
});

test('投影：default_git_rules 兼容 meta.git_rules 旧键', () => {
  assert.equal(projectFromWire({ id: 'x', meta: { git_rules: 'md only' } }).default_git_rules, 'md only');
});

// ---- ③ 漂移门 -------------------------------------------------------------

test('漂移门：一致 ⇒ 绿（无 findings；null 值不算类型漂移）', () => {
  const d = detectWireDrift(wire());
  assert.deepEqual(d.findings, []);
  assert.equal(d.ok, true);
});

test('漂移门：缺字段 ⇒ 红（wire_field_missing）', () => {
  const w = wire();
  delete w.meta;
  const d = detectWireDrift(w);
  assert.equal(d.ok, false);
  assert.deepEqual(d.findings.map((f) => `${f.code}:${f.field}`), ['wire_field_missing:meta']);
});

test('漂移门：类型变化 ⇒ 红（wire_type_changed）', () => {
  const d = detectWireDrift(wire({ labels: 'category:dev' }));
  assert.equal(d.ok, false);
  assert.deepEqual(d.findings, [{ code: 'wire_type_changed', field: 'labels', expected: 'array', actual: 'string' }]);
});

test('漂移门：新增字段 ⇒ 加性漂移：告警但仍 ok（可读继续）', () => {
  const d = detectWireDrift(wire({ schema_note: 'x' }));
  assert.equal(d.ok, true);
  assert.deepEqual(d.findings.map((f) => f.code), ['wire_field_added']);
});

test('漂移门：声明版本 vs 注入版本 —— 一致 ⇒ 绿，不符 ⇒ 红', () => {
  assert.equal(detectWireDrift(wire(), { boardSchemaVersion: BOARD_WIRE_SCHEMA_VERSION }).ok, true);
  const d = detectWireDrift(wire(), { boardSchemaVersion: BOARD_WIRE_SCHEMA_VERSION + 1 });
  assert.equal(d.ok, false);
  assert.equal(d.findings[0].code, 'schema_version_mismatch');
});

test('漂移门：实取不是对象 ⇒ 红（wire_shape_invalid）', () => {
  assert.equal(detectWireDrift(null).ok, false);
  assert.equal(detectWireDrift([]).ok, false);
  assert.equal(jsonType([]), 'array');
});

test('漂移 ⇒ 显式告警 + 降级为不可用（不静默按旧 schema 读）', () => {
  const { runner } = runnerOf(envelope([wire({ name: 42 })]));
  const { warns, warn } = spyWarn();
  const res = resolveViaCli('demo', { runner, warn });
  assert.equal(res.available, false, '破坏性漂移必须降级（交回退），不得返回 metadata');
  assert.match(String(res.reason), /board wire 漂移/);
  assert.equal(warns.length, 1, '漂移必须显式告警');
  assert.match(warns[0], /wire_type_changed\(name\)/);
  assert.ok(res.drift && res.drift.ok === false);
});

test('加性漂移 ⇒ 告警但命中（降级为可读）', () => {
  const { runner } = runnerOf(envelope([wire({ extra_field: 1 })]));
  const { warns, warn } = spyWarn();
  const res = resolveViaCli('demo', { runner, warn });
  assert.equal(res.available, true);
  assert.equal(res.found, true);
  assert.equal(res.metadata.name, 'demo');
  assert.equal(warns.length, 1);
  assert.match(warns[0], /wire_field_added/);
});

// ---- ④ 解析链与失败语义 ----------------------------------------------------

test('CLI 缺失（spawn 无 status）⇒ available:false，绝不误判为「板里没这个 code」', () => {
  const runner = () => ({ status: null, stdout: null, stderr: null, error: Object.assign(new Error('spawn taskctl ENOENT'), { code: 'ENOENT' }) });
  const res = resolveViaCli('demo', { runner, warn: () => {} });
  assert.equal(res.available, false);
  assert.match(String(res.reason), /ENOENT/);
});

test('CLI 非零退出 / 坏 JSON / 信封形状不符 ⇒ 一律 available:false（降级，不抛）', () => {
  assert.equal(resolveViaCli('demo', { runner: runnerOf('', 1, 'boom').runner, warn: () => {} }).available, false);
  assert.equal(resolveViaCli('demo', { runner: runnerOf('not json').runner, warn: () => {} }).available, false);
  assert.equal(resolveViaCli('demo', { runner: runnerOf({ ok: false, error: {} }).runner, warn: () => {} }).available, false);
  assert.equal(resolveViaCli('demo', { runner: () => { throw new Error('kaboom'); }, warn: () => {} }).available, false);
});

test('板可读但无该 code ⇒ available:true, found:false（与「基座不可用」可区分）', () => {
  const res = resolveViaCli('absent', { runner: runnerOf(envelope([wire()])).runner, warn: () => {} });
  assert.deepEqual(res, { available: true, found: false });
});

test('解析链：builtin 短路 → 基座命中 source=base → 基座不可用回退 source=fallback → 未注册抛错', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-boardadapter-'));
  const fallbackFile = path.join(dir, 'projects.json');
  fs.writeFileSync(fallbackFile, JSON.stringify({ projects: { fallbackp: { kind: 'docs', root: '/fb' } } }));
  try {
    const builtin = { name: '__team__', kind: 'team', root: null };
    assert.equal(resolveProject('__team__', { builtin }).source, 'builtin');

    const hit = resolveProject('demo', {
      builtin,
      fallbackFile,
      baseOpts: { runner: runnerOf(envelope([wire()])).runner, warn: () => {} },
    });
    assert.equal(hit.source, 'base');
    assert.equal(hit.metadata.root, '/abs/dir');

    const fb = resolveProject('fallbackp', {
      builtin,
      fallbackFile,
      baseOpts: { runner: () => ({ status: null, stdout: null, stderr: null, error: new Error('ENOENT') }), warn: () => {} },
    });
    assert.equal(fb.source, 'fallback');
    assert.equal(fb.metadata.kind, 'docs');

    assert.throws(
      () => getProject('nope', { builtin, fallbackFile, baseOpts: { runner: () => ({ status: null, error: new Error('ENOENT') }), warn: () => {} } }),
      /项目未注册: nope/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('适配器身份：name 与 §8 契约一致（可与 provider 基座互换）', () => {
  assert.equal(adapterName, 'task-panel');
  assert.equal(typeof PROJECT_WIRE_FIELDS.meta, 'string');
});

test('CLI：无参 ⇒ 用法、exit 0；未注册 code ⇒ 明确错误、exit 1（不静默）', () => {
  assert.equal(main([]), 0);
  assert.equal(main(['definitely-not-registered-code']), 1);
});
