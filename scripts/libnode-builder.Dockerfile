# Toolchain image for cross-compiling Node.js as libnode.so for Android.
#
# Why a container at all: gyp's make generator emits GNU-linker flags
# (--start-group, -soname) for the *host* tools it builds along the way — V8's
# mksnapshot, torque, and friends. Apple's linker rejects those outright, so a
# macOS host cannot build them. Termux, the reference recipe this follows
# (PRD ADR-3), builds on Linux; so do we, and the build is then identical on a
# developer's Mac, on a Linux box, and in CI.
#
# Pinned to linux/amd64 because Google ships no aarch64-Linux NDK: the toolchain
# binaries are x86_64 ELF. On Apple Silicon this runs under the container
# runtime's Rosetta layer.
FROM --platform=linux/amd64 debian:bookworm-slim

# NDK r28c == 28.2.13676358, the same revision android/app/build.gradle.kts
# pins. The app and the runtime it loads must come from one toolchain.
ARG NDK_VERSION=28.2.13676358
ARG NDK_RELEASE=r28c

ENV DEBIAN_FRONTEND=noninteractive

# Split from the build tools below so that changing those does not force the
# NDK — a 600 MB download — to be fetched again.
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates curl unzip xz-utils \
    && rm -rf /var/lib/apt/lists/*

# The build script looks for the NDK under $ANDROID_SDK_ROOT/ndk/<version>,
# the same layout the Android SDK uses on a developer machine.
ENV ANDROID_SDK_ROOT=/opt/android-sdk
RUN mkdir -p "$ANDROID_SDK_ROOT/ndk" \
    && curl -fsSL -o /tmp/ndk.zip \
        "https://dl.google.com/android/repository/android-ndk-${NDK_RELEASE}-linux.zip" \
    && unzip -q /tmp/ndk.zip -d /tmp \
    && mv "/tmp/android-ndk-${NDK_RELEASE}" "$ANDROID_SDK_ROOT/ndk/${NDK_VERSION}" \
    && rm /tmp/ndk.zip

# zlib1g-dev is for the *host* half of the build: --shared-zlib applies to both
# toolsets, so the tools V8 and ICU build to run here need zlib too, not just
# the Android target (which links the NDK's own libz).
RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential python3 python3-venv git zlib1g-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace
