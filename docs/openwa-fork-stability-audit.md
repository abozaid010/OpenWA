# OpenWA Fork — Production Stability Audit & Migration Plan

> Generated: 2026-07-08
> Method: verified against actual code, `git` history, and a live test run — not the summary docs alone.
> Scope: `abozaid010/OpenWA` fork `main` (`3b74a19`) vs `rmyndharis/OpenWA` `upstream/main` (`9efacb0`, = `v0.8.11 + 3`).

---

## 0. Evidence base & the one gap you must close

Everything below is backed by code, git, or a test run. The **one thing I could not verify** is the *actual* production error output. The task says "don't speculate — provide evidence," so I am explicit about confidence:

- **CONFIRMED** = proven by code/git/test in this repo.
- **LIKELY** = a latent defect I can prove exists in code, whose firing in *your* production I cannot confirm without logs.

**Action required from you:** paste the real signatures. The single most useful commands:

```bash
docker logs openwa-api 2>&1 | grep -iE "ProtocolError|413|LOGOUT|Idempotency|unhandledRejection|ECONN|webhook" | tail -100
docker exec openwa-api printenv | grep -iE "MEDIA|PUPPETEER|WEBHOOK|REDIS|QUEUE|ENGINE"
```

The env dump is critical: several fork env vars are now **orphaned** (read by nothing) and give a false sense of protection (see §3.2).

---

## 1. Executive Summary

### 1.1 The headline finding

Your instability is **not** caused by being on the wrong upstream version, and **not** by a dependency conflict. Proof:

- `package.json` **and** `package-lock.json` are **byte-identical to upstream** (`git diff upstream/main...HEAD -- package.json package-lock.json` is empty). The fork introduces **zero** dependency changes.
- The fork is **0 commits behind** upstream `main` and 9 ahead; all 9 ahead are config/webhook, not engine.

The instability comes from **four fork-specific problems**, in priority order:

| # | Root cause | Confidence | Category |
|---|-----------|-----------|----------|
| **R1** | **Webhook idempotency key is generated without `occurredAt`**, so recurring lifecycle events (`session.status`, `session.disconnected`, `session.authenticated`, `message.reaction`) get a **constant** key across occurrences → a conformant receiver dedupes and **silently drops every repeat**. Fires exactly during reconnect/flap storms. | **CONFIRMED** (bug in code) / **LIKELY** (matches "errors started appearing") | **Broken** |
| **R2** | The **inbound-media + Puppeteer `protocolTimeout` hardening was silently dropped** in the upstream merge (`d47b5cc`). The adapter is now identical to upstream, but `INBOUND_MEDIA_MAX_BYTES` / `PUPPETEER_PROTOCOL_TIMEOUT_MS` are still forwarded by compose and documented in `.env` — **they now do nothing**. There is **no `protocolTimeout` anywhere in upstream v0.8.11**, so the ProtocolError mitigation is gone with no replacement. | **CONFIRMED** | **Broken (regression)** |
| **R3** | The fork's `webhook.service.ts` is an **old upstream service + `capWebhookMedia`**, hand-patched to compile against new controllers. It drops ~7 upstream correctness fixes (per-webhook idempotency salt, filters, concurrent dispatch, **queue-failure fallback delivery**, durable failure recording, SSRF IP-pinning, payload isolation). Its **own unit tests fail 19/24** (`npx jest webhook.service.spec.ts`) — the diverged logic ships with no passing coverage. | **CONFIRMED** | **Broken / Risky** |
| **R4** | Compose regressions: **`stop_grace_period: 45s` removed** (Chromium SIGKILLed mid-teardown → orphaned session profiles → LOGOUT loops), **images unpinned** (`docker-socket-proxy`, `minio` → `:latest` drift), **volume `name:` pins removed** (orchestration path can bind a different/empty volume). | **CONFIRMED** | **Risky** |

### 1.2 Recommended upstream version

**Do not roll back to an old "stable" tag.** There is no LTS here — this is a 0.x project shipping **~4 releases/day** (v0.2.0→v0.8.11 in ~3 weeks; see §4). Old tags (e.g. the `v0.4.1` your runbook references) predate the upstream **inbound-media-cap system, outbound SSRF hardening, and session/webhook fixes** that you actually need. Rolling back trades your known bugs for a larger set of already-fixed ones.

