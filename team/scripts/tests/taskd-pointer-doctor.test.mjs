#!/usr/bin/env node
/**
 * taskd-pointer-doctor.test.mjs — 运行期指针命名体检回归（B 面，T-20261012-001338）
 *
 * 覆盖：新名/旧名路径口径（对标 provider runtime-locator，含 TASKD_RUNTIME_POINTER 覆盖）、
 * 指针读取的容错（缺失/坏 JSON/数组）、pid 存活判定，以及事故现场的四个检出码：
 *   legacy_only（新名缺失+旧名仍在）/ legacy_data_dir_missing / legacy_daemon_live / data_dir_missing。
 * 全部走注入依赖，不触盘、不联网、不碰真实指针。
 *
 * 运行：node --test scripts/tests/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import {
  POINTER_DIR_NEW,
  POINTER_DIR_LEGACY,
  pointerPathFor,
  readPointerFile,
  pidAlive,
  inspect,
  main,
} from '../taskd-pointer-doctor.mjs';

const HOME = '/home/tester';

// ---- 路径口径（对标 provider src/shared/runtime-locator.mjs#resolveRuntimePointerPath）----

test('路径：darwin 新名 = Application Support/MeerkatTaskPanel/runtime.json', () => {
  assert.equal(
    pointerPathFor({ dirName: POINTER_DIR_NEW, platform: 'darwin', env: {}, home: HOME }),
    path.join(HOME, 'Library', 'Application Support', 'MeerkatTaskPanel', 'runtime.json'),
  );
});

test('路径：darwin 旧名 = Application Support/TaskPanel/runtime.json（仅作遗留检出）', () => {
  assert.equal(
    pointerPathFor({ dirName: POINTER_DIR_LEGACY, platform: 'darwin', env: {}, home: HOME }),
    path.join(HOME, 'Library', 'Application Support', 'TaskPanel', 'runtime.json'),
  );
});

test('路径：非 darwin 走 XDG 状态目录（provider 包名，非目录名小写化）；XDG_STATE_HOME 覆盖生效', () => {
  assert.equal(
    pointerPathFor({ dirName: POINTER_DIR_NEW, platform: 'linux', env: {}, home: HOME }),
    path.join(HOME, '.local', 'state', 'meerkat-taskpanel', 'runtime.json'),
  );
  assert.equal(
    pointerPathFor({ dirName: POINTER_DIR_NEW, platform: 'linux', env: { XDG_STATE_HOME: '/state' }, home: HOME }),
    path.join('/state', 'meerkat-taskpanel', 'runtime.json'),
  );
});

test('路径：TASKD_RUNTIME_POINTER 只覆盖新名（旧名始终是被检出的遗留路径）', () => {
  const env = { TASKD_RUNTIME_POINTER: '/tmp/pinned.json' };
  assert.equal(pointerPathFor({ dirName: POINTER_DIR_NEW, platform: 'darwin', env, home: HOME }), '/tmp/pinned.json');
  assert.equal(
    pointerPathFor({ dirName: POINTER_DIR_LEGACY, platform: 'darwin', env, home: HOME }),
    path.join(HOME, 'Library', 'Application Support', 'TaskPanel', 'runtime.json'),
  );
});

// ---- 读取/存活判定的容错 ----------------------------------------------------

test('读指针：文件缺失 / 坏 JSON / 数组 ⇒ null（绝不抛）', () => {
  const deps = { readFileSync: () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); } };
  assert.equal(readPointerFile('/nope/runtime.json', deps), null);
  const bad = { readFileSync: () => '{not json' };
  assert.equal(readPointerFile('/x/runtime.json', bad), null);
  const arr = { readFileSync: () => '[1,2]' };
  assert.equal(readPointerFile('/x/runtime.json', arr), null);
});

test('pidAlive：当前进程存活 ⇒ true；非法/不存在 pid ⇒ false', () => {
  assert.equal(pidAlive(process.pid), true);
  assert.equal(pidAlive(0), false);
  assert.equal(pidAlive(-1), false);
  assert.equal(pidAlive('123'), false);
  assert.equal(pidAlive(999999999), false);
});

// ---- 事故现场：四个检出码 ---------------------------------------------------

/** 注入全部副作用：exists/pidAlive/probeHealth/readPointerFile */
function depsFor({ newPointer = null, legacyPointer = null, missingPaths = [], livePids = [], liveUrls = [] } = {}) {
  return {
    readPointerFile: (file) => (file.includes('MeerkatTaskPanel') ? newPointer : legacyPointer),
    exists: (p) => !missingPaths.includes(p),
    pidAlive: (pid) => livePids.includes(pid),
    probeHealth: async (url) => liveUrls.includes(url),
  };
}

