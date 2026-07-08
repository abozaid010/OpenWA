# OpenWA Production Stability Plan

**Goal:** Stabilize OpenWA on production (`lenaai-restore-1`, 5 concurrent wwebjs sessions, 5 GB container RAM).

**Release baseline:** `5dd8c28` / `v0.4.1` — no upstream fix to pull; inbound skip and hardening must be written in this fork.

---

## Hard Constraints (read first)

| Rule | What it means in practice |
|------|---------------------------|
| **Never overwrite server `docker-compose.yml` or `.env`** | Production has operator-specific overrides (Traefik port, `read_only` disabled, `mem_limit: 5g`, `pids_limit: 2048`, etc.). Deploy **images + env values**, not a wholesale compose replace. |
| **All new behavior behind env vars** | Code defaults must be safe; production toggles via `.env` only. Repo compose may **forward** vars with defaults — it must not hardcode production values. |
| **Repo compose ≠ production compose** | Merge only the **env forward lines** you need into the server compose by hand. Keep server-only edits (ports, limits, security opts) intact. |

### Safe deploy pattern (every code release)

```bash
# On dev machine — build and tag
git checkout feat/inbound-hardening   # or release tag after merge
docker compose build openwa-api
docker save … | ssh …   # or push to a registry the server pulls from

# On server — image swap only; do NOT git checkout over compose/.env
docker compose build openwa-api          # if building on-host
docker compose up -d openwa-api          # recreates container, keeps volumes + .env
docker exec openwa-api printenv INBOUND_MEDIA_MAX_BYTES PUPPETEER_PROTOCOL_TIMEOUT_MS SIMULATE_TYPING
```

To add a new env forward on the server, append **one line** to the `openwa-api.environment:` block — do not replace the file.

---

## Problems We're Fixing

| Symptom | Root cause |
|---------|------------|
| **HTTP 413 on webhooks** | Inbound media downloaded → base64 in JSON → receiver rejects payload |
| **Puppeteer `ProtocolError` / timeouts** | Chromium under memory pressure during large downloads, typing, sends |
| **RAM climb ~350 MB → ~1 GB / session / 24h** | Renderer heap leak; container hits 95% with 5 sessions |
| **Session `LOGOUT` loops** | Often follows resource exhaustion or duplicate WA Web sessions |

**Important:** OpenWA cannot stop WhatsApp from showing the message in the linked account. We can only skip download, storage, and webhook bytes.

---

## Current Production State (Phase 1 — DONE)

Verified on server; **do not revert** these operator choices:

| Setting | Server value | Notes |
|---------|--------------|-------|
| `mem_limit` | `5g` | Hardcoded on server (not `${OPENWA_MEM_LIMIT}`) — intentional for 5 sessions |
| `pids_limit` | `2048` | Raised from 512 |
| `read_only` | **disabled** (commented) | Operational workaround — keep until Chromium smoke on read-only rootfs passes |
| Traefik dashboard | `8085:8080` | Host port conflict fix — server-only |
| `AUTO_START_SESSIONS` | `true` | Sessions survive container restart |
| `NODE_OPTIONS` | `--max-old-space-size=768` | Caps Node heap separately from Chromium |
| `SIMULATE_TYPING` | `true` (max 1000 ms) | Forwarded through compose; typing hardened in Phase 2d |

**Loose end — resolve before Phase 2 deploy:**

- `lenaai-phone-46` is still `qr_ready`, `phone: null` (old `public-4346` did not survive).
- **Action:** Scan its QR **or** delete the session so you have a clean 5/5 ready set. A dangling `qr_ready` session holds a Chromium instance for nothing.

**Still missing on server (add via `.env`, not compose replace):**

- `shm_size: '2gb'` on `openwa-api` — add to server compose if not already present; one of the highest-impact Chromium stability fixes in Docker.

---

## Architecture Overview

