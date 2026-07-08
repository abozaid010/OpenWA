# OpenWA Fork — Stability Migration Plan (verify-first)

> Companion to `docs/openwa-fork-stability-audit.md` (the evidence). This file is the **execution plan only**.
>
> **Operating rule for every step:** _verify the current state before changing anything, and verify the result after. Do not assume — run the check, read the output, then decide._ Each step has a **Precheck** (evidence gate) and an **Acceptance** (result gate). If a Precheck output does not match "Expected", **STOP and re-scope** — do not proceed on assumption.

---

## Legend

- **Precheck** — command(s) to run *before* the change. Confirms the problem still exists and the ground truth. Never skip.
- **Change** — what to edit. Do not write code until the Precheck for that step passed.
- **Acceptance** — command(s) that must pass *after* the change. If red, revert that step.
- **Rollback** — how to undo just this step.

Everything runs on a working branch, never on `main` or on the server compose/.env.

---

## Phase 0 — Preflight: gather ground truth (no code, no assumptions)

Goal: replace every assumption in the audit with a verified fact from *this* repo and *this* production host.

### 0.1 Confirm repo divergence baseline

**Precheck / run:**
```bash
git fetch upstream --tags
git rev-parse HEAD
git rev-list --left-right --count upstream/main...HEAD          # expect: 0<TAB>9
git diff --stat upstream/main...HEAD -- package.json package-lock.json   # expect: empty
git describe --tags upstream/main                                # note the tag
```
**Expected:** `0  9` behind/ahead; empty package diff (proves no dependency drift). If package diff is **non-empty**, STOP — the audit's "zero dependency changes" premise is wrong for your tree; re-audit deps first.

### 0.2 Capture production runtime facts (needs server access)

**Precheck / run on the server:**
```bash
docker exec openwa-api printenv | grep -iE "QUEUE_ENABLED|REDIS_ENABLED|PLUGINS_ENABLED|ENGINE_TYPE|MEDIA_DOWNLOAD_MAX_BYTES|INBOUND_MEDIA_MAX_BYTES|PUPPETEER_PROTOCOL_TIMEOUT_MS|WEBHOOK_MEDIA_MAX_BYTES"
docker logs openwa-api 2>&1 | grep -iE "ProtocolError|413|LOGOUT|Idempotency|unhandledRejection|webhook" | tail -100
```
**Record the answers — they gate later phases:**
- `QUEUE_ENABLED` / `REDIS_ENABLED` → decides whether R3a (queue-fallback loss) can fire.
- `PLUGINS_ENABLED` → decides whether R3b/R3c (hook payload bugs) can fire.
- Which of `MEDIA_DOWNLOAD_MAX_BYTES` vs `INBOUND_MEDIA_MAX_BYTES` is set → decides real media cap (5 MB vs 50 MiB default).
- Log grep → which symptoms are actually present (converts audit "LIKELY" → "CONFIRMED").

**Do not proceed to Phase 3+ scoping until this is filled in.** If the server is unreachable, mark these UNKNOWN and treat every gated fix as "apply defensively" — but say so explicitly, do not pretend it's confirmed.

### 0.3 Establish the failing-test baseline

**Precheck / run:**
```bash
test -d node_modules && echo "deps ok" || npm ci
npx jest src/modules/webhook 2>&1 | tail -8
```
**Expected:** webhook.service.spec.ts fails (~19). Record the exact failing count — this is the "before" number Phase 2 must drive to zero.

**Gate:** Phase 0 is complete only when 0.1 and 0.3 are captured, and 0.2 is either captured or explicitly marked UNKNOWN.

---

## Phase 1 — Create the working branch (reversible, no logic change)

**Precheck:**
```bash
git status --porcelain          # expect: only the 3 untracked docs/ files + venv/
```
**Change:**
```bash
git checkout -b prod/v0.8.11-stable v0.8.11   # use the tag confirmed in 0.1
```
**Acceptance:**
```bash
git log --oneline -1
npx tsc --noEmit 2>&1 | tail -5   # baseline: does the tag compile clean on its own?
```
**Expected:** clean typecheck at the tag. If the tag itself doesn't compile, STOP — the version choice is wrong, revisit §4 of the audit before any fork work.
**Rollback:** `git checkout main && git branch -D prod/v0.8.11-stable`

