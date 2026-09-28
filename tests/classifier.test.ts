import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/defaults';
import { AppError } from '../src/lib/errors';
import type {
  CategoryDefinition, RuntimeHooks, Settings, VideoDataset, VideoRecord,
} from '../src/types';
import { classifyDataset, parseClassification, validateCategories } from '../src/ai/classifier';
import { buildAIRequest, defaultAIProvider, type AIProvider } from '../src/ai/provider';

const categories: CategoryDefinition[] = [
  { name: '电影', description: '完整电影作品' },
  { name: '知识', description: '教程和知识讲解' },
  { name: '不确定', description: '信息不足或无法可靠归类' },
];

function video(aid: number, overrides: Partial<VideoRecord> = {}): VideoRecord {
  return {
    aid,
    bvid: `BV${aid}`,
    title: `标题 ${aid}`,
    description: `简介 ${aid}`,
    tags: ['标签一', '标签二', '标签三'],
    tname: '影视',
    tid: 1,
    tidV2: 2,
    upper: { mid: 44, name: 'UP 主' },
    duration: 3600,
    sourceFolderIds: [98765],
    primarySourceFolderId: 98765,
    metadataFetchedAt: '2026-09-28T00:00:00.000Z',
    ...overrides,
  };
}

function dataset(videos: VideoRecord[]): VideoDataset {
  return { version: 3, updatedAt: '2026-09-27T18:30:00.000Z', sourceFolderIds: [98765], videos };
}

function settings(overrides: Partial<Settings> = {}): Settings {
  return {
    ...DEFAULT_SETTINGS,
    categories: categories.map(category => ({ ...category })),
    provider: 'openai-compatible',
    baseUrl: 'https://ai.example.test/v1',
    apiKey: 'test-key-do-not-log',
    model: 'test-model',
    aiBatchSize: 20,
    requestDelayMs: 0,
    cooldownMs: 5000,
    maxRetries: 2,
    confidenceThreshold: 0.7,
    ...overrides,
  };
}

describe('validateCategories', () => {
  it('trims category names and descriptions and keeps one uncertain category', () => {
    expect(validateCategories([
      { name: ' 电影 ', description: ' 完整电影作品 ' },
      { name: ' 不确定 ', description: ' 信息不足 ' },
    ])).toEqual([
      { name: '电影', description: '完整电影作品' },
      { name: '不确定', description: '信息不足' },
    ]);
  });

  it.each([
    ['non-array', null],
    ['empty', []],
    ['missing uncertain', [{ name: '电影', description: '作品' }]],
    ['duplicate uncertain', [
      { name: '不确定', description: '一个' },
      { name: ' 不确定 ', description: '另一个' },
    ]],
    ['duplicate trimmed name', [
      { name: '电影', description: '一个' },
      { name: ' 电影 ', description: '另一个' },
      { name: '不确定', description: '保留类' },
    ]],
    ['empty description', [
      { name: '电影', description: ' ' },
      { name: '不确定', description: '保留类' },
    ]],
    ['missing description', [
      { name: '电影' },
      { name: '不确定', description: '保留类' },
    ]],
    ['unsafe prototype name', [
      { name: '__proto__', description: '非法类' },
      { name: '不确定', description: '保留类' },
    ]],
    ['unsafe constructor name', [
      { name: 'constructor', description: '非法类' },
      { name: '不确定', description: '保留类' },
    ]],
    ['unsafe prototype name', [
      { name: 'prototype', description: '非法类' },
      { name: '不确定', description: '保留类' },
    ]],
  ])('rejects %s category data', (_label, input) => {
    expect(() => validateCategories(input)).toThrow(AppError);
  });
});

