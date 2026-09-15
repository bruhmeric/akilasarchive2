# Akilas Archive

A public **file terminal** for your Cloudflare R2 buckets — a beautiful
Linux-style command-line site with extensive search, one-time download
links, and a private admin panel — sized for a **512 MB / 1 vCPU VPS**.

```
                       ┌───────────────────────────────┐
   visitors ──────────▶│  akilasarchive.site          │  Caddy (auto-HTTPS) + app
                       │  terminal UI · search · links │  Docker, ~130 MB RAM total
                       └──────────────┬────────────────┘  (metadata only — KBs)
                                      │ list/index objects
                                      ▼
                          Cloudflare R2  (your buckets)

   visitors ──────────▶ dl.akilasarchive.site ─▶ Cloudflare Worker ─▶ R2
                       (one-time HMAC link)      streams the file
```

**File bytes never touch the VPS.** The VPS only ever serves the terminal
HTML/CSS/JS and small JSON search results. Downloads are streamed from
Cloudflare's edge by the Worker.

---

## What you get

| piece | where | what it does |
|---|---|---|
| `app/` | your VPS (Docker) | Node 22 + Express + SQLite — terminal UI, admin panel, search index, one-time link issuer. No build step. |
| `worker/` | Cloudflare Workers | download gateway: validates one-time links, streams R2 objects, supports resume (Range). |
| `Caddyfile` | your VPS | automatic HTTPS for akilasarchive.site, compression, security headers. |
| `deploy.sh` | your VPS | one-command deploy / update from git. |

Public visitors only ever see `akilasarchive.site` URLs. No bucket names, no
R2 endpoints, no account IDs appear anywhere in the public UI — links are
one-time, single-use and expire in minutes.

---

## 0 · Prerequisites

- VPS with Docker + docker compose v2 (Ubuntu: `curl -fsSL https://get.docker.com | sh`)
- Domain **akilasarchive.site** at Namecheap
- A free Cloudflare account with **R2** enabled (billing tab → R2 → purchase
  the free plan — gives 10 GB storage + zero egress fees on the worker path)
- Ports 80/443 free on the VPS (your existing app on 8080 is untouched)

---

## 1 · R2 buckets + API token

1. Cloudflare dashboard → **R2** → note your **Account ID** (right sidebar).
2. Create your buckets if not done yet (e.g. `movies`, `tv`, `music`) and
   upload files (rclone is great for this).
3. R2 → **Manage API Tokens** → **Create API token**:
   - permissions: **Object Read & Write**
   - scope: *Apply to all buckets* (so you can add buckets from the admin
     panel without touching the token)
   - copy the **Access Key ID** and **Secret Access Key**.

## 2 · Deploy the download Worker (from your own PC, not the VPS)

The worker is deployed once from any machine with Node installed:

```bash
cd worker
npm install
npx wrangler login            # opens a browser to authorise
```

Edit `wrangler.toml`: set `R2_ACCOUNT_ID` in `[vars]`.

Set the three secrets:

```bash
npx wrangler secret put DOWNLOAD_SECRET      # paste: openssl rand -hex 32
npx wrangler secret put R2_ACCESS_KEY_ID     # your R2 Access Key ID
npx wrangler secret put R2_SECRET_ACCESS_KEY # your R2 Secret
npx wrangler deploy
```

Note the printed URL (`https://akilas-archive-dl.<your-sub>.workers.dev`) —
this is your `DOWNLOAD_BASE_URL` unless you do step 2b.

### 2b (recommended) · Custom domain `dl.akilasarchive.site`

Serve downloads from your own subdomain instead of `workers.dev`:

1. In Cloudflare, add your domain: dash → **Add a domain** → `akilasarchive.site`
   (free plan) → it gives you **two nameservers**.
2. Namecheap → Domain → Nameservers → **Custom DNS** → paste the two
   Cloudflare nameservers. (DNS propagates in minutes to hours.)
