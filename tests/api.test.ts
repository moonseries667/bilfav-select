import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpBilibiliAdapter } from '../src/api/bilibili';
import type { BilibiliRequestOptions, BilibiliTransport } from '../src/api/bilibili-http';
import { AppError } from '../src/lib/errors';

type Call = { url: string; options: BilibiliRequestOptions };
type MockResult = { status?: number; body?: unknown; responseText?: string; reject?: boolean };

const ok = (data: unknown) => ({ code: 0, message: '0', data });
const loggedIn = () => ok({ isLogin: true, mid: 7, uname: 'tester' });
const folderList = (folders: unknown[]) => ok({ count: folders.length, list: folders });
const folder = (id: number, attr: number, values: Record<string, unknown> = {}) => ({
  id, fid: id - 1, mid: 7, attr, title: `folder-${id}`, media_count: 0, ...values,
});

function transport(handler: (url: string, options: BilibiliRequestOptions, calls: Call[]) => MockResult | Promise<MockResult>) {
  const calls: Call[] = [];
  const mock: BilibiliTransport = vi.fn(async (url, options) => {
    calls.push({ url, options });
    const result = await handler(url, options, calls);
    if (result.reject) throw new Error('mock network failure');
    return {
      status: result.status ?? 200,
      responseText: result.responseText ?? JSON.stringify(result.body ?? {}),
    };
  });
  return { mock, calls };
}

const settings = () => ({ requestDelayMs: 0, cooldownMs: 50, maxRetries: 2 });
const jsonBody = (call: Call): URLSearchParams => new URLSearchParams(call.options.body ?? '');

afterEach(() => vi.unstubAllGlobals());

