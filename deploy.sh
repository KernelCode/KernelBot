#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
#  KERNEL — VPS Deploy Script
#  Installs bun, Chromium, clones the repo, configures .env,
#  sets up a systemd service, and starts the bot.
#
#  Usage:  sudo bash deploy.sh
#  Re-run safe — detects existing installs and skips/updates.
# ─────────────────────────────────────────────────────────────
set -euo pipefail

# ── Config ──
INSTALL_DIR="/opt/kernel"
SERVICE_NAME="kernel"
ENV_FILE="$INSTALL_DIR/.env"
DATA_DIR="/root/.kernelbot"
REPO_URL="https://github.com/KernelCode/KernelBot.git"
LOG_FILE="/tmp/kernel-deploy-$(date +%Y%m%d-%H%M%S).log"
MIN_DISK_MB=500
MIN_RAM_MB=256
REQUIRED_CMDS=(curl git)
STEP=0
TOTAL_STEPS=9

# ── Colors ──
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
RED='\033[0;31m'
DIM='\033[2m'
BOLD='\033[1m'
NC='\033[0m'

# ── Helpers ──
step()  { STEP=$((STEP + 1)); echo ""; echo -e "${BOLD}${CYAN}[$STEP/$TOTAL_STEPS]${NC} ${BOLD}$1${NC}"; }
info()  { echo -e "  ${CYAN}→${NC} $1"; }
ok()    { echo -e "  ${GREEN}✓${NC} $1"; }
warn()  { echo -e "  ${YELLOW}!${NC} $1"; }
fail()  { echo -e "  ${RED}✗${NC} $1"; }
die()   { fail "$1"; echo -e "  ${DIM}Full log: $LOG_FILE${NC}"; exit 1; }

# Log everything to file while keeping terminal output clean
exec > >(tee -a "$LOG_FILE") 2>&1

# ── Banner ──
echo ""
echo -e "${CYAN}╔══════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║       KERNEL — VPS Deploy Script         ║${NC}"
echo -e "${CYAN}║  Telegram AI Bot · Bun · Chromium · SSH  ║${NC}"
echo -e "${CYAN}╚══════════════════════════════════════════╝${NC}"
echo -e "${DIM}  Log: $LOG_FILE${NC}"

# ═══════════════════════════════════════════════════════════════
#  STEP 1 — Pre-flight checks
# ═══════════════════════════════════════════════════════════════
step "Pre-flight checks"

# Root check
if [[ "$EUID" -ne 0 ]]; then
  die "Must run as root. Use: sudo bash deploy.sh"
fi
ok "Running as root"

# OS check
if [[ ! -f /etc/os-release ]]; then
  die "Cannot detect OS. This script supports Debian/Ubuntu."
fi
source /etc/os-release
if [[ "$ID" != "debian" && "$ID" != "ubuntu" && "$ID_LIKE" != *"debian"* ]]; then
  warn "Detected $PRETTY_NAME — this script is tested on Debian/Ubuntu."
  read -rp "  Continue anyway? [y/N] " yn
  [[ "$yn" =~ ^[Yy]$ ]] || exit 0
else
  ok "OS: $PRETTY_NAME"
fi

# Architecture
ARCH=$(uname -m)
ok "Arch: $ARCH"

# Disk space
AVAIL_MB=$(df -m / | awk 'NR==2 {print $4}')
if (( AVAIL_MB < MIN_DISK_MB )); then
  die "Not enough disk space: ${AVAIL_MB}MB available, ${MIN_DISK_MB}MB required"
fi
ok "Disk: ${AVAIL_MB}MB available"

# RAM
TOTAL_RAM_MB=$(free -m | awk '/Mem:/ {print $2}')
if (( TOTAL_RAM_MB < MIN_RAM_MB )); then
  warn "Low RAM: ${TOTAL_RAM_MB}MB (recommend ${MIN_RAM_MB}MB+)"
else
  ok "RAM: ${TOTAL_RAM_MB}MB"
fi

# Network connectivity
if curl -sf --max-time 5 https://bun.sh > /dev/null 2>&1; then
  ok "Network: reachable"
else
  die "No internet connectivity. Check your network and try again."
fi

# ═══════════════════════════════════════════════════════════════
#  STEP 2 — System dependencies
# ═══════════════════════════════════════════════════════════════
step "System dependencies"

