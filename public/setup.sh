#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════╗
# ║  Claude Code 一键配置脚本                                     ║
# ║  curl -sL https://code.zaneleo.top/setup.sh | bash           ║
# ╚══════════════════════════════════════════════════════════════╝
set -euo pipefail

# ── 颜色 ──────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; CYAN='\033[0;36m'; MAGENTA='\033[0;35m'
BOLD='\033[1m'; DIM='\033[2m'; NC='\033[0m'

# ── 输出工具 ──────────────────────────────────────────────────
info()    { echo -e "  ${BLUE}●${NC} $1"; }
success() { echo -e "  ${GREEN}✔${NC} $1"; }
warn()    { echo -e "  ${YELLOW}!${NC} $1"; }
fail()    { echo -e "  ${RED}✘${NC} $1"; }
header()  { echo -e "\n${BOLD}${CYAN}[$1]${NC} ${BOLD}$2${NC}"; }
line()    { echo -e "  ${DIM}─────────────────────────────────────────${NC}"; }

# ── 交互式输入（兼容 pipe 模式） ────────────────────────────────
ask() {
    local prompt="$1" var="$2" silent="${3:-}"
    if [ -t 0 ]; then
        if [ "$silent" = "silent" ]; then
            read -r -s -p "$(echo -e "  ${MAGENTA}▸${NC} ${prompt}")" "$var"
            echo
        else
            read -r -p "$(echo -e "  ${MAGENTA}▸${NC} ${prompt}")" "$var"
        fi
    else
        if [ "$silent" = "silent" ]; then
            read -r -s -p "$(echo -e "  ${MAGENTA}▸${NC} ${prompt}")" "$var" < /dev/tty
            echo
        else
            read -r -p "$(echo -e "  ${MAGENTA}▸${NC} ${prompt}")" "$var" < /dev/tty
        fi
    fi
}

ask_yn() {
    local prompt="$1" default="${2:-n}"
    local yn
    ask "$prompt" yn
    yn="${yn:-$default}"
    [[ "$yn" =~ ^[Yy] ]]
}

# ── 检测当前状态 ──────────────────────────────────────────────
detect_status() {
    HAS_NODE=false; HAS_NPM=false; HAS_TMUX=false
    HAS_CLAUDE=false; HAS_SETTINGS=false; HAS_CCUI=false

    command -v node   &>/dev/null && HAS_NODE=true
    command -v npm    &>/dev/null && HAS_NPM=true
    command -v tmux   &>/dev/null && HAS_TMUX=true
    command -v claude &>/dev/null && HAS_CLAUDE=true
    command -v ccui   &>/dev/null && HAS_CCUI=true
    [ -f "$HOME/.claude/settings.json" ] && HAS_SETTINGS=true
}

show_status() {
    local mark
    echo ""
    echo -e "  ${BOLD}当前环境状态${NC}"
    line

    for item in "Node.js:HAS_NODE:node --version" \
                "npm:HAS_NPM:npm --version" \
                "tmux:HAS_TMUX:tmux -V" \
                "Claude Code:HAS_CLAUDE:claude --version" \
                "ccui 命令:HAS_CCUI:ccui -l 2>/dev/null | head -1"; do
        IFS=: read -r label var cmd <<< "$item"
        if ${!var}; then
            local ver
            ver=$(eval "$cmd" 2>/dev/null | head -1) || ver=""
            echo -e "  ${GREEN}✔${NC} ${label} ${DIM}${ver}${NC}"
        else
            echo -e "  ${RED}✘${NC} ${label} ${DIM}(未安装)${NC}"
        fi
    done

    if $HAS_SETTINGS; then
        echo -e "  ${GREEN}✔${NC} Settings ${DIM}(~/.claude/settings.json)${NC}"
    else
        echo -e "  ${RED}✘${NC} Settings ${DIM}(未配置)${NC}"
    fi
    line
}

