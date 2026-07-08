import { assertSafeFetchUrl } from '../security/ssrf-guard';

/** Default cap on a server-side media download: 50 MiB (overridable via MEDIA_DOWNLOAD_MAX_BYTES). */
const DEFAULT_MEDIA_MAX_BYTES = 50 * 1024 * 1024;
/** Default timeout for a server-side media download: 30s (overridable via MEDIA_DOWNLOAD_TIMEOUT_MS). */
const DEFAULT_MEDIA_TIMEOUT_MS = 30_000;

function positiveIntFromEnv(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Fetch remote media as a Buffer for sending, with an SSRF host guard, a byte cap, and a timeout.
 * The guard runs BEFORE any network call, so an internal/reserved URL throws `SsrfBlockedError`
 * and no outbound socket is opened. `redirect: 'error'` is used because the guard only validated
 * the original host — a followed 3xx could reach an internal target. The cap is enforced while
 * streaming (Content-Length may be absent or wrong) to bound memory use.
 *
 * Engine-neutral: returns raw bytes + the response content-type, so any engine adapter can use it.
 */
export async function loadRemoteMediaBuffer(url: string): Promise<{ data: Buffer; mimetype: string }> {
  await assertSafeFetchUrl(url);

  const maxBytes = positiveIntFromEnv('MEDIA_DOWNLOAD_MAX_BYTES', DEFAULT_MEDIA_MAX_BYTES);
  const timeoutMs = positiveIntFromEnv('MEDIA_DOWNLOAD_TIMEOUT_MS', DEFAULT_MEDIA_TIMEOUT_MS);

  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) {
    throw new Error(`Media fetch failed with status ${response.status}`);
  }

  const declaredLength = Number(response.headers.get('content-length') ?? '');
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error(`Media exceeds the ${maxBytes}-byte limit`);
  }

  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error('Media response has no body');
  }

  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(`Media exceeds the ${maxBytes}-byte limit`);
    }
    chunks.push(Buffer.from(value));
  }

  const mimetype = (response.headers.get('content-type') ?? '').split(';')[0].trim();
  return { data: Buffer.concat(chunks), mimetype };
}
