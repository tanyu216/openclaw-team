#!/usr/bin/env bash
# check-all.sh — 日常巡检门禁聚合（PROTOCOL §⑳.1）
# 用法：bash check-all.sh [--segment fast|slow|all] [--report <path>]
#   --segment fast  只跑「快门禁」（秒级）：红线一致 / 术语抽象 / §引用可解析 / 依赖 CVE 扫描 /
#                   防漂移巡检 / 卡 schema / handoff / 关系不变量 / 幂等 / 会话一致性 / 契约测试 /
#                   ACL 终态守卫 / 项目解析 / 调度求值（provider ACL 4 套快测在此，in-band 即时信号）/ 归档预览
#   --segment slow  只跑「慢套件」（带外刷新）：framework 套件 `node --test scripts/tests/*.test.mjs`
#                   **+ provider ACL 全量** `node --test skills/task-ops/tests/*.test.mjs`（glob 全目录）
#   --segment all   两段都跑（**默认**；人工 / CI 用）。相较历史覆盖，慢段新增 provider ACL 全量（T-20261014-034118）
#   --report <path> 额外把机器可读 verdict 原子写往 <path>（供 check-all-gate.mjs 的异步慢段刷新落缓存）
# 为什么要分段（T-20261013-031036）：完整门禁 ≈15-20s，而调度路径的 trigger-eval 预算是
# OPENCLAW_TEAM_EVAL_TIMEOUT_MS（默认 8000ms）⇒ 每次都 eval-timeout、且超时信封不带任何判定
# （真红被遮蔽）。快段可稳稳落进预算，慢套件走 check-all-gate.mjs 的带外刷新 + 缓存判定。
# provider ACL 全量放慢段（T-20261014-034118）：实测这五套缺失套件 ≈6.1s，而快段的在带内上界
# OPENCLAW_TEAM_CHECKALL_FAST_TIMEOUT_MS=6000ms（快段自身实测 warm 2.4-3.7s / cold ≈6.1s，余量已薄）
# ⇒ 若加快段必 fast-timeout（UNCONFIRMED），那正是 §⑳.1 要消除的「真红被超时/降级掩盖」。
# 本脚本为「只读巡检门禁」：任何步骤都不得写 tasks/。归档步骤必须带 --dry-run（真只读，不移动文件）；
# 真实归档由 meerkat-taskpanel(taskctl)/Elon 例行巡检执行（PROTOCOL §⑳.3），不由此门禁代劳。
# 输出信封：末行 JSON {"ok":true|false,...} —— dispatcher 按 ok 归一（ok:false ⇒ fire:true，失败才唤醒模型）；
# 红时信封另带 message（失败项摘要，dispatcher 直接转发给模型）与 failed[]（失败步骤标签）。
set -u
# 团队根目录：默认 ~/.openclaw/team，可用 OPENCLAW_TEAM_ROOT 覆盖（与 lib.mjs / scan-deps.mjs 同源，单测隔离用）。
TEAM="${OPENCLAW_TEAM_ROOT:-$HOME/.openclaw/team}"
S="$TEAM/scripts"
fail=0
provider_missing=0
FAILED_STEPS=()          # 失败步骤标签（红时进信封 message/failed[]）
SLOW_FAILED_FILES=()     # 慢套件的失败测试文件 basename（node --test 输出解析）

SEGMENT=all
REPORT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --segment)   SEGMENT="${2:-}"; shift 2 ;;
    --segment=*) SEGMENT="${1#*=}"; shift ;;
    --report)    REPORT="${2:-}"; shift 2 ;;
    --report=*)  REPORT="${1#*=}"; shift ;;
    -h|--help)   sed -n '2,18p' "$0"; exit 0 ;;
    *) echo "未知参数: $1（用法: --segment fast|slow|all [--report <path>]）" >&2; exit 2 ;;
  esac
