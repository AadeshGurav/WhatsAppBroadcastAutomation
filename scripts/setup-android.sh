#!/data/data/com.termux/files/usr/bin/bash
#
# Senderrr — Android (Termux) setup script
#
# Turns a fresh Termux install into a running Senderrr server: installs the
# Node toolchain, builds the app, generates the secrets it needs, installs
# and configures Cloudflare Tunnel so it's reachable from the internet, and
# wires everything to survive a phone reboot.
#
# Safe to re-run: every step checks whether it's already done and skips it,
# so running this again after an update just picks up what changed.
#
# Usage (from inside the cloned repo):
#   bash scripts/setup-android.sh

set -uo pipefail

# ── Output helpers ──────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m'

log_info()    { echo -e "${BLUE}ℹ${NC} $1"; }
log_success() { echo -e "${GREEN}✓${NC} $1"; }
log_warn()    { echo -e "${YELLOW}⚠${NC} $1"; }
log_error()   { echo -e "${RED}✗${NC} $1"; }
log_step()    { echo -e "\n${BOLD}── $1 ──${NC}"; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR" || { log_error "Could not find the project directory."; exit 1; }

# ── Sanity check: are we actually in Termux? ────────────────────────────────
if [ -z "${PREFIX:-}" ] || [[ "$PREFIX" != *com.termux* ]]; then
  log_warn "This doesn't look like Termux (no \$PREFIX pointing at com.termux)."
  log_warn "This script is written for Termux on Android — it may not work elsewhere."
  read -r -p "Continue anyway? [y/N] " reply
  [[ "$reply" =~ ^[Yy]$ ]] || exit 1
fi

# ═════════════════════════════════════════════════════════════════════════
log_step "1/8 — System packages"
# ═════════════════════════════════════════════════════════════════════════

pkg update -y >/dev/null 2>&1
NEEDED_PKGS=(nodejs-lts git python make clang libtool pkg-config openssl-tool curl)
MISSING_PKGS=()
for p in "${NEEDED_PKGS[@]}"; do
  if ! pkg list-installed 2>/dev/null | grep -q "^${p}/"; then
    MISSING_PKGS+=("$p")
  fi
done
if [ "${#MISSING_PKGS[@]}" -gt 0 ]; then
  log_info "Installing: ${MISSING_PKGS[*]}"
  pkg install -y "${MISSING_PKGS[@]}"
else
  log_success "All required packages already installed."
fi

# ═════════════════════════════════════════════════════════════════════════
log_step "2/8 — Keep the phone awake while Senderrr runs"
# ═════════════════════════════════════════════════════════════════════════

termux-wake-lock
log_success "Wake lock acquired (Android won't suspend the CPU while Termux is open)."

log_warn "One thing this script CANNOT do for you: Android's battery optimizer"
log_warn "can still kill Termux in the background unless you exempt it."
log_warn "Opening Termux's App Info screen now — set Battery to 'Unrestricted'."
am start -a android.settings.APPLICATION_DETAILS_SETTINGS -d package:com.termux >/dev/null 2>&1 \
  || log_warn "Couldn't open it automatically — go to: Settings → Apps → Termux → Battery → Unrestricted."
read -r -p "Press Enter once you've set Termux's battery to Unrestricted (or to skip)... " _

# ═════════════════════════════════════════════════════════════════════════
log_step "3/8 — App dependencies"
# ═════════════════════════════════════════════════════════════════════════

if [ ! -d node_modules ] || [ package.json -nt node_modules ]; then
  log_info "Running npm install (this can take a few minutes on a phone)..."
  if ! npm install --no-audit --no-fund; then
    log_error "npm install failed."
    log_warn "If the failure mentions 'sqlite3' or 'node-gyp', the native module couldn't"
    log_warn "compile on this device. Fix: set DATABASE_TYPE=postgres in .env and point it"
    log_warn "at a remote Postgres database (e.g. Neon) instead of local SQLite, then re-run"
    log_warn "this script."
    exit 1
  fi
  log_success "Dependencies installed."
else
  log_success "Dependencies already installed and up to date."
fi

# ═════════════════════════════════════════════════════════════════════════
log_step "4/8 — Configuration (.env)"
# ═════════════════════════════════════════════════════════════════════════

touch .env

set_env_default() {
  local key="$1" value="$2"
  if ! grep -q "^${key}=" .env 2>/dev/null; then
    echo "${key}=${value}" >> .env
    log_info "Set ${key}"
  fi
}

set_env_default "ENGINE_TYPE" "baileys"
set_env_default "DEPLOYMENT_MODE" "local"
set_env_default "PORT" "2785"
# Secrets: auto-generate rather than ask a non-technical user to invent one.
# These MUST be random once the server is reachable from the internet — the
# app's own fallback for a missing API_MASTER_KEY is a fixed, publicly-known
# development key, which is fine on localhost but not once Cloudflare Tunnel
# is exposing this to the whole internet.
if ! grep -q "^API_MASTER_KEY=" .env 2>/dev/null; then
  echo "API_MASTER_KEY=owa_k1_$(openssl rand -hex 32)" >> .env
  log_info "Generated a random API_MASTER_KEY"
fi
if ! grep -q "^WA_JWT_SECRET=" .env 2>/dev/null; then
  echo "WA_JWT_SECRET=$(openssl rand -hex 32)" >> .env
  log_info "Generated a random WA_JWT_SECRET"
fi
log_success "Configuration ready (.env)."

# ═════════════════════════════════════════════════════════════════════════
log_step "5/8 — Build"
# ═════════════════════════════════════════════════════════════════════════

log_info "Building Senderrr..."
if ! npm run build; then
  log_error "Build failed — see the error above."
  exit 1
fi
log_success "Build complete."

# ═════════════════════════════════════════════════════════════════════════
log_step "6/8 — Process manager (pm2)"
# ═════════════════════════════════════════════════════════════════════════

if ! command -v pm2 >/dev/null 2>&1; then
  log_info "Installing pm2..."
  npm install -g pm2
fi
log_success "pm2 ready."

# ═════════════════════════════════════════════════════════════════════════
log_step "7/8 — Cloudflare Tunnel (makes Senderrr reachable from the internet)"
# ═════════════════════════════════════════════════════════════════════════

CLOUDFLARED_BIN="$PREFIX/bin/cloudflared"

install_cloudflared() {
  local arch
  case "$(uname -m)" in
    aarch64|arm64) arch="arm64" ;;
    armv7l|armv8l) arch="arm" ;;
    x86_64)        arch="amd64" ;;
    *) log_error "Unsupported architecture: $(uname -m)"; return 1 ;;
  esac
  local url="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${arch}"
  log_info "Downloading cloudflared (${arch})..."
  if ! curl -fsSL -o "$CLOUDFLARED_BIN" "$url"; then
    log_error "Download failed. Check your internet connection and try again."
    return 1
  fi
  chmod +x "$CLOUDFLARED_BIN"
  return 0
}

