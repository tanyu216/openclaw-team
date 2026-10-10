#!/usr/bin/env node
/**
 * trigger-template.mjs — 单一真源：Gateway inline-JS 条件触发脚本正文（trigger body）。
 *
 * 为什么存在（T-20261010-092547）：`install.sh` 的 `write_trigger()` 生成触发脚本、
 * `config/reconcile.mjs` 需要拿「应然正文」与 live `trigger.script` 比对以修复漂移。
 * 若正文模板散在 bash heredoc 里，测试无法构造**逐字节**应然件 ⇒ 漂移检测不可复现。
 * 本模块把模板收敛为可 import 的纯函数：install.sh 用它写文件，测试用它造 fixture。
 *
 * CLI（供 install.sh write_trigger 调用）：
 *   node team/automations/trigger-template.mjs <teamDir> <evalTimeoutS> <evalTimeoutMs> <dargs…>
 *   → stdout = 触发脚本正文（UTF-8）。
 *
 * 约定（勿改，见 team/AUTOMATIONS.md §3.6/§6）：绝对路径；**禁止** `{{…}}` 占位符模板替换；
 * exec() 携带**有界** timeoutSeconds（Gateway 30s 预算内）。
 *
 * `dargs` 是 dispatch.mjs 的作业参数：`poll <agent>` / `patrol` / `check-all`。
 */

import { pathToFileURL } from "node:url";

/**
 * @param {{teamDir:string, dargs:string, evalTimeoutS:number|string, evalTimeoutMs:number|string}} o
 * @returns {string} 触发脚本正文（以单个换行结尾；heredoc 语义）
 */
export function renderTrigger({ teamDir, dargs, evalTimeoutS, evalTimeoutMs }) {
  const cmd = `node ${teamDir}/automations/dispatch.mjs ${dargs}`;
  return (
    [
      `// OpenClaw cron condition-trigger — openclaw-team framework dispatcher (provider-agnostic).`,
      `// Inline JS executed by the Gateway; no brace-template substitution — absolute paths only.`,
      `// Bounded evaluation: exec() timeoutSeconds=${evalTimeoutS} (dispatcher bound ${evalTimeoutMs}ms).`,
      `const res = await exec({ command: "${cmd}", timeoutSeconds: ${evalTimeoutS} });`,
      `const out = String(res?.aggregated ?? res?.stdout ?? res?.output ?? "").trim();`,
      `let r = null; try { r = JSON.parse(out.split("\\n").pop().trim()); } catch (e) { r = null; }`,
      `if (!r || r.fire !== true) { json({ fire: false, state: (r && r.state) || { checkedAt: Date.now() } }); }`,
      `else { json({ fire: true, message: r.message || "", state: r.state || { firedAt: Date.now() } }); }`,
      ``,
    ].join("\n")
  );
}

/** CLI：<teamDir> <evalTimeoutS> <evalTimeoutMs> <dargs…> → stdout 触发脚本正文 */
function main(argv) {
  const [teamDir = "", evalTimeoutS = "", evalTimeoutMs = "", ...dargs] = argv;
  process.stdout.write(renderTrigger({ teamDir, dargs: dargs.join(" "), evalTimeoutS, evalTimeoutMs }));
}

// 仅当作为 CLI 调用时执行（被 import 时无副作用）。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2));
}
