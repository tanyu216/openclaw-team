#!/usr/bin/env bash
# prototype-guard.sh — 原型「禁写实现」门禁（`R-PROTO-1` / `R-GATE-1`）
# 用途：对设计原型目录做机检，命中真实实现痕迹即失败（退出码 1）。
# 用法：prototype-guard.sh <prototype_dir>
# 说明：banned token 集为可扩展清单；路径应由 lib.get_project 解析后传入。
set -u
DIR="${1:-}"
if [ -z "$DIR" ]; then echo "用法: $0 <prototype_dir>"; exit 2; fi
if [ ! -d "$DIR" ]; then echo "目录不存在: $DIR"; exit 2; fi

# banned token 集（原型内禁止出现）：网络调用 / 真实鉴权 / 凭据存取 / 真实端点
PATTERNS='fetch\(|XMLHttpRequest|axios|apiFetch|idtoken|access_token|localStorage|sessionStorage|/api/v[0-9]'

hits=$(grep -RInE "$PATTERNS" "$DIR" --include='*.html' --include='*.js' --include='*.css' 2>/dev/null || true)
if [ -n "$hits" ]; then
  echo "❌ 原型门禁失败：检出疑似真实实现（`R-PROTO-1` 禁在 prototype/** 写实现）"
  echo "$hits"
  exit 1
fi
echo "✅ 原型门禁通过：$DIR"