```
┌──────────────────────────────────────────────────────────────────────────┐
│  Phase 1 ✅  Server config baseline (compose/.env — operator-owned)       │
└──────────────────────────────────────────────────────────────────────────┘
                                    ↓
┌──────────────────────────────────────────────────────────────────────────┐
│  Phase 2     Inbound hardening (code — whatsapp-web-js.adapter.ts)        │
│              1:1 filter · oversized skip · protocolTimeout · typing       │
└──────────────────────────────────────────────────────────────────────────┘
                                    ↓
┌──────────────────────────────────────────────────────────────────────────┐
│  Phase 3     Stop SQLite base64 bloat (session.service + storage)         │
└──────────────────────────────────────────────────────────────────────────┘
                                    ↓
┌──────────────────────────────────────────────────────────────────────────┐
│  Phase 4     Optional: media URLs + disk sweep (under-threshold files)    │
└──────────────────────────────────────────────────────────────────────────┘
                                    ↓
┌──────────────────────────────────────────────────────────────────────────┐
│  Phase 5     Memory recycler (staggered page.reload per session)          │
└──────────────────────────────────────────────────────────────────────────┘
                                    ↓
┌──────────────────────────────────────────────────────────────────────────┐
│  Phase 6     Ops hardening after 48h stable (webhooks, Redis, backups)    │
└──────────────────────────────────────────────────────────────────────────┘
                                    ↓
┌──────────────────────────────────────────────────────────────────────────┐
│  Future      Baileys trial on one non-critical session (scaling path)     │
└──────────────────────────────────────────────────────────────────────────┘
```

---

## Phase 2 — Inbound Hardening (core code patch)

**Branch:** `feat/inbound-hardening` off `main` / `v0.4.1`

**Primary file:** `src/engine/adapters/whatsapp-web-js.adapter.ts`

### 2a. 1:1-only filter

**Where:** First lines inside the `message` handler (`client.on('message', …)`), ~line 254.

**Behavior:** Drop groups, status, newsletters before any contact lookup or download.

```typescript
// Skip non-1:1 chats unless INBOUND_GROUPS_ENABLED=true
if (process.env.INBOUND_GROUPS_ENABLED !== 'true' && !msg.from.endsWith('@c.us')) {
  return;
}
```

Groups (`@g.us`), status (`status@broadcast`), newsletters (`@newsletter`) → never downloaded, stored, or webhooked.

**Env:** `INBOUND_GROUPS_ENABLED=false` (default) — set `true` only if you explicitly need group webhooks.

### 2b. Oversized-media skip (before `downloadMedia()`)

**Where:** Replace the unconditional download block at ~lines 283–297.

**Today (always downloads):**

```283:297:src/engine/adapters/whatsapp-web-js.adapter.ts
        // Handle media
        if (msg.hasMedia) {
          try {
            const media = await msg.downloadMedia();
            if (media) {
              incomingMessage.media = {
                mimetype: media.mimetype,
                filename: media.filename || undefined,
                data: media.data,
              };
            }
          } catch (error) {
            this.logger.error('Error downloading media', String(error));
          }
        }
```

**Target behavior:**

```typescript
const maxBytes = Number(process.env.INBOUND_MEDIA_MAX_BYTES ?? 5_242_880);
const sizeBytes = (msg as { _data?: { size?: number } })._data?.size ?? 0;

if (msg.hasMedia && sizeBytes > maxBytes) {
  incomingMessage.skippedMedia = true;
  incomingMessage.mediaSizeBytes = sizeBytes;
  // metadata-only — NO downloadMedia() call
} else if (msg.hasMedia) {
  // existing download path (Phase 3 may redirect to storage)
}
```

**Env:** `INBOUND_MEDIA_MAX_BYTES=5242880` (5 MB default)

**Webhook shape (Option A — emit event, no bytes):**

```json
{
  "hasMedia": true,
  "skippedMedia": true,
  "mediaSizeBytes": 7340032,
  "media": null
}
```

**Verify:** Send a 6 MB video → metadata event, no download spike in `docker stats`, no 413.

### 2c. `protocolTimeout` on Puppeteer Client init

**Where:** `new Client({ puppeteer: { … } })`, ~lines 195–208.

**Today:** No `protocolTimeout` set — production logs show `ProtocolError: Runtime.callFunctionOn timed out`.

```typescript
puppeteer: {
  headless: this.config.puppeteer?.headless ?? true,
  args: puppeteerArgs,
  protocolTimeout: Number(process.env.PUPPETEER_PROTOCOL_TIMEOUT_MS ?? 120_000),
  ...(this.config.puppeteer?.executablePath ? { executablePath: … } : {}),
},
```