done
case "$SEGMENT" in
  fast|slow|all) ;;
  *) echo "未知 --segment: ${SEGMENT}（应为 fast|slow|all）" >&2; exit 2 ;;
esac

run() { local label="$1"; shift; echo "── $label"; "$@" || { echo "   ↑ FAIL"; fail=1; FAILED_STEPS+=("$label"); }; }

# 与 run() 同义，但把子进程输出 tee 到文件（供慢套件解析失败用例）；仍原样透传到 stdout 供人读。
run_capture() {
  local label="$1" out="$2"; shift 2
  echo "── $label"
  "$@" 2>&1 | tee "$out"
  local rc="${PIPESTATUS[0]}"
  if [ "$rc" != 0 ]; then echo "   ↑ FAIL"; fail=1; FAILED_STEPS+=("$label"); fi
}

# provider 依赖显式化（T-20261009-211234-providerdecouple · 方案②启动期硬失败）：
# 卡校验/幂等/契约测试均链接 provider ACL 库 skills/task-ops/（有意不随仓）。缺失 ⇒ 明确错误 +
# 非零退出（绝不静默）。此时仅跑不依赖 provider 的纯 lint，其余跳过并报 provider 未安装。
if [ ! -f "$TEAM/skills/task-ops/lib/team-paths.mjs" ] || [ ! -f "$TEAM/skills/task-ops/lib/projects.mjs" ]; then
  echo "✗ provider 未安装：check-all 依赖 provider ACL 库 $TEAM/skills/task-ops/lib/（缺失 team-paths.mjs/projects.mjs）。"
  echo "   请安装 meerkat-taskpanel 或其它基座（./install.sh --meerkat-taskpanel <dir>），或设 OPENCLAW_TASK_OPS_DIR 指向含 lib/ 的 task-ops 检出目录。"
  fail=1
  provider_missing=1
fi

if [ "$SEGMENT" = all ] || [ "$SEGMENT" = fast ]; then

# 纯 lint（不依赖 provider）：provider 缺失时也照跑，保留红线/术语/§引用 信号
run "红线块一致性 check-redlines"        node "$S/check-redlines.mjs"
run "术语抽象 lint-impl-names"           node "$S/lint-impl-names.mjs"
run "§引用可解析 lint-refs"              node "$S/lint-refs.mjs"

# 依赖 CVE 扫描（team/guides/dependency-cve-gate.md §3.2；告警档）：
# 默认 warn-only，绝不因缺扫描器/离线/命中而使 check-all 变红；仅显式 SCAN_STRICT=1
# 时按 §4.1 阈值（Critical/High，CVSS>=7.0）计入 fail。不走 run()（避免非零即置红）。
echo "── 依赖 CVE 扫描 scan-deps (warn; SCAN_STRICT=1 才按阈值阻断)"
if ! node "$S/scan-deps.mjs"; then
  if [ "${SCAN_STRICT:-0}" = 1 ]; then echo "   ↑ FAIL (strict)"; fail=1; FAILED_STEPS+=("依赖 CVE 扫描 scan-deps (strict)"); fi
fi