3. In Cloudflare **DNS**: add record `A` → name `@` → your **VPS IP**, proxy
   status **DNS only (grey cloud)** — so Caddy on the VPS handles TLS.
4. In `worker/wrangler.toml`, **uncomment** the `routes` block
   (`pattern = "dl.akilasarchive.site"`) → `npx wrangler deploy` again.

If you skip 2b, just set `DOWNLOAD_BASE_URL` in `.env` to the
`workers.dev` URL — everything else works identically.

## 3 · DNS for the main site

- **If you moved nameservers to Cloudflare (step 2b):** nothing more to do —
  the `A @ → VPS IP` record (grey cloud) already points the apex at your VPS.
  Optionally add `CNAME www → akilasarchive.site` (also grey).
- **If you stayed on Namecheap DNS:** in Namecheap → Advanced DNS add
  `A Record | @ | <VPS IP>` and `A Record | www | <VPS IP>`, and use the
  `workers.dev` URL as `DOWNLOAD_BASE_URL`.

Open the firewall (only needed once):

```bash
sudo ufw allow 80/tcp && sudo ufw allow 443/tcp
```

## 4 · Deploy on the VPS (from git)

```bash
ssh your-vps
git clone <your-repo-url> akilas-archive && cd akilas-archive
cp .env.example .env
nano .env          # fill in every value (see the file's comments)
./deploy.sh
```

`deploy.sh` builds the image, starts `app` + `caddy`, and waits for the
health check. Caddy obtains the TLS certificate automatically on the first
request to `https://akilasarchive.site`.

**Updates from git are just:**

```bash
git pull && ./deploy.sh
```

### .env values (full reference)

| var | value |
|---|---|
| `R2_ACCOUNT_ID` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` | from step 1 |
| `DOWNLOAD_SECRET` | the same hex secret you set on the worker |
| `SESSION_SECRET` | `openssl rand -hex 32` |
| `ADMIN_PASSWORD` | initial admin password (**first boot only** — afterwards change it in the panel; see Troubleshooting to recover) |
| `ADMIN_PASSWORD_FORCE` | `1` = overwrite the stored password from `ADMIN_PASSWORD` on next boot (recovery only, remove after) |
| `DOWNLOAD_BASE_URL` | `https://dl.akilasarchive.site` or the workers.dev URL |
| `DL_MODE` | `worker` (recommended) or `presign` fallback |
| `TURNSTILE_SITE_KEY` | public site key of your Turnstile widget (shows the CAPTCHA on the admin login) |
| `TURNSTILE_SECRET` | the widget's **Secret Key** from the Cloudflare dashboard — while empty, verification is OFF |
| `TURNSTILE_HOSTNAMES` | optional comma-separated hostname allowlist; default = hostname of `PUBLIC_BASE_URL` |

## 5 · Configure your categories

Open **`https://akilasarchive.site/admin`** and log in.

### 5a (optional) · Turnstile CAPTCHA on the admin login

A Cloudflare Turnstile widget protects the admin login from bots and
credential-stuffing. The widget is already created in your Cloudflare
dashboard (Turnstile → your widget → site key `0x4AAAAAAE1dPKOfQ8Nb4P8f`).
To enable it end-to-end:

1. **Widget hostnames** — Cloudflare dashboard → **Turnstile → your widget
   → Hostname Management**: add `akilasarchive.site` (the exact hostname
   your browser shows on `/admin`), then **save**. This list is checked by
   the widget itself when it renders — a missing hostname makes the widget
   appear but fail with Cloudflare error **110200 (domain not authorized)**,
   visible as a generic "troubleshoot" link inside the widget box. The login
   card prints the exact error code + fix when this happens. If you also want
   to test from `localhost`, add `localhost` there too — but never add it to
   `TURNSTILE_HOSTNAMES` in production.
