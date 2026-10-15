#!/usr/bin/env node
/**
 * taskd-pointer-doctor.mjs — taskd 运行期指针（runtime pointer）只读体检（B 面，T-20261012-001338）
 *
 * 缺陷背景（Elon 2026-10-12 实测）：基座改名后，CLI 按**新名**找指针
 *   ~/Library/Application Support/MeerkatTaskPanel/runtime.json（缺失），
 * 而**旧名**目录里还留着实指针
 *   ~/Library/Application Support/TaskPanel/runtime.json，
 * 其 `dataDir` 指向**已删除的旧仓**（形如 `<已删检出>/.data`），taskd 由旧路径拉起
 * ⇒ CLI 直连「started but never answered /health」类**静默**失败（看起来像基座挂了，其实是两个名字各写各的）。
 *
 * 本脚本是**只读诊断**：只 stat / 读 JSON / 对 pid 做 kill -0 / 可选探测 /health。
 * **不启动、不重启、不移动、不删除任何指针或目录**（live 运维动作按卡边界只给步骤，由 Elon 触发）。
 *
 * 指针路径口径**对标 provider**：`meerkat-taskpanel` 的 `src/shared/runtime-locator.mjs#resolveRuntimePointerPath`
 *   `TASKD_RUNTIME_POINTER` > macOS `<home>/Library/Application Support/MeerkatTaskPanel/runtime.json`
 *   > 其它平台 `<XDG_STATE_HOME|~/.local/state>/meerkat-taskpanel/runtime.json`
 * 该规则在此**显式复刻**（provider 有意不随仓、不 import 其内部）；改名前后两套名字都查，命名的单一裁决是
 * **新名 `MeerkatTaskPanel`**（旧名 `TaskPanel` 仅作为「需要迁移的遗留」被检出并告警）。
 *
 * 用法：node scripts/taskd-pointer-doctor.mjs [--json] [--no-probe]
 * 退出码：0 = 新名指针健康；1 = 检出漂移/陈旧（告警，含 legacy-only / dataDir 缺失 / pid 已死 / health 不通）；2 = 用法错。
 * 信封：末行 JSON `{"ok":<bool>,...}`（与 check-all 同口径，供 dispatcher 归一）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 新名（唯一裁决）与旧名的指针目录名（darwin）；非 darwin 走 XDG 状态目录下的包名（provider 口径）。 */
export const POINTER_DIR_NEW = 'MeerkatTaskPanel';
export const POINTER_DIR_LEGACY = 'TaskPanel';
/** 非 darwin 的 XDG 状态目录名 = provider 包名（**不是** darwin 目录名的小写化）。 */
export const POINTER_XDG_DIR = { [POINTER_DIR_NEW]: 'meerkat-taskpanel', [POINTER_DIR_LEGACY]: 'task-panel' };
const POINTER_FILE = 'runtime.json';

/**
 * 指针文件路径（纯路径运算，不触盘）。`dirName` 为平台目录名（新名/旧名）。
 * @param {{dirName: string, platform?: string, env?: object, home?: string}} opts
 * @returns {string}
 */
export function pointerPathFor({ dirName, platform = process.platform, env = process.env, home = os.homedir() }) {
  const override = dirName === POINTER_DIR_NEW ? env.TASKD_RUNTIME_POINTER : undefined;
  if (typeof override === 'string' && override.trim() !== '') return path.resolve(override); // provider 的显式覆盖（只对新名生效）
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', dirName, POINTER_FILE);
  const xdg = env.XDG_STATE_HOME;
  const base = typeof xdg === 'string' && xdg.trim() !== '' ? path.resolve(xdg) : path.join(home, '.local', 'state');
  return path.join(base, POINTER_XDG_DIR[dirName] ?? dirName, POINTER_FILE);
}