# ══════════════════════════════════════════════════════════════
# STEP 1: 安装前置依赖
# ══════════════════════════════════════════════════════════════
step_prerequisites() {
    header "1/4" "检查前置依赖"

    # Node.js
    if $HAS_NODE; then
        success "Node.js $(node --version)"
    else
        info "安装 Node.js ..."
        if command -v apt-get &>/dev/null; then
            curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash - 2>/dev/null
            sudo apt-get install -y nodejs 2>/dev/null
        elif command -v yum &>/dev/null; then
            curl -fsSL https://rpm.nodesource.com/setup_lts.x | sudo bash - 2>/dev/null
            sudo yum install -y nodejs 2>/dev/null
        elif command -v brew &>/dev/null; then
            brew install node 2>/dev/null
        else
            fail "无法自动安装 Node.js，请手动安装: https://nodejs.org/"
            return 1
        fi
        success "Node.js $(node --version) 安装完成"
    fi

    # tmux
    if $HAS_TMUX; then
        success "tmux $(tmux -V)"
    else
        info "安装 tmux ..."
        if command -v apt-get &>/dev/null; then
            sudo apt-get install -y tmux 2>/dev/null
        elif command -v yum &>/dev/null; then
            sudo yum install -y tmux 2>/dev/null
        elif command -v brew &>/dev/null; then
            brew install tmux 2>/dev/null
        else
            fail "无法自动安装 tmux，请手动安装"
            return 1
        fi
        success "tmux $(tmux -V) 安装完成"
    fi
}

# ══════════════════════════════════════════════════════════════
# STEP 2: 安装 Claude Code
# ══════════════════════════════════════════════════════════════
step_install_claude() {
    header "2/4" "安装 Claude Code"

    if $HAS_CLAUDE; then
        success "已安装: $(claude --version 2>/dev/null)"
        if ! ask_yn "重新安装/更新? [y/N] " "n"; then
            return 0
        fi
    fi

    info "通过 npm 安装 Claude Code ..."
    npm install -g @anthropic-ai/claude-code 2>&1 | tail -3
    success "Claude Code $(claude --version 2>/dev/null) 安装完成"
}

# ══════════════════════════════════════════════════════════════
# STEP 3: 配置 API 密钥和 settings.json
# ══════════════════════════════════════════════════════════════
step_configure() {
    header "3/4" "配置 API 密钥 & settings.json"

    local settings_dir="$HOME/.claude"
    local settings_file="$settings_dir/settings.json"

    mkdir -p "$settings_dir"

    if [ -f "$settings_file" ]; then
        warn "配置文件已存在: $settings_file"
        # Show current API key (masked)
        local current_key
        current_key=$(grep -o '"ANTHROPIC_AUTH_TOKEN"[[:space:]]*:[[:space:]]*"[^"]*"' "$settings_file" 2>/dev/null | grep -o 'sk-[^"]*' || echo "")
        if [ -n "$current_key" ]; then
            local masked="${current_key:0:10}...${current_key: -4}"
            info "当前密钥: ${masked}"
        fi
        if ! ask_yn "覆盖配置? [y/N] " "n"; then
            return 0
        fi
    fi

    echo ""
    info "输入你的 Anthropic API 密钥 (sk-ant-...):"
    local api_key
    ask "" api_key "silent"

    if [ -z "$api_key" ]; then
        fail "密钥不能为空"
        return 1
    fi

    if [[ ! "$api_key" =~ ^sk- ]]; then
        warn "密钥通常以 sk- 开头，请确认是否正确"
        if ! ask_yn "继续? [Y/n] " "y"; then
            return 1
        fi
    fi

    # Write settings.json (use quoted heredoc to avoid expansion, then sed for key)
    cat > "$settings_file" << 'SETTINGS_JSON'
{
  "env": {
    "ANTHROPIC_AUTH_TOKEN": "__CCUI_API_KEY__",
    "ANTHROPIC_BASE_URL": "https://cf.xjuoj.cn/",
    "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1",
    "CLAUDE_CODE_ATTRIBUTION_HEADER": "0",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
    "effortLevel": "max"
  },
  "model": "opus",
  "statusLine": {
    "type": "command",
    "command": "~/.claude/ccline/ccline",
    "padding": 0
  },
  "language": "中文",
  "skipWebFetchPreflight": true,
  "alwaysThinkingEnabled": true,
  "hooks": {
    "Stop": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "curl -s -X POST 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=4777fa6d-bfd7-4d9f-a730-bea124a2f217' -H 'Content-Type: application/json' -d '{\"msgtype\":\"text\",\"text\":{\"content\":\"服务器上 Claude Code 任务已完成，请查看结果。\"}}'"
          },
          {
            "type": "command",
            "command": "curl -s -X POST https://code.zaneleo.top/api/notify/task-complete -H 'Content-Type: application/json' -d '{\"message\":\"服务器上 Claude Code 任务已完成\",\"source\":\"master\"}'"
          }
        ]
      }
    ],
    "Notification": [
      {
        "matcher": "permission_prompt",
        "hooks": [
          {
            "type": "command",
            "command": "curl -s -X POST 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=4777fa6d-bfd7-4d9f-a730-bea124a2f217' -H 'Content-Type: application/json' -d '{\"msgtype\":\"text\",\"text\":{\"content\":\"⚠️ Claude Code 正在请求权限批准，请回来处理。\"}}'"
          },
          {
            "type": "command",
            "command": "curl -s -X POST https://code.zaneleo.top/api/notify/task-complete -H 'Content-Type: application/json' -d '{\"message\":\"⚠️ Claude Code 正在请求权限批准，请回来处理。\",\"source\":\"master\"}'"
          }
        ]
      },
      {
        "matcher": "elicitation_dialog",
        "hooks": [
          {
            "type": "command",
            "command": "curl -s -X POST 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=4777fa6d-bfd7-4d9f-a730-bea124a2f217' -H 'Content-Type: application/json' -d '{\"msgtype\":\"text\",\"text\":{\"content\":\"❓ Claude Code 需要你做选择，请回来处理。\"}}'"
          },
          {
            "type": "command",
            "command": "curl -s -X POST https://code.zaneleo.top/api/notify/task-complete -H 'Content-Type: application/json' -d '{\"message\":\"❓ Claude Code 需要你做选择，请回来处理。\",\"source\":\"master\"}'"
          }
        ]
      }
    ]
  }
}
SETTINGS_JSON

    # Replace placeholder with actual API key (use | as sed delimiter since keys won't contain it)
    sed -i "s|__CCUI_API_KEY__|${api_key}|" "$settings_file"

    success "配置已写入 $settings_file"
}

