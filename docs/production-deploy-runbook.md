# OpenWA Production Deploy Runbook

Step-by-step guide for deploying code from your local Mac to the production server. Written after the **inbound hardening** stability patch (July 2026).

---

## Quick reference

| Item | Value |
|------|-------|
| **Local repo (Mac)** | `/Users/abozaid/workspace/OpenWA` |
| **Your fork** | https://github.com/abozaid010/OpenWA |
| **Upstream (original)** | https://github.com/rmyndharis/OpenWA |
| **Production branch** | `feat/inbound-hardening` |
| **Production server** | `lenaai-restore-1` (GCP, `europe-west3-c`, project `chat-history-449709`) |
| **Server install path** | `/home/abozaid/OpenWA` |
| **API port (host)** | `127.0.0.1:2785` |

### Git remotes (Mac)

```
origin   → https://github.com/abozaid010/OpenWA.git      (your fork — push here)
upstream → https://github.com/rmyndharis/OpenWA.git      (original — pull updates)
```

### Current branch state (as of deploy)

| Branch | Commit | Notes |
|--------|--------|-------|
| `feat/inbound-hardening` | `fe27ce5` | Stability patch — **deploy this** |
| `main` (local) | `5dd8c28` / v0.4.1 | Base release; 276 commits behind upstream `main` (v0.8.0) |

Fork branch URL: https://github.com/abozaid010/OpenWA/tree/feat/inbound-hardening

---

## What the stability patch does

Two env-gated changes in `whatsapp-web-js.adapter.ts` (no behavior change unless env vars are set):

| Env var | Server value | Effect |
|---------|--------------|--------|
| `INBOUND_MEDIA_MAX_BYTES` | `5242880` (5 MB) | Skip `downloadMedia()` for larger inbound files. Delivers metadata-only webhook (`skippedMedia: true`). Protects Chromium RAM and stops 413 webhook retries. |
| `PUPPETEER_PROTOCOL_TIMEOUT_MS` | `120000` | Caps stuck Chromium CDP calls (typing, sends, downloads) so they fail fast instead of wedging the worker. |

**Files in the patch:**

- `src/engine/adapters/whatsapp-web-js.adapter.ts` — skip logic + optional `protocolTimeout`
- `src/engine/interfaces/whatsapp-engine.interface.ts` — `skippedMedia`, `mediaSizeBytes` fields
- `docker-compose.yml` — env forwards (empty defaults)
- `.env.example` — documentation

**Typing:** `SIMULATE_TYPING` stays enabled on the server. The patch reduces Chromium load (no big downloads) and bounds stuck CDP calls — typing should stay healthy without disabling it.

---

## Hard rules (every deploy)

1. **Never replace** server `docker-compose.yml` or `.env` wholesale from git.
2. **Append** new compose env-forward lines by hand if missing.
3. **Do not** `git pull upstream main` on the server until you plan a v0.8.0 upgrade.
4. Deploy = **new image + restart** — volumes and session data persist in Docker volume `openwa_openwa-data`.
5. Remove **inline comments** from `.env` value lines (e.g. `5242880 # 5 MB` breaks parsing).

---

## Server-specific config (operator-owned, do not overwrite)

These exist only on the server compose — keep them when pulling code:

- Traefik dashboard port `8085:8080` (not 8080)
- `mem_limit: 5g` (hardcoded, not `${OPENWA_MEM_LIMIT}`)
- `pids_limit: 2048`
- `read_only: true` commented out
- `AUTO_START_SESSIONS=true`
- `NODE_OPTIONS=--max-old-space-size=768`
- `SIMULATE_TYPING` / `SIMULATE_TYPING_MAX_MS` forwards

Backups from first deploy: `~/OpenWA/.env.deploy.bak`, `~/OpenWA/docker-compose.yml.deploy.bak`

---

## One-time setup (already done)

Skip this section if remotes and fork already exist.

### Mac

```bash
cd /Users/abozaid/workspace/OpenWA

# Fork: https://github.com/rmyndharis/OpenWA → abozaid010/OpenWA (GitHub UI)

git remote rename origin upstream    # skip if already configured
git remote add origin https://github.com/abozaid010/OpenWA.git
git remote -v
```

### Server

```bash
cd ~/OpenWA
git remote add fork https://github.com/abozaid010/OpenWA.git
```

### Required compose forwards (server `openwa-api.environment:`)

Must exist or the container will not see `.env` values:

```yaml
      - PUPPETEER_PROTOCOL_TIMEOUT_MS=${PUPPETEER_PROTOCOL_TIMEOUT_MS:-}
      - INBOUND_MEDIA_MAX_BYTES=${INBOUND_MEDIA_MAX_BYTES:-}
```

### Required server `.env` values

```bash
INBOUND_MEDIA_MAX_BYTES=5242880
PUPPETEER_PROTOCOL_TIMEOUT_MS=120000
```

---

## Deploy workflow (repeat every code change)

### Part A — Mac: commit and push

