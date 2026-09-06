# Running Senderrr on an Android Phone

This guide walks you through turning a spare Android phone into a Senderrr server —
no coding, no computer required. Once it's done, that phone runs Senderrr
24/7 and is reachable from anywhere on the internet.

Expect this to take **30–45 minutes** the first time, most of it waiting for
downloads and installs.

This is the Termux-based setup — the fastest way to get Senderrr running on a
phone today. A dedicated Senderrr Android app (no Termux, install one APK,
updates itself) is planned next; see
[`docs/23-android-ndk-migration-prd.md`](docs/23-android-ndk-migration-prd.md)
if you want the full roadmap. This guide will keep working after that app
ships — it isn't going away.

## What you'll need

- **An Android phone** you can dedicate to this (it won't be usable as a
  normal phone while it's running the server — see [Notes](#notes-before-you-start) below).
- **A charger** — this phone stays plugged in and running all the time.
- **Wi-Fi** for the phone.
- **A WhatsApp number** you want to automate — this can be a number on
  *any* phone (including this one). You'll link it using WhatsApp's own
  "Linked Devices" feature, the same way WhatsApp Web works.

## Notes before you start

- Use a phone you don't need for daily use. It needs to stay powered on,
  connected to Wi-Fi, and running this software continuously.
- Keep it somewhere cool — like the rest of a home server, it'll run best in
  an air-conditioned room rather than direct sun or a hot pocket.
- Turn off automatic system and app updates for this phone (Play Store
  auto-update, Android system updates). An update that reboots the phone or
  changes permissions mid-run can interrupt the server.

## Step 1 — Install Termux

Termux turns your phone into a small Linux computer, which is what lets
Senderrr run on it at all.

**Important:** install Termux from **F-Droid**, not the Google Play Store —
the Play Store version is outdated and no longer maintained.

1. On the phone, open a browser and go to: **https://f-droid.org/en/packages/com.termux/**
2. Tap **Download APK**, then open the downloaded file to install it.
   (Android will warn about installing from an unknown source — this is
   expected for F-Droid; allow it for your browser app.)
3. Also install **Termux:Boot**, a companion app that starts Senderrr
   automatically if the phone ever restarts: **https://f-droid.org/en/packages/com.termux.boot/**
   Open Termux:Boot once after installing it (just open the app, you don't
   need to do anything inside it) so Android registers it.

## Step 2 — Turn off the lock screen

This is a one-time Android setting, not a Senderrr setting — but skipping it
will cause the server to fail to start after every phone restart.

Go to **Settings → Security → Screen lock → None**.

(Android encrypts app data behind your lock screen PIN/pattern by default.
On a normal phone that's a good thing; on a dedicated server with nobody
to type in a PIN after a restart, it means the server can't read its own
data until someone manually unlocks it. Setting the lock screen to "None"
avoids that.)

## Step 3 — Open Termux and run the setup

Open the Termux app. You'll see a black screen with a text prompt — this is
completely normal, it's how Termux works. Type (or copy-paste) each of the
following, pressing Enter after each line:

```
pkg install git -y
git clone https://github.com/AadeshGurav/Senderrr.git
cd Senderrr
bash scripts/setup-android.sh
```

This one script does everything else automatically:

- Installs Node.js and the tools needed to build Senderrr.
- Keeps the phone's CPU awake while Senderrr runs, and opens Termux's
  battery settings so you can set it to "Unrestricted" (Android will
  otherwise slow down or kill background apps — when the app-info screen
  opens, tap **Battery → Unrestricted**, then go back to Termux and press
  Enter to continue).
- Downloads Senderrr's dependencies and builds it.
- Generates random security keys for you — you don't need to invent or
  remember any passwords.
- Installs **Cloudflare Tunnel**, which is what makes the phone reachable
  from the internet without opening any router ports.
- Asks **one question**, and only if it needs to: whether you want an
  instant free internet address (no account needed, but it changes each
  time the server restarts) or a permanent one on your own domain (needs a
  free Cloudflare account — the script tells you exactly where to get the
  token if you choose this). If you're just trying this out, pick the
  instant free one; you can switch to a permanent address later by editing
  the `.env` file and re-running the script.
- Sets up auto-start, so Senderrr comes back on its own if the phone ever
  reboots or loses power.
- Starts everything and prints your Dashboard link.

If anything fails partway through, it's safe to just run
`bash scripts/setup-android.sh` again — it picks up where it left off.

## Step 4 — Connect WhatsApp

Once the script finishes, it prints a **Dashboard** link
(`http://localhost:2785/wa/dashboard` on the phone itself, or your public
link from Cloudflare Tunnel if you set one up).

1. Open that link in a browser (on the phone, or from any other device if
   you're using the public link).
2. Go to **Sessions** in the left menu.
3. Click **New Session**, give it a short name (e.g. `main`), and confirm.
4. A QR code appears. On the phone that has the WhatsApp account you want
   to automate:
   - Open **WhatsApp**
   - Tap **Menu → Linked Devices**
   - Tap **Link a Device** and scan the QR code shown in the Dashboard.
5. The session status will flip to connected within a few seconds. That's
   it — Senderrr is now live on that WhatsApp number.

## Checking on it later

From Termux, at any time:

```
pm2 status          # is it running?
pm2 logs            # what's it doing right now?
pm2 restart all     # restart Senderrr and the tunnel
```

## Troubleshooting

**The setup script fails during `npm install`, mentioning `sqlite3` or
`node-gyp`.**
Some phones can't compile this one piece from source. Open the `.env` file
(`nano .env` in Termux) and add a line `DATABASE_TYPE=postgres` pointing at
a remote Postgres database (for example a free one from
[Neon](https://neon.tech)) instead of the phone's local storage, then run
`bash scripts/setup-android.sh` again.

**The server doesn't come back after the phone restarts.**
Double-check Termux:Boot is installed and was opened once (Step 1), and
that the lock screen is set to "None" (Step 2). Both are required for
auto-start to work.

**My public link stopped working.**
If you chose the free instant link, it changes every time the tunnel
restarts (e.g. after a phone reboot) — check `pm2 logs senderrr-tunnel` for
the new one, or switch to a permanent address (see Step 3) so the link
never changes.

**I want to see the auto-generated admin key again.**
It's saved in the project folder — run `cat data/.api-key` in Termux.
