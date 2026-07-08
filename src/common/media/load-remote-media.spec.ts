import { loadRemoteMediaBuffer } from './load-remote-media';
import { SsrfBlockedError } from '../security/ssrf-guard';

describe('loadRemoteMediaBuffer', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
    delete process.env.MEDIA_DOWNLOAD_MAX_BYTES;
  });

  // Build a Response-like with a single-chunk body stream.
  const fakeResponse = (bytes: number[], headers: Record<string, string>) => ({
    ok: true,
    status: 200,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    body: {
      getReader: () => {
        let done = false;
        return {
          read: () =>
            done
              ? Promise.resolve({ done: true, value: undefined })
              : ((done = true), Promise.resolve({ done: false, value: new Uint8Array(bytes) })),
          cancel: () => Promise.resolve(),
        };
      },
    },
  });

  it('blocks an internal URL via the SSRF guard before any fetch', async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as typeof fetch;
    await expect(loadRemoteMediaBuffer('http://127.0.0.1/x.png')).rejects.toBeInstanceOf(SsrfBlockedError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fetches a public URL and returns the bytes + content-type', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValue(fakeResponse([1, 2, 3], { 'content-type': 'image/png', 'content-length': '3' }));
    global.fetch = fetchMock as typeof fetch;
    const res = await loadRemoteMediaBuffer('http://8.8.8.8/x.png');
    expect(res.mimetype).toBe('image/png');
    expect(Array.from(res.data)).toEqual([1, 2, 3]);
    // Never follow redirects (a 3xx could reach an internal host the guard never validated).
    expect(fetchMock).toHaveBeenCalledWith('http://8.8.8.8/x.png', expect.objectContaining({ redirect: 'error' }));
  });

  it('rejects a body that exceeds the byte cap', async () => {
    process.env.MEDIA_DOWNLOAD_MAX_BYTES = '2';
    const fetchMock = jest.fn().mockResolvedValue(fakeResponse([1, 2, 3], { 'content-type': 'image/png' }));
    global.fetch = fetchMock as typeof fetch;
    await expect(loadRemoteMediaBuffer('http://8.8.8.8/x.png')).rejects.toThrow(/exceeds/i);
  });
});
