---
name: omadia-onboarding
description: >-
  Install and launch the omadia desktop app from the latest GitHub Release, then
  open the onboarding wizard. Idempotent and self-healing: if omadia is already
  installed, re-running only relaunches it. Use when a person asks you to install,
  set up, try, or run omadia locally.
---

# Install omadia locally

You are helping a non-technical person install **omadia** — a self-hosted agentic
OS — on their own machine and open its onboarding wizard. omadia ships a native
desktop app (no Docker, no build tools) with an embedded database, so the whole
job is: download the right installer for this machine from the latest GitHub
Release, install it, launch it, and confirm the wizard appears.

Follow the steps in order. Run one command at a time and **show the user each
command before you run it** — the desktop apps ask for confirmation, and the user
should see what is happening.

## Rules (do not skip)

- **Only install official signed release assets** from
  `https://github.com/byte5ai/omadia`. Never download omadia from anywhere else.
- **Never build from source and never use Docker** in this path. If a step below
  fails, stop and tell the user — do not fall back to cloning the repo, running
  `npm`, or `docker compose`. Those paths are for developers, not for this
  install, and a from-source build produces an unsigned app the OS will block.
- **Resolve the download URL from the release API, not by guessing a filename.**
  The desktop version string is pinned independently of the release tag, so the
  asset is named `omadia-0.1.0-*` even in release `v0.59.x`. Always read the
  asset's own `browser_download_url` from the API response (Step 3–4).

## Step 1 — If omadia is already installed, just launch it

This skill is idempotent. Before downloading anything, check whether omadia is
already installed at the per-OS path; if it is, **launch it and skip to Step 6**.
Do not re-download. After the first install, omadia updates itself in the
background (electron-updater), so a fresh download is only needed the first time.

- **macOS:** look for `/Applications/omadia.app` (also check `~/Applications/omadia.app`).
  If present: `open /Applications/omadia.app` → go to Step 6.
- **Windows:** look for `omadia.exe` under `%LOCALAPPDATA%\Programs\omadia`.
  If present: launch it → go to Step 6.
- **Linux:** look for a previously downloaded `omadia-*.AppImage` (e.g. in
  `~/Applications` or `~/Downloads`). If present and executable: run it → Step 6.

## Step 2 — Detect the operating system and CPU architecture

Determine which installer this machine needs:

- **macOS Apple Silicon (M1/M2/M3/M4):** `arch = arm64`
- **macOS Intel:** `arch = x64`
- **Windows:** `x64` (only build published)
- **Linux:** `x64` AppImage (only build published)

On macOS, `uname -m` returns `arm64` (Apple Silicon) or `x86_64` (Intel).

## Step 3 — List recent releases from the GitHub API

No `gh` CLI is required — plain `curl` works. **Do not use `/releases/latest`.** A
single release can be *partial* — a macOS or Windows build sometimes fails
(signing/notarization) and that tag ships with only the Linux asset, yet it is
still the "latest" release. So list the recent releases (newest first) and pick
the newest one that actually has the asset for *this* machine:

```bash
curl -fsSL "https://api.github.com/repos/byte5ai/omadia/releases?per_page=20"
```

This returns a JSON array of releases, newest first, each with an `assets` array;
every asset has a `name` and a `browser_download_url`.

## Step 4 — Pick the newest asset for this machine

Match the asset **by pattern** (the version number in the name will change; the
pattern will not). Scanning the `?per_page=20` response top-to-bottom, the **first**
matching asset is the one from the newest release that has it:

| This machine | Match asset name | Example |
|---|---|---|
| macOS Apple Silicon | ends with `-arm64.dmg` | `omadia-0.1.0-arm64.dmg` |
| macOS Intel | ends with `-x64.dmg` | `omadia-0.1.0-x64.dmg` |
| Windows | matches `omadia.Setup.*.exe` | `omadia.Setup.0.1.0.exe` |
| Linux | ends with `.AppImage` | `omadia-0.1.0.AppImage` |

Ignore `.blockmap`, `.yml`, `.zip`, and `.deb` assets for this flow — the `.dmg`,
`.exe`, and `.AppImage` are the installers.

