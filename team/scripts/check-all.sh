#!/usr/bin/env bash
# check-all.sh — 日常巡检门禁聚合（PROTOCOL §⑳.1）
# 用法：bash check-all.sh
# 聚合：红线一致 / 术语抽象 / §引用可解析 / 依赖 CVE 扫描(warn) / 卡 schema / 契约测试 / 原型门禁(可选) / 归档(dry)
# 输出信封：末行 JSON {"ok":true|false,...} —— dispatcher 按 ok 归一（ok:false ⇒ fire:true，失败才唤醒模型）。
set -u
TEAM="$HOME/.openclaw/team"
S="$TEAM/scripts"
fail=0
provider_missing=0
run() { echo "── $1"; shift; "$@" || { echo "   ↑ FAIL"; fail=1; }; }

# provider 依赖显式化（T-20261009-211234-providerdecouple · 方案②启动期硬失败）：
# 卡校验/幂等/契约测试均链接 provider ACL 库 skills/task-ops/（有意不随仓）。缺失 ⇒ 明确错误 +
# 非零退出（绝不静默）。此时仅跑不依赖 provider 的纯 lint，其余跳过并报 provider 未安装。
if [ ! -f "$TEAM/skills/task-ops/lib/team-paths.mjs" ] || [ ! -f "$TEAM/skills/task-ops/lib/projects.mjs" ]; then
  echo "✗ provider 未安装：check-all 依赖 provider ACL 库 $TEAM/skills/task-ops/lib/（缺失 team-paths.mjs/projects.mjs）。"
  echo "   请安装 meerkat-taskpanel 或其它基座（./install.sh --meerkat-taskpanel <dir>），或设 OPENCLAW_TASK_OPS_DIR 指向含 lib/ 的 task-ops 检出目录。"
  fail=1
  provider_missing=1
fi

# 纯 lint（不依赖 provider）：provider 缺失时也照跑，保留红线/术语/§引用 信号
run "红线块一致性 check-redlines"        node "$S/check-redlines.mjs"
run "术语抽象 lint-impl-names"           node "$S/lint-impl-names.mjs"
run "§引用可解析 lint-refs"              node "$S/lint-refs.mjs"

# 依赖 CVE 扫描（team/guides/dependency-cve-gate.md §3.2；告警档）：
# 默认 warn-only，绝不因缺扫描器/离线/命中而使 check-all 变红；仅显式 SCAN_STRICT=1
# 时按 §4.1 阈值（Critical/High，CVSS>=7.0）计入 fail。不走 run()（避免非零即置红）。
echo "── 依赖 CVE 扫描 scan-deps (warn; SCAN_STRICT=1 才按阈值阻断)"
if ! node "$S/scan-deps.mjs"; then
  if [ "${SCAN_STRICT:-0}" = 1 ]; then echo "   ↑ FAIL (strict)"; fail=1; fi
fi

if [ "$provider_missing" = 0 ]; then
  run "卡 schema/状态机 check-card"        node "$S/check-card.mjs"
  run "新 seg 背景包 check-handoff"        node "$S/check-handoff.mjs"
  run "关系不变量 check-relations"         node "$S/check-relations.mjs"
  run "建卡幂等(同 idem 非终态>1)"          node "$S/check-idem.mjs"
  run "卡↔registry session 一致性 check-sessions" node "$S/check-sessions.mjs"
  run "契约测试（task-interface v1）"      node "$TEAM/skills/task-ops/tests/contract.test.mjs"
  run "ACL 项目解析（identity code）"      node --test "$TEAM/skills/task-ops/tests/projects.test.mjs"
  run "ACL 调度求值（provider-agnostic）"  node --test "$TEAM/skills/task-ops/tests/schedule.test.mjs"
  run "frontmatter 幂等/写卡护栏 测试"     node --test "$S/tests/"*.test.mjs
  [ -n "${PROTOTYPE_DIR:-}" ] && run "原型禁写实现原型门禁" bash "$S/prototype-guard.sh" "$PROTOTYPE_DIR"
  echo "── 归档 dry-run（--days 7）"; node "$S/archive.mjs" --days 7
fi

echo
checkedAt="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
if [ "$fail" = 0 ]; then
  echo "check-all：全部通过 ✔"
  echo "{\"ok\":true,\"checkedAt\":\"$checkedAt\"}"
else
  echo "check-all：存在失败项 ✗"
  echo "{\"ok\":false,\"checkedAt\":\"$checkedAt\",\"providerMissing\":$provider_missing}"
fi
exit "$fail"
