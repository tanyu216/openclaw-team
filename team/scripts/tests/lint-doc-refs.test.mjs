/**
 * lint-doc-refs.test.mjs — 文档路径引用门禁的行为契约。
 *
 * 两道防线都要钉住：
 *   ① **真问题必红** —— 方法库指针断了（历史实证：`roles/turing/guides/` 从未存在）必须判红；
 *   ② **误报必零** —— 扩展名散文（`.md`）、运行时点文件（`.claude/settings.json`）、
 *      provider 侧路径（`skills/**`，有意不随仓）、实例/运行时路径（`workspace/…`）一律不得判红。
 * ② 与 ① 同等重要：一个上线即红的门会被立刻关掉，等于没有。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../lint-doc-refs.mjs', import.meta.url));
const { extractPathRefs, skipReason, lintDocRefs } = await import('../lint-doc-refs.mjs');

let ROOT;
/** 造一个「最小分发仓」：repo 模式只扫 `<repo>/team` 与 `<repo>/roles`。 */
before(() => {
  ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-docrefs-'));
  const put = (rel, body = '') => {
    const p = path.join(ROOT, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  };
  put('install.sh');
  put('roles/elon/AGENTS.md');
  put('roles/linus/AGENTS.md', 'see `guides/linus-only.md`\n');
  put('roles/linus/guides/linus-only.md');
  put('team/PROTOCOL.md');
  put('team/guides/shared.md');
  put('team/AUTOMATIONS.md');
  put('team/automations/README.md', 'see `../AUTOMATIONS.md`\n');
  put('team/scripts/tests/real.test.mjs');
  put('team/guides/refs.md', [
    'ok: `team/guides/shared.md`',
    'ok-team-guide: `guides/shared.md`',
    'ok-tests-shorthand: `tests/real.test.mjs`',
    'skip-extension: `.md` / `.json`',
    'skip-runtime: `.claude/settings.json` / `.ui-align.json`',
    'skip-not-vendored: `skills/task-ops/lib/task.mjs`',
    'skip-external: `src/core/storage/md/import.mjs` and `workspace/T-1/x.md`',
    'skip-bare: `dispatch.mjs` and `providers.json`',
    'skip-url: `https://example.com/a.md`',
    '```',
    'skip-fenced: `team/guides/nope.md`',
    '```',
    '',
  ].join('\n'));
});
after(() => { fs.rmSync(ROOT, { recursive: true, force: true }); });

const M = () => ({ mode: 'repo', repo: ROOT, team: path.join(ROOT, 'team'), home: path.join(ROOT, 'home') });
const lint = () => lintDocRefs(M());

test('提取：反引号命令里只取像路径的词；散文裸路径不取', () => {
  assert.deepEqual(extractPathRefs('run `node team/scripts/a.mjs --x` now'), ['team/scripts/a.mjs']);
  assert.deepEqual(extractPathRefs('see `providers.json` and dispatch.mjs'), []);
  assert.deepEqual(extractPathRefs('[t](team/guides/shared.md)'), ['team/guides/shared.md']);
});

test('跳过规则各自生效（每一类都不得进检查面）', () => {
  assert.equal(skipReason('.md'), 'dotfile-or-extension');
  assert.equal(skipReason('.claude/settings.json'), 'dotfile-or-extension');
  assert.equal(skipReason('skills/task-ops/lib/task.mjs'), 'not-vendored');
  assert.equal(skipReason('src/core/storage/md/import.mjs'), 'external');
  assert.equal(skipReason('workspace/T-1/x.md'), 'external');
  assert.equal(skipReason('https://example.com/a.md'), 'url');
  assert.equal(skipReason('~/x/y.md'), 'host-path');
  assert.equal(skipReason('a/<id>.md'), 'placeholder');
  assert.equal(skipReason('team/guides/shared.md'), '');   // 检查面
  assert.equal(skipReason('guides/shared.md'), '');        // 检查面（层根简写）
  assert.equal(skipReason('../AUTOMATIONS.md'), '');       // 检查面（相对引用）
});

test('基线：仓内一切可解析 ⇒ 零断引用', () => {
  const { bad, checked } = lint();
  assert.deepEqual(bad, [], `不应有断引用：${JSON.stringify(bad)}`);
  assert.ok(checked > 0, '必须真的检查了引用（否则门是空的）');
});

test('突变：真问题必红 —— 角色方法库指针断', () => {
  const saved = fs.readFileSync(path.join(ROOT, 'roles/linus/AGENTS.md'), 'utf8');
  fs.writeFileSync(path.join(ROOT, 'roles/linus/AGENTS.md'), 'see `guides/never-built.md`\n');
  try {
    const { bad } = lint();
    assert.equal(bad.length, 1);
    assert.equal(bad[0].token, 'guides/never-built.md');
    assert.equal(bad[0].file, path.join('roles', 'linus', 'AGENTS.md'));
  } finally { fs.writeFileSync(path.join(ROOT, 'roles/linus/AGENTS.md'), saved); }
});

test('突变：真问题必红 —— team 侧断引用；且恢复后回绿', () => {
  const f = path.join(ROOT, 'team/guides/refs.md');
  const saved = fs.readFileSync(f, 'utf8');
  fs.writeFileSync(f, saved + '\ndangling: `team/guides/nope.md`\n');
  try {
    const { bad } = lint();
    assert.equal(bad.length, 1);
    assert.equal(bad[0].token, 'team/guides/nope.md');
  } finally { fs.writeFileSync(f, saved); }
  assert.deepEqual(lint().bad, []);
});

test('突变：fenced code block 内的引用不检查（不得因示例而红）', () => {
  const f = path.join(ROOT, 'team/guides/refs.md');
  const saved = fs.readFileSync(f, 'utf8');
  try {
    assert.deepEqual(lint().bad, []);
  } finally { fs.writeFileSync(f, saved); }
});

test('CLI：断引用 ⇒ exit 1 且打印位置；干净 ⇒ exit 0', () => {
  const f = path.join(ROOT, 'team/guides/refs.md');
  const saved = fs.readFileSync(f, 'utf8');
  try {
    let out = execFileSync(process.execPath, [CLI, '--repo', ROOT], { encoding: 'utf8' });
    assert.match(out, /全部可解析/);
  } catch (e) { assert.fail(`干净树应 exit 0，实得 ${e.status}：${e.stdout}`); }

  fs.writeFileSync(f, saved + '\nbad: `team/guides/gone.md`\n');
  let failed = false;
  try { execFileSync(process.execPath, [CLI, '--repo', ROOT], { encoding: 'utf8' }); }
  catch (e) {
    failed = true;
    assert.equal(e.status, 1);
    assert.match(e.stdout, /断引用 team\/guides\/gone\.md/);
  } finally { fs.writeFileSync(f, saved); }
  assert.ok(failed, '断引用必须非零退出（否则 check-all 的 run() 捕不到）');
});