**macOS/Linux** — resolve the download URL in one command (example: Apple Silicon):

```bash
curl -fsSL "https://api.github.com/repos/byte5ai/omadia/releases?per_page=20" \
  | grep -o '"browser_download_url": *"[^"]*-arm64\.dmg"' \
  | head -n1 | cut -d'"' -f4
```

Swap the pattern for `-x64\.dmg` (Intel) or `[^"]*\.AppImage` (Linux). `head -n1`
takes the newest match because the array is newest-first. Prefer `jq` if present.

**Windows** — in PowerShell, use `Invoke-RestMethod` (do **not** use `curl` here:
in PowerShell `curl` is an alias for `Invoke-WebRequest` and won't accept these
flags — use the real `curl.exe` or the cmdlet below):

```powershell
$releases = Invoke-RestMethod "https://api.github.com/repos/byte5ai/omadia/releases?per_page=20"
$ExeUrl = ($releases.assets | Where-Object { $_.name -match '^omadia\.Setup\..*\.exe$' } |
           Select-Object -First 1).browser_download_url
```

If no asset matches for this machine in any of the 20 releases (e.g. no macOS
build has shipped recently), **stop and tell the user** — do not fall back to a
build from source.

## Step 5 — Download and install

Download to a temp directory first, then install per OS:

**macOS** (`.dmg`):

```bash
# DMG_URL is the browser_download_url from Step 4
curl -fsSL -o /tmp/omadia.dmg "$DMG_URL"
hdiutil attach /tmp/omadia.dmg -nobrowse -quiet     # mounts under /Volumes/omadia*
cp -R "/Volumes/omadia"*/omadia.app /Applications/  # copy the app in
hdiutil detach "/Volumes/omadia"* -quiet            # unmount
rm /tmp/omadia.dmg
```

**Windows** (`.exe`, per-user NSIS installer):

```powershell
# $ExeUrl is the browser_download_url from Step 4. Use Invoke-WebRequest, NOT
# `curl` — in PowerShell `curl` aliases Invoke-WebRequest and won't take -o.
Invoke-WebRequest -Uri $ExeUrl -OutFile "$env:TEMP\omadia-setup.exe"
Start-Process -Wait "$env:TEMP\omadia-setup.exe"    # installs per-user; confirm the prompts
```

**Linux** (`.AppImage`, no install — the file *is* the app):

```bash
# APPIMAGE_URL is the browser_download_url from Step 4
mkdir -p ~/Applications
curl -fsSL -o ~/Applications/omadia.AppImage "$APPIMAGE_URL"
chmod +x ~/Applications/omadia.AppImage
```

## Step 6 — Launch omadia

- **macOS:** `open /Applications/omadia.app` (launch by path — a freshly copied
  app may not be registered with Launch Services yet, so `open -a omadia` can miss).
- **Windows:** launch omadia from the Start menu or run the installed `omadia.exe`.
- **Linux:** `~/Applications/omadia.AppImage`

The app starts an embedded database and the omadia kernel on first launch, which
can take up to about a minute. It shows its own progress and health check while
it boots — you do **not** need to check any port or URL yourself.

## Step 7 — Verify: the onboarding wizard is open

Confirm two things:

1. The omadia process is running.
2. The omadia window shows the **onboarding wizard** (the first-run setup screen
   that asks for an AI provider).

If the window is open and the wizard is visible, the install succeeded — hand
back to the user to finish the wizard. If the app launched but no window appears
after ~90 seconds, tell the user and stop (do not retry a from-source install).

## Note on the AI provider key (no API key required)

The wizard asks for an AI provider. If the user has a **Claude Pro or Max**
subscription, they can pick the CLI-subscription provider instead of pasting a
metered API key — omadia can run on the subscription they already have. Mention
this so they don't think a paid API key is mandatory.

One prerequisite for that option: omadia detects the subscription by finding the
vendor's **official CLI installed and logged in on this machine**. So the
CLI-subscription path needs the `claude` CLI installed and authenticated locally
first. If the user hasn't got it, the API-key option always works as the fallback.