# 防漂移巡检（只读）：仓 ↔ 实例 diff。仅报差异，绝不写、绝不移动文件。仓路径取
# OPENCLAW_TEAM_REPO，否则读 .install-state.json 的 repoPath；两者都缺 ⇒ 跳过（非红）。
#   · **部署面差异 ⇒ 默认红**（fail-closed）。部署面 = install.sh 部署的**可执行面**，其 drift 恒为
#     「部署滞后」（第三种实现态），必须机检为红——否则 merge 后未重跑 install.sh 的漂移会像本次
#     对账一样静默累积（T-20261014-204806 立，T-20261014-214625 扩展）：
#       - `team/scripts/**`    （install.sh §1；T-20261014-204806）
#       - `team/automations/**`（install.sh §1；T-20261014-214625）—— `dispatch.mjs`/`providers.json`
#         是**可执行路由面**（派发 + provider 入口映射），不是纯文档：旧文件会让计划任务静默错派。
#       - `tools/**`           （install.sh §1a；T-20261014-214625）—— **独立比对** `$REPO/tools ↔
#         $TEAM/tools`（见下方 tools 段；不复用上面那对 `team/`，两者不是同一棵树）。
#     三个面都覆盖 **diff 的三种形态**：内容不同（`Files A and B differ`）、面目录整体仓内有实例无
#     （`Only in <repo>/team: <s>`）、面上某文件仓内有实例无（`Only in <repo>/team/<s>: <name>`）——
#     后两种是片段正则的历史盲区，而「仓里新增了文件/脚本、线上还没部署」恰是最典型的一档滞后
#     （T-20261014-204806 对账时即有 3 个仓内新脚本）。
#   · 其它面（docs / guides…）差异 ⇒ 仅告警，DRIFT_STRICT=1 时才算 fail（裁定归口 Elon）。
#   · 主机本地 / 运行期项（scripts/triggers、tmp、*-proposed-clauses.md、备份 *.bak*、实例 tools/ 下
#     的本地附加物如 tools/openssl3）已排除，不误红。
echo "── 防漂移巡检 repo↔instance diff（只读；仅报差异）"
REPO_DIR="${OPENCLAW_TEAM_REPO:-}"
if [ -z "$REPO_DIR" ] && [ -f "$TEAM/.install-state.json" ]; then
  REPO_DIR="$(node -e 'try{process.stdout.write(String(require(process.argv[1]).repoPath||""))}catch(e){}' "$TEAM/.install-state.json" 2>/dev/null || true)"
fi
if [ -z "$REPO_DIR" ] || [ ! -d "$REPO_DIR/team" ]; then
  echo "   (skip) 未配置仓路径：设 OPENCLAW_TEAM_REPO=<repo>（或 install.sh 写 .install-state.json.repoPath）"