---

## Phase 2 — Webhook service: revert to upstream, keep only `capWebhookMedia`

Goal: delete R1, R1b, R3a–R3e by returning to the upstream service, then surgically re-add the one durable fork win.

### 2.1 Verify what upstream's service actually contains (before trusting the revert)

**Precheck / run:**
```bash
git show upstream/main:src/modules/webhook/webhook.service.ts | grep -nE "occurredAt|allSettled|withSafeFetch|evaluateFilters|recordWebhookDeliveryFailure|structuredClone"
```
**Expected:** all six present. This proves the revert restores the fixes the fork dropped. If any is **absent**, STOP — upstream at this tag doesn't have the fix you're reverting to; re-scope which tag to base on.

### 2.2 Capture the fork's `capWebhookMedia` exactly (before deleting the file)

**Precheck / run:**
```bash
git show HEAD:src/modules/webhook/webhook.service.ts | sed -n '/export function capWebhookMedia/,/^}/p' > /tmp/capWebhookMedia.snippet
grep -n "capWebhookMedia(data)" -R src/modules/webhook/webhook.service.ts   # find the single call site
```
**Expected:** function body captured; exactly one call site (`const safeData = capWebhookMedia(data)`). Read both — do not re-type from memory.

### 2.3 Revert the three webhook files to upstream

**Change:**
```bash
git checkout upstream/main -- \
  src/modules/webhook/webhook.service.ts \
  src/modules/webhook/webhook.service.spec.ts \
  src/modules/webhook/webhook-session-scope.spec.ts
```
**Acceptance (before re-adding the cap):**
```bash
git diff --stat upstream/main...HEAD -- src/modules/webhook/   # expect: empty (fully upstream)
npx jest src/modules/webhook 2>&1 | tail -6                    # expect: all pass
```
**Expected:** webhook diff empty; suite green. This is the moment the 19 failures must become 0. If still red, STOP — the tag's own suite is broken; do not layer the cap on a red base.

### 2.4 Re-apply `capWebhookMedia` surgically

**Change (only after 2.3 is green):**
1. Paste the captured `capWebhookMedia` function into the upstream `webhook.service.ts`.
2. In `dispatch()`, at the exact upstream choke point, insert `const safeData = capWebhookMedia(data);` and thread `safeData` into the payload build **without** removing upstream's `occurredAt`, per-webhook salt, or `structuredClone` (verify each is still present after your edit).
3. Port only the `capWebhookMedia` test block from the old spec into the upstream spec.

**Acceptance:**
```bash
npx tsc --noEmit 2>&1 | tail -5
npx jest src/modules/webhook 2>&1 | tail -8
git show upstream/main:src/modules/webhook/webhook.service.ts | grep -c occurredAt   # note baseline
grep -c "occurredAt" src/modules/webhook/webhook.service.ts                          # must be >= baseline
```
**Expected:** green suite; `occurredAt` still present (proves R1 not reintroduced); cap tests pass.
**Rollback:** `git checkout upstream/main -- src/modules/webhook/` and redo 2.4.

---

## Phase 3 — Re-apply Puppeteer `protocolTimeout` (R2), only if verified missing

### 3.1 Verify it's actually absent upstream (don't assume)

**Precheck / run:**
```bash
grep -rn "protocolTimeout" src/ ; echo "exit=$?"
grep -n "new Client(" -A15 src/engine/adapters/whatsapp-web-js.adapter.ts | grep -n "puppeteer"
```
**Expected:** no `protocolTimeout` in `src/`; the `new Client({ puppeteer: {…} })` block located. If `protocolTimeout` **is** already present, SKIP this phase.

### 3.2 Change

