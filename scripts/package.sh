#!/usr/bin/env bash
# 打包：
#   1) 精简安装包：只含 extension/，用于 chrome://extensions 加载或分发
#   2) 完整项目包：含插件、仿真页面、测试、文档（不含本地密钥与测试产物）
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p dist
rm -f dist/*.zip
STAMP=$(date +%Y%m%d-%H%M%S)
EXT_OUT="dist/crosshair-extension-${STAMP}.zip"
FULL_OUT="dist/crosshair-source-${STAMP}.zip"

(cd extension && zip -qr "../${EXT_OUT}" . -x '*.DS_Store')

zip -qr "${FULL_OUT}" \
  README.md DESIGN.md LICENSE .gitignore extension docs scripts \
  -x '*.DS_Store' '.deepseek_key'

echo "已打包："
unzip -l "${EXT_OUT}" | tail -2
echo
unzip -l "${FULL_OUT}" | tail -2