2. **`.env` on the VPS** — set both keys:
   ```bash
   TURNSTILE_SITE_KEY=0x4AAAAAAE1dPKOfQ8Nb4P8f
   TURNSTILE_SECRET=<Secret Key from dashboard → Turnstile → your widget>
   docker compose up -d   # picks up the new env
   ```
   Keep the secret only in `.env` (it is git-ignored) — never in chat,
   issues or anywhere else.
3. **Verify**: open `/admin` — the widget appears under the password field;
   after logging in, **settings → deployment** shows `login captcha:
   turnstile on · akilasarchive.site`.

How it behaves:

- With only `TURNSTILE_SITE_KEY` set, the widget renders but the server does
  not enforce it (migration-safe; the boot log says so).
- With `TURNSTILE_SECRET` set, every login is **rejected** unless the token
  passes Cloudflare's siteverify (success + action `login` + hostname in the
  allowlist). Captcha failures are logged as `login_captcha` in the activity
  log; they never consume the 6-attempt password lockout.
- If siteverify is unreachable, login fails closed (`captcha verification
  unavailable`) — retry shortly; this is the canonical Turnstile behavior.
- Widget-side failures surface on the login card with the official Turnstile
  error code and a fix (e.g. `110200` hostname not in the widget's Hostname
  Management, `110100/400020` bad site key, `400070` disabled widget,
  `200500` blocked iframe). Expired tokens re-challenge automatically.
- Removing both vars restores the previous login flow, widget included.

**Admin panel basics** (the usual workflow):

- **Categories → add category**: e.g. name `Movies`, bucket `movies`.
  The panel tests the bucket against R2 immediately, then starts indexing.
