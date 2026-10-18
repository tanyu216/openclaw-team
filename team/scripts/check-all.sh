#!/usr/bin/env bash
# check-all.sh — 日常巡检门禁聚合（`R-GATE-1`）
# 用法：bash check-all.sh [--segment fast|slow|all] [--report <path>] [--repo <R> | --live]
#   --segment fast  只跑「快门禁」（秒级）：红线一致 / 术语抽象 / §引用可解析 / 文档路径引用 / 依赖 CVE 扫描 /
#                   卡 schema / handoff / 关系不变量 / 幂等 / 会话一致性 /
#                   建卡完备性（epic 子卡完整性 + 路线图×卡 对账）/ 卡面 Report 完备性 / 契约测试 /
#                   ACL 终态守卫 / 项目解析 / 调度求值（provider ACL 4 套快测在此，in-band 即时信号）/ 归档预览
#   --segment slow  只跑「慢套件」（带外刷新）：framework 套件 `node --test scripts/tests/*.test.mjs`
#                   **+ provider ACL 全量** `node --test skills/task-ops/tests/*.test.mjs`（glob 全目录）
#   --segment all   两段都跑（**默认**；人工 / CI 用）。相较历史覆盖，慢段新增 provider ACL 全量（T-20261014-034118）
#   --report <path> 额外把机器可读 verdict 原子写往 <path>（供 check-all-gate.mjs 的异步慢段刷新落缓存）
#   --repo <R>      仓内模式（见下）；--live 反之。也可用 OPENCLAW_TEAM_MODE=live|repo。
# 两种运行模式（本脚本**不再需要本机装实例**）：
#   · **live**：`$TEAM/scripts` 在场 ⇒ 巡检**安装实例**（含卡校验 / 契约测试 / provider 全量 / 归档预览）。
#     今天的行为即此，逐字节不变。
#   · **repo**：没有实例 ⇒ **仓内自证**：语法检查（bash -n / node --check）、三个 lint 的**仓内模式**
#     （校验 `roles/<role>/AGENTS.md` 种子 + `team/**`）、framework 套件。**不读本机任何路径**，
#     依赖实例的步骤显式 skip（不是红）。开放仓的贡献者/CI 走这条路。
#     判定顺序：--live / --repo ⇒ 显式；OPENCLAW_TEAM_MODE ⇒ 指定；否则「有实例走 live，没有走 repo」；
#     两者都不可解析 ⇒ exit 2 并给出指引（**绝不回落 $HOME**，也绝不静默假绿）。
# 为什么要分段（T-20261013-031036）：完整门禁 ≈15-20s，而调度路径的 trigger-eval 预算是
# OPENCLAW_TEAM_EVAL_TIMEOUT_MS（默认 8000ms）⇒ 每次都 eval-timeout、且超时信封不带任何判定
# （真红被遮蔽）。快段可稳稳落进预算，慢套件走 check-all-gate.mjs 的带外刷新 + 缓存判定。
# provider ACL 全量放慢段（T-20261014-034118）：实测这五套缺失套件 ≈6.1s，而快段的在带内上界
# OPENCLAW_TEAM_CHECKALL_FAST_TIMEOUT_MS=6000ms（快段自身实测 warm 2.4-3.7s / cold ≈6.1s，余量已薄）
# ⇒ 若加快段必 fast-timeout（UNCONFIRMED），那正是 `R-GATE-1` 要消除的「真红被超时/降级掩盖」。
# 本脚本为「只读巡检门禁」：任何步骤都不得写 tasks/。归档步骤必须带 --dry-run（真只读，不移动文件）；
# 真实归档由 meerkat-taskpanel(taskctl)/Elon 例行巡检执行（`R-ARCHIVE-1`），不由此门禁代劳。
# 输出信封：末行 JSON {"ok":true|false,"mode":...,...} —— dispatcher 按 ok 归一（ok:false ⇒ fire:true，
# 失败才唤醒模型）；红时信封另带 message（失败项摘要，dispatcher 直接转发给模型）与 failed[]（失败步骤标签）。
set -u
# 团队根目录：默认 ~/.openclaw/team，可用 OPENCLAW_TEAM_ROOT 覆盖（与 lib.mjs / scan-deps.mjs 同源，单测隔离用）。
TEAM="${OPENCLAW_TEAM_ROOT:-${OPENCLAW_HOME:-$HOME/.openclaw}/team}"
fail=0
provider_missing=0
FAILED_STEPS=()          # 失败步骤标签（红时进信封 message/failed[]）
SLOW_FAILED_FILES=()     # 慢套件的失败测试文件 basename（node --test 输出解析）