**Env:** `PUPPETEER_PROTOCOL_TIMEOUT_MS=120000`

### 2d. Typing hardening

**Where:** `sendChatState()` ~lines 1211–1225 — already wrapped in try/catch (good).

**Also check:** `src/modules/message/message.service.ts` — `SIMULATE_TYPING` / `SIMULATE_TYPING_MAX_MS` (lines ~574–583). Ensure send path never fails when typing throws.

**Env (server already has):**

```bash
SIMULATE_TYPING=true
SIMULATE_TYPING_MAX_MS=1000
```

Set `SIMULATE_TYPING=false` if typing timeouts persist after 2c.

### 2e. History sync path (same file)

**Where:** ~lines 1014–1016 — second `downloadMedia()` call for history/backfill.

Apply the same size check there so backfill cannot trigger a large download.

### Repo compose forwards (add to repo; merge one line at a time on server)

```yaml
# Inbound / Puppeteer hardening (Phase 2)
- INBOUND_MEDIA_MAX_BYTES=${INBOUND_MEDIA_MAX_BYTES:-5242880}
- INBOUND_GROUPS_ENABLED=${INBOUND_GROUPS_ENABLED:-false}
- PUPPETEER_PROTOCOL_TIMEOUT_MS=${PUPPETEER_PROTOCOL_TIMEOUT_MS:-120000}
- SIMULATE_TYPING=${SIMULATE_TYPING:-true}
- SIMULATE_TYPING_MAX_MS=${SIMULATE_TYPING_MAX_MS:-1000}
```

Add matching entries to `.env.example` with comments. **Do not** change server `.env` values during merge — only document defaults.

### Phase 2 checklist

- [ ] Create branch `feat/inbound-hardening`
- [ ] Implement 2a–2e in `whatsapp-web-js.adapter.ts`
- [ ] Extend `IncomingMessage` type with `skippedMedia?`, `mediaSizeBytes?`
- [ ] Add env forwards to repo `docker-compose.yml` + `.env.example`
- [ ] Unit tests: skip when size > limit; skip groups; download when under limit
- [ ] Build image, deploy on server (image only)
- [ ] Append env forwards to server compose if missing
- [ ] Set in server `.env`: `INBOUND_MEDIA_MAX_BYTES=5242880`, `PUPPETEER_PROTOCOL_TIMEOUT_MS=120000`
- [ ] Verify: `docker exec openwa-api printenv INBOUND_MEDIA_MAX_BYTES`
- [ ] Test: 6 MB file → skipped; group message → no webhook; normal image → still works

---

## Phase 3 — Stop SQLite Base64 Bloat

**Problem:** Even under-threshold media stores full base64 in SQLite via `metadata.media`:

```434:437:src/modules/session/session.service.ts
            const metadata: Record<string, unknown> = {};
            if (incoming.media) {
              metadata.media = incoming.media;
            }
```

Over weeks this slows OpenWA and inflates webhook payloads.

**Fix:**

1. On download (under-threshold path), write bytes to `StorageService` (`STORAGE_TYPE=local`, `/app/data/media`).
2. Store in DB/webhook: `{ path, mimetype, filename, sizeBytes }` — **not** `data: "<base64…>"`.
3. For skipped media (Phase 2b), store `{ skipped: true, reason: "too_large", sizeBytes, mimetype }`.

**Files:**

| File | Change |
|------|--------|
| `src/engine/adapters/whatsapp-web-js.adapter.ts` | After download, optionally delegate to storage (or pass raw buffer up) |
| `src/modules/session/session.service.ts` | Persist reference, strip base64 before webhook dispatch |
| `src/common/storage/storage.service.ts` | Use existing `put`/`get` for local path |

**Env (optional):**

```bash
INBOUND_MEDIA_STORE_PATH=true          # store files on disk instead of inline base64
INBOUND_MEDIA_WEBHOOK_MODE=metadata    # metadata | url | base64 (legacy)
```

Default `metadata` for new installs; allow `base64` for backward-compatible webhook consumers.

### Phase 3 checklist

- [ ] Confirm `du -sh /app/data/openwa.sqlite` baseline before deploy
- [ ] Implement storage-backed media path
- [ ] Webhook sends path/URL, not bytes
- [ ] Re-test 413 scenario with small media (should also shrink payloads)

