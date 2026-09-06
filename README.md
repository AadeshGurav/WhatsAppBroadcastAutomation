# Senderrr

Senderrr is a multi-tenant WhatsApp automation gateway — campaigns, scraper-driven
lead capture, message templates, anti-ban pacing, and scheduling, all behind a
REST API and a React dashboard. It's built on [NestJS](https://nestjs.com/) with
TypeORM (SQLite or Postgres) and is a fork of
[OpenWA](https://github.com/rmyndharis/OpenWA) by Yudhi Armyndharis, with a
`wa-automation` module layered on top for campaigns, anti-ban throttling, and
scheduling.

## WhatsApp connection engines

Senderrr can talk to WhatsApp two ways, selected with `ENGINE_TYPE` in `.env`:

- **`whatsapp-web.js`** (default) — drives a real, headless Chromium browser
  running WhatsApp Web. Full-featured and battle-tested, but needs a browser
  process per session, so it's best suited to a server or container host.
- **`baileys`** — a pure Node.js implementation of WhatsApp's own multi-device
  protocol. No browser, no Chromium — which is what makes it possible to run
  Senderrr on lightweight hardware, including an Android phone (see below).

Both engines implement the same internal interface, so the rest of the app —
campaigns, webhooks, the dashboard — doesn't need to know or care which one
is running underneath.

## Quick start (Docker)

```bash
git clone https://github.com/AadeshGurav/Senderrr.git
cd Senderrr
./scripts/senderrr.sh
```

No `.env` is required to get started — the app writes sane defaults
(SQLite, no Redis, local file storage) to `data/.env.generated` on first
run, and prints an auto-generated admin API key to the console. Create a
`.env` file later to override anything (database, storage, engine choice,
etc.) — see [`docs/`](docs/) for the full list of settings.

`scripts/senderrr.sh` reads `.env` and brings up the right set of Docker
Compose profiles (dashboard, proxy, queue, etc.) for your configuration. See
[`docs/`](docs/) for the full architecture, API reference, and operations
guides — start with
[`docs/01-project-overview.md`](docs/01-project-overview.md).

## Running it on an Android phone

Because the `baileys` engine needs no browser, Senderrr can run entirely on a
dedicated Android phone — no cloud hosting required — and be exposed to the
internet over a Cloudflare Tunnel. There's a guided, no-coding-required setup
for this:

**➡️ [ANDROID_SETUP.md](ANDROID_SETUP.md)** — step-by-step instructions for
turning a spare phone into a 24/7 Senderrr server, including a single setup
script (`scripts/setup-android.sh`) that installs everything, generates the
required secrets, and configures internet access automatically.

## Documentation

The [`docs/`](docs/) directory has the full reference set: requirements,
system architecture, database design, API specification, deployment and
operational runbooks, troubleshooting, and more — see
[`docs/21-glossary.md`](docs/21-glossary.md) if you're looking for a specific
term, or [`docs/12-troubleshooting-faq.md`](docs/12-troubleshooting-faq.md)
for common issues.

## License

MIT — see the upstream [OpenWA](https://github.com/rmyndharis/OpenWA) project,
of which this is a fork.
