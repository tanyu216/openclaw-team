/**
 * lint-doc-refs.test.mjs — 文档引用门禁的行为契约（三腿：文件路径 + 跨文件章节锚 + 节内条款号）。
 *
 * 两道防线都要钉住：
 *   ① **真问题必红** —— 方法库指针断了（历史实证：`roles/turing/guides/` 从未存在）、
 *      跨文件章节锚断了（历史实证：`§6.3` / `§3.3` 写成子标题而目标无此标题）、
 *      节内条款号断了（本腿上线首跑即抓到 `worker-report-template.md` 的
 *      `PROTOCOL §⑥ clause 13` —— §⑥ 只有 8 条，实指 `§⑥.1` 第 13 条）必须判红；
 *   ② **误报必零** —— 扩展名散文（`.md`）、运行时点文件（`.claude/settings.json`）、
 *      provider 侧路径（`skills/**`，有意不随仓）、实例/运行时路径（`workspace/…`）、
 *      **目标文件没有编号标题**（如空的 `shared.md`）、**体不是 `1..n` 连续顶层有序列表**
 *      （表格 / 体内跳号）、**裸阿拉伯 `#K`**（本仓表示表格行）一律不得判红。
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
const { extractPathRefs, extractSectionRefs, extractItemRefs, skipReason, lintDocRefs } =
  await import('../lint-doc-refs.mjs');

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
  // 第三腿夹具：圈码锚恒指 `PROTOCOL.md` ⇒ 给它一个 `### ⑥.1` 带 11 条顶层有序项。
  put('team/PROTOCOL.md',
    `## ⑥ S\n### ⑥.1 Q\n${Array.from({ length: 11 }, (_, i) => `${i + 1}. item ${i + 1}`).join('\n')}\n`);
  put('team/guides/shared.md');
  // 第二腿夹具：一份**有编号标题**的目标（`## 3` / `## 6` + `### 6.3`），用以证 §N 的解析语义。
  put('team/guides/numbered.md', '## 3. Steps\n1. one\n## 6. Invariants\n### 6.3 Sub\ntext\n');
  // 第三腿夹具：有序列表 / 嵌套重启 / 表格 / 顶层重启，四种体各一。
  put('team/guides/items.md', [
    '## 6. Invar', '1. a', '2. b', '3. c', '',
    '### 6.1 Sub', '1. x', '',                       // 子节重启：不得串进 §6
    '## 7. Tbl', '| # | F |', '|---|---|', '| 1 | q |', '',
    '## 8. Restart', '1. a', '2. b', '### 8.1 More', '1. z', '',
    '## 9. Jumbled', '1. a', '3. c', '',               // 体内跳号 ⇒ 不可判定
  ].join('\n'));
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
    'ok-secref: `guides/numbered.md` §3',
    'ok-secref-child: `guides/numbered.md` §6.3',
    'ok-secref-parent: `guides/numbered.md` §6',
    'ok-secref-list: `guides/numbered.md` §3 / §6.3',
    'skip-secref-noheading: `guides/shared.md` §9',
    'skip-secref-self: see §3.3',            // 无文件名 ⇒ 文件内一类，本腿**有意**不判
    'ok-itemref-file: `guides/items.md` §6 clause 3',
    'ok-itemref-file-step: `guides/items.md` §6 step 2',
    'ok-itemref-circ: PROTOCOL §⑥.1 clause 11',
    'ok-itemref-circ-hash: PROTOCOL §⑥.1 #8',
    // **不识别**的三类：裸阿拉伯 #K（本仓表示表格行）、无文件锚的 step、U+2011 连字符节号
    'skip-itemref-bare-hash: the contract §4 #9',
    'skip-itemref-no-file: see §4.1 step 3',
    'skip-itemref-u2011: §6.3‑A step 3',
    '```',
    'skip-fenced: `team/guides/nope.md`',
    'skip-fenced-secref: `guides/numbered.md` §9',
    'skip-fenced-itemref: `guides/items.md` §6 clause 99',
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

// ── 第二腿：跨文件章节锚（`<name>.md §N` / `§N.M`）────────────────────────

test('提取：只取 `§` **紧邻**文件名的跨文件锚；文件内与圈码一概不取', () => {
  assert.deepEqual(extractSectionRefs('see `guides/a.md` §6.3'), [{ file: 'guides/a.md', nums: ['6.3'] }]);
  assert.deepEqual(extractSectionRefs('`guides/a.md` §3 / §4 / §6.3'),
    [{ file: 'guides/a.md', nums: ['3', '4', '6.3'] }]);
  // `§` 不紧邻文件名 ⇒ 指自己所在文件：本腿**有意**只做跨文件（文件内编号可能有意变动）
  assert.deepEqual(extractSectionRefs('see `guides/a.md`; also §3.3'), []);
  assert.deepEqual(extractSectionRefs('see §3.3'), []);
  // 圈码引用是 `lint-refs.mjs` 的领域（且只对 PROTOCOL.md），本腿不碰
  assert.deepEqual(extractSectionRefs('see `team/PROTOCOL.md` §⑥.4'), []);
});

test('基线（含第二腿）：路径锚与章节锚一起零断引用', () => {
  const { bad, sectionChecked } = lint();
  assert.deepEqual(bad, [], `不应有断引用：${JSON.stringify(bad)}`);
  assert.ok(sectionChecked > 0, '必须真的检查了章节锚（否则第二腿是空的）');
});

test('突变：章节锚断了必红 —— §N 指向目标没有的编号', () => {
  const f = path.join(ROOT, 'team/guides/refs.md');
  const saved = fs.readFileSync(f, 'utf8');
  fs.writeFileSync(f, saved + '\nbad-secref: `guides/numbered.md` §9\n');
  try {
    const { bad } = lint();
    assert.equal(bad.length, 1, `应恰好一条：${JSON.stringify(bad)}`);
    assert.equal(bad[0].token, 'guides/numbered.md §9');
  } finally { fs.writeFileSync(f, saved); }
  assert.deepEqual(lint().bad, [], '恢复后须回绿');
});

test('§N 语义 = 「N 这一节**及其子节**」：只有 ### 6.3 时 §6 照样命中', () => {
  const f = path.join(ROOT, 'team/guides/numbered.md');
  const saved = fs.readFileSync(f, 'utf8');
  fs.writeFileSync(f, '## 3. Steps\n### 6.3 Sub\ntext\n');   // 去掉 `## 6`，只留子节
  try {
    assert.deepEqual(lint().bad, [], '§6 不得因为父标题不在而误报');
  } finally { fs.writeFileSync(f, saved); }
});

test('目标文件不存在 ⇒ 本腿不判（那是路径腿的职责，不得同一处报两条）', () => {
  const f = path.join(ROOT, 'team/guides/refs.md');
  const saved = fs.readFileSync(f, 'utf8');
  fs.writeFileSync(f, saved + '\nabsent: `guides/absent.md` §3\n');
  try {
    const { bad } = lint();
    assert.equal(bad.length, 1, `应只有路径腿那一条：${JSON.stringify(bad)}`);
    assert.equal(bad[0].token, 'guides/absent.md');
  } finally { fs.writeFileSync(f, saved); }
});

// ── 第三腿：节内条款号（`§N clause M` / `§N step M` / `§N.M #M`）─────────────

test('提取：只收目标可判定的三类；裸阿拉伯 #K 等三类一概不取', () => {
  assert.deepEqual(extractItemRefs('x `guides/a.md` §6 clause 3'),
    [{ file: 'guides/a.md', sec: '6', kind: 'clause', item: 3 }]);
  assert.deepEqual(extractItemRefs('x `guides/a.md` §3 step 2'),
    [{ file: 'guides/a.md', sec: '3', kind: 'step', item: 2 }]);
  assert.deepEqual(extractItemRefs('x PROTOCOL §⑥.1 clause 11'),
    [{ file: null, sec: '⑥.1', kind: 'clause', item: 11 }]);
  assert.deepEqual(extractItemRefs('x `§⑥.1` clause 11'),        // 反引号拆写
    [{ file: null, sec: '⑥.1', kind: 'clause', item: 11 }]);
  assert.deepEqual(extractItemRefs('x §⑥.1 hard gate #1'),
    [{ file: null, sec: '⑥.1', kind: '#', item: 1 }]);
  // 不识别：裸阿拉伯 #K（本仓 = 表格行）、无文件锚的 step、非识别标记词、U+2011
  assert.deepEqual(extractItemRefs('the contract §4 #9'), []);
  assert.deepEqual(extractItemRefs('see §4.1 step 3'), []);
  assert.deepEqual(extractItemRefs('see §8.3 rule 5'), []);
  assert.deepEqual(extractItemRefs('§6.3‑A step 3'), []);
});

test('基线（含第三腿）：条目锚与其它两腿一起零断引用', () => {
  const { bad, itemChecked } = lint();
  assert.deepEqual(bad, [], `不应有断引用：${JSON.stringify(bad)}`);
  assert.ok(itemChecked > 0, '必须真的检查了条目锚（否则第三腿是空的）');
});

test('突变：条目锚断了必红 —— K 超过该节顶层条目数', () => {
  const f = path.join(ROOT, 'team/guides/refs.md');
  const saved = fs.readFileSync(f, 'utf8');
  fs.writeFileSync(f, saved + '\nbad-itemref: `guides/items.md` §6 clause 9\n');
  try {
    const { bad } = lint();
    assert.equal(bad.length, 1, `应恰好一条：${JSON.stringify(bad)}`);
    assert.equal(bad[0].token, 'guides/items.md §6 clause 9');
  } finally { fs.writeFileSync(f, saved); }
  assert.deepEqual(lint().bad, [], '恢复后须回绿');
});

test('突变：圈码锚自动解析到 PROTOCOL（文档不写文件名也判）', () => {
  const f = path.join(ROOT, 'team/guides/refs.md');
  const saved = fs.readFileSync(f, 'utf8');
  fs.writeFileSync(f, saved + '\nbad-circ: PROTOCOL §⑥.1 clause 12\n');
  try {
    const { bad } = lint();
    assert.equal(bad.length, 1, `应恰好一条：${JSON.stringify(bad)}`);
    assert.equal(bad[0].token, 'PROTOCOL §⑥.1 clause 12');
  } finally { fs.writeFileSync(f, saved); }
});

test('嵌套不串节：§6 的 3 条不得把 §6.1 的条目算进来', () => {
  const f = path.join(ROOT, 'team/guides/refs.md');
  const saved = fs.readFileSync(f, 'utf8');
  fs.writeFileSync(f, saved + '\nprobe: `guides/items.md` §6 clause 4\n');
  try {
    const { bad } = lint();
    assert.equal(bad.length, 1, '§6 只有 3 条 ⇒ clause 4 必须红（若绿说明子节被串进来了）');
  } finally { fs.writeFileSync(f, saved); }
  fs.writeFileSync(f, saved + '\nprobe2: `guides/items.md` §6.1 clause 1\n');
  try {
    assert.deepEqual(lint().bad, [], '子节自己的第 1 条须命中');
  } finally { fs.writeFileSync(f, saved); }
});

test('体不可判定 ⇒ 一律 skip，绝不判红（表格 / 体内跳号）；子标题处停止是语义不是歧义', () => {
  const f = path.join(ROOT, 'team/guides/refs.md');
  const saved = fs.readFileSync(f, 'utf8');
  try {
    fs.writeFileSync(f, saved + '\nno-list: `guides/items.md` §7 clause 2\n');
    assert.deepEqual(lint().bad, [], '目标是表格 ⇒ no-list ⇒ skip');
    fs.writeFileSync(f, saved + '\nambiguous: `guides/items.md` §9 clause 4\n');
    assert.deepEqual(lint().bad, [], '体内跳号 ⇒ ambiguous ⇒ skip');
    fs.writeFileSync(f, saved + '\nchildstop: `guides/items.md` §8 clause 4\n');
    assert.equal(lint().bad.length, 1,
      '子标题处停止 ⇒ §8 只有 1..2 ⇒ clause 4 必须红（这是解析语义，不是 ambiguous）');
  } finally { fs.writeFileSync(f, saved); }
});

test('目标文件不存在 ⇒ 第三腿不判（那是路径腿的职责，不得重复报）', () => {
  const f = path.join(ROOT, 'team/guides/refs.md');
  const saved = fs.readFileSync(f, 'utf8');
  fs.writeFileSync(f, saved + '\nabsent: `guides/absent.md` §6 clause 3\n');
  try {
    const { bad } = lint();
    assert.equal(bad.length, 1, `应只有路径腿那一条：${JSON.stringify(bad)}`);
    assert.equal(bad[0].token, 'guides/absent.md');
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
