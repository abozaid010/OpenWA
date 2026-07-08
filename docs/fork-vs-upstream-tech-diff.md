# OpenWA Fork vs Upstream — Technical Diff Summary

> Generated: 2026-07-08 · Updated after stability migration on `prod/v0.8.11-stable`
> Purpose: single reference for **what this fork adds / changes** vs the original OpenWA repo.

| Side | Repo | Branch / tip | Notes |
|------|------|--------------|-------|
| **Upstream** | [rmyndharis/OpenWA](https://github.com/rmyndharis/OpenWA) | `main` @ `9efacb0` (= `v0.8.11` + 3) | Base for this migration |
| **Fork stability branch** | local | `prod/v0.8.11-stable` | Webhook = upstream + `capWebhookMedia` only; `protocolTimeout` restored; compose regressions fixed |

---

## Post-migration fork surface (current truth)

| Keep | Why |
|------|-----|
| `capWebhookMedia` + `WEBHOOK_MEDIA_MAX_BYTES` | Only durable product win — prevents webhook 413 storms |
| `protocolTimeout` ← `PUPPETEER_PROTOCOL_TIMEOUT_MS` | Restored on upstream adapter (was orphaned after merge) |
| `MEDIA_DOWNLOAD_MAX_BYTES` (compose + `.env.example`) | Live upstream inbound cap; replaced orphaned `INBOUND_MEDIA_MAX_BYTES` |
| Compose: `stop_grace_period: 45s`, `shm_size: 2gb`, image pins, volume `name:` pins | R4 + Chromium launch root cause (prod had default 64MB shm) |
| `mem_limit: 5g`, `pids_limit: 2048`, `AUTO_START_SESSIONS`, `NODE_OPTIONS`, typing knobs, port bindings | Prod ops keep |
| `default.conf` | LenaAI nginx — operator-owned ingress |
| `.gitignore` `started*` + `venv/` | Hygiene |

| Removed / reverted | Why |
|--------------------|-----|
| Fork-shaped `webhook.service.ts` | Dropped R1 (`occurredAt`), R1b salt, filters, allSettled, queue fallback, SSRF pin, failure recording |
| Orphan interface fields `skippedMedia` / `mediaSizeBytes` | Nothing in `src/` set them after adapter merge drop |
| Traefik service in repo compose | Mounted `./traefik/*` but directory absent; ingress is nginx/`default.conf` |
| `INBOUND_MEDIA_MAX_BYTES` passthrough | Orphaned; use `MEDIA_DOWNLOAD_MAX_BYTES` |

**Verified gates:** webhook suite 120/120; full Jest **2038** passed; `nest build` clean. Prod Chromium launch failure (`Failed to launch … Code: null`, `ShmSize=64MB`) addressed in compose via `shm_size: 2gb` — confirm on server after deploy.

For the previous 9-commit inventory and audit detail, see `docs/openwa-fork-stability-audit.md` and `docs/openwa-stability-migration-plan.md`.
