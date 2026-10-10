#!/usr/bin/env node
/**
 * archive.test.mjs — archive.mjs 回归测试（读侧 frontmatter 解析收敛）
 *
 * 背景：archive.mjs 曾用 /^status:\s*(\S+)/m 自建正则取 status，
 *   `status: "done"`（带引号）时取到 `"done"`（含引号），`!== 'done'` ⇒ 静默不归档。
 * 本套件不 mock 内部函数：只真实读写临时目录，通过真实 CLI 子进程跑 archive.mjs。
 * 运行：node --test scripts/tests/archive.test.mjs
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { serializeFrontmatter } from '../lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ARCHIVE = path.join(HERE, '..', 'archive.mjs');

const scratchDirs = [];
/** 建临时 team-root（含 tasks/），返回 { root, tasks } */
function mkTeam() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-archive-'));
  scratchDirs.push(root);
  const tasks = path.join(root, 'tasks');
  fs.mkdirSync(tasks, { recursive: true });
  return { root, tasks };
}
after(() => {
  for (const d of scratchDirs) fs.rmSync(d, { recursive: true, force: true });
});

/** 用 lib.serializeFrontmatter 写一张最小任务卡，返回卡绝对路径 */
function writeCard(tasks, id, status, extra = {}) {
  const fm = {
    __order: ['id', 'title', 'assignee', 'status', 'goal', 'project', ...Object.keys(extra)],
    id,
    title: `卡 ${id}`,
    assignee: 'elon',
    status,
    goal: '回归测试用卡',
    project: '__team__',
    ...extra,
  };
  const p = path.join(tasks, `${id}.md`);
  fs.writeFileSync(p, serializeFrontmatter(fm, '## Body\n正文\n'), 'utf8');
  return p;
}

/** 把卡 mtime 设到过去（120s 前），确保 --days 0 的 cutoff 命中 */
function ageCard(card) {
  const pastSec = Date.now() / 1000 - 120;
  fs.utimesSync(card, pastSec, pastSec);
}

/** 以独立进程跑真实 archive CLI，返回 stdout */
function runArchive(root, args = ['--days', '0']) {
  return execFileSync('node', [ARCHIVE, ...args], {
    env: { ...process.env, OPENCLAW_TEAM_ROOT: root },
    encoding: 'utf8',
  });
}

const archivedOf = (out) => Number((/archived=(\d+)/.exec(out) || [])[1]);
const wouldArchiveOf = (out) => Number((/would-archive=(\d+)/.exec(out) || [])[1]);

/** 在 tasks/archive/ 下递归查找被归档的卡，返回其路径（未找到返回 null） */
function findArchived(tasks, id) {
  const archRoot = path.join(tasks, 'archive');
  if (!fs.existsSync(archRoot)) return null;
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { const r = walk(p); if (r) return r; }
      else if (e.name === `${id}.md`) return p;
    }
    return null;
  };
  return walk(archRoot);
}

// ---- 用例 1（回归核心）：status 带双引号 ------------------------------------
test('回归核心：status:"done"（带双引号）+ 旧 mtime ⇒ archived=1 且移到 archive/', () => {
  const { root, tasks } = mkTeam();
  const id = 'T-20260101-000001-quoted';
  const card = writeCard(tasks, id, 'done');
  // serializeFrontmatter 不会给无特殊字符的 done 加引号；此处手工制造旧 bug 的触发形态
  const raw = fs.readFileSync(card, 'utf8').replace(/^status: done$/m, 'status: "done"');
  fs.writeFileSync(card, raw, 'utf8');
  ageCard(card);

  const out = runArchive(root);
  assert.equal(archivedOf(out), 1, `应归档 1 张，stdout: ${out}`);

  const moved = findArchived(tasks, id);
  assert.ok(moved, `被归档文件应存在于 tasks/archive/ 下，stdout: ${out}`);
  assert.ok(moved.includes(`${path.sep}tasks${path.sep}archive${path.sep}`), `归档路径应含 tasks/archive/: ${moved}`);
  assert.equal(fs.existsSync(path.join(tasks, `${id}.md`)), false, '原 tasks/ 下的卡应被移走');
});

// ---- 用例 2（基线）：status 不带引号 ----------------------------------------
test('基线：status: done（不带引号）⇒ archived=1', () => {
  const { root, tasks } = mkTeam();
  const id = 'T-20260101-000002-plain';
  const card = writeCard(tasks, id, 'done');
  ageCard(card);

  const out = runArchive(root);
  assert.equal(archivedOf(out), 1, `stdout: ${out}`);
  assert.ok(findArchived(tasks, id), '卡应被归档');
});