---

## Phase 4 — Link for Small Media + Disk Sweep (optional)

Only needed if webhook consumers want fetchable URLs for under-threshold files.

1. After Phase 3 storage write, expose URL via existing API or signed path in webhook.
2. **Never** delete inside the message handler (race with webhook fetch).
3. Scheduled sweep on host or in-app cron:

```bash
# Delete media files older than 60 minutes (tune MEDIA_RETENTION_MINUTES)
find /app/data/media -type f -mmin +60 -delete
```

**Env:**

```bash
MEDIA_RETENTION_MINUTES=60
MEDIA_SWEEP_ENABLED=true
```

Big files never reach disk — Phase 2b skips them.

---

## Phase 5 — Memory Recycler

**Observation:** Renderer heap climbs ~350 MB → ~1 GB per session over ~24h at 5 sessions on 5 GB → sustained 95% RAM.

**Fix:** Staggered nightly `page.reload()` per session (keeps auth via LocalAuth, drops heap to baseline). Implement as scheduled job in the app.

**Where to hook:**

- Active engines held in `session.service.ts` in-memory map (~line 45).
- Each wwebjs adapter exposes the Puppeteer `page` via `this.client.puppage` (or equivalent) — reload one session every N minutes, not all at once.

**Env:**

```bash
MEMORY_RECYCLE_ENABLED=true
MEMORY_RECYCLE_INTERVAL_MS=86400000       # 24h cycle
MEMORY_RECYCLE_STAGGER_MS=900000          # 15 min between sessions
MEMORY_RECYCLE_MIN_UPTIME_MS=3600000      # don't reload sessions younger than 1h
```

**Verify over 48h:** `docker stats` shows sawtooth (drop after reload), not monotonic climb.

### Phase 5 checklist

- [ ] Implement recycler service
- [ ] Log before/after heap per session reload
- [ ] Ensure reload does not trigger LOGOUT (test one session off-hours first)
- [ ] Monitor 48h — RAM stays below ~80% steady state

---

## Phase 6 — Operational Hardening (after 48h stable)

| Item | Action | Env / config |
|------|--------|--------------|
| Auto-start | Already `true` on server | `AUTO_START_SESSIONS=true` |
| Minimal webhooks | Drop `*`, `presence.update` unless required | Webhook UI / API |
| Async webhooks | Decouple slow receivers from message handler | `REDIS_ENABLED=true` + separate Redis DB index from `lenaai-redis` |
| Metrics | Enable scrape endpoint | `METRICS_TOKEN=<long-random>` |
| Disk monitoring | Weekly check | `docker exec openwa-api du -sh /app/data /app/data/media /app/data/openwa.sqlite` |
| Backups | Schedule | `scripts/backup.sh` — sessions/ + sqlite |
| LOGOUT runbook | Stop session → fix root cause → QR once → start | Document in runbook |
| WhatsApp Web pin | If QR/auth flapping | `WWEBJS_WEB_VERSION=2.3000.1023204257` |

### Expensive features — disable unless needed

| Setting | Risk |
|---------|------|
| `RESOLVE_LID_TO_PHONE=true` | Extra contact lookup per message |
| `PLUGINS_ENABLED=true` | Translation/auto-reply per message |
| `SIMULATE_TYPING=true` | Extra browser calls — keep max ms low or disable |

---

## Env Variable Catalog

| Variable | Default | Phase | Purpose |
|----------|---------|-------|---------|
| `INBOUND_MEDIA_MAX_BYTES` | `5242880` | 2 | Skip download when `msg._data.size` exceeds limit |
| `INBOUND_GROUPS_ENABLED` | `false` | 2 | Allow group/status inbound processing |
| `PUPPETEER_PROTOCOL_TIMEOUT_MS` | `120000` | 2 | Puppeteer protocol timeout |
| `SIMULATE_TYPING` | `true` | 1/2 | Typing simulation on send |
| `SIMULATE_TYPING_MAX_MS` | `5000` (repo) / `1000` (server) | 1/2 | Max typing pause |
| `AUTO_START_SESSIONS` | `false` (repo) / `true` (server) | 1/6 | Restore sessions on boot |
| `OPENWA_MEM_LIMIT` | `2g` (repo) / `5g` (server) | 1 | Container RAM — set on server only |
| `NODE_OPTIONS` | — | 1 | e.g. `--max-old-space-size=768` |
| `WWEBJS_WEB_VERSION` | auto | 6 | Pin WA Web HTML version |
| `INBOUND_MEDIA_STORE_PATH` | `false` | 3 | Disk storage vs inline base64 |
| `MEDIA_RETENTION_MINUTES` | `60` | 4 | Disk sweep age |
| `MEMORY_RECYCLE_ENABLED` | `false` | 5 | Nightly page reload |
| `REDIS_ENABLED` | `false` | 6 | Async webhook queue |
| `METRICS_TOKEN` | empty | 6 | Metrics auth |