/** 读指针文件（缺失/坏 JSON ⇒ null，绝不抛）。`reader` 可注入（单测隔离）。 */
export function readPointerFile(file, { readFileSync = fs.readFileSync } = {}) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** pid 是否存活（kill -0；无权限/异常按「未知」= false 处理）。 */
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** 探测 /health（任意 `status:"ok"`（信封内或外）算通；异常 = false）。 */
export async function probeHealth(url, { timeoutMs = 1500 } = {}) {
  if (typeof url !== 'string' || url.trim() === '') return false;
  try {
    const res = await fetch(`${url.replace(/\/+$/, '')}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return false;
    const body = await res.json();
    return body?.status === 'ok' || body?.data?.status === 'ok';
  } catch {
    return false;
  }
}

/**
 * 体检（可注入，供单测）。只读；不产生任何副作用。
 * @param {{platform?: string, env?: object, home?: string, probe?: boolean, deps?: object}} [opts]
 * @returns {Promise<{ok: boolean, expected: string, legacy: string, findings: Array<{code: string, severity: string, detail: string}>, pointer: object|null, legacyPointer: object|null}>}
 */
export async function inspect(opts = {}) {
  const { platform = process.platform, env = process.env, home = os.homedir(), probe = true } = opts;
  const deps = { readPointerFile, pidAlive, probeHealth, exists: (p) => fs.existsSync(p), ...(opts.deps ?? {}) };
  const expected = pointerPathFor({ dirName: POINTER_DIR_NEW, platform, env, home });
  const legacy = pointerPathFor({ dirName: POINTER_DIR_LEGACY, platform, env, home });

  const pointer = deps.readPointerFile(expected);
  const legacyPointer = deps.readPointerFile(legacy);
  const findings = [];

  if (pointer === null) {
    findings.push(
      legacyPointer !== null
        ? {
            code: 'legacy_only',
            severity: 'warn',
            detail: `新名指针缺失、旧名指针仍在：${legacy} —— 基座改名未迁移，CLI 会另起一个 taskd（典型症状「started but never answered /health」）`,
          }
        : { code: 'pointer_missing', severity: 'warn', detail: `新名指针不存在：${expected}（基座未运行；CLI 会自动拉起并在此处写指针）` },
    );
  } else {
    if (typeof pointer.url !== 'string' || pointer.url.trim() === '') {
      findings.push({ code: 'pointer_malformed', severity: 'warn', detail: `指针无 url 字段：${expected}` });
    }
    if (!deps.pidAlive(pointer.pid)) {
      findings.push({
        code: 'pid_dead',
        severity: 'warn',
        detail: `指针 pid=${pointer.pid} 已不存在（陈旧指针；CLI 会忽略它并另起 taskd）`,
      });
    }
    if (typeof pointer.dataDir === 'string' && pointer.dataDir.trim() !== '' && !deps.exists(pointer.dataDir)) {
      findings.push({
        code: 'data_dir_missing',
        severity: 'warn',
        detail: `指针 dataDir 不存在：${pointer.dataDir}（指向已删除/搬迁的旧仓 —— board 会把数据写到那里）`,
      });
    }
    if (probe && typeof pointer.url === 'string' && !(await deps.probeHealth(pointer.url))) {
      findings.push({ code: 'health_failed', severity: 'warn', detail: `${pointer.url}/health 未应答` });
    }
  }

  if (legacyPointer !== null && pointer !== null) {
    // 两套指针并存且新名也有 ⇒ 旧名是残留（未清理），仍是漂移信号（但不阻断）。
    findings.push({
      code: 'legacy_leftover',
      severity: 'warn',
      detail: `旧名指针仍残留（应归档/删除以免误导排查）：${legacy}`,
    });
  }
  if (legacyPointer !== null) {
    // 旧名指针的**内容**也体检一次：事故现场正是「旧名指针 + dataDir 指向已删旧仓 + pid 已死」。
    if (typeof legacyPointer.dataDir === 'string' && legacyPointer.dataDir.trim() !== '' && !deps.exists(legacyPointer.dataDir)) {
      findings.push({
        code: 'legacy_data_dir_missing',
        severity: 'warn',
        detail: `旧名指针 dataDir 不存在：${legacyPointer.dataDir}（事故现场：指向已删除的旧仓，board 数据会写到那里）`,
      });
    }
    if (!deps.pidAlive(legacyPointer.pid)) {
      findings.push({ code: 'legacy_pid_dead', severity: 'warn', detail: `旧名指针 pid=${legacyPointer.pid} 已不存在（由旧路径拉起的 taskd 已死/已换）` });
    }
    // 旧名 taskd 仍在应答 ⇒ 端口被占 + 数据写在已删除的旧仓（最危险的一种：看起来「基座正常」）。
    if (probe && typeof legacyPointer.url === 'string' && (await deps.probeHealth(legacyPointer.url))) {
      findings.push({
        code: 'legacy_daemon_live',
        severity: 'warn',
        detail: `旧名 taskd 仍在 ${legacyPointer.url} 应答（端口被占；它把 board 写在 ${legacyPointer.dataDir} —— 迁移前须先停掉它，否则新 taskd 起不来/数据分叉）`,
      });
    }
  }

  return { ok: findings.length === 0, expected, legacy, findings, pointer, legacyPointer };
}

/** 渲染人读输出（stdout 给 JSON 信封时，人读走 stderr —— 与 check-all/taskctl 同口径）。 */
export function renderHuman(report, out = (s) => process.stderr.write(s)) {
  const same = report.expected === report.legacy;
  out(`新名指针（裁决）：${report.expected}\n`);
  if (!same) out(`旧名指针（遗留）：${report.legacy}\n`);
  if (report.findings.length === 0) out('✔ 指针健康：新名路径命中、pid 存活、dataDir 存在、/health 通\n');
  for (const f of report.findings) out(`⚠ [${f.severity}/${f.code}] ${f.detail}\n`);
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log('用法: node scripts/taskd-pointer-doctor.mjs [--json] [--no-probe]');
    return 0;
  }
  const known = argv.filter((a) => !['--json', '--no-probe'].includes(a));
  if (known.length) {
    console.error(`未知参数: ${known.join(' ')}（用法: --json / --no-probe）`);
    return 2;
  }
  const report = await inspect({ probe: !argv.includes('--no-probe') });
  renderHuman(report);
  if (argv.includes('--json')) {
    console.log(JSON.stringify({ ok: report.ok, expected: report.expected, legacy: report.legacy, findings: report.findings }));
  }
  return report.ok ? 0 : 1;
}

// main-guard：经 realpath 归一后比较（与 lib.mjs 同口径），符号链接调用亦能命中
try {
  const self = fs.realpathSync(new URL(import.meta.url));
  const arg = fs.realpathSync(path.resolve(process.argv[1]));
  if (arg === self) main().then((code) => process.exit(code));
} catch { /* realpath 失败 ⇒ 视为被 import，不执行 main */ }