describe('parseClassification', () => {
  it('maps invalid category, invalid confidence, low confidence and missing aid to uncertain', () => {
    const videos = [video(1), video(2), video(3), video(4)];
    const raw = JSON.stringify([
      { aid: 1, category: '不存在', confidence: 0.99 },
      { aid: 2, category: '电影', confidence: '0.99' },
      { aid: 3, category: '知识', confidence: 0.69 },
    ]);

    expect(parseClassification(raw, videos, categories, 0.7).map(result => result.category))
      .toEqual(['不确定', '不确定', '不确定', '不确定']);
  });

  it('uses the first result for a duplicate aid and ignores foreign aids', () => {
    const parsed = parseClassification(JSON.stringify([
      { aid: 1, category: '电影', confidence: 0.8, reason: 'first' },
      { aid: 1, category: '知识', confidence: 1, reason: 'second' },
      { aid: 999, category: '知识', confidence: 1 },
    ]), [video(1), video(2)], categories, 0.7);

    expect(parsed).toEqual([
      expect.objectContaining({ aid: 1, category: '电影', confidence: 0.8, reason: 'first' }),
      expect.objectContaining({ aid: 2, category: '不确定' }),
    ]);
    expect(parsed).toHaveLength(2);
  });

  it('does not let a later duplicate repair an invalid first result', () => {
    const parsed = parseClassification(JSON.stringify([
      { aid: 1, category: '未知', confidence: 1 },
      { aid: 1, category: '电影', confidence: 1 },
    ]), [video(1)], categories, 0.7);
    expect(parsed[0].category).toBe('不确定');
  });

  it('clamps real numeric confidence and accepts fenced arrays with brackets in strings and trailing commas', () => {
    const raw = '```json\n[ {"aid":1,"category":"电影","confidence":1.4,' +
      '"reason":"说明含 }、] 和逗号, 都属于字符串",}, ]\n```';
    const parsed = parseClassification(raw, [video(1)], categories, 0.7);
    expect(parsed[0]).toMatchObject({
      aid: 1, category: '电影', confidence: 1,
      reason: '说明含 }、] 和逗号, 都属于字符串',
    });
  });

  it('accepts a JSON object wrapper and turns malformed JSON into uncertain results', () => {
    expect(parseClassification(JSON.stringify({ results: [
      { aid: 1, category: '知识', confidence: 0.91 },
    ] }), [video(1)], categories, 0.7)[0].category).toBe('知识');

    expect(parseClassification('[{"aid":1,"category":"电影",]', [video(1)], categories, 0.7)[0])
      .toMatchObject({ category: '不确定', confidence: 0 });
  });

  it('keeps unavailable videos uncertain even if a model result is supplied', () => {
    const parsed = parseClassification(JSON.stringify([
      { aid: 1, category: '电影', confidence: 1 },
    ]), [video(1, { unavailable: true })], categories, 0.7);
    expect(parsed[0]).toMatchObject({ category: '不确定', reason: '视频不可用' });
  });
});

