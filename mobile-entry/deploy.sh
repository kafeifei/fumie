#!/usr/bin/env bash
# 构建 web bundle(在主仓库,worktree 没有 node_modules)、同步产物、部署到 Vercel。
# 用法:./deploy.sh [--skip-build]
set -euo pipefail

MAIN_REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENTRY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

SKIP_BUILD=0
for arg in "$@"; do
	case "$arg" in
		--skip-build) SKIP_BUILD=1 ;;
		*) echo "未知参数: $arg" >&2; exit 1 ;;
	esac
done

if [[ $SKIP_BUILD -eq 0 ]]; then
	echo "==> 构建 web bundle($MAIN_REPO)"
	(cd "$MAIN_REPO" && node --experimental-strip-types build/next/index.ts bundle --target web --minify --out out-fumie-web)
fi

echo "==> 同步产物到 $ENTRY_DIR/bundle(排除 sourcemap)"
rsync -a --delete --exclude='*.map' "$MAIN_REPO/out-fumie-web/" "$ENTRY_DIR/bundle/"

echo "==> 部署到 Vercel"
cd "$ENTRY_DIR"
WHOAMI="$(vercel whoami 2>/dev/null || true)"
echo "当前 Vercel 账号: ${WHOAMI:-未登录}"
read -r -p "确认使用此账号部署？[y/N] " CONFIRM
if [[ "$CONFIRM" != "y" && "$CONFIRM" != "Y" ]]; then
	echo "已取消。用 vercel login / vercel switch 切换账号后重试。" >&2
	exit 1
fi
vercel deploy --prod