- Each category = one served bucket; the **toggle switch** instantly
  shows/hides it in the public terminal (your "control which buckets to
  serve" switch).
- **Settings**: re-index interval, one-time link lifetime, download window,
  and the admin password.
- **Log**: audit trail of logins, re-indexes and category changes.

Public site: **`https://akilasarchive.site`** — a terminal:

```
guest@akilasarchive:~$ ls
guest@akilasarchive:~$ cd movies
guest@akilasarchive:~/movies$ search matrix -t mkv --min 1GB
guest@akilasarchive:~/movies$ download 42
✔ one-time download link ready:
    https://akilasarchive.site/get/AbC123…
```

Commands: `ls · cd · tree · search (find/grep) · download (dl) · info ·
stats · neofetch · theme · crt · help` — plus tab completion, history and
clickable rows. `help search` shows all search flags
(`-c` category, `-t` type, `--min/--max` size, `--sort`, pages…).

---

## Memory footprint (512 MB VPS)

| process | RAM |
|---|---|
| app (Node, capped at `--max-old-space-size=192`, compose `mem_limit: 280m`) | ~70–140 MB |
| caddy | ~20–40 MB |
| **total** | **~150 MB** — plenty of headroom for your 8080 app |

Recommended extras on a small VPS: add a swapfile (`fallocate -l 1G
/swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile`
+ fstab entry) so the first big index build never OOMs.

Indexing only **lists object metadata** (1000 keys per request, batched and
yielding so the terminal stays responsive); it never downloads file bytes.

## Operations cheat-sheet

```bash
docker compose ps                # status
docker compose logs -f app       # app logs
docker compose restart app       # restart
./deploy.sh                      # re-deploy / update
docker compose exec app node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>r.text()).then(console.log)"
```

Backups: everything durable lives in `./data/archive.db` (SQLite) + `.env`.
`cp -a data /backup` while the app is stopped is a full backup.

## Troubleshooting

| symptom | fix |
|---|---|
| container restart-loop with `[FATAL] Missing required environment variable` | `.env` incomplete — `docker compose logs app` names the variable. |
| **admin login rejects the `.env` password** | **`ADMIN_PASSWORD` is only read on the very first boot** — afterwards the password lives in the database (`./data/archive.db`) and editing `.env` does nothing. Two fixes: (a) add `ADMIN_PASSWORD_FORCE=1` to `.env`, set `ADMIN_PASSWORD` to the desired value, `docker compose up -d`, log in, then remove the force flag; or (b) hot-reset without restarting: `docker compose exec app node scripts/reset-password.js 'MyNewPass123'`. Also note: 6 failed attempts lock your IP out for 15 minutes ("locked — retry in N min") — a restart clears it immediately. |
| admin login says "locked — retry in N min" | brute-force lockout (15 min). Wait it out, or clear instantly with `docker compose restart app`. |
| admin "R2 list failed" on add | wrong bucket name, or token scope/permissions — test with `aws s3 ls --endpoint https://<acct>.r2.cloudflarestorage.com` or rclone. |
| admin login says "captcha required — complete the human verification" but no widget appears | `TURNSTILE_SECRET` is set but `TURNSTILE_SITE_KEY` is missing/typo'd in `.env` — the login card names this exact problem in current versions. Also: older `admin.js` had a bug where the widget could NEVER load (a `<div id="turnstile">` collides with the `window.turnstile` API name) — update to the latest release (`git pull && ./deploy.sh`) and hard-refresh. |
| widget shows an error / "troubleshoot" link, no verification happens | Cloudflare error **110200 — domain not authorized**: the hostname in your address bar is not in the widget's Hostname Management. Dashboard → Turnstile → widget → Hostnames → add `akilasarchive.site` (and `www.` variants if used) → save → hard-refresh. (The login card prints the exact code; other codes: `110100/400020` bad site key, `400070` widget disabled, `200500` blocked iframe.) |
| admin login says "captcha verification failed — retry" | token rejected by siteverify: most common cause is the widget's domain list not containing the hostname you're visiting (dashboard → Turnstile → widget → domains), or the hostname allowlist (`TURNSTILE_HOSTNAMES`, default `akilasarchive.site` from `PUBLIC_BASE_URL`) mismatching. |
| admin login says "captcha verification unavailable" | the VPS could not reach `challenges.cloudflare.com` (outbound network/DNS) — login fails closed by design; retry once connectivity is back. |
| terminal shows volumes but "no volumes mounted yet" | categories not added/enabled in admin, or index still running — check dashboard. |
| `/get/<link>` → 403 invalid signature | `DOWNLOAD_SECRET` differs between `.env` (VPS) and the worker secret — re-run `wrangler secret put`. |
| `/get/<link>` → worker 500 misconfigured | worker missing `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` / `R2_ACCOUNT_ID`. |
| download starts then dies at ~100 MB | you're on workers.dev with `DL_MODE=worker` — fine normally; if it persists check R2 token perms. |
| certificate errors on first visit | DNS not propagated yet, or ports 80/443 blocked — `docker compose logs caddy`. |
| something on the VPS already uses 80/443 | stop it, or remap ports in `docker-compose.yml` and adjust `Caddyfile` site addresses. |

## Security notes

- Public API is read-only, rate-limited, and reveals only category names,
  file names/sizes/dates and `/get/<token>` links — never bucket names or R2
  endpoints (in `worker` mode).
- One-time links: single-use, short-lived, redeemable once, then HTTP 410.
- Admin: scrypt-hashed password, HttpOnly+SameSite cookie, login rate
  limiting + lockout, audit log; `/admin` is `noindex` and blocked in
  `robots.txt`. Optional Cloudflare Turnstile CAPTCHA gates the login
  (siteverify is validated server-side, fail-closed — see section 5a).
- The app runs as an unprivileged user; SQLite lives in `./data`.

## Local demo (no R2 needed)

```bash
cd app
DATA_DIR=./data-demo R2_ACCOUNT_ID=0 R2_ACCESS_KEY_ID=x R2_SECRET_ACCESS_KEY=x \
DOWNLOAD_SECRET=$(openssl rand -hex 32) SESSION_SECRET=$(openssl rand -hex 32) \
ADMIN_PASSWORD=test1234 node ../scripts/seed-demo.js
# then start with the same env and DATA_DIR and open http://localhost:3000
```