describe('HttpBilibiliAdapter', () => {
  it('uses nav mid and attr default marker instead of titles or fid guesses', async () => {
    const { mock, calls } = transport(url => {
      if (url.includes('/x/web-interface/nav')) return { body: loggedIn() };
      if (url.includes('/created/list-all')) {
        return { body: folderList([
          folder(100, 0, { fid: 500, title: 'a normal-looking title' }),
          folder(101, 22, { fid: 0, title: '默认收藏夹' }),
        ]) };
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    const adapter = new HttpBilibiliAdapter(settings(), {}, mock);

    const folders = await adapter.listFolders();

    expect(folders.map(item => [item.id, item.isDefault])).toEqual([[100, true], [101, false]]);
    expect(calls[1].url).toContain('up_mid=7');
    expect(calls.every(call => call.options.anonymous === false)).toBe(true);
  });

  it('rejects default-folder rename before any write request', async () => {
    const { mock, calls } = transport(url => {
      if (url.includes('/x/web-interface/nav')) return { body: loggedIn() };
      if (url.includes('/created/list-all')) return { body: folderList([folder(100, 0)]) };
      throw new Error(`Unexpected URL: ${url}`);
    });
    const adapter = new HttpBilibiliAdapter(settings(), {}, mock);

    await expect(adapter.renameFolder(100, 'renamed')).rejects.toMatchObject({ kind: 'safety' });
    expect(calls.some(call => call.options.method === 'POST')).toBe(false);
  });

  it('preserves folder privacy, intro and cover during rename', async () => {
    vi.stubGlobal('document', { cookie: 'SESSDATA=hidden; bili_jct=csrf-secret' });
    const { mock, calls } = transport(url => {
      if (url.includes('/x/web-interface/nav')) return { body: loggedIn() };
      if (url.includes('/created/list-all')) return { body: folderList([folder(102, 3, { title: 'private source' })]) };
      if (url.includes('/x/v3/fav/folder/info')) {
        return { body: ok({ id: 102, fid: 101, mid: 7, attr: 3, title: 'private source', intro: 'kept intro', cover: 'kept-cover', media_count: 4 }) };
      }
      if (url.includes('/x/v3/fav/folder/edit')) return { body: ok({}) };
      throw new Error(`Unexpected URL: ${url}`);
    });
    const adapter = new HttpBilibiliAdapter(settings(), {}, mock);

    await adapter.renameFolder(102, 'private source-旧');

    const edit = calls.find(call => call.url.includes('/folder/edit'))!;
    const body = jsonBody(edit);
    expect(body.get('media_id')).toBe('102');
    expect(body.get('title')).toBe('private source-旧');
    expect(body.get('privacy')).toBe('1');
    expect(body.get('intro')).toBe('kept intro');
    expect(body.get('cover')).toBe('kept-cover');
    expect(body.get('csrf')).toBe('csrf-secret');
  });

  it('rejects an incomplete later page instead of returning a partial folder scan', async () => {
    const medias = Array.from({ length: 20 }, (_, index) => ({ id: index + 1, type: 2, attr: 0, title: `v${index + 1}` }));
    const { mock, calls } = transport(url => {
      if (url.includes('/x/web-interface/nav')) return { body: loggedIn() };
      if (url.includes('/created/list-all')) return { body: folderList([folder(200, 2, { media_count: 21 })]) };
      if (url.includes('/x/v3/fav/resource/list')) {
        if (url.includes('pn=1')) return { body: ok({ info: { media_count: 21 }, medias, has_more: true }) };
        return { reject: true };
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    const adapter = new HttpBilibiliAdapter({ ...settings(), maxRetries: 0 }, { sleep: async () => undefined }, mock);

    await expect(adapter.listFolderVideos(200)).rejects.toBeInstanceOf(AppError);
    expect(calls.filter(call => call.url.includes('/x/v3/fav/resource/list'))).toHaveLength(2);
  });

  it('loads full tags from the tags endpoint and maps video detail fields', async () => {
    const { mock, calls } = transport(url => {
      if (url.includes('/x/web-interface/view/detail/tag')) {
        return { body: ok([{ tag_name: 'tag one' }, { tag_name: 'tag two' }, { tag_name: 'tag three' }]) };
      }
      if (url.includes('/x/web-interface/view?')) {
        return { body: ok({
          aid: 123, bvid: 'BV123', title: 'Video title', desc: 'full description',
          tname: 'category', tid: 17, tid_v2: 1701, duration: 301,
          owner: { mid: 9, name: 'uploader' },
        }) };
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    const adapter = new HttpBilibiliAdapter(settings(), {}, mock);

    const metadata = await adapter.getVideoMetadata(123, 'BV123');

    expect(metadata).toMatchObject({
      aid: 123, bvid: 'BV123', title: 'Video title', description: 'full description',
      tags: ['tag one', 'tag two', 'tag three'], tname: 'category', tid: 17,
      tidV2: 1701, duration: 301, upper: { mid: 9, name: 'uploader' },
    });
    expect(calls.some(call => call.url.includes('/x/web-interface/view/detail/tag?aid=123'))).toBe(true);
  });

  it('rejects missing resource types and truncated scans even if page info is absent', async () => {
    let medias: unknown[] = [{ id: 1, title: 'schema changed' }];
    const { mock } = transport(url => {
      if (url.includes('/x/web-interface/nav')) return { body: loggedIn() };
      if (url.includes('/created/list-all')) return { body: folderList([folder(201, 2, { media_count: 1 })]) };
      return { body: ok({ medias, has_more: false }) };
    });
    const adapter = new HttpBilibiliAdapter(settings(), {}, mock);
    await expect(adapter.listFolderVideos(201)).rejects.toMatchObject({ kind: 'invalid' });
    medias = [];
    await expect(adapter.listFolderVideos(201)).rejects.toThrow('0/1');
  });

  it('rejects missing detail identity and partially malformed tag records', async () => {
    let detail: Record<string, unknown> = { title: '缺少 aid' };
    const { mock } = transport(url => url.includes('/view/detail/tag')
      ? { body: ok([{ tag_name: 'valid' }, { renamed_field: 'unknown' }]) }
      : { body: ok(detail) });
    const adapter = new HttpBilibiliAdapter(settings(), {}, mock);
    await expect(adapter.getVideoMetadata(123)).rejects.toMatchObject({ kind: 'invalid' });
    detail = { aid: 123, title: 'valid detail' };
    await expect(adapter.getVideoMetadata(123)).rejects.toThrow('部分标签');
  });

  it('sends exact batch-copy fields and never a move or source-delete request', async () => {
    vi.stubGlobal('document', { cookie: 'bili_jct=csrf-secret' });
    const { mock, calls } = transport(url => {
      if (url.includes('/x/web-interface/nav')) return { body: loggedIn() };
      if (url.includes('/created/list-all')) return { body: folderList([folder(201, 2), folder(202, 2)]) };
      if (url.includes('/x/v3/fav/resource/copy')) return { body: ok(0) };
      throw new Error(`Unexpected URL: ${url}`);
    });
    const adapter = new HttpBilibiliAdapter(settings(), {}, mock);

    await adapter.copyVideos(201, 202, [44, 45]);

    const copy = calls.find(call => call.url.includes('/resource/copy'))!;
    expect(Object.fromEntries(jsonBody(copy))).toEqual({
      src_media_id: '201', tar_media_id: '202', mid: '7', resources: '44:2,45:2',
      platform: 'web', csrf: 'csrf-secret',
    });
    expect(calls.every(call => !call.url.includes('/resource/move') && !call.url.includes('/resource/batch-del'))).toBe(true);
  });

  it('falls back only on an unavailable batch route and leaves del_media_ids empty', async () => {
    vi.stubGlobal('document', { cookie: 'bili_jct=csrf-secret' });
    const { mock, calls } = transport(url => {
      if (url.includes('/x/web-interface/nav')) return { body: loggedIn() };
      if (url.includes('/created/list-all')) return { body: folderList([folder(301, 2), folder(302, 2)]) };
      if (url.includes('/x/v3/fav/resource/copy')) return { status: 404, body: { code: -1, message: 'route missing' } };
      if (url.includes('/x/v3/fav/resource/deal')) return { body: ok({ prompt: false }) };
      throw new Error(`Unexpected URL: ${url}`);
    });
    const adapter = new HttpBilibiliAdapter(settings(), {}, mock);

    await adapter.copyVideos(301, 302, [77, 78]);

    const fallbackCalls = calls.filter(call => call.url.includes('/resource/deal'));
    expect(fallbackCalls).toHaveLength(2);
    expect(fallbackCalls.map(call => jsonBody(call).get('rid'))).toEqual(['77', '78']);
    expect(fallbackCalls.every(call => jsonBody(call).get('add_media_ids') === '302' && jsonBody(call).get('del_media_ids') === '')).toBe(true);
    expect(calls.some(call => call.url.includes('/resource/batch-del') || call.url.includes('/resource/move'))).toBe(false);
  });

  it('retries temporary GET failures and enforces at least the configured 412 cooldown', async () => {
    let attempts = 0;
    const waits: number[] = [];
    const { mock } = transport(url => {
      if (!url.includes('/x/web-interface/nav')) throw new Error(`Unexpected URL: ${url}`);
      attempts++;
      if (attempts === 1) return { status: 412, body: {} };
      return { body: loggedIn() };
    });
    const adapter = new HttpBilibiliAdapter(settings(), { sleep: async ms => { waits.push(ms); } }, mock);

    await expect(adapter.getCurrentUser()).resolves.toEqual({ mid: 7, name: 'tester' });
    expect(attempts).toBe(2);
    expect(waits.some(ms => ms >= 50)).toBe(true);
  });

  it('retries a temporary GET 5xx response within the configured retry limit', async () => {
    let attempts = 0;
    const waits: number[] = [];
    const { mock } = transport(url => {
      if (!url.includes('/x/web-interface/nav')) throw new Error(`Unexpected URL: ${url}`);
      attempts++;
      if (attempts === 1) return { status: 503, body: {} };
      return { body: loggedIn() };
    });
    const adapter = new HttpBilibiliAdapter(settings(), { sleep: async ms => { waits.push(ms); } }, mock);

    await expect(adapter.getCurrentUser()).resolves.toEqual({ mid: 7, name: 'tester' });
    expect(attempts).toBe(2);
    expect(waits.length).toBeGreaterThan(0);
  });

  it('accepts a null resource list only for a confirmed empty folder', async () => {
    const { mock } = transport(url => {
      if (url.includes('/x/web-interface/nav')) return { body: loggedIn() };
      if (url.includes('/created/list-all')) return { body: folderList([folder(401, 2, { media_count: 0 })]) };
      if (url.includes('/x/v3/fav/resource/list')) return { body: ok({ info: { media_count: 0 }, medias: null, has_more: false }) };
      throw new Error(`Unexpected URL: ${url}`);
    });
    const adapter = new HttpBilibiliAdapter(settings(), {}, mock);

    await expect(adapter.listFolderVideos(401)).resolves.toEqual([]);
  });

  it('does not interpret HTTP 404 from the view route as an unavailable video', async () => {
    const { mock } = transport(url => url.includes('/x/web-interface/view?')
      ? { status: 404, body: {} }
      : { body: {} });
    const adapter = new HttpBilibiliAdapter(settings(), {}, mock);

    await expect(adapter.getVideoMetadata(555)).rejects.toMatchObject({ kind: 'api', code: 404 });
  });

  it('propagates an invalid tags response instead of downgrading the video to unavailable', async () => {
    const { mock } = transport(url => {
      if (url.includes('/x/web-interface/view/detail/tag')) return { body: ok({ tags: ['not an array'] }) };
      if (url.includes('/x/web-interface/view?')) return { body: ok({ aid: 556, title: 'valid video' }) };
      throw new Error(`Unexpected URL: ${url}`);
    });
    const adapter = new HttpBilibiliAdapter(settings(), {}, mock);

    await expect(adapter.getVideoMetadata(556)).rejects.toMatchObject({ kind: 'invalid' });
  });

  it('does not retry a create after an ambiguous network failure', async () => {
    vi.stubGlobal('document', { cookie: 'bili_jct=csrf-secret' });
    let createAttempts = 0;
    const { mock } = transport(url => {
      if (url.includes('/x/web-interface/nav')) return { body: loggedIn() };
      if (url.includes('/x/v3/fav/folder/add')) {
        createAttempts++;
        return { reject: true };
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    const adapter = new HttpBilibiliAdapter(settings(), {}, mock);

    await expect(adapter.createFolder('new')).rejects.toMatchObject({ kind: 'network' });
    expect(createAttempts).toBe(1);
  });

  it('does not surface untrusted API message text that could echo request data', async () => {
    const { mock } = transport(url => url.includes('/x/web-interface/nav')
      ? { body: { code: -101, message: 'echoed secret-value' } }
      : { body: {} });
    const adapter = new HttpBilibiliAdapter(settings(), {}, mock);

    let caught: unknown;
    try {
      await adapter.getCurrentUser();
    } catch (error) {
      caught = error;
    }
    const error = caught as AppError;
    expect(error.message).not.toContain('secret-value');
    expect(error.code).toBe(-101);
  });
});
