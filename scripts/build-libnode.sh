#!/usr/bin/env bash
#
# Senderrr — build the Android Node runtime (libnode.so).
#
# This is the entry point: run it from the project root, on any machine with a
# container runtime, and it produces
# android/app/src/main/jniLibs/<abi>/libnode.so plus the headers the JNI bridge
# compiles against (PRD docs/23-android-ndk-migration-prd.md, ADR-3).
#
# The build itself happens inside the pinned Linux toolchain image
# (scripts/libnode-builder.Dockerfile), because V8's build generates host tools
# with GNU-linker flags that Apple's linker rejects — and because a containered
# build is byte-for-byte the same one CI and every other developer gets.
#
# Usage:
#   bash scripts/build-libnode.sh              # build, resuming any partial one
#   bash scripts/build-libnode.sh --clean      # re-run configure from scratch
#   ANDROID_ABI=x86_64 bash scripts/build-libnode.sh   # emulator build
#
# Expect a couple of hours cold. Intermediate output lives in .ndk-build/,
# which is gitignored — none of this is source.

set -euo pipefail

readonly IMAGE_TAG="senderrr/libnode-builder:ndk-28.2.13676358"
readonly ANDROID_ABI="${ANDROID_ABI:-arm64-v8a}"

readonly GREEN='\033[0;32m' RED='\033[0;31m' BLUE='\033[0;34m' BOLD='\033[1m' NC='\033[0m'
log_info()    { echo -e "${BLUE}i${NC} $1"; }
log_success() { echo -e "${GREEN}v${NC} $1"; }
log_step()    { echo -e "\n${BOLD}-- $1 --${NC}"; }
die()         { echo -e "${RED}x${NC} $1" >&2; exit 1; }

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

command -v docker >/dev/null \
  || die "docker is not installed. It is only needed to build libnode.so, not to run Senderrr."
docker info >/dev/null 2>&1 \
  || die "The container runtime is installed but not running. Start it and try again."

log_step "Toolchain image"
if docker image inspect "$IMAGE_TAG" >/dev/null 2>&1; then
  log_info "$IMAGE_TAG already built."
else
  log_info "Building $IMAGE_TAG (one-off, downloads the Android NDK)."
  docker build --platform linux/amd64 \
    -t "$IMAGE_TAG" \
    -f "$SCRIPT_DIR/libnode-builder.Dockerfile" \
    "$SCRIPT_DIR" \
    || die "Could not build the toolchain image."
  log_success "Image ready."
fi

log_step "Building libnode.so for $ANDROID_ABI"
# The project is mounted rather than copied so the build writes its artifacts
# straight into android/app/src/main/jniLibs and resumes from .ndk-build/ on a
# rerun. Running as the invoking user keeps those artifacts owned by them.
docker run --rm --platform linux/amd64 \
  --user "$(id -u):$(id -g)" \
  --env ANDROID_ABI="$ANDROID_ABI" \
  --env HOME=/tmp \
  --volume "$PROJECT_DIR:/workspace" \
  --workdir /workspace \
  "$IMAGE_TAG" \
  bash scripts/libnode-build-in-container.sh "$@"

log_success "libnode.so is in android/app/src/main/jniLibs/$ANDROID_ABI."