SEGMENT=all
REPORT=""
CLI_REPO=""
CLI_LIVE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --segment)   SEGMENT="${2:-}"; shift 2 ;;
    --segment=*) SEGMENT="${1#*=}"; shift ;;
    --report)    REPORT="${2:-}"; shift 2 ;;
    --report=*)  REPORT="${1#*=}"; shift ;;
    --repo)      CLI_REPO="${2:-}"; shift 2 ;;
    --repo=*)    CLI_REPO="${1#*=}"; shift ;;
    --live)      CLI_LIVE=1; shift ;;
    -h|--help)   awk 'NR>1 && /^#/ {print; next} NR>1 {exit}' "$0"; exit 0 ;;
    *) echo "未知参数: $1（用法: --segment fast|slow|all [--report <path>] [--repo <R> | --live]）" >&2; exit 2 ;;
  esac
done
case "$SEGMENT" in
  fast|slow|all) ;;
  *) echo "未知 --segment: ${SEGMENT}（应为 fast|slow|all）" >&2; exit 2 ;;
esac

# ---- 运行模式（live = 巡检安装实例 / repo = 仓内自证；语义见文件头）---------------------------------
MODE="${OPENCLAW_TEAM_MODE:-}"
case "$MODE" in
  ''|live|repo) ;;
  *) echo "未知 OPENCLAW_TEAM_MODE: ${MODE}（应为 live|repo）" >&2; exit 2 ;;
esac
if [ -n "$CLI_REPO" ] && [ "$CLI_LIVE" = 1 ]; then echo "✗ --repo 与 --live 互斥" >&2; exit 2; fi
if [ -n "$CLI_REPO" ]; then MODE=repo; fi        # 命令行 > 环境变量
if [ "$CLI_LIVE" = 1 ]; then MODE=live; fi
if [ -z "$MODE" ]; then
  # 实例在场的判据是 **scripts/ 目录**（不是某个具体文件）：门禁 fixture 与部分真实布局只保证目录在。
  if [ -d "$TEAM/scripts" ]; then MODE=live; else MODE=repo; fi
fi
if [ "$MODE" = repo ]; then
  REPO_DIR="${CLI_REPO:-${OPENCLAW_TEAM_REPO:-}}"
  if [ -z "$REPO_DIR" ]; then
    # 隐式仓根 = 本脚本的 ../../（部署副本的 ../../ 是 ~/.openclaw，不含分发根标记 ⇒ 天然不成立）
    here="$(cd "$(dirname "$0")" && pwd)"
    cand="$(cd "$here/../.." && pwd)"
    if [ -d "$cand/roles" ] && [ -f "$cand/team/SHARED-RULES.md" ] && [ -f "$cand/install.sh" ]; then REPO_DIR="$cand"; fi
  fi
  if [ -z "$REPO_DIR" ] || [ ! -f "$REPO_DIR/team/scripts/check-all.sh" ]; then
    echo "✗ repo 模式：未能定位分发仓根（需同时含 roles/ + team/SHARED-RULES.md + install.sh）" >&2
    echo "   请用 --repo <repo> 或 OPENCLAW_TEAM_REPO=<repo> 指定分发仓。" >&2
    exit 2
  fi
  S="$REPO_DIR/team/scripts"
  # repo 模式绝不读本机实例：连子进程也不给这两条缝（否则下游可能回落 $HOME）。
  unset OPENCLAW_TEAM_ROOT OPENCLAW_HOME
else
  if [ ! -d "$TEAM/scripts" ]; then
    echo "✗ live 模式：实例不可解析（${TEAM}/scripts 不存在）" >&2
    echo "   请设 OPENCLAW_TEAM_ROOT=<team>，或改用 --repo <repo> 跑仓内自证。" >&2
    exit 2
  fi
  S="$TEAM/scripts"
fi

run() { local label="$1"; shift; echo "── $label"; "$@" || { echo "   ↑ FAIL"; fail=1; FAILED_STEPS+=("$label"); }; }

