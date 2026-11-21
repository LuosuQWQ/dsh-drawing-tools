#!/usr/bin/env bash
# Start ComfyUI the same way scripts/start-comfyui.ps1 does on Windows.
#
#   ./scripts/start-comfyui.sh            # start in the background, print the log path
#   ./scripts/start-comfyui.sh --wait     # start and wait until /system_stats answers
#   ./scripts/start-comfyui.sh --stop     # stop the instance this script started
#
# ComfyUI 目录取 COMFYUI_HOME（默认 ~/ComfyUI），解释器取 COMFYUI_PYTHON
# （默认优先 venv 里的 python，其次 python3），日志目录取 COMFYUI_LOG_DIR
# （默认 ${TMPDIR:-/tmp}/dsh-drawing-logs）。
set -euo pipefail

COMFY_HOME="${COMFYUI_HOME:-}"
LOG_DIR="${COMFYUI_LOG_DIR:-${TMPDIR:-/tmp}/dsh-drawing-logs}"
PID_FILE="$LOG_DIR/comfyui.pid"
ORIGIN="${COMFY_ORIGIN:-http://127.0.0.1:8188}"

if [ -z "$COMFY_HOME" ]; then
  echo "请用 COMFYUI_HOME 指定 ComfyUI 安装目录（脚本不预设默认位置）。" >&2
  exit 2
fi

python_bin() {
  if [ -n "${COMFYUI_PYTHON:-}" ]; then echo "$COMFYUI_PYTHON"; return; fi
  if [ -x "$COMFY_HOME/venv/bin/python" ]; then echo "$COMFY_HOME/venv/bin/python"; return; fi
  if [ -x "$COMFY_HOME/.venv/bin/python" ]; then echo "$COMFY_HOME/.venv/bin/python"; return; fi
  command -v python3 || command -v python
}

online() {
  curl -fsS --max-time 2 "$ORIGIN/system_stats" >/dev/null 2>&1
}

start() {
  if online; then
    echo "ComfyUI 已在运行：$ORIGIN"
    return 0
  fi
  local py
  py="$(python_bin)"
  if [ ! -x "$py" ]; then
    echo "找不到 Python 解释器；用 COMFYUI_PYTHON 指定，或把 ComfyUI 放在 COMFYUI_HOME 里。" >&2
    return 1
  fi
  if [ ! -f "$COMFY_HOME/main.py" ]; then
    echo "找不到 $COMFY_HOME/main.py；用 COMFYUI_HOME 指向 ComfyUI 安装目录。" >&2
    return 1
  fi
  mkdir -p "$LOG_DIR"
  local log="$LOG_DIR/comfyui-$(date +%Y%m%d-%H%M%S).log"
  ( cd "$COMFY_HOME" && nohup "$py" main.py "$@" >>"$log" 2>&1 & echo $! >"$PID_FILE" )
  echo "已启动 ComfyUI（pid $(cat "$PID_FILE")），日志：$log"
}

stop() {
  if [ ! -f "$PID_FILE" ]; then
    echo "没有记录 pid（$PID_FILE）；请手动停止 ComfyUI。"
    return 0
  fi
  local pid
  pid="$(cat "$PID_FILE")"
  if kill -0 "$pid" 2>/dev/null; then
    kill "$pid" && echo "已停止 ComfyUI（pid $pid）"
  else
    echo "进程 $pid 已不存在。"
  fi
  rm -f "$PID_FILE"
}

wait_online() {
  for _ in $(seq 1 90); do
    if online; then echo "ComfyUI 已就绪：$ORIGIN"; return 0; fi
    sleep 1
  done
  echo "等待超时（90s）；看一眼日志目录 $LOG_DIR。" >&2
  return 1
}

mode="start"
for arg in "$@"; do
  case "$arg" in
    --stop) mode="stop" ;;
    --wait) mode="wait" ;;
  esac
done

case "$mode" in
  stop) stop ;;
  wait) start; wait_online ;;
  *) start ;;
esac
