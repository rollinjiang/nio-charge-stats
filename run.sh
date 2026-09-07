#!/bin/zsh
# ============================================================
# NIO 充换电站看板 · 一键运行：抓取 -> 聚合
# 每天定时任务调用本脚本，自动更新数据与看板
# ============================================================
set -e
cd "$(dirname "$0")"

NODE="/Users/rollin/.workbuddy/binaries/node/versions/22.22.2-2/bin/node"
NODE_PATH="/Users/rollin/.workbuddy/binaries/node/workspace/node_modules"

echo "[$(date '+%Y-%m-%d %H:%M:%S')] 开始抓取 NIO 数据（轻量 HTTP 版，无需浏览器）..."
"$NODE" scraper/nio_http.js

echo "[$(date '+%Y-%m-%d %H:%M:%S')] 开始聚合指标..."
"$NODE" aggregate/agg.js

echo "[$(date '+%Y-%m-%d %H:%M:%S')] 完成。updated data/dashboard.json"