**Note:** `MEDIA_DOWNLOAD_MAX_BYTES` in `.env.example` only limits **outbound** URL fetches when sending — **not** inbound WhatsApp media.

---

## Verification Matrix

| Test | Expected |
|------|----------|
| Send 6 MB video to a 1:1 chat | `message.received` with `skippedMedia: true`, no RAM spike |
| Send normal 500 KB image | Downloaded/stored, webhook succeeds, no 413 |
| Message from a group | No webhook (with default `INBOUND_GROUPS_ENABLED=false`) |
| Container restart | All 5 sessions auto-start (`AUTO_START_SESSIONS=true`) |
| 48h uptime | No monotonic RAM climb (Phase 5 sawtooth) |
| Logs | No recurring `ProtocolError` / 413 / LOGOUT loops |

```bash
# Quick health commands
docker stats openwa-api --no-stream
curl -s http://127.0.0.1:2785/api/health/ready
docker logs openwa-api 2>&1 | grep -iE "ProtocolError|413|LOGOUT|skippedMedia" | tail -30
docker exec openwa-api du -sh /app/data /app/data/media /app/data/openwa.sqlite
```

---

## What NOT to Do

- **Don't** `git checkout` repo `docker-compose.yml` over the server file — merge env lines only.
- **Don't** reset server `.env` from `.env.example` — append new keys only.
- **Don't** raise webhook receiver body limit instead of skipping large media — treats symptom, not cause.
- **Don't** rely on `MEDIA_DOWNLOAD_MAX_BYTES` for inbound WhatsApp media.
- **Don't** silently drop large messages — use `skippedMedia: true` for visibility.
- **Don't** restart the container repeatedly during a LOGOUT loop — stop the session first.
- **Don't** switch to Baileys and harden Chromium in the same release.

---

## Strategic Note: Baileys (post-stabilization)

`src/engine/adapters/baileys.adapter.ts` exists; `ENGINE_TYPE` is pluggable (`whatsapp-web.js` | `baileys`).

| Engine | ~RAM / session | Browser |
|--------|----------------|---------|
| whatsapp-web.js | ~700 MB | Chromium (Puppeteer) |
| Baileys | ~50–150 MB | None |

Phases 2–5 are **wwebjs Chromium babysitting**. They are the right path for production **now**. After 48h stable:

1. Trial `ENGINE_TYPE=baileys` on **one non-critical session**.
2. Compare RAM, reconnect behavior, feature parity (media, groups, etc.).
3. If good, migrate sessions gradually — do not big-bang switch.

---

## Implementation Order (summary)

| Step | Phase | Owner | Effort |
|------|-------|-------|--------|
| 1 | Resolve `lenaai-phone-46` qr_ready | Ops | 5 min |
| 2 | Add `shm_size: 2gb` on server if missing | Ops | 5 min |
| 3 | Inbound hardening code + tests | Dev | 1–2 days |
| 4 | Deploy image; append env forwards on server | Ops | 30 min |
| 5 | SQLite/storage media path | Dev | 1 day |
| 6 | Optional URL + disk sweep | Dev | 0.5 day |
| 7 | Memory recycler | Dev | 1 day |
| 8 | 48h soak test | Ops | 2 days |
| 9 | Redis webhooks, metrics, backups | Ops | 0.5 day |
| 10 | Baileys trial (one session) | Dev/Ops | later |

---

*Last updated: production review — OpenWA v0.4.1 / lenaai-restore-1*