else
  drift="$(diff -rq "$REPO_DIR/team" "$TEAM" \
    -x tasks -x workspace -x memory -x claude-sessions.json -x turing-runs.json \
    -x projects.json -x team.config.json -x .board -x .backups \
    -x .install-state.json -x proposals -x reviews -x skills -x tools \
    -x .check-all-slow.json -x .check-all-slow.lock -x .check-all-slow.log \
    -x .sla-scan-ledger.json -x .sla-scan-state.json -x .sla-loop-patrol-state.json \
    -x triggers -x tmp -x '*-proposed-clauses.md' -x '*.bak*' 2>/dev/null || true)"
  if [ -z "$drift" ]; then
    echo "   ✔ 仓 team/ 与实例一致（已忽略运行期/主机本地项）"
  else
    printf '%s\n' "$drift" | sed 's/^/   Δ /'
    echo "   ⚠ 检出动差异（裁定归口 Elon——回灌 or 部署）"
    # 部署面 fail-closed：team/scripts/** 或 team/automations/** 出现 repo↔instance 差异 ⇒ 部署滞后
    # ⇒ 默认红（见文件头）。两条独立判据 ⇒ 信封里能直接读出是哪个面滞后。
    # 每一面都要覆盖 **diff 的三种形态**（T-20261014-214625）：
    #   (a) 两侧都有但内容不同  ⇒ `Files <repo>/team/<s>/x and … differ`   → 含 `/team/<s>/`
    #   (b) 面目录整体仓内有、实例无 ⇒ `Only in <repo>/team: <s>`            → ★ 片段正则漏判
    #   (c) 面上某文件仓内有、实例无 ⇒ `Only in <repo>/team/<s>: x`          → ★ 同上
    # (b)/(c) 恰是「仓里新增了脚本、线上还没部署」——最典型的一档滞后（T-20261014-204806 对账时
    # 就有 3 个仓内新脚本）。用 -F 定长匹配，避免仓路径里的正则元字符误伤。
    deploy_surface_drift() {
      printf '%s\n' "$drift" | grep -qF \
        -e "/team/$1/" -e "Only in ${REPO_DIR}/team: $1" -e "Only in ${REPO_DIR}/team/$1:"
    }
    if deploy_surface_drift scripts; then
      echo "   ↑ FAIL (deploy surface drift: team/scripts/**)"; fail=1; FAILED_STEPS+=("部署面漂移 team/scripts")
    fi
    if deploy_surface_drift automations; then
      echo "   ↑ FAIL (deploy surface drift: team/automations/**)"; fail=1; FAILED_STEPS+=("部署面漂移 team/automations")
    fi
    if [ "${DRIFT_STRICT:-0}" = 1 ]; then echo "   ↑ FAIL (drift strict)"; fail=1; FAILED_STEPS+=("防漂移巡检 (strict)"); fi
  fi

  # ---- tools 面显式比对（install.sh §1a：$REPO/tools → $TEAM/tools）----------------------------
  # 为什么不靠「去掉上面那行的 `-x tools`」：上面比的是 `$REPO/team` ↔ `$TEAM`，仓内并没有
  # `team/tools/` ⇒ 实例 `$TEAM/tools/` 会被读成「仅实例有」的**伪差异**，真盲区（仓改 tools/
  # 未部署）依旧看不见。工具面是**另一对**路径，必须独立比对。
  # 判据（触发条件）：仓侧文件在实例缺失、或内容不同 ⇒ 部署滞后 ⇒ **默认红**（与 scripts/automations
  # 同列）。**仅实例有**的条目忽略：install.sh 只部署 $REPO/tools 下的条目，主机本地附加物
  # （如 tools/openssl3 本地构建）属设计内，不误红。
  # 豁免开关：无单独开关（与 scripts/automations 同口径）。仓库路径本身可用 OPENCLAW_TEAM_REPO
  # 指向「应与之对齐的基线检出」——lane 部署超前（未合并即前移）时用它隔离出真实滞后。
  if [ -d "$REPO_DIR/tools" ]; then
    if [ ! -d "$TEAM/tools" ]; then
      echo "   ↑ FAIL (deploy surface drift: tools/ 实例缺目录 $TEAM/tools)"; fail=1; FAILED_STEPS+=("部署面漂移 tools")
    else
      tools_drift="$(diff -rq "$REPO_DIR/tools" "$TEAM/tools" 2>/dev/null | grep -vF "Only in ${TEAM}/tools" || true)"
      if [ -z "$tools_drift" ]; then
        echo "   ✔ 仓 tools/ 与实例 tools/ 一致（忽略实例本地附加物）"
      else
        printf '%s\n' "$tools_drift" | sed 's/^/   Δ /'
        echo "   ↑ FAIL (deploy surface drift: tools/**)"; fail=1; FAILED_STEPS+=("部署面漂移 tools")
      fi
    fi
  fi
fi

if [ "$provider_missing" = 0 ]; then
  run "卡 schema/状态机 check-card"        node "$S/check-card.mjs"
  run "新 seg 背景包 check-handoff"        node "$S/check-handoff.mjs"
  run "关系不变量 check-relations"         node "$S/check-relations.mjs"
  run "建卡幂等(同 idem 非终态>1)"          node "$S/check-idem.mjs"
  run "卡↔registry session 一致性 check-sessions" node "$S/check-sessions.mjs"
  run "契约测试（task-interface v1）"      node "$TEAM/skills/task-ops/tests/contract.test.mjs"
  run "ACL 终态不可逆守卫"                node "$TEAM/skills/task-ops/tests/terminal-guard.test.mjs"
  run "ACL 项目解析（identity code）"      node --test "$TEAM/skills/task-ops/tests/projects.test.mjs"
  run "ACL 调度求值（provider-agnostic）"  node --test "$TEAM/skills/task-ops/tests/schedule.test.mjs"
  # SLA 巡检阈值漂移核对（guides/sla-inspection-contract.md §11 钩子 H6）：运行期映射表 vs PROTOCOL §⑮。
  # 只在脚本已部署时跑（部署前显式 skip，避免「仓里已修 ≠ 线上已修」制造既存红）；非零 = 阈值漂移 ⇒ 红。
  if [ -f "$S/sla-scan.mjs" ]; then
    run "SLA 阈值漂移核对 sla-scan --check-thresholds" node "$S/sla-scan.mjs" --check-thresholds
  else
    echo "── SLA 阈值漂移核对 sla-scan --check-thresholds"
    echo "   (skip) $S/sla-scan.mjs 未部署（install.sh 部署后本步生效）"
  fi
  [ -n "${PROTOTYPE_DIR:-}" ] && run "原型禁写实现原型门禁" bash "$S/prototype-guard.sh" "$PROTOTYPE_DIR"
  # 只读预览（--dry-run）：只报「将归档」计数，不 mkdir / 不 rename（门禁不得产生写副作用）
  echo "── 归档预览 dry-run（--days 7 · 只读，不移动文件）"; node "$S/archive.mjs" --days 7 --dry-run
