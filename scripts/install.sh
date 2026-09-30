#!/bin/sh
# cx 一键安装（macOS / Linux）：下载已发布二进制 → SHA-256 校验 → 原子安装 → cx login → cx mcp install
#
#   curl -fsSL https://raw.githubusercontent.com/alongor666/cx-cli/main/scripts/install.sh | sh
#
# 可选环境变量：
#   CX_VERSION=v1.4.0     固定版本（默认 latest）
#   CX_BIN_DIR=~/bin      安装目录（默认 ~/.local/bin）
#   CX_MCP_CLIENTS=cursor,claude-code   只写这些 Agent（默认自动检测）
#   CX_SKIP_MCP=1         只装 cx，不写 Agent 配置
#   CX_RELEASE_BASE=URL   下载根地址（内网镜像/本地验收用；默认 GitHub release）
#
# PAT 只在 `cx login` 的隐藏输入里出现，不经过本脚本、不进 shell history、不写进任何 Agent 配置。
# 信任边界：SHA256SUMS 与二进制同源（同一 GitHub release），挡传输损坏，挡不住 release 本身被篡改。
# 升级：重跑本命令。卸载：cx mcp uninstall && cx logout && rm "$(command -v cx)"
set -eu

REPO="alongor666/cx-cli"
VERSION="${CX_VERSION:-latest}"
BIN_DIR="${CX_BIN_DIR:-$HOME/.local/bin}"

say() { printf '%s\n' "$*" >&2; }
die() { say "✘ $*"; exit 1; }

case "$(uname -s)" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) die "不支持的系统: $(uname -s)（Windows 请用 install.ps1）" ;;
esac
case "$(uname -m)" in
  arm64|aarch64) arch=arm64 ;;
  x86_64|amd64) arch=x64 ;;
  *) die "不支持的 CPU 架构: $(uname -m)" ;;
esac
asset="cx-${os}-${arch}"

if [ -n "${CX_RELEASE_BASE:-}" ]; then
  base="$CX_RELEASE_BASE"
elif [ "$VERSION" = latest ]; then
  base="https://github.com/${REPO}/releases/latest/download"
else
  base="https://github.com/${REPO}/releases/download/${VERSION}"
fi

if command -v sha256sum >/dev/null 2>&1; then sha() { sha256sum "$1" | cut -d' ' -f1; }
elif command -v shasum >/dev/null 2>&1; then sha() { shasum -a 256 "$1" | cut -d' ' -f1; }
else die "缺少 sha256sum / shasum，无法校验"; fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp" "$BIN_DIR/cx.tmp.$$"' EXIT INT TERM

say "下载 ${asset}（${VERSION}）…"
curl -fsSL --retry 3 -o "$tmp/SHA256SUMS" "$base/SHA256SUMS" || die "下载 SHA256SUMS 失败"
curl -fSL --retry 3 --progress-bar -o "$tmp/$asset" "$base/$asset" || die "下载 $asset 失败"

expected="$(awk -v a="$asset" '$2 == a { print $1 }' "$tmp/SHA256SUMS")"
[ -n "$expected" ] || die "SHA256SUMS 中没有 $asset"
actual="$(sha "$tmp/$asset")"
[ "$expected" = "$actual" ] || die "SHA-256 不匹配（期望 $expected，实际 $actual），已中止"
say "✔ SHA-256 校验通过"

mkdir -p "$BIN_DIR"
chmod 755 "$tmp/$asset"
mv -f "$tmp/$asset" "$BIN_DIR/cx.tmp.$$"
mv -f "$BIN_DIR/cx.tmp.$$" "$BIN_DIR/cx"
cx="$BIN_DIR/cx"
say "✔ 已安装 $cx（$("$cx" --version)）"

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) say "提示：$BIN_DIR 不在 PATH，可在 shell 配置中加入 export PATH=\"$BIN_DIR:\$PATH\"（Agent 配置用绝对路径，不受影响）" ;;
esac

[ "${CX_SKIP_MCP:-}" = 1 ] && exit 0

# curl | sh 时 stdin 是脚本管道，交互输入必须显式接到终端。
# 真打开一次来判定（[ -r /dev/tty ] 只查权限位，无控制终端时照样为真）
{ : </dev/tty; } 2>/dev/null || die "没有可交互终端。请在终端里依次运行：$cx login 与 $cx mcp install"

# 「已登录」只认 ~/.chexian/config.json 里的令牌：Agent 进程不继承 shell 的 CX_PAT
if env -u CX_PAT -u CX_BASE_URL "$cx" whoami >/dev/null 2>&1; then
  say "✔ 已登录（沿用 ~/.chexian/config.json 中的 PAT）"
else
  say "请粘贴个人 PAT（网页登录后侧栏「API 令牌」签发；输入不回显）"
  "$cx" login </dev/tty || die "登录失败"
fi

if [ -n "${CX_MCP_CLIENTS:-}" ]; then
  "$cx" mcp install --client "$CX_MCP_CLIENTS" </dev/tty
else
  "$cx" mcp install </dev/tty
fi
