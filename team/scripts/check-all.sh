#!/usr/bin/env bash
# check-all.sh — 日常巡检门禁聚合（PROTOCOL §⑳.1）
# 用法：bash check-all.sh
# 聚合：红线一致 / 术语抽象 / §引用可解析 / 卡 schema / 契约测试 / 原型门禁(可选) / 归档(dry)
set -u
TEAM="$HOME/.openclaw/team"
S="$TEAM/scripts"
fail=0
run() { echo "── $1"; shift; "$@" || { echo "   ↑ FAIL"; fail=1; }; }

run "红线块一致性 check-redlines"        node "$S/check-redlines.mjs"
run "术语抽象 lint-impl-names"           node "$S/lint-impl-names.mjs"
run "§引用可解析 lint-refs"              node "$S/lint-refs.mjs"
run "卡 schema/状态机 check-card"        node "$S/check-card.mjs"
run "新 seg 背景包 check-handoff"        node "$S/check-handoff.mjs"
run "关系不变量 check-relations"         node "$S/check-relations.mjs"
run "建卡幂等(同 idem 非终态>1)"          node "$S/check-idem.mjs"
run "契约测试（task-interface v1）"      node "$TEAM/skills/task-ops/tests/contract.test.mjs"
run "ACL 项目解析（identity code）"      node --test "$TEAM/skills/task-ops/tests/projects.test.mjs"
run "ACL 调度求值（provider-agnostic）"  node --test "$TEAM/skills/task-ops/tests/schedule.test.mjs"
run "frontmatter 幂等/写卡护栏 测试"     node --test "$S/tests/"*.test.mjs
[ -n "${PROTOTYPE_DIR:-}" ] && run "原型禁写实现原型门禁" bash "$S/prototype-guard.sh" "$PROTOTYPE_DIR"
echo "── 归档 dry-run（--days 7）"; node "$S/archive.mjs" --days 7

echo
[ "$fail" = 0 ] && echo "check-all：全部通过 ✔" || echo "check-all：存在失败项 ✗"
exit "$fail"