**Recommendation:** **Pin to `v0.8.11`** (the tag your HEAD already sits 3 commits past) and change the *operating model* from "track `main` HEAD" to "**pin a tag → soak on staging 24–48h → promote**." Your problem is process (unpinned, untested hybrid deployed straight to prod), not version number. Upstream's active fix branches (`fix/session-webhook-event-delivery`, `fix/message-ack-reaction-hooks`, `feat/force-kill-stuck-session`, `fix/outbound-ssrf-hardening`) confirm they are actively hardening exactly your pain areas — stay **close** to upstream, not pinned old.

### 1.3 Recommended migration strategy (one sentence)

**Revert `webhook.service.ts` to upstream and re-apply only `capWebhookMedia` (~40 lines) as a surgical patch; re-apply the `protocolTimeout` hunk on top of upstream's adapter; replace the orphaned `INBOUND_MEDIA_MAX_BYTES` with upstream's `MEDIA_DOWNLOAD_MAX_BYTES`; restore `stop_grace_period`, image pins, and volume-name pins in compose.** This deletes R1/R3 wholesale, restores R2, and fixes R4 — while keeping every genuinely valuable customization.

---

## 2. Change Inventory

`git diff --name-status upstream/main...HEAD` → 8 files. Full per-file assessment:

| File | Why modified | Risk | Verdict | Reasoning (evidence) |
|------|-------------|------|---------|----------------------|
| `src/modules/webhook/webhook.service.ts` | Add `capWebhookMedia`; hand-align API to new controllers | **HIGH** | **Revert to upstream + re-apply `capWebhookMedia` only** | Is an *old* service shape. Drops per-webhook idempotency salt + `occurredAt` (**R1**), filters, `Promise.allSettled` dispatch, queue-failure fallback, `recordWebhookDeliveryFailure`, `withSafeFetch` IP-pin, `structuredClone` isolation, retention prune. Own tests fail 19/24. |
| `src/modules/webhook/webhook.service.spec.ts` | Rewritten for fork shape | **HIGH** | **Replace with upstream suite** | Broken: `TestingModule` never provides `WebhookDeliveryFailure` repo the constructor now requires → 19 failures. Provides no real coverage. |
| `src/modules/webhook/webhook-session-scope.spec.ts` | Constructor-arg realignment | MED | **Replace with upstream** | Only exists to patch the fork constructor. Moot once service reverts. |
| `src/engine/interfaces/whatsapp-engine.interface.ts` | Add `skippedMedia`, `mediaSizeBytes` | LOW | **Remove the 2 fields** | Set by **nothing** in `src/` (grep confirms). Orphaned by the dropped `fe27ce5` adapter patch. Upstream uses `media.omitted` / `media.sizeBytes`. |
| `docker-compose.yml` | Prod ops tuning | **MED** | **Keep most, fix 4 items** | Keep mem/pids/typing/auto-start. **Restore** `stop_grace_period`, image pins, volume `name:` pins. **Replace** orphaned `INBOUND_MEDIA_MAX_BYTES`/`PUPPETEER_PROTOCOL_TIMEOUT_MS` forwards. See §5. |
| `.env.example` | Document fork env vars | LOW | **Rewrite the added block** | Documents `INBOUND_MEDIA_MAX_BYTES` (orphaned) & `PUPPETEER_PROTOCOL_TIMEOUT_MS` (orphaned). Does **not** document `WEBHOOK_MEDIA_MAX_BYTES` (the one that works). Point users to `MEDIA_DOWNLOAD_MAX_BYTES`. |
| `default.conf` | LenaAI nginx vhosts | LOW | **Keep** (deployment-specific) | Net-new file, no upstream equivalent. No stability impact on the OpenWA container. |
| `.gitignore` | Ignore `started*` markers | NONE | **Keep** | Harmless hygiene. |

---

## 3. Stability Analysis (Safe / Risky / Broken)

### 3.1 ✅ SAFE — keep

| Change | Why it's safe / valuable |
|--------|--------------------------|
| `capWebhookMedia()` + `WEBHOOK_MEDIA_MAX_BYTES` | Genuinely useful, self-contained, does not mutate the WS-path object. **The one durable product win.** Keep it — but re-host it on top of the upstream service. |
| `mem_limit: 5g`, `pids_limit: 2048` | Correct for 5 concurrent wwjs Chromium sessions. Upstream's own comment explains 512 pids kills Chromium mid-spawn. |
| `AUTO_START_SESSIONS=true`, `NODE_OPTIONS=--max-old-space-size=768`, `SIMULATE_TYPING*` | Deliberate, documented operator choices. |
| `default.conf`, `.gitignore` | No engine impact. |

### 3.2 ⚠️ RISKY — may cause intermittent production issues