# 与 run() 同义，但把子进程输出 tee 到文件（供慢套件解析失败用例）；仍原样透传到 stdout 供人读。
run_capture() {
  local label="$1" out="$2"; shift 2
  echo "── $label"
  "$@" 2>&1 | tee "$out"
  local rc="${PIPESTATUS[0]}"
  if [ "$rc" != 0 ]; then echo "   ↑ FAIL"; fail=1; FAILED_STEPS+=("$label"); fi
}

# repo 模式的仓内语法自证：bash -n 所有 shell + node --check 所有 framework mjs。
# 无实例机器上「仓内自证」唯一的静态门（实例面步骤在 repo 模式整体跳过）。
syntax_selfcheck() {
  local bad=0 f
  for f in "$REPO_DIR"/team/scripts/*.sh "$REPO_DIR"/install.sh; do
    [ -f "$f" ] || continue
    if ! bash -n "$f"; then echo "   ↑ bash -n 失败：${f}"; bad=1; fi
  done
  for f in "$REPO_DIR"/team/scripts/*.mjs "$REPO_DIR"/team/automations/*.mjs; do
    [ -f "$f" ] || continue
    if ! node --check "$f"; then echo "   ↑ node --check 失败：${f}"; bad=1; fi
  done
  return "$bad"
}

# provider 依赖显式化（T-20261009-211234-providerdecouple · 方案②启动期硬失败）：
# 卡校验/幂等/契约测试均链接 provider ACL 库 skills/task-ops/（有意不随仓）。**live 模式**下缺失 ⇒
# 明确错误 + 非零退出（绝不静默）。此时仅跑不依赖 provider 的纯 lint，其余跳过并报 provider 未安装。
# **repo 模式**下本机根本没有实例：实例面步骤（卡校验 / 契约测试 / provider 全量 / 归档预览）
# 整体跳过 —— 这是设计内的降级，**不是红**（开放仓的贡献者没有实例，门禁仍须给出判定）。
if [ "$MODE" = repo ]; then
  echo "── provider 预检（live 专用）"
  echo "   (skip) repo 模式：无实例 ⇒ 卡校验 / 契约测试 / provider 全量 / 归档预览 等实例面步骤整体跳过"
  provider_missing=1
elif [ ! -f "$TEAM/skills/task-ops/lib/team-paths.mjs" ] || [ ! -f "$TEAM/skills/task-ops/lib/projects.mjs" ]; then
  echo "✗ provider 未安装：check-all 依赖 provider ACL 库 $TEAM/skills/task-ops/lib/（缺失 team-paths.mjs/projects.mjs）。"
  echo "   请安装 meerkat-taskpanel 或其它基座（./install.sh --meerkat-taskpanel <dir>），或设 OPENCLAW_TASK_OPS_DIR 指向含 lib/ 的 task-ops 检出目录。"
  fail=1
  provider_missing=1
fi

if [ "$SEGMENT" = all ] || [ "$SEGMENT" = fast ]; then

# 纯 lint（不依赖 provider）：两种模式都跑，只是**目标面**不同 —— repo 模式显式 `--repo`，
# 校验的是仓内种子与仓内文档，不读本机实例。
LINT_ARGS=()
[ "$MODE" = repo ] && LINT_ARGS=(--repo "$REPO_DIR")
run "红线块一致性 check-redlines"        node "$S/check-redlines.mjs" ${LINT_ARGS[@]+"${LINT_ARGS[@]}"}
run "术语抽象 lint-impl-names"           node "$S/lint-impl-names.mjs" ${LINT_ARGS[@]+"${LINT_ARGS[@]}"}
run "共享规则块一致性 check-shared-rules" node "$S/check-shared-rules.mjs" ${LINT_ARGS[@]+"${LINT_ARGS[@]}"}
run "规则 ID 可解析 lint-rule-refs"      node "$S/lint-rule-refs.mjs" ${LINT_ARGS[@]+"${LINT_ARGS[@]}"}
run "guides 禁引协议卷 lint-no-protocol-refs" node "$S/lint-no-protocol-refs.mjs" ${LINT_ARGS[@]+"${LINT_ARGS[@]}"}
# 文档**路径**引用可解析（本步管文件/目录路径与 guide 内小节锚；规则 ID 由 lint-rule-refs 管）。
# 历史实证：角色 AGENTS.md 指向从未建立的方法库目录（`roles/turing/guides/`）—— 零成本复发、
# 无门禁可见。误报控制见脚本头注（宁漏勿误：实测松散规则下 466 条“断引用”里真问题只有 5 条）。
run "文档路径引用 lint-doc-refs"         node "$S/lint-doc-refs.mjs" ${LINT_ARGS[@]+"${LINT_ARGS[@]}"}
run "SLA 阈值文件校验 check-sla-thresholds" node "$S/check-sla-thresholds.mjs" ${LINT_ARGS[@]+"${LINT_ARGS[@]}"}

# repo 模式的仓内语法自证（实例面步骤在 repo 模式整体跳过，见下）。
if [ "$MODE" = repo ]; then
  run "仓内语法自证 bash -n / node --check" syntax_selfcheck
fi

# 依赖 CVE 扫描（team/guides/dependency-cve-gate.md §3.2；告警档）：
# 默认 warn-only，绝不因缺扫描器/离线/命中而使 check-all 变红；仅显式 SCAN_STRICT=1
# 时按 §4.1 阈值（Critical/High，CVSS>=7.0）计入 fail。不走 run()（避免非零即置红）。
# 扫描对象是**安装实例的技能树** ⇒ repo 模式无实例，显式 skip。
if [ "$MODE" = live ]; then
  echo "── 依赖 CVE 扫描 scan-deps (warn; SCAN_STRICT=1 才按阈值阻断)"
  if ! node "$S/scan-deps.mjs"; then
    if [ "${SCAN_STRICT:-0}" = 1 ]; then echo "   ↑ FAIL (strict)"; fail=1; FAILED_STEPS+=("依赖 CVE 扫描 scan-deps (strict)"); fi
  fi
else
  echo "── 依赖 CVE 扫描 scan-deps"
  echo "   (skip) repo 模式：扫描对象是安装实例的技能树"
fi

if [ "$provider_missing" = 0 ]; then
  run "卡 schema/状态机 check-card"        node "$S/check-card.mjs"
  run "新 seg 背景包 check-handoff"        node "$S/check-handoff.mjs"
  run "关系不变量 check-relations"         node "$S/check-relations.mjs"
  run "建卡幂等(同 idem 非终态>1)"          node "$S/check-idem.mjs"
  run "卡↔registry session 一致性 check-sessions" node "$S/check-sessions.mjs"
  # 建卡完备性门禁（epic 子卡完整性 + 「路线图 × 卡」对账；悬空路线图巡检为软告警，`R-DAG-1`/`R-GRANULARITY-1`/`R-GATE-1`）。
  # 只在脚本已部署时跑（部署前显式 skip，与 sla-scan 同款口径：避免「仓里已修 ≠ 线上已修」制造既存红）。
  if [ -f "$S/check-epic-completeness.mjs" ]; then
    run "建卡完备性 check-epic-completeness" node "$S/check-epic-completeness.mjs"
  else
    echo "── 建卡完备性 check-epic-completeness"
    echo "   (skip) $S/check-epic-completeness.mjs 未部署（install.sh 部署后本步生效）"
  fi
  # 卡面 Report 完备性（公共核心 A1…A8；T-20261015-010749-2）。
  # 硬触发面**只有 `in_review`**（交付待验收态）——正是父卡实测的事故型（2026-10-14 夜间 4 张
  # in_review 而卡面 Report 空）；其余非终态档最多次级提示，终态卡一律不查（不追溯翻旧账）。
  # 生效截止（`created_at` 早于门禁落仓时刻 ⇒ 降 warn）+ 豁免登记（托管模板 ∪ tasks 运行时登记）
  # 见脚本头注 (ii)/(iii)；这三条都是为了**上线即零既存红**，否则本步会让 live 门禁当场转红。
  # 与 check-epic-completeness 同款部署口：脚本未部署时显式 skip（避免「仓里已修 ≠ 线上已修」制造既存红）。
  if [ -f "$S/check-report.mjs" ]; then
    run "卡面 Report 完备性 check-report" node "$S/check-report.mjs"
  else
    echo "── 卡面 Report 完备性 check-report"
    echo "   (skip) $S/check-report.mjs 未部署（install.sh 部署后本步生效）"
  fi
  # 交付合并巡检：已 done 的卡，其 worktree 检出必须已并入 dev（`R-WORKTREE-1` 的前置条件）。
  # 在本次落地前，这条不变量**全库无任何代码校验**（写卡层 git-blind）⇒ 本步是把它变成机检。
  # 触发面**只有 `done`**：作业中的卡天然持有未合并的隔离树，无条件判会令每条在跑的 lane 转红。
  # 仓根由脚本自己按 dispatch.mjs 的既有约定解析（$OPENCLAW_TEAM_REPO → .install-state.json
  # repoPath）——live 模式下 shell 里没有 REPO_DIR，不能靠传参。生效截止 + 豁免登记见脚本头注 (iv)/(v)：
  # 三条都是为**上线即零既存红**；已知上限（树被移除后无法复查、分支名不合规即漏检）记入 `R-GATE-2`。
  # 与 check-report 同款部署口：脚本未部署时显式 skip（避免「仓里已修 ≠ 线上已修」制造既存红）。
  if [ -f "$S/check-merge.mjs" ]; then
    run "交付合并巡检 check-merge" node "$S/check-merge.mjs"
  else
    echo "── 交付合并巡检 check-merge"
    echo "   (skip) $S/check-merge.mjs 未部署（install.sh 部署后本步生效）"
  fi
  run "契约测试（task-interface v1）"      node "$TEAM/skills/task-ops/tests/contract.test.mjs"
  run "ACL 终态不可逆守卫"                node "$TEAM/skills/task-ops/tests/terminal-guard.test.mjs"
  run "ACL 项目解析（identity code）"      node --test "$TEAM/skills/task-ops/tests/projects.test.mjs"
  run "ACL 调度求值（provider-agnostic）"  node --test "$TEAM/skills/task-ops/tests/schedule.test.mjs"
  [ -n "${PROTOTYPE_DIR:-}" ] && run "原型禁写实现原型门禁" bash "$S/prototype-guard.sh" "$PROTOTYPE_DIR"
  # 只读预览（--dry-run）：只报「将归档」计数，不 mkdir / 不 rename（门禁不得产生写副作用）
  echo "── 归档预览 dry-run（--days 7 · 只读，不移动文件）"; node "$S/archive.mjs" --days 7 --dry-run
fi

fi  # /fast

if [ "$SEGMENT" = all ] || [ "$SEGMENT" = slow ]; then
  # 慢段 = framework 套件 +（仅 live）provider ACL 全量。两种模式的 framework 套件都跑。
  SLOW_OUT="$(mktemp -t check-all-slow.XXXXXX)"
  # frontmatter 幂等/写卡护栏 测试（framework test suite；本门禁的慢段之一 —— 实测 15-20s）
  run_capture "frontmatter 幂等/写卡护栏 测试" "$SLOW_OUT" node --test "$S/tests/"*.test.mjs
  PROVIDER_OUT=""
  if [ "$MODE" = repo ]; then
    echo "── provider ACL 全量测试（task-ops/tests glob）"
    echo "   (skip) repo 模式：provider 套件随安装实例，本机无实例"
  elif [ "$provider_missing" = 0 ]; then
    PROVIDER_OUT="$(mktemp -t check-all-provider.XXXXXX)"
    # provider ACL 全量（T-20261014-034118）：**glob 全目录，不逐文件列举**。
    # 卡面根因正是「check-all.sh 按文件名逐条列出 provider 测试 ⇒ 新增套件静默落在聚合门禁外」：
    # spawn-body/ idem/ relations/ actor-gate/ status-guard 五套此前均不在门禁内。glob 后
    # task-ops/tests 下任何 *.test.mjs 自动入闸，**新增套件不再需要改门禁**（结构性消除盲区）。
    # 与快段 4 套（contract/terminal-guard/projects/schedule）**有意重叠**：快段保 in-band 即时信号，
    # 慢段是全量权威扫（重叠的代价仅 ~2s 且落在带外）。见文件头「为什么分段」的预算依据。
    P_TESTS=()
    for f in "$TEAM/skills/task-ops/tests/"*.test.mjs; do [ -e "$f" ] && P_TESTS+=("$f"); done
    if [ "${#P_TESTS[@]}" -eq 0 ]; then
      # 匹配不到任何套件 ⇒ 显式红（fail-closed）：绝不因目录空/改名而静默通过
      echo "── provider ACL 全量测试（task-ops/tests/*.test.mjs）"
      echo "   ↑ FAIL：未匹配到任何 provider 套件（$TEAM/skills/task-ops/tests/）"
      fail=1; FAILED_STEPS+=("provider ACL 全量测试（零套件匹配）")
    else
      run_capture "provider ACL 全量测试（task-ops/tests glob）" "$PROVIDER_OUT" node --test "${P_TESTS[@]}"
    fi
  else
    echo "── provider ACL 全量测试（task-ops/tests/*.test.mjs）：provider 未安装，跳过"
  fi
  # 解析失败用例所属文件（node --test 在「failing tests」段每例打印 `test at <path>:LINE:COL`）；
  # 各段输出合并去重 ⇒ 任一段的失败文件都进信封 slowFailedFiles/message（慢段红必须随 message 暴露）。
  SLOW_SRCS=("$SLOW_OUT")
  [ -n "$PROVIDER_OUT" ] && SLOW_SRCS+=("$PROVIDER_OUT")
  SLOW_FAILED_FILES=()
  while IFS= read -r f; do
    [ -n "$f" ] && SLOW_FAILED_FILES+=("$f")
  done < <(grep -hE '^test at ' "${SLOW_SRCS[@]}" 2>/dev/null | sed -E 's/^test at (.*):[0-9]+:[0-9]+$/\1/' | sed -E 's#.*/##' | sort -u)
  rm -f "${SLOW_SRCS[@]}"
fi  # /slow

# ---- 信封（末行 JSON；dispatcher 按 ok 归一；红时带 message/failed[] 载明失败项）----
MSG=""
if [ "$fail" != 0 ]; then
  PARTS=""
  for s in ${FAILED_STEPS[@]+"${FAILED_STEPS[@]}"}; do PARTS="${PARTS:+$PARTS, }$s"; done
  DEFMSG="provider 未安装"; [ "${MODE}" = repo ] && DEFMSG="repo 模式失败"
  MSG="check-all(${SEGMENT}) RED: ${PARTS:-${DEFMSG}}"
  if [ "${#SLOW_FAILED_FILES[@]}" -gt 0 ]; then
    MSG="$MSG | slow-suite failed files: $(printf '%s ' "${SLOW_FAILED_FILES[@]}" | sed 's/ $//')"
  fi
fi
if [ "$fail" = 0 ]; then
  echo
  echo "check-all（${SEGMENT}）：全部通过 ✔"
else
  echo
  echo "check-all（${SEGMENT}）：存在失败项 ✗"
fi
# 用 node 生成 JSON（正确的转义 + 原子写 --report），避免 bash 手拼字符串的引号陷阱。
[ "$fail" = 0 ] && OKFLAG=1 || OKFLAG=0
ENVELOPE="$(node -e '
const [seg, ok, pm, msg, failedNl, slowNl, report, mode] = process.argv.slice(1);
const failed = failedNl ? failedNl.split("\n").filter(Boolean) : [];
const slowFiles = slowNl ? slowNl.split("\n").filter(Boolean) : [];
const o = { ok: ok === "1", segment: seg, mode, checkedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z") };
if (ok !== "1") {
  if (mode === "live") o.providerMissing = pm === "1";   // repo 模式无实例是设计内，不报 providerMissing
  o.failed = failed; o.message = msg;
  if (slowFiles.length) o.slowFailedFiles = slowFiles;   // 慢段的失败测试文件（basename）
}
const s = JSON.stringify(o);
if (report) {
  const fs = require("fs");
  const payload = JSON.stringify(Object.assign({}, o, { at: Date.now() }));
  const tmp = report + "." + process.pid + ".tmp";
  fs.writeFileSync(tmp, payload + "\n");
  fs.renameSync(tmp, report);
}
process.stdout.write(s + "\n");
' "$SEGMENT" "$OKFLAG" "$provider_missing" "$MSG" "$(printf '%s\n' ${FAILED_STEPS[@]+"${FAILED_STEPS[@]}"})" "$(printf '%s\n' ${SLOW_FAILED_FILES[@]+"${SLOW_FAILED_FILES[@]}"})" "$REPORT" "$MODE")"
echo "$ENVELOPE"
exit "$fail"