if [ -x "$CLOUDFLARED_BIN" ]; then
  log_success "cloudflared already installed ($("$CLOUDFLARED_BIN" --version 2>/dev/null | head -1))."
elif install_cloudflared; then
  log_success "cloudflared installed."
else
  log_error "Could not install cloudflared — you can still run Senderrr locally"
  log_warn "and expose it another way; re-run this script later to try again."
fi

# Only ask for a token if one isn't already configured — reruns stay silent.
if [ -x "$CLOUDFLARED_BIN" ] && ! grep -q "^CLOUDFLARE_TUNNEL_TOKEN=" .env 2>/dev/null; then
  echo
  log_info "Senderrr can be reached from the internet two ways:"
  echo "    1) Instant free link — no account needed, but the address changes"
  echo "       every time the tunnel restarts. Good for testing."
  echo "    2) A permanent address on your own domain — needs a free Cloudflare"
  echo "       account. Create one at: https://dash.cloudflare.com/ → Zero Trust"
  echo "       → Networks → Tunnels → Create a tunnel → 'Cloudflared' connector."
  echo "       Cloudflare will show you a token (a long string) — paste it below."
  echo
  read -r -p "Paste your Cloudflare Tunnel token (or leave blank for the instant free link): " tunnel_token
  if [ -n "$tunnel_token" ]; then
    echo "CLOUDFLARE_TUNNEL_TOKEN=${tunnel_token}" >> .env
    log_success "Saved. Future runs of this script won't ask again."
  else
    echo "CLOUDFLARE_TUNNEL_TOKEN=" >> .env
    log_info "Using the instant free link (no token). You can add a token to .env later."
  fi