// ---- 用例 3：非终态不归档 ---------------------------------------------------
test('status: in_progress ⇒ archived=0 且仍在 tasks/', () => {
  const { root, tasks } = mkTeam();
  const id = 'T-20260101-000003-wip';
  const card = writeCard(tasks, id, 'in_progress');
  ageCard(card);

  const out = runArchive(root);
  assert.equal(archivedOf(out), 0, `stdout: ${out}`);
  assert.equal(fs.existsSync(path.join(tasks, `${id}.md`)), true, '卡应仍在 tasks/');
});

// ---- 用例 4：引用保护 -------------------------------------------------------
test('引用保护：被 parent / depends_on 引用的终态卡 ⇒ archived=0', () => {
  // (a) parent 引用
  const a = mkTeam();
  const epicId = 'T-20260101-000010-epic';
  const childId = 'T-20260101-000011-child';
  const epic = writeCard(a.tasks, epicId, 'done');
  ageCard(epic);
  writeCard(a.tasks, childId, 'in_progress', { parent: epicId });

  let out = runArchive(a.root);
  assert.equal(archivedOf(out), 0, `parent 引用应阻止归档，stdout: ${out}`);
  assert.equal(fs.existsSync(path.join(a.tasks, `${epicId}.md`)), true, '被 parent 引用的卡不应归档');

  // (b) depends_on 引用
  const b = mkTeam();
  const depId = 'T-20260101-000020-dep';
  const targetId = 'T-20260101-000021-target';
  const dep = writeCard(b.tasks, depId, 'done');
  ageCard(dep);
  writeCard(b.tasks, targetId, 'in_progress', { depends_on: `[${depId}]` });

  out = runArchive(b.root);
  assert.equal(archivedOf(out), 0, `depends_on 引用应阻止归档，stdout: ${out}`);
  assert.equal(fs.existsSync(path.join(b.tasks, `${depId}.md`)), true, '被 depends_on 引用的卡不应归档');
});

// ---- 用例 5（T-20261010-055607）：--dry-run 必须真只读 ----------------------
test('--dry-run：真只读——报 would-archive=1 但不移动、不建 archive/、不改 mtime', () => {
  const { root, tasks } = mkTeam();
  const id = 'T-20260101-000030-dry';
  const card = writeCard(tasks, id, 'done');
  ageCard(card);
  const before = fs.statSync(card).mtimeMs;

  const out = runArchive(root, ['--days', '0', '--dry-run']);
  assert.equal(wouldArchiveOf(out), 1, `应报将归档 1 张，stdout: ${out}`);
  assert.ok(!/archived=/.test(out), `dry-run 不得报 archived=…（不得暗示已归档），stdout: ${out}`);
  assert.match(out, /no files moved/, `dry-run 输出应显式声明未移动文件，stdout: ${out}`);
  assert.equal(fs.existsSync(card), true, 'dry-run 不得移动原卡');
  assert.equal(findArchived(tasks, id), null, 'dry-run 不得写入 archive/');
  assert.equal(fs.existsSync(path.join(tasks, 'archive')), false, 'dry-run 不得创建 archive/ 目录');
  assert.equal(fs.statSync(card).mtimeMs, before, 'dry-run 不得改动卡 mtime');
});

// ---- 用例 6：dry-run 与真实归档同规则同计数（口径一致） --------------------
test('--dry-run 计数与默认（写）模式一致——同规则、只差是否落盘', () => {
  const a = mkTeam();
  const card = writeCard(a.tasks, 'T-20260101-000040-parity', 'done');
  ageCard(card);
  const dry = runArchive(a.root, ['--days', '0', '--dry-run']);
  const real = runArchive(a.root, ['--days', '0']);
  assert.equal(wouldArchiveOf(dry), archivedOf(real), `dry: ${dry} / real: ${real}`);
  assert.equal(archivedOf(real), 1, `默认模式仍须真归档，stdout: ${real}`);
});

// ---- 用例 7（防回归核心）：check-all 不得退回写模式 -------------------------
test('防回归：check-all.sh 的归档步骤必须显式 --dry-run（不得退化为真移动）', () => {
  const sh = fs.readFileSync(path.join(HERE, '..', 'check-all.sh'), 'utf8');
  const line = sh.split('\n').find((l) => l.includes('archive.mjs'));
  assert.ok(line, 'check-all.sh 应含 archive.mjs 调用');
  assert.match(line, /--dry-run/, `check-all.sh 归档步骤须带 --dry-run，实际: ${line}`);
});
