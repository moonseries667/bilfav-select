import { afterEach, describe, expect, it, vi } from 'vitest';
import { gmFetch, type GMXMLHttpRequestDetails, type GMXMLHttpResponse } from '../src/lib/gm';
import { BilibiliHttpClient } from '../src/api/bilibili-http';

const response = { status: 200, responseText: '{"code":0,"data":[]}' } as GMXMLHttpResponse;

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('userscript request deadlines', () => {
  it('rejects and aborts a request even when the manager never calls ontimeout, ignoring late callbacks', async () => {
    vi.useFakeTimers();
    let callbacks!: GMXMLHttpRequestDetails;
    const abort = vi.fn(() => callbacks.onabort?.());
    vi.stubGlobal('GM_xmlhttpRequest', (details: GMXMLHttpRequestDetails) => { callbacks = details; return { abort }; });
    const result = gmFetch('https://api.bilibili.com/test');
    const rejected = expect(result).rejects.toMatchObject({ kind: 'network', code: 408, retryable: true });
    await vi.advanceTimersByTimeAsync(30_000);
    await rejected;
    expect(abort).toHaveBeenCalledTimes(1);
    callbacks.onload?.(response);
    callbacks.ontimeout?.();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears its independent timer after success or a synchronous manager failure', async () => {
    vi.useFakeTimers();
    const abort = vi.fn();
    vi.stubGlobal('GM_xmlhttpRequest', (details: GMXMLHttpRequestDetails) => { details.onload?.(response); return { abort }; });
    await expect(gmFetch('https://api.bilibili.com/test')).resolves.toBe(response);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(abort).not.toHaveBeenCalled();
    vi.stubGlobal('GM_xmlhttpRequest', () => { throw new Error('manager failed'); });
    await expect(gmFetch('https://api.bilibili.com/test')).rejects.toMatchObject({ kind: 'network' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('honors a custom deadline and handles a manager without an abort handle', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('GM_xmlhttpRequest', vi.fn());
    const rejected = expect(gmFetch('https://api.bilibili.com/test', { timeout: 90_000 })).rejects.toMatchObject({ code: 408 });
    await vi.advanceTimersByTimeAsync(89_999);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds retries on a stalled Bilibili read, reports timeout, and releases the serialized queue', async () => {
    vi.useFakeTimers();
    const abort = vi.fn();
    const manager = vi.fn(() => ({ abort }));
    vi.stubGlobal('GM_xmlhttpRequest', manager);
    const log = vi.fn();
    const client = new BilibiliHttpClient({ requestDelayMs: 0, cooldownMs: 0, maxRetries: 2 }, { log, sleep: async () => {} });
    const rejected = expect(client.getData('https://api.bilibili.com/test')).rejects.toMatchObject({ code: 408, message: expect.stringContaining('请求超时') });
    await vi.advanceTimersByTimeAsync(90_000);
    await rejected;
    expect(manager).toHaveBeenCalledTimes(3);
    expect(abort).toHaveBeenCalledTimes(3);
    expect(log.mock.calls.map(call => call[0])).toEqual([
      'B 站请求超时（单次 30 秒），等待后重试 1/2',
      'B 站请求超时（单次 30 秒），等待后重试 2/2',
    ]);
    vi.stubGlobal('GM_xmlhttpRequest', (details: GMXMLHttpRequestDetails) => details.onload?.(response));
    await expect(client.getData('https://api.bilibili.com/test')).resolves.toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