info "Updating package lists..."
if ! apt-get update -qq 2>>"$LOG_FILE"; then
  die "apt-get update failed. Check your sources.list or network."
fi

PACKAGES=(
  curl unzip git
  chromium
  libnss3 libgbm1 libasound2 libatk-bridge2.0-0 libatk1.0-0
  libcups2 libdbus-1-3 libdrm2 libxcomposite1 libxdamage1
  libxfixes3 libxrandr2 libpango-1.0-0 libcairo2 fonts-liberation
)

# Try chromium, fall back to chromium-browser (some distros differ)
info "Installing ${#PACKAGES[@]} packages..."
if ! apt-get install -y --no-install-recommends "${PACKAGES[@]}" >>"$LOG_FILE" 2>&1; then
  warn "chromium failed, trying chromium-browser..."
  PACKAGES=("${PACKAGES[@]/chromium/chromium-browser}")
  if ! apt-get install -y --no-install-recommends "${PACKAGES[@]}" >>"$LOG_FILE" 2>&1; then
    die "Failed to install system dependencies. Check $LOG_FILE"
  fi
fi

# Verify Chromium
CHROMIUM_PATH=""
for cmd in chromium chromium-browser; do
  if command -v "$cmd" &>/dev/null; then
    CHROMIUM_PATH=$(command -v "$cmd")
    break
  fi
done
if [[ -z "$CHROMIUM_PATH" ]]; then
  die "Chromium not found after install. Check $LOG_FILE for errors."
fi
ok "Chromium: $CHROMIUM_PATH ($(${CHROMIUM_PATH} --version 2>/dev/null || echo 'installed'))"
ok "All system dependencies installed"

# ═══════════════════════════════════════════════════════════════
#  STEP 3 — Install bun
# ═══════════════════════════════════════════════════════════════
step "Bun runtime"

install_bun() {
  info "Installing bun..."
  if ! curl -fsSL https://bun.sh/install | bash >>"$LOG_FILE" 2>&1; then
    die "Bun installation failed. Check $LOG_FILE"
  fi
  export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
  export PATH="$BUN_INSTALL/bin:$PATH"
  # Symlink for system-wide use and for systemd
  ln -sf "$BUN_INSTALL/bin/bun" /usr/local/bin/bun
}

if command -v bun &>/dev/null; then
  CURRENT_BUN=$(bun --version 2>/dev/null || echo "unknown")
  ok "Bun already installed: v$CURRENT_BUN"
  read -rp "  Reinstall/update bun? [y/N] " yn
  if [[ "$yn" =~ ^[Yy]$ ]]; then
    install_bun
    ok "Bun updated: v$(bun --version)"
  fi
else
  install_bun
  if ! command -v bun &>/dev/null; then
    die "Bun not found in PATH after install. Try: export PATH=\$HOME/.bun/bin:\$PATH"
  fi
  ok "Bun installed: v$(bun --version)"
fi

# ═══════════════════════════════════════════════════════════════
#  STEP 4 — Clone or update repository
# ═══════════════════════════════════════════════════════════════
step "KERNEL source code"

if [[ -d "$INSTALL_DIR/.git" ]]; then
  info "Existing installation found at $INSTALL_DIR"
  cd "$INSTALL_DIR"

  # Check for local modifications
  if ! git diff --quiet 2>/dev/null; then
    warn "Local modifications detected."
    read -rp "  Stash changes and update? [Y/n] " yn
    if [[ "$yn" =~ ^[Nn]$ ]]; then
      ok "Keeping current version"
    else
      git stash >>"$LOG_FILE" 2>&1 || true
      info "Changes stashed"
    fi
  fi

  BEFORE=$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")
  if git pull --ff-only >>"$LOG_FILE" 2>&1; then
    AFTER=$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")
    if [[ "$BEFORE" == "$AFTER" ]]; then
      ok "Already up to date ($AFTER)"
    else
      ok "Updated: $BEFORE → $AFTER"
    fi
  else
    warn "Fast-forward pull failed (upstream may have diverged)"
    read -rp "  Force reset to origin/main? [y/N] " yn
    if [[ "$yn" =~ ^[Yy]$ ]]; then
      git fetch origin >>"$LOG_FILE" 2>&1
      git reset --hard origin/main >>"$LOG_FILE" 2>&1
      ok "Reset to origin/main ($(git rev-parse --short HEAD))"
    else
      ok "Keeping current version"
    fi
  fi