```bash
cd /Users/abozaid/workspace/OpenWA

# Work on the production branch
git checkout feat/inbound-hardening
git pull origin feat/inbound-hardening

# … make changes …

# Stage only what you intend to deploy (example — adjust paths)
git add \
  src/engine/adapters/whatsapp-web-js.adapter.ts \
  src/engine/interfaces/whatsapp-engine.interface.ts \
  docker-compose.yml \
  .env.example

git commit -m "feat(engine): describe your change"
git push origin feat/inbound-hardening
```

Optional: open a PR on your fork for your own record — not required for deploy.

### Part B — Server: pull code, rebuild, restart

SSH to the server:

```bash
gcloud compute ssh abozaid@lenaai-restore-1 \
  --project=chat-history-449709 \
  --zone=europe-west3-c \
  --tunnel-through-iap
```

On the server:

```bash
cd ~/OpenWA

# Backup operator config before any git operation
cp .env .env.deploy.bak
cp docker-compose.yml docker-compose.yml.deploy.bak

# Pull ONLY source files from fork (preserves server compose + .env)
git fetch fork feat/inbound-hardening
git checkout fork/feat/inbound-hardening -- \
  src/engine/adapters/whatsapp-web-js.adapter.ts \
  src/engine/interfaces/whatsapp-engine.interface.ts \
  .env.example

# Restore operator config
cp .env.deploy.bak .env

# Rebuild and restart (sessions persist in Docker volume)
docker compose build openwa-api
docker compose up -d openwa-api
```

**Alternative:** full branch checkout (only if you know compose/.env won't be clobbered):

```bash
git fetch fork feat/inbound-hardening
git checkout feat/inbound-hardening
git pull fork feat/inbound-hardening
cp .env.deploy.bak .env
cp docker-compose.yml.deploy.bak docker-compose.yml
# then manually re-merge any new compose env lines from the repo
docker compose build openwa-api && docker compose up -d openwa-api
```

Prefer the **checkout specific files** method — it is safer for production.

---

## Verify after every deploy

```bash
# Env vars must be inside the container
docker exec openwa-api printenv INBOUND_MEDIA_MAX_BYTES PUPPETEER_PROTOCOL_TIMEOUT_MS
# Expected:
# 5242880
# 120000

# Health
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:2785/api/health/ready
# Expected: 200

# Patch present in compiled image
docker exec openwa-api grep -l "Skipping oversized inbound media" \
  /app/dist/engine/adapters/whatsapp-web-js.adapter.js
# Expected: path printed

# Resource usage
docker stats openwa-api --no-stream

# Error scan
docker logs openwa-api 2>&1 | grep -iE "ProtocolError|413|Skipping oversized" | tail -20
```

### Functional test (manual)

Send a **>5 MB** file to a 1:1 WhatsApp chat. Then:

```bash
docker logs openwa-api 2>&1 | grep -i "Skipping oversized inbound media" | tail -5
```

Expected: log line with byte count; webhook payload has `skippedMedia: true`, no base64; no RAM spike in `docker stats`.

Send a **small image** (<5 MB): should still download and forward normally.

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `printenv` returns empty | Compose missing env forwards — append the two lines under `openwa-api.environment:` |
| Wrong byte limit | Check `.env` has no inline `#` comments on value lines |
| Build fails | Run `docker compose build openwa-api 2>&1 \| tail -50` and fix TypeScript errors locally first |
| Sessions gone after restart | Check `AUTO_START_SESSIONS=true` in server `.env` and compose forward |
| 413 still happening | Confirm patch is in image (`grep Skipping oversized …adapter.js`); confirm file sent was >5 MB |

---

## Keeping your fork updated with upstream

On Mac only — **do not do this on the production server** until you plan a major upgrade.

```bash
cd /Users/abozaid/workspace/OpenWA

git fetch upstream
git checkout main
git merge upstream/main          # upstream is now v0.8.0+
git push origin main
```

Your stability work stays on `feat/inbound-hardening`. When upgrading production to v0.8.0 later:

1. Create `production/v0.8.0` from `upstream/main`
2. Cherry-pick commit `fe27ce5` (and any follow-ups)
3. Test on staging before deploying to `lenaai-restore-1`

---

## Architecture: deploy flow

```
Mac (/Users/abozaid/workspace/OpenWA)
  │
  │  git push origin feat/inbound-hardening
  ▼
GitHub fork (abozaid010/OpenWA)
  │
  │  git fetch fork + checkout source files
  ▼
Server (/home/abozaid/OpenWA)
  │
  │  docker compose build openwa-api
  │  docker compose up -d openwa-api
  ▼
Container openwa-api
  │  reads INBOUND_MEDIA_MAX_BYTES, PUPPETEER_PROTOCOL_TIMEOUT_MS
  │  volume openwa_openwa-data → /app/data (sessions + sqlite)
  ▼
WhatsApp sessions (unchanged across deploy)
```

---

## Related docs

- [openwa-production-stability-plan.md](./openwa-production-stability-plan.md) — full Phases 1–6 stability plan
- Upstream repo: https://github.com/rmyndharis/OpenWA
- Your fork: https://github.com/abozaid010/OpenWA

---

*Last updated: July 2026 — after inbound hardening deploy to lenaai-restore-1*
