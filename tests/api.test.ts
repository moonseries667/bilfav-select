import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpBilibiliAdapter } from '../src/api/bilibili';
import type { BilibiliRequestOptions, BilibiliTransport } from '../src/api/bilibili-http';
import { AppError } from '../src/lib/errors';
import { Workflow } from '../src/core/workflow';
import { createInitialData } from '../src/lib/storage';
import { DEFAULT_SETTINGS } from '../src/defaults';
import { classifyDataset } from '../src/ai/classifier';
import type { AppData } from '../src/types';

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

  it('rejects missing resource types and an unconfirmed ID list even if page info is absent', async () => {
    let medias: unknown[] = [{ id: 1, title: 'schema changed' }];
    const { mock } = transport(url => {
      if (url.includes('/x/web-interface/nav')) return { body: loggedIn() };
      if (url.includes('/created/list-all')) return { body: folderList([folder(201, 2, { media_count: 1 })]) };
      return { body: ok({ medias, has_more: false }) };
    });
    const adapter = new HttpBilibiliAdapter(settings(), {}, mock);
    await expect(adapter.listFolderVideos(201)).rejects.toMatchObject({ kind: 'invalid' });
    medias = [];
    await expect(adapter.listFolderVideos(201)).rejects.toThrow('完整 ID 列表缺失');
  });

  it.each([-404, 62002, 62004, 62012])('scans 98/99 items when the omitted ID returns %i and never operates on that video', async code => {
    const medias = Array.from({ length: 98 }, (_, index) => ({ id: index + 1, type: 2, attr: 0, title: `v${index + 1}` }));
    const { mock, calls } = transport(url => {
      if (url.includes('/x/web-interface/nav')) return { body: loggedIn() };
      if (url.includes('/created/list-all')) return { body: folderList([folder(500, 2, { media_count: 99 })]) };
      if (url.includes('/resource/ids')) return { body: ok([...medias, { id: 99, type: 2 }]) };
      if (url.includes('/resource/list')) {
        const pn = Number(new URL(url).searchParams.get('pn'));
        return { body: ok({ info: { media_count: 99 }, medias: medias.slice((pn - 1) * 20, pn * 20), has_more: pn < 5 }) };
      }
      if (url.includes('/view?aid=99')) return { body: { code, data: null } };
      throw new Error(`Unexpected URL: ${url}`);
    });
    const adapter = new HttpBilibiliAdapter(settings(), {}, mock);

    expect((await adapter.listFolderVideos(500)).map(video => video.aid)).toEqual(medias.map(media => media.id));
    // Repeated source/target verification should reuse the confirmed status.
    expect(await adapter.getFolderAidSet(500)).toEqual(new Set(medias.map(media => media.id)));
    const countBefore = calls.length;
    await adapter.copyVideos(500, 501, [99]);
    expect(calls).toHaveLength(countBefore);
    expect(calls.filter(call => call.url.includes('/view?aid=99'))).toHaveLength(1);
    expect(calls.some(call => call.url.includes('/view/detail/tag') || call.options.method === 'POST')).toBe(false);
  });

  it('cross-checks an ID list that excludes hidden entries instead of requiring media_count equality', async () => {
    const media = { id: 1, type: 2, attr: 0, title: 'valid' };
    const { mock, calls } = transport(url => {
      if (url.includes('/x/web-interface/nav')) return { body: loggedIn() };
      if (url.includes('/created/list-all')) return { body: folderList([folder(501, 2, { media_count: 2 })]) };
      if (url.includes('/resource/ids')) return { body: ok([{ id: 1, type: 2 }]) };
      if (url.includes('/resource/list')) return { body: ok({ medias: [media], has_more: false }) };
      throw new Error(`Unexpected URL: ${url}`);
    });
    expect(await new HttpBilibiliAdapter(settings(), {}, mock).listFolderVideos(501)).toMatchObject([{ aid: 1 }]);
    expect(calls.some(call => call.url.includes('/view?'))).toBe(false);
  });

  it('announces the fourth page and missing-ID checks before awaiting them in a 72/73 scan', async () => {
    const medias = Array.from({ length: 72 }, (_, index) => ({ id: index + 1, type: 2, attr: 0, title: `v${index + 1}` }));
    const progress = vi.fn();
    const latest = () => progress.mock.calls.at(-1)?.[0];
    const { mock, calls } = transport(url => {
      if (url.includes('/x/web-interface/nav')) return { body: loggedIn() };
      if (url.includes('/created/list-all')) return { body: folderList([folder(509, 2, { media_count: 73 })]) };
      if (url.includes('/resource/list')) {
        const pn = Number(new URL(url).searchParams.get('pn'));
        expect(latest()).toMatchObject({ phase: 'scanning', completed: (pn - 1) * 20, total: 73,
          message: expect.stringContaining(`第 ${pn} 页`) });
        return { body: ok({ medias: medias.slice((pn - 1) * 20, pn * 20), has_more: pn < 4 }) };
      }
      if (url.includes('/resource/ids')) {
        expect(latest()).toMatchObject({ phase: 'reconciling', completed: 72, total: 73,
          message: expect.stringContaining('核对完整 ID 列表') });
        return { body: ok([...medias, { id: 73, type: 2 }]) };
      }
      if (url.includes('/view?aid=73')) {
        expect(latest()).toMatchObject({ phase: 'reconciling', completed: 0, total: 1,
          message: expect.stringContaining('aid 73') });
        return { body: { code: 62012, data: null } };
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    expect(await new HttpBilibiliAdapter(settings(), { progress }, mock).listFolderVideos(509)).toHaveLength(72);
    expect(latest()).toMatchObject({ phase: 'reconciling', completed: 1, total: 1 });
    expect(calls.filter(call => call.url.includes('/resource/list'))).toHaveLength(4);
    expect(calls.some(call => call.url.includes('/view/detail/tag') || call.options.method === 'POST')).toBe(false);
  });

  it.each([[], null])('accepts an all-unavailable terminal page %j after confirming missing IDs', async medias => {
    const { mock, calls } = transport(url => {
      if (url.includes('/x/web-interface/nav')) return { body: loggedIn() };
      if (url.includes('/created/list-all')) return { body: folderList([folder(502, 2, { media_count: 1 })]) };
      if (url.includes('/resource/ids')) return { body: ok([{ id: 99, type: 2 }]) };
      if (url.includes('/resource/list')) return { body: ok({ medias, has_more: false }) };
      if (url.includes('/view?aid=99')) return { body: { code: 11010, data: null } };
      throw new Error(`Unexpected URL: ${url}`);
    });
    expect(await new HttpBilibiliAdapter(settings(), {}, mock).listFolderVideos(502)).toEqual([]);
    expect(calls.some(call => call.url.includes('/view/detail/tag'))).toBe(false);
  });

  it('skips resource attr 1 and 9 while retaining a valid video with attr 16', async () => {
    const { mock, calls } = transport(url => {
      if (url.includes('/x/web-interface/nav')) return { body: loggedIn() };
      if (url.includes('/created/list-all')) return { body: folderList([folder(503, 2, { media_count: 3 })]) };
      if (url.includes('/resource/list')) return { body: ok({ medias: [
        { id: 1, type: 2, attr: 1 }, { id: 2, type: 2, attr: 9 }, { id: 3, type: 2, attr: 16, title: 'interactive' },
      ], has_more: false }) };
      throw new Error(`Unexpected URL: ${url}`);
    });
    const adapter = new HttpBilibiliAdapter(settings(), {}, mock);
    expect(await adapter.listFolderVideos(503)).toMatchObject([{ aid: 3, title: 'interactive' }]);
    const countBefore = calls.length;
    await adapter.getVideoMetadata(1);
    await adapter.copyVideos(503, 504, [1, 2]);
    expect(calls).toHaveLength(countBefore);
  });

  it('continues through an empty middle page containing hidden unavailable videos', async () => {
    const media = { id: 21, type: 2, attr: 0, title: 'valid after hidden page' };
    const { mock, calls } = transport(url => {
      if (url.includes('/x/web-interface/nav')) return { body: loggedIn() };
      if (url.includes('/created/list-all')) return { body: folderList([folder(506, 2, { media_count: 21 })]) };
      if (url.includes('/resource/ids')) return { body: ok([{ id: 21, type: 2 }]) };
      if (url.includes('/resource/list')) return { body: ok(url.includes('pn=1')
        ? { medias: null, has_more: true }
        : { medias: [media], has_more: false }) };
      throw new Error(`Unexpected URL: ${url}`);
    });
    expect(await new HttpBilibiliAdapter(settings(), {}, mock).listFolderVideos(506)).toMatchObject([{ aid: 21 }]);
    expect(calls.filter(call => call.url.includes('/resource/list'))).toHaveLength(2);
  });

  it('rejects an endlessly empty pagination response at the folder-count bound', async () => {
    const { mock, calls } = transport(url => {
      if (url.includes('/x/web-interface/nav')) return { body: loggedIn() };
      if (url.includes('/created/list-all')) return { body: folderList([folder(507, 2, { media_count: 21 })]) };
      if (url.includes('/resource/list')) return { body: ok({ medias: [], has_more: true }) };
      throw new Error(`Unexpected URL: ${url}`);
    });
    await expect(new HttpBilibiliAdapter(settings(), {}, mock).listFolderVideos(507)).rejects.toThrow('仍返回空页');
    expect(calls.filter(call => call.url.includes('/resource/list'))).toHaveLength(2);
  });

  it('still rejects an available ID missing from pagination', async () => {
    const { mock } = transport(url => {
      if (url.includes('/x/web-interface/nav')) return { body: loggedIn() };
      if (url.includes('/created/list-all')) return { body: folderList([folder(504, 2, { media_count: 1 })]) };
      if (url.includes('/resource/ids')) return { body: ok([{ id: 99, type: 2 }]) };
      if (url.includes('/resource/list')) return { body: ok({ medias: [], has_more: false }) };
      if (url.includes('/view?aid=99')) return { body: ok({ aid: 99, title: 'available' }) };
      if (url.includes('/view/detail/tag')) return { body: ok([]) };
      throw new Error(`Unexpected URL: ${url}`);
    });
    await expect(new HttpBilibiliAdapter(settings(), {}, mock).listFolderVideos(504)).rejects.toThrow('漏读了有效视频 99');
  });

  it('propagates a failed missing-ID status request instead of skipping it', async () => {
    const { mock } = transport(url => {
      if (url.includes('/x/web-interface/nav')) return { body: loggedIn() };
      if (url.includes('/created/list-all')) return { body: folderList([folder(505, 2, { media_count: 1 })]) };
      if (url.includes('/resource/ids')) return { body: ok([{ id: 99, type: 2 }]) };
      if (url.includes('/resource/list')) return { body: ok({ medias: [], has_more: false }) };
      if (url.includes('/view?aid=99')) return { reject: true };
      throw new Error(`Unexpected URL: ${url}`);
    });
    await expect(new HttpBilibiliAdapter({ ...settings(), maxRetries: 0 }, {}, mock).listFolderVideos(505)).rejects.toMatchObject({ kind: 'network' });
  });

  it('stops before requesting tags once a negative detail state confirms unavailability', async () => {
    const { mock, calls } = transport(url => {
      if (url.includes('/view?aid=99')) return { body: ok({ aid: 99, title: 'removed', state: -2 }) };
      throw new Error(`Unexpected URL: ${url}`);
    });
    const adapter = new HttpBilibiliAdapter(settings(), {}, mock);
    await expect(adapter.getVideoMetadata(99)).resolves.toMatchObject({ aid: 99, unavailable: true });
    expect(calls).toHaveLength(1);
  });

  it.each([-404, 11010, 62002, 62004, 62012])('skips detail code %i without tags, retries, or later video operations', async code => {
    const { mock, calls } = transport(url => {
      if (url.includes('/view?aid=99')) return { body: { code, message: 'untrusted echoed text', data: null } };
      throw new Error(`Unexpected URL: ${url}`);
    });
    const log = vi.fn();
    const adapter = new HttpBilibiliAdapter(settings(), { log }, mock);
    await expect(adapter.getVideoMetadata(99)).resolves.toMatchObject({ aid: 99, unavailable: true });
    await adapter.getVideoMetadata(99);
    await adapter.copyVideos(500, 501, [99]);
    expect(calls).toHaveLength(1);
    expect(adapter.isVideoUnavailable(99)).toBe(true);
    expect(log).toHaveBeenCalledWith(expect.stringContaining(`code ${code}`), 'info');
    expect(JSON.stringify(log.mock.calls)).not.toContain('untrusted echoed text');
  });

  it.each([62002, 62004, 62012])('skips a video that becomes unavailable with code %i during its tags request', async code => {
    const { mock, calls } = transport(url => {
      if (url.includes('/view?aid=99')) return { body: ok({ aid: 99, title: 'previously visible' }) };
      if (url.includes('/view/detail/tag?aid=99')) return { body: { code, data: null } };
      throw new Error(`Unexpected URL: ${url}`);
    });
    const adapter = new HttpBilibiliAdapter(settings(), {}, mock);
    await expect(adapter.getVideoMetadata(99)).resolves.toMatchObject({ aid: 99, unavailable: true });
    await adapter.getVideoMetadata(99);
    await adapter.copyVideos(500, 501, [99]);
    expect(calls).toHaveLength(2);
  });

  it.each([-101, -403, -400, 62099])('does not misclassify detail code %i as unavailable', async code => {
    const { mock } = transport(() => ({ body: { code, data: null } }));
    const adapter = new HttpBilibiliAdapter(settings(), {}, mock);
    await expect(adapter.getVideoMetadata(99)).rejects.toMatchObject({ kind: 'api', code });
    expect(adapter.isVideoUnavailable(99)).toBe(false);
  });

  it('does not treat code 62012 on an account endpoint as a video status', async () => {
    const { mock } = transport(() => ({ body: { code: 62012, data: null } }));
    await expect(new HttpBilibiliAdapter(settings(), {}, mock).getCurrentUser()).rejects.toMatchObject({ kind: 'api', code: 62012 });
  });

  it('continues HTTP-backed dataset refresh past a 62012 video and excludes it from classification', async () => {
    const { mock, calls } = transport(url => {
      if (url.includes('/x/web-interface/nav')) return { body: loggedIn() };
      if (url.includes('/created/list-all')) return { body: folderList([folder(500, 2, { title: '源-旧', media_count: 3 })]) };
      if (url.includes('/resource/list')) return { body: ok({ medias: [1, 2, 3].map(id => ({ id, type: 2, attr: 0, title: `v${id}` })), has_more: false }) };
      const aid = Number(new URL(url).searchParams.get('aid'));
      if (url.includes('/view?')) return { body: aid === 2 ? { code: 62012, data: null } : ok({ aid, title: `v${aid}` }) };
      if (url.includes('/view/detail/tag')) return { body: ok([{ tag_name: 'tag' }]) };
      throw new Error(`Unexpected URL: ${url}`);
    });
    let saved = createInitialData();
    const repository = {
      load: () => structuredClone(saved),
      save: (data: AppData) => { saved = structuredClone(data); },
    };
    const adapter = new HttpBilibiliAdapter(settings(), {}, mock);
    const workflow = new Workflow(adapter, repository);
    await workflow.freezeSources();
    const dataset = await workflow.refreshDataset(true);
    expect(dataset.videos.map(video => video.aid)).toEqual([1, 3]);
    expect(saved.dataset).toEqual(dataset);
    expect(calls.some(call => call.url.includes('/view/detail/tag?aid=2'))).toBe(false);
    const complete = vi.fn(async () => '[{"aid":1,"category":"不确定","confidence":0},{"aid":3,"category":"不确定","confidence":0}]');
    const manifest = await classifyDataset(dataset, structuredClone(DEFAULT_SETTINGS), {}, { complete });
    expect(manifest.results.map(result => result.aid)).toEqual([1, 3]);
    expect(complete.mock.calls).toHaveLength(1);
    await adapter.copyVideos(500, 501, [2]);
    expect(calls.some(call => call.options.method === 'POST')).toBe(false);
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