fi

# ═════════════════════════════════════════════════════════════════════════
log_step "8/8 — Auto-start on reboot"
# ═════════════════════════════════════════════════════════════════════════

mkdir -p "$HOME/.termux/boot"
BOOT_SCRIPT="$HOME/.termux/boot/start-senderrr.sh"
cat > "$BOOT_SCRIPT" <<EOF
#!$PREFIX/bin/bash
termux-wake-lock
cd "$PROJECT_DIR" && pm2 resurrect
EOF
chmod +x "$BOOT_SCRIPT"
if ! pm list packages 2>/dev/null | grep -q com.termux.boot; then
  log_warn "Install the 'Termux:Boot' app (F-Droid) so this actually runs after a reboot:"
  log_warn "  https://f-droid.org/packages/com.termux.boot/"
  log_warn "Open it once after installing so Android registers it."
fi
log_success "Boot script written."

# ── Launch ───────────────────────────────────────────────────────────────
# Read the specific values we need out of .env rather than sourcing the whole
# file — a token or password containing shell metacharacters would otherwise
# be executed as code, not just read as a string.
read_env() { grep -m1 "^${1}=" .env 2>/dev/null | cut -d= -f2-; }
PORT_VAL="$(read_env PORT)"
PORT_VAL="${PORT_VAL:-2785}"
TUNNEL_TOKEN_VAL="$(read_env CLOUDFLARE_TUNNEL_TOKEN)"

pm2 describe senderrr >/dev/null 2>&1 && pm2 delete senderrr >/dev/null 2>&1
pm2 start npm --name senderrr -- run start:prod

if [ -x "$CLOUDFLARED_BIN" ]; then
  pm2 describe senderrr-tunnel >/dev/null 2>&1 && pm2 delete senderrr-tunnel >/dev/null 2>&1
  if [ -n "$TUNNEL_TOKEN_VAL" ]; then
    pm2 start "$CLOUDFLARED_BIN" --name senderrr-tunnel -- tunnel run --token "$TUNNEL_TOKEN_VAL"
  else
    pm2 start "$CLOUDFLARED_BIN" --name senderrr-tunnel -- tunnel --url "http://localhost:${PORT_VAL}"
  fi
fi
pm2 save >/dev/null 2>&1

echo
echo -e "${GREEN}${BOLD}Senderrr is starting.${NC}"
echo "  Dashboard (on this phone):  http://localhost:${PORT_VAL}/wa/dashboard"
echo "  Logs:                       pm2 logs"
echo "  Status:                     pm2 status"
if [ -x "$CLOUDFLARED_BIN" ] && [ -z "$TUNNEL_TOKEN_VAL" ]; then
  echo
  log_info "Fetching your instant public link (this can take a few seconds)..."
  sleep 6
  pm2 logs senderrr-tunnel --lines 30 --nostream 2>/dev/null | grep -o 'https://[a-zA-Z0-9.-]*\.trycloudflare\.com' | tail -1
fi
echo
log_success "Setup complete. Open the Dashboard, go to Sessions → New Session, and scan the QR code from WhatsApp to connect."