Add one line inside the `puppeteer: { … }` object:
```ts
protocolTimeout: Number(process.env.PUPPETEER_PROTOCOL_TIMEOUT_MS) || undefined,
```
(`|| undefined` = unset falls back to Puppeteer's default; no behavior change unless the env var is set.)

**Acceptance:**
```bash
grep -n "protocolTimeout" src/engine/adapters/whatsapp-web-js.adapter.ts
npx tsc --noEmit 2>&1 | tail -5
npx jest src/engine/adapters/whatsapp-web-js.adapter.spec.ts 2>&1 | tail -6
```
**Expected:** line present, compiles, adapter tests pass.
**Rollback:** `git checkout -- src/engine/adapters/whatsapp-web-js.adapter.ts`

---

## Phase 4 — Remove orphaned inbound knobs; standardize on the upstream cap

### 4.1 Verify the orphans are truly unused

**Precheck / run:**
```bash
grep -rn "skippedMedia\|mediaSizeBytes\|INBOUND_MEDIA_MAX_BYTES" src/ | grep -v spec
grep -rn "MEDIA_DOWNLOAD_MAX_BYTES" src/engine/adapters/inbound-media-cap.ts
```
**Expected:** the fork fields appear only in the interface/`.env` (no adapter reads); `inbound-media-cap.ts` reads `MEDIA_DOWNLOAD_MAX_BYTES`. If an adapter **does** read `INBOUND_MEDIA_MAX_BYTES`, STOP — the field is live; do not remove it.

### 4.2 Change
- Remove `skippedMedia?` / `mediaSizeBytes?` from `whatsapp-engine.interface.ts` (confirm no non-spec reader remains after removal).
- Rewrite the added `.env.example` block: document `MEDIA_DOWNLOAD_MAX_BYTES`, `MEDIA_DOWNLOAD_ENABLED`, `PUPPETEER_PROTOCOL_TIMEOUT_MS`, and `WEBHOOK_MEDIA_MAX_BYTES`; delete the `INBOUND_MEDIA_MAX_BYTES` lines.

**Acceptance:**
```bash
grep -rn "skippedMedia\|mediaSizeBytes" src/ | grep -v spec   # expect: empty
npx tsc --noEmit 2>&1 | tail -5
```
**Expected:** no dangling readers; compiles.
**Rollback:** `git checkout -- src/engine/interfaces/whatsapp-engine.interface.ts .env.example`

---

## Phase 5 — Compose regressions (repo file only; server compose stays operator-owned)

### 5.1 Verify each regression still exists vs upstream

**Precheck / run:**
```bash
git show upstream/main:docker-compose.yml | grep -nE "stop_grace_period|docker-socket-proxy:v|minio:RELEASE|name: openwa_"
grep -nE "stop_grace_period|docker-socket-proxy|minio/minio|name: openwa_|INBOUND_MEDIA_MAX_BYTES|MEDIA_DOWNLOAD_MAX_BYTES" docker-compose.yml
ls traefik/ 2>/dev/null || echo "no traefik/ dir (referenced by compose)"
```
**Expected:** upstream has `stop_grace_period`, pinned images, `name:` pins; fork is missing them; `traefik/` files referenced but absent. Confirm each before editing.

### 5.2 Change (repo `docker-compose.yml`)
- Restore `stop_grace_period: 45s` on `openwa-api`.
- Re-pin `docker-socket-proxy:v0.4.2` and `minio/minio:RELEASE.<pinned>`.
- Restore volume `name:` pins (`openwa_openwa-data`, `openwa_postgres-data`, `openwa_redis-data`, `openwa_minio-data`).
- Replace `INBOUND_MEDIA_MAX_BYTES`/`PUPPETEER_PROTOCOL_TIMEOUT_MS` forwards with `MEDIA_DOWNLOAD_MAX_BYTES` + keep `WEBHOOK_MEDIA_MAX_BYTES`; keep `PUPPETEER_PROTOCOL_TIMEOUT_MS` forward (now wired by Phase 3).
- Add `shm_size: '2gb'` on `openwa-api`.
- Either commit `traefik/traefik.yml` + `traefik/dynamic.yml` or remove the `traefik` service from the **repo** compose.
- **Keep unchanged:** `mem_limit: 5g`, `pids_limit: 2048`, `read_only` commented, `AUTO_START_SESSIONS`, `NODE_OPTIONS`, `SIMULATE_TYPING*`, port bindings.

**Acceptance:**
```bash
docker compose config >/dev/null && echo "compose valid"          # syntactic validation
grep -nE "stop_grace_period|:v0.4.2|name: openwa_|MEDIA_DOWNLOAD_MAX_BYTES|shm_size" docker-compose.yml
```
**Expected:** compose validates; all restored keys present.
**Rollback:** `git checkout -- docker-compose.yml`

---

## Phase 6 — Whole-tree verification gate (must be green before any deploy)

**Precheck / run:**
```bash
npx tsc --noEmit 2>&1 | tail -5
npx jest 2>&1 | tail -12
npm run build 2>&1 | tail -10      # or: nest build
```
**Expected:** typecheck clean; **full** suite green (the 19 webhook failures from 0.3 are gone); build succeeds.
**Gate:** if any is red, do not build an image. Fix or revert the offending phase.

---

## Phase 7 — Staging soak (behavioral proof, not just green tests)

Deploy the image to **staging** (never straight to prod). Run these targeted checks — each maps to a specific root cause:

| Check | Maps to | Pass criteria |
|-------|---------|---------------|
| Receiver deduping on `X-OpenWA-Idempotency-Key`; force disconnect→reconnect **twice** | R1 | Two distinct `session.status`/`session.disconnected` deliveries arrive (pre-fix: one) |
| Two webhooks on the same event | R1b | Both receive it |
| `QUEUE_ENABLED=true`, briefly kill Redis mid-send | R3a | Delivery still happens (fallback) or is durably recorded |
| `MEDIA_DOWNLOAD_MAX_BYTES=5242880`; send 6 MB file | R2 | `media.omitted:true`, no base64, no RAM spike, no 413 |
| Send 500 KB image | R2 | Downloaded normally |
| `docker compose restart openwa-api` under load | R4 | Graceful drain, no Chromium SIGKILL in logs, all sessions auto-start |
| `docker volume ls \| grep openwa` | R4 | Orchestration + compose bind the **same** volume |

**Gate:** promote to prod only after **48 h** with no `ProtocolError`/`413`/`LOGOUT`/`unhandledRejection` in logs and stable (non-monotonic) RAM.

---

## Phase 8 — Production promotion (image + env only)

Per the existing runbook — **never** `git checkout` compose/.env over the server:
```bash
# on server
cp .env .env.deploy.bak; cp docker-compose.yml docker-compose.yml.deploy.bak
# pull only the changed source files (or swap a pre-built image tag)
docker compose build openwa-api && docker compose up -d openwa-api
```
Set in server `.env`: `MEDIA_DOWNLOAD_MAX_BYTES=5242880`, `PUPPETEER_PROTOCOL_TIMEOUT_MS=120000`, `WEBHOOK_MEDIA_MAX_BYTES=<value>` (no inline `#` comments on value lines).

**Acceptance (prod smoke):**
```bash
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:2785/api/health/ready   # 200
docker exec openwa-api printenv MEDIA_DOWNLOAD_MAX_BYTES PUPPETEER_PROTOCOL_TIMEOUT_MS
docker logs openwa-api 2>&1 | grep -iE "ProtocolError|413|LOGOUT|unhandledRejection" | tail -20   # clean
```
**Rollback:** re-`up -d` the previous image tag (session volume unchanged → pure image swap); restore `.env.deploy.bak` / `docker-compose.yml.deploy.bak` if needed.

---

## Phase 9 — Close the loop

- Update `docs/fork-vs-upstream-tech-diff.md` to reflect the reverted webhook service + reduced fork surface.
- Optional: open an upstream PR for the `protocolTimeout` addition (Phase 3) so you stop carrying it.
- Adopt the operating model: **pin a tag → soak on staging → promote**; watch upstream `fix/session-webhook-event-delivery`, `fix/message-ack-reaction-hooks`, `feat/force-kill-stuck-session`, `fix/outbound-ssrf-hardening`.

---

## Stop conditions (do not push through on assumption)

- Phase 0.1 package diff **non-empty** → dependency drift exists; re-audit before anything else.
- Phase 2.3 webhook suite still **red** after revert → base tag suite is broken; do not layer changes.
- Phase 2.4 `occurredAt` count **below** upstream baseline → R1 reintroduced by your edit; fix before continuing.
- Phase 6 full suite/build **red** → no image is built.
- Phase 7 any root-cause check **fails** or 48 h soak shows the symptom → do not promote.
