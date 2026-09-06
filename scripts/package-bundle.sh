#!/usr/bin/env bash
#
# Senderrr — package the application bundle the Android app ships and runs.
#
# The bundle is the compiled NestJS server plus its production dependencies and
# the built dashboard: exactly what the Docker and Termux deployments run, with
# nothing Android-specific in it. That is the point of the shell/bundle split
# (PRD docs/23-android-ndk-migration-prd.md §4) — most releases replace this and
# nothing else, without a reinstall.
#
# Writes android/app/src/main/assets/bundle.zip and bundle.version, both
# gitignored: this is a build artifact, like libnode.so.
#
# Usage (from the project root):
#   bash scripts/package-bundle.sh

set -euo pipefail

readonly GREEN='\033[0;32m' RED='\033[0;31m' BLUE='\033[0;34m' BOLD='\033[1m' NC='\033[0m'
log_info()    { echo -e "${BLUE}i${NC} $1"; }
log_success() { echo -e "${GREEN}v${NC} $1"; }
log_step()    { echo -e "\n${BOLD}-- $1 --${NC}"; }
die()         { echo -e "${RED}x${NC} $1" >&2; exit 1; }

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
readonly ASSETS_DIR="$PROJECT_DIR/android/app/src/main/assets"
readonly STAGING_DIR="$PROJECT_DIR/.ndk-build/bundle"

cd "$PROJECT_DIR"
command -v npm >/dev/null || die "npm is required to build the bundle."

log_step "Building the server and dashboard"
npm run build      >/dev/null || die "The server build failed."
npm run dashboard:build >/dev/null || die "The dashboard build failed."
log_success "Built."

log_step "Collecting production dependencies"
# A separate tree, so the developer's own node_modules (which has dev
# dependencies in it) is neither shipped nor disturbed.
rm -rf "$STAGING_DIR"
mkdir -p "$STAGING_DIR"
cp package.json package-lock.json "$STAGING_DIR/"
( cd "$STAGING_DIR" && npm ci --omit=dev --ignore-scripts >/dev/null ) \
  || die "Installing production dependencies failed."
log_success "node_modules: $(du -sh "$STAGING_DIR/node_modules" | cut -f1)"

log_step "Assembling the bundle"
cp -R dist "$STAGING_DIR/dist"
mkdir -p "$STAGING_DIR/dashboard-ui"
cp -R dashboard-ui/dist "$STAGING_DIR/dashboard-ui/dist"
rm -f "$STAGING_DIR/package-lock.json"

# The version the installer compares against what is already on the device.
# Content-addressed, so rebuilding identical output does not force a reinstall.
version="$( (cd "$STAGING_DIR" && find . -type f -exec shasum -a 256 {} + | sort | shasum -a 256) | cut -c1-16)"

mkdir -p "$ASSETS_DIR"
rm -f "$ASSETS_DIR/bundle.zip"
# Deflated. The phone pays for this once, while unpacking on first run; an
# uncompressed bundle would make the APK roughly three times the size, every
# time anyone downloads or sideloads it.
( cd "$STAGING_DIR" && zip -q -r "$ASSETS_DIR/bundle.zip" . ) \
  || die "Could not create bundle.zip."
printf '%s' "$version" > "$ASSETS_DIR/bundle.version"

log_success "bundle.zip ($(du -h "$ASSETS_DIR/bundle.zip" | cut -f1)), version $version"
echo
log_info "Build the app with:  cd android && ./gradlew :app:assembleDebug"