else
  if [[ -d "$INSTALL_DIR" ]]; then
    warn "$INSTALL_DIR exists but is not a git repo."
    read -rp "  Remove and re-clone? [y/N] " yn
    [[ "$yn" =~ ^[Yy]$ ]] || die "Cannot continue without a clean install directory."
    rm -rf "$INSTALL_DIR"
  fi

  info "Cloning from $REPO_URL..."
  if ! git clone "$REPO_URL" "$INSTALL_DIR" >>"$LOG_FILE" 2>&1; then
    die "git clone failed. Check your network and that the repo URL is correct."
  fi
  cd "$INSTALL_DIR"
  ok "Cloned to $INSTALL_DIR ($(git rev-parse --short HEAD))"
fi

# Verify entry point exists
if [[ ! -f "$INSTALL_DIR/bin/kernel.js" ]]; then
  die "bin/kernel.js not found — repo may be incomplete or corrupted."
fi
ok "Entry point verified: bin/kernel.js"

# ═══════════════════════════════════════════════════════════════
#  STEP 5 — Install dependencies
# ═══════════════════════════════════════════════════════════════
step "Project dependencies"

cd "$INSTALL_DIR"
info "Running bun install..."
if ! bun install >>"$LOG_FILE" 2>&1; then
  warn "bun install failed, retrying with clean cache..."
  rm -rf node_modules
  if ! bun install >>"$LOG_FILE" 2>&1; then
    die "bun install failed twice. Check $LOG_FILE"
  fi
fi

# Verify node_modules
if [[ ! -d "$INSTALL_DIR/node_modules" ]]; then
  die "node_modules not created — bun install may have silently failed."
fi
DEP_COUNT=$(ls -1 "$INSTALL_DIR/node_modules" 2>/dev/null | wc -l)
ok "$DEP_COUNT packages installed"

# ═══════════════════════════════════════════════════════════════
#  STEP 6 — Environment variables
# ═══════════════════════════════════════════════════════════════
step "Environment variables"

SKIP_ENV=false

