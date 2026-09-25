#!/system/bin/sh
# =============================================================================
# 修图台 · 手机启动器
#   双击运行（或用 DSHA 终端执行）即可启动本地服务并打开浏览器
# =============================================================================
set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="$DIR/app"
[ -d "$APP_DIR" ] || APP_DIR="$DIR"
PORT="${PORT:-8788}"

# 找 node
NODE=""
for c in node /usr/local/bin/node /usr/bin/node /data/data/com.termux/files/usr/bin/node; do
  if command -v "$c" >/dev/null 2>&1; then NODE="$c"; break; fi
done
if [ -z "$NODE" ]; then
  echo "✗ 没有找到 node，请先安装 Node.js"
  exit 1
fi

# 关掉旧的同端口进程
if command -v pkill >/dev/null 2>&1; then
  pkill -f "server.js $PORT" 2>/dev/null || true
fi

echo "正在启动修图台（端口 $PORT）…"
"$NODE" "$APP_DIR/server.js" "$PORT" &
SRV=$!
sleep 1.5

URL="http://127.0.0.1:$PORT"
echo ""
echo "在手机浏览器打开：$URL"

# 尝试自动拉起浏览器
if command -v am >/dev/null 2>&1; then
  am start -a android.intent.action.VIEW -d "$URL" >/dev/null 2>&1 || true
elif command -v termux-open-url >/dev/null 2>&1; then
  termux-open-url "$URL" || true
fi

echo ""
echo "服务已在后台运行（PID $SRV）。停止：kill $SRV"
wait $SRV