fi

fi  # /fast

if [ "$SEGMENT" = all ] || [ "$SEGMENT" = slow ]; then
  if [ "$provider_missing" = 0 ]; then
    SLOW_OUT="$(mktemp -t check-all-slow.XXXXXX)"
    PROVIDER_OUT="$(mktemp -t check-all-provider.XXXXXX)"
    # frontmatter 幂等/写卡护栏 测试（framework test suite；本门禁的慢段之一 —— 实测 15-20s）
    run_capture "frontmatter 幂等/写卡护栏 测试" "$SLOW_OUT" node --test "$S/tests/"*.test.mjs
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
    # 解析失败用例所属文件（node --test 在「failing tests」段每例打印 `test at <path>:LINE:COL`）；
    # 两段输出合并去重 ⇒ 任一段的失败文件都进信封 slowFailedFiles/message（慢段红必须随 message 暴露）。
    SLOW_FAILED_FILES=()
    while IFS= read -r f; do
      [ -n "$f" ] && SLOW_FAILED_FILES+=("$f")
    done < <(grep -hE '^test at ' "$SLOW_OUT" "$PROVIDER_OUT" 2>/dev/null | sed -E 's/^test at (.*):[0-9]+:[0-9]+$/\1/' | sed -E 's#.*/##' | sort -u)
    rm -f "$SLOW_OUT" "$PROVIDER_OUT"
  else
    echo "── 慢套件（scripts/tests/*.test.mjs + task-ops/tests/*.test.mjs）：provider 未安装，跳过"
  fi
fi  # /slow

# ---- 信封（末行 JSON；dispatcher 按 ok 归一；红时带 message/failed[] 载明失败项）----
MSG=""
if [ "$fail" != 0 ]; then
  PARTS=""
  for s in ${FAILED_STEPS[@]+"${FAILED_STEPS[@]}"}; do PARTS="${PARTS:+$PARTS, }$s"; done
  MSG="check-all(${SEGMENT}) RED: ${PARTS:-provider 未安装}"
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
const [seg, ok, pm, msg, failedNl, slowNl, report] = process.argv.slice(1);
const failed = failedNl ? failedNl.split("\n").filter(Boolean) : [];
const slowFiles = slowNl ? slowNl.split("\n").filter(Boolean) : [];
const o = { ok: ok === "1", segment: seg, checkedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z") };
if (ok !== "1") {
  o.providerMissing = pm === "1"; o.failed = failed; o.message = msg;
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
' "$SEGMENT" "$OKFLAG" "$provider_missing" "$MSG" "$(printf '%s\n' ${FAILED_STEPS[@]+"${FAILED_STEPS[@]}"})" "$(printf '%s\n' ${SLOW_FAILED_FILES[@]+"${SLOW_FAILED_FILES[@]}"})" "$REPORT")"
echo "$ENVELOPE"
exit "$fail"