| Change | Failure mode | Evidence |
|--------|-------------|----------|
| **Orphaned `INBOUND_MEDIA_MAX_BYTES` / `PUPPETEER_PROTOCOL_TIMEOUT_MS`** | You believe inbound media is capped at 5 MB and CDP calls time out at 120 s. **Neither is true.** Inbound media is now capped by **upstream's `MEDIA_DOWNLOAD_MAX_BYTES` (default 50 MiB)** — so 5–50 MB media you meant to skip is now downloaded to heap. `protocolTimeout` is **absent entirely** → a stuck Chromium CDP call can still wedge a worker. | `grep -rn "INBOUND_MEDIA_MAX_BYTES\|protocolTimeout" src/` → only interface/doc mentions, **zero** adapter reads. `inbound-media-cap.ts` reads `MEDIA_DOWNLOAD_MAX_BYTES`. |
| **Concrete env defaults replacing upstream blank-forward** (`DATABASE_TYPE=sqlite`, `ENGINE_TYPE=whatsapp-web.js`, `STORAGE_TYPE=local`, `REDIS_ENABLED=false`) | A real compose value **pins** and beats the dashboard's `data/.env.generated`. Toggling engine/storage/redis in the dashboard **silently won't apply** → "why won't my setting change" confusion. | Compose diff §5; upstream comments explain the blank-forward contract. |
| **Volume `name:` pins removed** | `docker.service.ts` orchestration binds literal `openwa_<svc>-data`. Without the pin, the compose-created name depends on the project (dir) name; a rename or `-p` flag → orchestration mounts a **different/empty** volume → "sessions gone." Currently works only because the server dir happens to resolve to `openwa_…`. | Compose diff §5; upstream comment on volumes block. |

### 3.3 ❌ BROKEN — revert