const LEGACY_FILE = path.join(HOME, 'Library', 'Application Support', 'TaskPanel', 'runtime.json');
const NEW_FILE = path.join(HOME, 'Library', 'Application Support', 'MeerkatTaskPanel', 'runtime.json');

test('事故现场（复刻 2026-10-12 实测）：新名缺失 + 旧名指针指向已删旧仓 + 旧名 taskd 仍在应答 ⇒ 全检出、ok:false', async () => {
  const legacyPointer = {
    url: 'http://127.0.0.1:9527',
    dataDir: '/Users/tanyu/Documents/task-panel/.data',
    pid: 77976,
    version: '1.0.0',
  };
  const report = await inspect({
    platform: 'darwin',
    env: {},
    home: HOME,
    deps: depsFor({
      newPointer: null,
      legacyPointer,
      missingPaths: [legacyPointer.dataDir],
      livePids: [77976], // 旧名 taskd 仍在（事故现场：pid 存活）
      liveUrls: [legacyPointer.url],
    }),
  });
  const codes = report.findings.map((f) => f.code).sort();
  assert.deepEqual(codes, ['legacy_daemon_live', 'legacy_data_dir_missing', 'legacy_only']);
  assert.equal(report.ok, false, '检出任一 ⇒ ok:false（不得静默）');
  assert.equal(report.expected, NEW_FILE);
  assert.equal(report.legacy, LEGACY_FILE);
});

test('健康：新名指针命中、pid 存活、dataDir 存在、/health 通 ⇒ ok:true、零告警', async () => {
  const pointer = { url: 'http://127.0.0.1:9527', dataDir: '/data/board', pid: 4242 };
  const report = await inspect({
    platform: 'darwin',
    env: {},
    home: HOME,
    deps: depsFor({ newPointer: pointer, legacyPointer: null, livePids: [4242], liveUrls: [pointer.url] }),
  });
  assert.deepEqual(report.findings, []);
  assert.equal(report.ok, true);
});

test('漂移：仅有新名但 dataDir 已消失 ⇒ data_dir_missing', async () => {
  const pointer = { url: 'http://127.0.0.1:9527', dataDir: '/gone/.data', pid: 4242 };
  const report = await inspect({
    platform: 'darwin',
    env: {},
    home: HOME,
    deps: depsFor({ newPointer: pointer, livePids: [4242], liveUrls: [pointer.url], missingPaths: ['/gone/.data'] }),
  });
  assert.deepEqual(report.findings.map((f) => f.code), ['data_dir_missing']);
  assert.equal(report.ok, false);
});

test('两套并存：新名健康但旧名残留 ⇒ legacy_leftover（仍告警，提醒清理）', async () => {
  const pointer = { url: 'http://127.0.0.1:9527', dataDir: '/data/board', pid: 4242 };
  const report = await inspect({
    platform: 'darwin',
    env: {},
    home: HOME,
    deps: depsFor({
      newPointer: pointer,
      legacyPointer: { url: 'http://127.0.0.1:9999', dataDir: '/data/board', pid: 4242 },
      livePids: [4242],
      liveUrls: [pointer.url],
    }),
  });
  assert.deepEqual(report.findings.map((f) => f.code), ['legacy_leftover']);
  assert.equal(report.ok, false);
});

test('两套都无 ⇒ pointer_missing（基座未运行；CLI 会自动拉起）', async () => {
  const report = await inspect({
    platform: 'darwin',
    env: {},
    home: HOME,
    deps: depsFor({ newPointer: null, legacyPointer: null }),
  });
  assert.deepEqual(report.findings.map((f) => f.code), ['pointer_missing']);
});

test('陈旧指针：pid 已死 / health 不通 ⇒ pid_dead + health_failed', async () => {
  const pointer = { url: 'http://127.0.0.1:9527', dataDir: '/data/board', pid: 4242 };
  const report = await inspect({
    platform: 'darwin',
    env: {},
    home: HOME,
    deps: depsFor({ newPointer: pointer, livePids: [], liveUrls: [] }),
  });
  assert.deepEqual(report.findings.map((f) => f.code).sort(), ['health_failed', 'pid_dead']);
});

// ---- CLI 契约 --------------------------------------------------------------

test('CLI：未知参数 ⇒ exit 2（用法错，不误报体检结论）', async () => {
  assert.equal(await main(['--bogus']), 2);
});

test('CLI：--help ⇒ exit 0', async () => {
  assert.equal(await main(['--help']), 0);
});