if [[ -f "$ENV_FILE" ]]; then
  info "Existing .env found at $ENV_FILE"

  # Show what's configured (keys only, no values)
  echo -e "  ${DIM}Configured vars:${NC}"
  while IFS='=' read -r key _; do
    [[ -z "$key" || "$key" == \#* ]] && continue
    echo -e "    ${DIM}$key${NC}"
  done < "$ENV_FILE"

  read -rp "  Reconfigure? [y/N] " yn
  if [[ ! "$yn" =~ ^[Yy]$ ]]; then
    ok "Keeping existing .env"
    SKIP_ENV=true
  fi
fi

if [[ "$SKIP_ENV" != "true" ]]; then
  echo ""
  echo -e "  ${BOLD}Required:${NC}"
  echo "    TELEGRAM_BOT_TOKEN    — from @BotFather on Telegram"
  echo "    OWNER_TELEGRAM_ID     — your numeric Telegram user ID"
  echo ""
  echo -e "  ${BOLD}Plus at least one AI provider key:${NC}"
  echo "    ANTHROPIC_API_KEY     — Claude (anthropic.com)"
  echo "    OPENAI_API_KEY        — GPT (platform.openai.com)"
  echo "    GOOGLE_API_KEY        — Gemini (ai.google.dev)"
  echo "    GROQ_API_KEY          — Groq (console.groq.com)"
  echo ""

  # Collect required vars with validation
  while true; do
    read -rp "  TELEGRAM_BOT_TOKEN: " BOT_TOKEN
    if [[ -z "$BOT_TOKEN" ]]; then
      fail "Bot token is required."
    elif [[ ! "$BOT_TOKEN" =~ ^[0-9]+: ]]; then
      warn "Token doesn't look like a Telegram bot token (format: 123456:ABC-DEF...)"
      read -rp "  Use it anyway? [y/N] " yn
      [[ "$yn" =~ ^[Yy]$ ]] && break
    else
      break
    fi
  done

  while true; do
    read -rp "  OWNER_TELEGRAM_ID: " OWNER_ID
    if [[ -z "$OWNER_ID" ]]; then
      fail "Owner ID is required."
    elif [[ ! "$OWNER_ID" =~ ^[0-9]+$ ]]; then
      fail "Owner ID must be a number. Get it from @userinfobot on Telegram."
    else
      break
    fi
  done

  echo ""
  echo "  AI provider keys (press Enter to skip any):"
  read -rp "  ANTHROPIC_API_KEY: " ANTHROPIC_KEY
  read -rp "  OPENAI_API_KEY: " OPENAI_KEY
  read -rp "  GOOGLE_API_KEY: " GOOGLE_KEY
  read -rp "  GROQ_API_KEY: " GROQ_KEY

  # Verify at least one AI key
  if [[ -z "$ANTHROPIC_KEY" && -z "$OPENAI_KEY" && -z "$GOOGLE_KEY" && -z "$GROQ_KEY" ]]; then
    warn "No AI provider key set. The bot won't work without at least one."
    read -rp "  Continue anyway? [y/N] " yn
    [[ "$yn" =~ ^[Yy]$ ]] || die "Setup cancelled. Re-run when you have an API key."
  fi

  # Write .env
  cat > "$ENV_FILE" <<EOF
# KERNEL Bot — Environment Variables
# Generated by deploy.sh on $(date)

TELEGRAM_BOT_TOKEN=${BOT_TOKEN}
OWNER_TELEGRAM_ID=${OWNER_ID}
EOF

  [[ -n "${ANTHROPIC_KEY:-}" ]] && echo "ANTHROPIC_API_KEY=${ANTHROPIC_KEY}" >> "$ENV_FILE"
  [[ -n "${OPENAI_KEY:-}" ]]    && echo "OPENAI_API_KEY=${OPENAI_KEY}" >> "$ENV_FILE"
  [[ -n "${GOOGLE_KEY:-}" ]]    && echo "GOOGLE_API_KEY=${GOOGLE_KEY}" >> "$ENV_FILE"
  [[ -n "${GROQ_KEY:-}" ]]      && echo "GROQ_API_KEY=${GROQ_KEY}" >> "$ENV_FILE"

  chmod 600 "$ENV_FILE"
  ok ".env written (permissions: 600)"
fi

# ═══════════════════════════════════════════════════════════════
#  STEP 7 — Puppeteer config
# ═══════════════════════════════════════════════════════════════
step "Puppeteer configuration"

# Ensure Puppeteer env vars are in .env (idempotent)
if grep -q "PUPPETEER_EXECUTABLE_PATH" "$ENV_FILE" 2>/dev/null; then
  # Update path in case chromium location changed
  sed -i "s|PUPPETEER_EXECUTABLE_PATH=.*|PUPPETEER_EXECUTABLE_PATH=${CHROMIUM_PATH}|" "$ENV_FILE"
  ok "Puppeteer config updated (${CHROMIUM_PATH})"
else
  echo "" >> "$ENV_FILE"
  echo "# Puppeteer — use system Chromium" >> "$ENV_FILE"
  echo "PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true" >> "$ENV_FILE"
  echo "PUPPETEER_EXECUTABLE_PATH=${CHROMIUM_PATH}" >> "$ENV_FILE"
  ok "Puppeteer configured (${CHROMIUM_PATH})"
fi

# Verify Chromium actually runs
if $CHROMIUM_PATH --headless --disable-gpu --no-sandbox --dump-dom about:blank >/dev/null 2>&1; then
  ok "Chromium headless test passed"
else
  warn "Chromium headless test failed — web browsing tools may not work"
  warn "This is often fine on minimal VPS images; the bot will still run."
fi

# ═══════════════════════════════════════════════════════════════
#  STEP 8 — Data directory
# ═══════════════════════════════════════════════════════════════
step "Data directory"

mkdir -p "$DATA_DIR"
chmod 700 "$DATA_DIR"

if [[ -d "$DATA_DIR/conversations" ]]; then
  CONV_COUNT=$(ls -1 "$DATA_DIR/conversations" 2>/dev/null | wc -l)
  ok "Data directory exists with $CONV_COUNT conversation(s)"
else
  ok "Data directory created at $DATA_DIR"
fi

# ═══════════════════════════════════════════════════════════════
#  STEP 9 — Systemd service
# ═══════════════════════════════════════════════════════════════
step "Systemd service"

BUN_PATH=$(command -v bun)
if [[ -z "$BUN_PATH" ]]; then
  die "Cannot find bun in PATH. This should not happen."
fi
info "Using bun at: $BUN_PATH"

SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
EXISTING_SERVICE=false

if [[ -f "$SERVICE_FILE" ]]; then
  EXISTING_SERVICE=true
  info "Existing service found, updating..."
fi

cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=KERNEL Telegram Bot
Documentation=https://github.com/KernelCode/KernelBot
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${INSTALL_DIR}
EnvironmentFile=${ENV_FILE}
ExecStart=${BUN_PATH} run bin/kernel.js --start
Restart=always
RestartSec=10

# Hardening
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=${DATA_DIR} ${INSTALL_DIR}
PrivateTmp=true

# Logging
StandardOutput=journal
StandardError=journal
SyslogIdentifier=${SERVICE_NAME}

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
ok "Service file written to $SERVICE_FILE"

if ! systemctl is-enabled --quiet "$SERVICE_NAME" 2>/dev/null; then
  systemctl enable "$SERVICE_NAME" >>"$LOG_FILE" 2>&1
fi
ok "Service enabled (auto-start on boot)"

# ── Start / Restart ──
echo ""
if [[ "$EXISTING_SERVICE" == "true" ]] && systemctl is-active --quiet "$SERVICE_NAME"; then
  read -rp "  Bot is currently running. Restart with new changes? [Y/n] " yn
  if [[ "$yn" =~ ^[Nn]$ ]]; then
    ok "Service left running (old version)"
  else
    info "Restarting..."
    systemctl restart "$SERVICE_NAME"
  fi
else
  read -rp "  Start KERNEL now? [Y/n] " yn
  if [[ "$yn" =~ ^[Nn]$ ]]; then
    info "Start later with: systemctl start $SERVICE_NAME"
  else
    info "Starting..."
    systemctl start "$SERVICE_NAME"
  fi
fi

# Health check — wait and verify
if systemctl is-active --quiet "$SERVICE_NAME" 2>/dev/null || true; then
  info "Waiting 5s for startup..."
  sleep 5
  if systemctl is-active --quiet "$SERVICE_NAME"; then
    ok "KERNEL is running! (PID: $(systemctl show -p MainPID --value "$SERVICE_NAME"))"
  else
    fail "Service failed to start."
    echo ""
    echo -e "  ${BOLD}Last 20 log lines:${NC}"
    journalctl -u "$SERVICE_NAME" -n 20 --no-pager | sed 's/^/    /'
    echo ""
    warn "Common fixes:"
    echo "    1. Check your bot token:  grep TELEGRAM_BOT_TOKEN $ENV_FILE"
    echo "    2. Check full logs:       journalctl -u $SERVICE_NAME -f"
    echo "    3. Try running manually:  cd $INSTALL_DIR && source $ENV_FILE && bun run bin/kernel.js --start"
  fi
fi

# ═══════════════════════════════════════════════════════════════
#  Summary
# ═══════════════════════════════════════════════════════════════
echo ""
echo -e "${GREEN}╔══════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║          Setup Complete!                 ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════╝${NC}"
echo ""
echo -e "  ${BOLD}Install dir:${NC}    $INSTALL_DIR"
echo -e "  ${BOLD}Data dir:${NC}       $DATA_DIR"
echo -e "  ${BOLD}Config:${NC}         $ENV_FILE"
echo -e "  ${BOLD}Service:${NC}        $SERVICE_NAME"
echo -e "  ${BOLD}Deploy log:${NC}     $LOG_FILE"
echo ""
echo -e "  ${BOLD}Commands:${NC}"
echo "    systemctl status $SERVICE_NAME      — check status"
echo "    systemctl restart $SERVICE_NAME     — restart bot"
echo "    systemctl stop $SERVICE_NAME        — stop bot"
echo "    journalctl -u $SERVICE_NAME -f      — live logs"
echo "    journalctl -u $SERVICE_NAME -n 100  — last 100 lines"
echo "    nano $ENV_FILE                      — edit env vars"
echo ""
echo -e "  ${BOLD}Update:${NC}"
echo "    cd $INSTALL_DIR && git pull && bun install && systemctl restart $SERVICE_NAME"
echo ""