describe('classifyDataset', () => {
  it('sends every requested metadata field and no source folder metadata', async () => {
    const item = video(17, {
      title: '完整标题', description: '完整简介', tags: ['tag-a', 'tag-b', 'tag-c'],
      tname: '影视分区', tid: 11, tidV2: 22, upper: { mid: 33, name: '作者' }, duration: 1234,
      sourceFolderIds: [98765], primarySourceFolderId: 98765,
    });
    let receivedSystem = '';
    let receivedUser = '';
    const provider: AIProvider = {
      async complete(system, user) {
        receivedSystem = system;
        receivedUser = user;
        return JSON.stringify([{ aid: 17, category: '电影', confidence: 0.9 }]);
      },
    };

    const manifest = await classifyDataset(dataset([item]), settings(), {}, provider);
    const serializedVideos = receivedUser.slice(receivedUser.indexOf('videos = ') + 'videos = '.length);
    const sent = JSON.parse(serializedVideos) as Array<Record<string, unknown>>;
    expect(sent[0]).toMatchObject({
      aid: 17, title: '完整标题', description: '完整简介', tags: ['tag-a', 'tag-b', 'tag-c'],
      tname: '影视分区', tid: 11, tidV2: 22, upper: { mid: 33, name: '作者' }, duration: 1234,
    });
    expect(receivedUser).not.toContain('sourceFolderIds');
    expect(receivedUser).not.toContain('primarySourceFolderId');
    expect(receivedUser).not.toContain('98765');
    expect(receivedSystem).toContain('ALLOWED_CATEGORIES');
    expect(receivedSystem).toContain('"name": "电影"');
    expect(receivedSystem).toContain('完整电影作品');
    expect(receivedSystem).toContain('严格 JSON 数组');
    expect(manifest.prompt).toBe(receivedSystem);
    expect(manifest).toMatchObject({
      datasetVersion: 3,
      datasetUpdatedAt: '2026-09-27T18:30:00.000Z',
      promptVersion: 1,
      results: [expect.objectContaining({ aid: 17, category: '电影', confidence: 0.9 })],
    });
    expect(manifest.stats).toEqual({ 电影: 1, 知识: 0, 不确定: 0 });
  });

  it('does not call the provider for unavailable videos and records them as uncertain', async () => {
    const complete = vi.fn(async () => '[]');
    const manifest = await classifyDataset(
      dataset([video(18, { unavailable: true })]), settings(), {}, { complete },
    );

    expect(complete).not.toHaveBeenCalled();
    expect(manifest.results[0]).toMatchObject({ aid: 18, category: '不确定', reason: '视频不可用' });
    expect(manifest.stats).toEqual({ 电影: 0, 知识: 0, 不确定: 1 });
  });

  it('bounds batch retries and makes every item in the exhausted batch uncertain', async () => {
    const complete = vi.fn(async () => {
      throw new AppError('sensitive body and key must not escape', 'rate-limit', 429, true);
    });
    const waits: number[] = [];
    const logs: string[] = [];
    const hooks: RuntimeHooks = {
      sleep: async ms => { waits.push(ms); },
      log: message => { logs.push(message); },
    };
    const config = settings({ maxRetries: 2, cooldownMs: 5000 });

    const manifest = await classifyDataset(dataset([video(19)]), config, hooks, { complete });
    expect(complete).toHaveBeenCalledTimes(3);
    expect(waits).toHaveLength(2);
    expect(waits.every(ms => ms >= config.cooldownMs)).toBe(true);
    expect(manifest.results[0]).toMatchObject({ aid: 19, category: '不确定' });
    expect(manifest.stats).toEqual({ 电影: 0, 知识: 0, 不确定: 1 });
    expect(logs.join('\n')).not.toContain('sensitive body');
    expect(logs.join('\n')).not.toContain(config.apiKey);
    expect(logs.join('\n')).not.toContain(config.baseUrl);
    expect(logs.some(message => message.includes('失败') && message.includes('重试 2 次'))).toBe(true);
  });

  it('rejects missing credentials for the real provider before starting classification', async () => {
    const log = vi.fn();
    await expect(classifyDataset(
      dataset([video(21)]), settings({ model: '' }), { log }, defaultAIProvider,
    )).rejects.toThrow(AppError);
    expect(log).not.toHaveBeenCalled();
  });

  it('deduplicates dataset aids and uses injected time and checkpoints', async () => {
    const checkpoint = vi.fn();
    const fixedDate = new Date('2026-09-28T08:00:00.000Z');
    const manifest = await classifyDataset(
      dataset([video(20), video(20, { title: 'duplicate' })]),
      settings(),
      { checkpoint, now: () => fixedDate },
      { complete: async () => '[{"aid":20,"category":"知识","confidence":0.8}]' },
    );
    expect(manifest.results).toHaveLength(1);
    expect(manifest.createdAt).toBe(fixedDate.toISOString());
    expect(checkpoint).toHaveBeenCalled();
  });
});

describe('OpenAI-compatible request builder', () => {
  it('keeps the API key in the Authorization header and makes anonymous GM requests', () => {
    const config = settings();
    const request = buildAIRequest('system', 'user', config);
    expect(request.url).toBe('https://ai.example.test/v1/chat/completions');
    expect(new URL(request.url).search).toBe('');
    expect(request.headers.Authorization).toBe(`Bearer ${config.apiKey}`);
    expect(request.anonymous).toBe(true);
    expect(JSON.parse(request.body)).toMatchObject({
      model: config.model,
      messages: [{ role: 'system', content: 'system' }, { role: 'user', content: 'user' }],
    });
  });

  it('rejects base URLs containing query credentials', () => {
    expect(() => buildAIRequest('system', 'user', settings({ baseUrl: 'https://ai.example.test/v1?key=secret' })))
      .toThrow(AppError);
  });
});