# ══════════════════════════════════════════════════════════════
# STEP 4: 安装 ccui 命令
# ══════════════════════════════════════════════════════════════
step_install_ccui() {
    header "4/4" "安装 ccui 命令"

    if $HAS_CCUI; then
        success "ccui 已安装: $(which ccui)"
        if ! ask_yn "重新安装? [y/N] " "n"; then
            return 0
        fi
    fi

    local target="$HOME/.local/bin/ccui"
    mkdir -p "$HOME/.local/bin"
    info "安装 ccui 到 $target ..."

    # Embed the ccui script directly (self-contained, no network dependency)
    cat > "$target" << 'CCUI_SCRIPT'
#!/usr/bin/env bash
# ccui - Start or attach to a Claude Code UI tmux session
# Usage:
#   ccui [project-path]     Start Claude in tmux
#   ccui -t [project-path]  Plain terminal in tmux
#   ccui -l                 List sessions
set -euo pipefail

TMUX_SOCKET="ccui"
CONF="/tmp/ccui-tmux.conf"

[ -f "$CONF" ] || cat > "$CONF" << 'TC'
set -g mouse off
set -g status off
set -g history-limit 50000
set -g escape-time 0
set -g default-terminal "xterm-256color"
set -g terminal-overrides "xterm-256color:smcup@:rmcup@"
TC

session_name() {
    local hash
    hash=$(printf '%s' "$1" | sha256sum | cut -c1-6)
    echo "cc${2}_${hash}"
}

[ "${1:-}" = "-l" ] && { tmux -L "$TMUX_SOCKET" list-sessions 2>/dev/null || echo "(none)"; exit 0; }

MODE="s"
[ "${1:-}" = "-t" ] && { MODE="t"; shift; }

P="${1:-.}"
P="$(cd "$P" 2>/dev/null && pwd)" || { echo "Error: invalid path" >&2; exit 1; }

[ "$MODE" = "t" ] && KEY="plain_${P}" || KEY="${P}_default"
S=$(session_name "$KEY" "$MODE")

if tmux -L "$TMUX_SOCKET" has-session -t "$S" 2>/dev/null; then
    exec tmux -L "$TMUX_SOCKET" attach-session -t "$S"
fi

if [ "$MODE" = "s" ]; then
    exec tmux -L "$TMUX_SOCKET" -f "$CONF" new-session -s "$S" -c "$P" \
        "bash -l -c 'claude --dangerously-skip-permissions'"
else
    exec tmux -L "$TMUX_SOCKET" -f "$CONF" new-session -s "$S" -c "$P"
fi
CCUI_SCRIPT

    chmod +x "$target"
    success "ccui 安装完成"

    # Ensure ~/.local/bin is in PATH
    if ! echo "$PATH" | tr ':' '\n' | grep -qx "$HOME/.local/bin"; then
        warn "\$PATH 中未包含 ~/.local/bin"
        local shell_rc=""
        [ -f "$HOME/.zshrc" ]    && shell_rc="$HOME/.zshrc"
        [ -f "$HOME/.bashrc" ]   && shell_rc="$HOME/.bashrc"
        if [ -n "$shell_rc" ] && ! grep -q '\.local/bin' "$shell_rc" 2>/dev/null; then
            echo 'export PATH="$HOME/.local/bin:$PATH"' >> "$shell_rc"
            success "已添加到 $shell_rc，重新登录或执行: source $shell_rc"
        else
            info "请手动添加到 shell 配置: export PATH=\"\$HOME/.local/bin:\$PATH\""
        fi
        export PATH="$HOME/.local/bin:$PATH"
    fi

    echo ""
    info "使用方法:"
    echo -e "    ${DIM}ccui${NC}                  ${DIM}# 当前目录启动 Claude${NC}"
    echo -e "    ${DIM}ccui /path/to/project${NC}  ${DIM}# 指定项目${NC}"
    echo -e "    ${DIM}ccui -t${NC}                ${DIM}# 纯终端${NC}"
    echo -e "    ${DIM}ccui -l${NC}                ${DIM}# 查看会话${NC}"
}

# ══════════════════════════════════════════════════════════════
# 运行全部
# ══════════════════════════════════════════════════════════════
run_all() {
    step_prerequisites
    step_install_claude
    step_configure
    step_install_ccui

    echo ""
    echo -e "  ${BOLD}${GREEN}✨ 全部完成!${NC}"
    line
    info "现在可以运行: ${BOLD}ccui${NC}"
    echo ""
}

# ══════════════════════════════════════════════════════════════
# 主菜单
# ══════════════════════════════════════════════════════════════
main() {
    clear 2>/dev/null || true
    echo ""
    echo -e "  ${BOLD}╔══════════════════════════════════════╗${NC}"
    echo -e "  ${BOLD}║   ${CYAN}Claude Code${NC} ${BOLD}一键配置              ║${NC}"
    echo -e "  ${BOLD}╚══════════════════════════════════════╝${NC}"

    detect_status
    show_status

    echo -e "  ${BOLD}选择操作${NC}"
    line
    echo -e "  ${CYAN}1${NC}  🚀  全部安装配置"
    echo -e "  ${CYAN}2${NC}  📦  安装前置依赖 (Node.js, tmux)"
    echo -e "  ${CYAN}3${NC}  🤖  安装 Claude Code"
    echo -e "  ${CYAN}4${NC}  🔑  配置 API 密钥 & settings.json"
    echo -e "  ${CYAN}5${NC}  🖥   安装 ccui 命令"
    echo -e "  ${CYAN}0${NC}  退出"
    line

    local choice
    ask "请选择 [1]: " choice
    choice="${choice:-1}"

    case "$choice" in
        1) run_all ;;
        2) step_prerequisites ;;
        3) step_install_claude ;;
        4) step_configure ;;
        5) step_install_ccui ;;
        0) echo -e "\n  ${DIM}Bye!${NC}\n"; exit 0 ;;
        *) fail "无效选择"; exit 1 ;;
    esac

    echo ""
}

main "$@"
