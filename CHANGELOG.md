# Changelog

All notable changes to Senderrr are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project doesn't yet cut version
numbers (no public releases), so entries are grouped by date instead of a version tag until that
changes.

Per `CLAUDE.md` §15/§18.4: this file is updated in the **same commit** that makes the change it
describes — never as a separate follow-up. "Ship small and often, and say what changed in
language a user recognizes" (§18.4) is the standard this file is held to; write entries for what a
developer or client-facing operator would want to know, not a raw commit-message dump.

## [Unreleased]

### Added
- **Native Android app (PRD Phase 2, in progress).** A new `android/` module: a sideloadable
  Senderrr app that runs the whole NestJS server on the phone itself, with no Termux, no `adb`
  and no terminal. What works so far — the app installs and launches, starts a foreground
  service that runs the server in its own `:noderuntime` process, unpacks the server into app
  storage on first run, keeps the CPU awake while it serves, restarts itself if the runtime
  process dies, and comes back after a reboot. A Home screen shows whether the server is running
  and starts or stops it; it also asks for the background-execution permission Android otherwise
  uses to kill the server overnight, and keeps asking if that permission is ever withdrawn. An
  **Advanced** screen behind a warning shows the runtime's live output and offers restart and
  copy-logs — a read-only tail, not a shell (PRD ADR-8).

  **Not usable yet**: WhatsApp pairing still happens through the dashboard, the app cannot make
  the server reachable from outside the local network (Cloudflare Tunnel, PRD Phase 3), and it
  does not update itself (PRD Phase 5). The Termux path (`ANDROID_SETUP.md`) is unaffected and
  stays supported — the two are independent deployment methods, not a migration with a deadline.
- `scripts/build-libnode.sh` — cross-compiles the Node 24 runtime as `libnode.so` for Android,
  inside a pinned Linux toolchain image so the build is the same on any machine. Needed once
  before building the app; takes a couple of hours cold.
- `scripts/package-bundle.sh` — packages the compiled server, its production dependencies and
  the built dashboard into the bundle the app ships and runs. This is the layer that later
  updates itself over the air without reinstalling the app (PRD ADR-6).
- `docs/23-android-ndk-migration-prd.md` — the full plan for the native Android app (NDK-embedded Node
  runtime), phased into small reviewable commits with explicit ADRs. See that document for
  architecture and rationale.
- This changelog.
- PRD: ADR-9 (daily database backup to the client's own Google Drive, via Credential Manager +
  AuthorizationClient, scheduled through the existing `@nestjs/schedule` dependency) and ADR-10
  (unified Excel export joining a campaign, its broadcasts, and their per-group delivery/retry
  logs — currently spread across four tables with no enforced link between the campaign and its
  broadcasts) — both client requests, added as Phase 7 and Phase 8 with the same commit-by-commit
  breakdown as the rest of the plan.

## 2026-09-06

### Added
- `scripts/setup-android.sh` — idempotent Termux setup script: installs the Node toolchain,
  builds the app, generates random `API_MASTER_KEY`/`WA_JWT_SECRET`, installs Cloudflare Tunnel
  and prompts for a tunnel token only if one isn't already configured, wires up auto-start via
  Termux:Boot, and starts everything with `pm2`.
- `ANDROID_SETUP.md` — non-technical, step-by-step guide to running Senderrr on a spare Android
  phone via Termux (the interim/fast deployment path — see the NDK PRD for the native-app
  successor).
- `README.md` — restored after being dropped in an earlier restructuring; documents the
  whatsapp-web.js/Baileys engine choice and links to the Android setup guide.
- Native link-preview support in the Baileys adapter (`warmUpLinkPreview` in
  `whatsapp-engine/adapters/baileys.adapter.ts`): pre-fetched article title/description/thumbnail
  data (from the existing WAF-bypass scraper pipeline) is now handed directly to Baileys as a
  `WAUrlInfo`, with the pre-fetched image bytes uploaded to WhatsApp's media CDN so Baileys never
  makes its own network request for the article or its image — preserving thumbnail quality
  parity with the whatsapp-web.js engine without needing that engine's CDP-based crawler patch.

## Earlier

### Added
- `whatsapp-engine/adapters/baileys.adapter.ts` and supporting stores/entities/migrations — the
  full Baileys engine adapter implementing `IWhatsAppEngine`, selectable via `ENGINE_TYPE=baileys`
  alongside the existing `whatsapp-web.js` engine. See `claude/senderrr-on-android-phone-plan.md`
  for why this swap matters for running Senderrr on lightweight hardware.