| Change | Defect | Evidence |
|--------|--------|----------|
| **Idempotency without `occurredAt` (R1)** | `dispatch()` calls `generateIdempotencyKey(event, {...safeData, sessionId})` — no 3rd arg. For `session.status`/`disconnected`/`authenticated`/`reaction`, `occurredAt` is the *only* salt (docstring in the identical `idempotency.util.ts` says so). Constant key → receiver dedupes → **lifecycle webhooks dropped on every reconnect after the first**. | webhook.service.ts diff (loses `const occurredAt = …`); `idempotency.util.ts` unchanged from upstream and documents the requirement. |
| **Single idempotency key for all webhooks of an event (R1b)** | Upstream salts per-webhook (`${base}_${webhook.id}`). Fork uses one key for all → two webhooks on the same event collide; a receiver drops the sibling. | webhook.service.ts diff. |
| **Queue-failure fallback removed (R3a)** | Upstream: if `webhookQueue.add()` throws (Redis blip, `enableOfflineQueue:false`), it **delivers directly** as a fallback. Fork just logs `webhook_queue_failed` → **webhook silently lost** whenever Redis hiccups (only bites if `QUEUE_ENABLED=true`). | webhook.service.ts diff (whole fallback block deleted). |
| **`finalPayload = hookResult.payload` (no `?? payload`) (R3b)** | If a `webhook:before` plugin returns a result without a `payload` key, `finalPayload` is `undefined` → signature/body computed over `undefined`. Upstream guards with `?? payload`. | webhook.service.ts diff. Only fires if plugins/hooks are enabled. |
| **`JSON.stringify` moved outside `try` (R3c)** | Upstream deliberately serializes+signs **inside** `try` so a poisoned (BigInt/circular) hook payload is caught per-webhook. Fork can throw out of the loop → rejects the fire-and-forget `dispatch()` → `unhandledRejection`. | webhook.service.ts diff. |
| **SSRF direct path: `withSafeFetch` → manual `fetch` (R3d)** | Loses validated-IP pinning (DNS-rebinding TOCTOU) and leaks the resolved internal IP back to the client (`throw new BadRequestException(error.message)` vs upstream's generic message + server-side log). Security regression. **Note:** the *queued* path still uses `withSafeFetch` (processor unchanged), so this only affects direct + test delivery. | webhook.service.ts diff; `webhook.processor.ts` still imports `withSafeFetch`. |
| **Filters accepted but ignored (R3e)** | DTO still validates `filters` (`webhook.dto.ts:93`, `IsValidWebhookFilters`), but fork `create()`/`update()` drop it and `dispatch()` never calls `evaluateFilters`. A webhook configured to receive a filtered subset **receives everything** → over-delivery / possible data exposure. | webhook.service.ts diff; `webhook.dto.ts` still exposes `filters`. |
| **Dropped `protocolTimeout` + inbound skip adapter patch (R2)** | `fe27ce5` added them; `d47b5cc` merge dropped the hunks; adapter now == upstream. | `git diff upstream/main...HEAD -- src/engine/adapters/whatsapp-web-js.adapter.ts` is **empty**. |
| **`stop_grace_period: 45s` removed (R4)** | Docker's 10 s default can SIGKILL Chromium mid-teardown → orphaned session profile → auth corruption → LOGOUT loop. Upstream comment explains exactly this. | Compose diff §5. |

---

## 4. Why "latest" and "old stable" are both wrong — version evidence

Tag dates (`git log -1 --format=%ci <tag>`):

```
v0.1.0  2026-02-05      <- 4-month gap
v0.2.0  2026-06-15
v0.4.1  2026-06-18      <- your runbook's baseline
v0.7.0  2026-06-23
v0.8.0  2026-07-02
v0.8.11 2026-07-08      <- today; ~40 tags in the last ~10 days
```

- **No stability plateau exists.** A project cutting ~4 releases/day has no battle-tested LTS. "Most stable" = "a specific pinned tag that you soaked," not any particular number.
- **Old ≠ safe.** `v0.4.1` lacks upstream's `inbound-media-cap` system, `withSafeFetch` SSRF pinning, and the session/webhook fixes now on `main`. Rolling back **reintroduces** solved bugs.
- **Stay close.** Active upstream branches target your exact symptoms: `fix/session-webhook-event-delivery`, `fix/message-ack-reaction-hooks`, `feat/force-kill-stuck-session`, `fix/outbound-ssrf-hardening`, `fix/wwjs-forward-message-id`.

**Verdict: pin `v0.8.11`, adopt tag-based promotion, watch the fix branches above and pull them as they merge.**

---

## 5. Docker & Deployment Review

Preserve the prod compose — but four regressions vs upstream must be reverted:

| Item | Fork (current) | Restore to | Why |
|------|----------------|-----------|-----|
| `stop_grace_period` | *removed* | `stop_grace_period: 45s` | Prevents SIGKILL of Chromium mid-teardown → orphaned sessions → LOGOUT loops (**R4**). |
| `docker-socket-proxy` image | `tecnativa/docker-socket-proxy` (`:latest`) | `:v0.4.2` | Reproducible builds; no surprise breakage on upstream `:latest` push. |
| `minio` image | `minio/minio` (`:latest`) | pinned `RELEASE.*` | Same. (Only if `minio` profile used.) |
| Volume `name:` pins | *removed* | `name: openwa_openwa-data` (+ peers) | Compose path and `docker.service.ts` orchestration must bind the **same** volume regardless of project name (**§3.2**). |

**Keep as-is (do not "fix" toward upstream):** `mem_limit: 5g`, `pids_limit: 2048`, `read_only` commented out, `AUTO_START_SESSIONS`, `NODE_OPTIONS`, `SIMULATE_TYPING*`, port bindings. These are deliberate, documented operator choices.

**Also address:**
- **Traefik service references `./traefik/traefik.yml` + `./traefik/dynamic.yml` that do not exist in the repo** → `docker compose --profile with-proxy up` (or `full`) breaks. Either commit those files or drop the service from the *repo* compose (prod server has its own).
- **Replace** the two orphaned env forwards with the real knob:
  ```yaml
  # inbound media cap (upstream system) — default 50 MiB; set to 5 MiB to match old intent
  - MEDIA_DOWNLOAD_MAX_BYTES=${MEDIA_DOWNLOAD_MAX_BYTES:-5242880}
  - MEDIA_DOWNLOAD_ENABLED=${MEDIA_DOWNLOAD_ENABLED:-true}
  # keep — this one is wired and works:
  - WEBHOOK_MEDIA_MAX_BYTES=${WEBHOOK_MEDIA_MAX_BYTES:-}
  ```
- **Add** `shm_size: '2gb'` on `openwa-api` (your stability plan flags it as missing and high-impact for Chromium).
- Consider re-adopting upstream's **blank-forward** for `ENGINE_TYPE`/`STORAGE_TYPE`/`REDIS_ENABLED` **only if** you want the dashboard to control them; otherwise document that compose pins them on purpose.

---

## 6. Migration Plan (ordered, low-risk)

Do this on a branch off `v0.8.11`, verify on staging, then promote. Never `git checkout` compose/.env over the server.

1. **Branch:** `git checkout -b prod/v0.8.11-stable v0.8.11`.
2. **Revert the webhook service to upstream, keep the cap:**
   - `git checkout upstream/main -- src/modules/webhook/webhook.service.ts src/modules/webhook/webhook.service.spec.ts src/modules/webhook/webhook-session-scope.spec.ts`
   - Re-add **only** the `capWebhookMedia` function and its single call `const safeData = capWebhookMedia(data)` at the dispatch choke point, passing `safeData` into the payload build. (~40 lines. This is the *only* fork webhook code that survives.)
   - This deletes R1, R1b, R3a–R3e in one move and restores green tests.
3. **Re-apply the Puppeteer/inbound hardening on top of upstream (R2):**
   - Add `protocolTimeout: Number(process.env.PUPPETEER_PROTOCOL_TIMEOUT_MS) || undefined` to the `new Client({ puppeteer: {…} })` block (this is genuinely missing upstream and worth contributing back).
   - Do **not** re-add the old inbound skip — upstream's `inbound-media-cap` is strictly better. Instead set `MEDIA_DOWNLOAD_MAX_BYTES=5242880` in `.env`.
4. **Remove orphans:** delete `skippedMedia`/`mediaSizeBytes` from the interface; rewrite the `.env.example` block to document `MEDIA_DOWNLOAD_MAX_BYTES`, `MEDIA_DOWNLOAD_ENABLED`, `PUPPETEER_PROTOCOL_TIMEOUT_MS`, and `WEBHOOK_MEDIA_MAX_BYTES`.
5. **Fix compose (§5):** restore `stop_grace_period`, image pins, volume names; swap env forwards; add `shm_size`.
6. **Green the suite:** `npx jest` must pass (currently 19 webhook failures). Do not deploy red.
7. **Promote:** build image on staging, soak 24–48 h, then image-swap on prod per your existing runbook (env + image only, never compose/.env wholesale).

Optional follow-up: open a PR to upstream for the `protocolTimeout` addition so you stop carrying it.

---

## 7. Validation Plan

**Automated (must be green before build):**
- `npx jest` — full suite (webhook specs currently fail; must pass post-revert).
- `npx tsc --noEmit` / `nest build` — hybrid must compile.

**Webhook correctness (the R1 fix):**
- Subscribe a test receiver that dedupes on `X-OpenWA-Idempotency-Key`. Force a session **disconnect→reconnect twice**. Assert **two** distinct `session.status`/`session.disconnected` deliveries arrive (pre-fix: only the first). This is the direct regression test for the reported errors.
- Register **two** webhooks on the same event; assert **both** receive it (per-webhook salt).
- With `QUEUE_ENABLED=true`, kill Redis briefly during a send; assert delivery still happens (fallback) or is durably recorded.

**Media / Chromium (R2):**
- Set `MEDIA_DOWNLOAD_MAX_BYTES=5242880`. Send a 6 MB file → `media.omitted:true`, no base64, no RAM spike (`docker stats`), no 413.
- Send a 500 KB image → downloaded normally.
- Confirm `printenv MEDIA_DOWNLOAD_MAX_BYTES PUPPETEER_PROTOCOL_TIMEOUT_MS` inside the container.

**Docker resilience (R4):**
- `docker compose restart openwa-api` under load; confirm graceful drain (no Chromium SIGKILL in logs) and all sessions auto-start.
- Confirm the orchestration path and compose bind the **same** volume (`docker volume ls | grep openwa`).

**Rollout & rollback:**
- Rollout: staging 24–48 h soak → image-swap on prod (`docker compose build openwa-api && docker compose up -d openwa-api`), volumes/`.env` untouched.
- Rollback: keep the previous image tag; `docker compose up -d` the prior tag. Session volume is unchanged, so rollback is a pure image swap. Keep `.env.deploy.bak` / `docker-compose.yml.deploy.bak` as your runbook already prescribes.

**Production smoke checklist:**
- [ ] `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:2785/api/health/ready` → 200
- [ ] `docker logs openwa-api | grep -iE "ProtocolError|413|LOGOUT|unhandledRejection"` → clean over 1 h
- [ ] All 5 sessions `ready`; RAM stable (no monotonic climb) over 48 h
- [ ] Lifecycle webhooks arrive on repeated reconnects (R1)

---

## 8. Uncertainties (stated honestly)

- **R1 firing in prod** is LIKELY, not CONFIRMED — it depends on your receiver deduping on the idempotency header (the documented contract). Confirm with the receiver's logs or the reconnect test in §7.
- **R3a/R3b/R3c** only bite when `QUEUE_ENABLED=true` and/or plugins mutate payloads. Check your `printenv QUEUE_ENABLED PLUGINS_ENABLED`.
- **Actual production stack traces were not available for this audit.** Provide §0's log dump to convert LIKELY→CONFIRMED and to catch anything outside the fork diff (e.g. an upstream-side issue).
