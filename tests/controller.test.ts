import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import { DEFAULT_SETTINGS } from '../src/defaults';
import legacyPrompt from '../src/prompts/classifier-legacy.txt?raw';
import formerDefaultPrompt from '../src/prompts/classifier-v1.txt?raw';
import { createInitialData, loadSettings } from '../src/lib/storage';
import { defaultAIProvider } from '../src/ai/provider';
import * as providerModule from '../src/ai/provider';
import * as downloadModule from '../src/lib/download';
import { AppError } from '../src/lib/errors';
import { createController } from '../src/controller';
import type { AppData, ClassificationManifest, Repository, Settings } from '../src/types';

const { apply } = vi.hoisted(() => ({ apply: vi.fn(async () => undefined) }));
vi.mock('../src/core/workflow', () => ({
  Workflow: class {
    data: AppData;
    applyManifest = apply;
    constructor(_adapter: unknown, repository: Repository) { this.data = repository.load(); }
  },
}));

const dataKey = 'bilfav-select:data:v1';
const settingsKey = 'bilfav-select:settings:v1';
let values: Map<string, unknown>;
let config: Settings;

beforeEach(() => {
  apply.mockClear();
  values = new Map();
  config = { ...structuredClone(DEFAULT_SETTINGS), model: 'test-model', baseUrl: 'https://ai.example/v1',
    apiKey: 'private-test-key', aiBatchSize: 1, maxRetries: 0, requestDelayMs: 500 };
  const data = createInitialData();
  data.state.sourceFrozen = true;
  data.state.sourceFolderIds = [10];
  data.state.generatedFolderIds = { '上一轮': 20 };
  data.dataset = { version: 1, updatedAt: '2026-09-28T00:00:00.000Z', sourceFolderIds: [10],
    videos: [1, 2].map(aid => ({ aid, title: 'MMD', description: '模型成片', tags: ['MMD'],
      sourceFolderIds: [10], primarySourceFolderId: 10, metadataFetchedAt: '2026-09-28T00:00:00.000Z' })) };
  data.manifest = { version: 1, runId: 'old-run', createdAt: data.dataset.updatedAt,
    datasetVersion: 1, datasetUpdatedAt: data.dataset.updatedAt, categories: config.categories,
    confidenceThreshold: 0.7, promptVersion: 1, prompt: 'old prompt',
    results: [1, 2].map(aid => ({ aid, category: 'MMD', confidence: 0.9 })), stats: { MMD: 2 } };
  values.set(dataKey, data);
  values.set(settingsKey, config);
  vi.stubGlobal('GM_getValue', (key: string, fallback: unknown) => structuredClone(values.get(key) ?? fallback));
  vi.stubGlobal('GM_setValue', (key: string, value: unknown) => { values.set(key, structuredClone(value)); });
  vi.spyOn(providerModule, 'fetchModels').mockResolvedValue(['test-model', 'other-model']);
});

async function fetchModels(controller: ReturnType<typeof createController>): Promise<void> { await controller.fetchModels(config); }

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('classification before folder rebuilding', () => {
  it('keeps the old manifest and generated folder IDs after failure, then resumes across a controller reload', async () => {
    const calls: number[] = [];
    let fail = true;
    vi.spyOn(defaultAIProvider, 'complete').mockImplementation(async (_system, user) => {
      const aid = JSON.parse(user.slice(user.indexOf('videos = ') + 9))[0].aid;
      calls.push(aid);
      if (aid === 2 && fail) throw new AppError('temporary failure', 'network', undefined, true);
      return JSON.stringify([{ aid, category: 'MMD', confidence: 0.9 }]);
    });
    const controller = createController();
    await fetchModels(controller);
    await controller.classifyApply();
    expect(apply).not.toHaveBeenCalled();
    expect(get(controller.view).data.manifest?.runId).toBe('old-run');
    expect(get(controller.view).data.state.generatedFolderIds).toEqual({ '上一轮': 20 });
    expect(get(controller.view).data.classificationDraft?.results.map(result => result.aid)).toEqual([1]);
    expect(JSON.stringify(values.get(dataKey))).not.toContain(config.apiKey);

    fail = false;
    const reloaded = createController();
    await fetchModels(reloaded);
    await reloaded.resumeClassification();
    expect(calls).toEqual([1, 2, 2]);
    expect(apply).toHaveBeenCalledTimes(1);
    expect((apply.mock.calls[0] as unknown as [ClassificationManifest])[0].results).toHaveLength(2);
    expect(get(reloaded.view).data.classificationDraft).toBeUndefined();
    expect(get(reloaded.view).data.manifest?.runId).not.toBe('old-run');
  });

  it('blocks malformed output and keeps the previous result even when HTTP succeeded', async () => {
    vi.spyOn(defaultAIProvider, 'complete').mockResolvedValue('[]');
    const controller = createController();
    await fetchModels(controller);
    await controller.classifyApply();
    expect(apply).not.toHaveBeenCalled();
    expect(get(controller.view).data.manifest?.runId).toBe('old-run');
    expect(get(controller.view).error).toContain('未完整返回');
  });

  it('requires a freshly listed model from the same connection before classification', async () => {
    const complete = vi.spyOn(defaultAIProvider, 'complete').mockResolvedValue('[]');
    const controller = createController();
    await controller.classifyApply();
    expect(get(controller.view).error).toContain('获取模型列表');
    expect(complete).not.toHaveBeenCalled();
  });

  it('exports persisted detailed logs with the right filename and redacts keys across reload', async () => {
    const download = vi.spyOn(downloadModule, 'downloadJson').mockImplementation(() => undefined);
    const controller = createController();
    await fetchModels(controller);
    controller.exportDetailedLogs();
    expect(download).toHaveBeenCalledWith('bilfav-detailed-logs.json', expect.objectContaining({ truncated: false, events: expect.any(Array) }));
    const payload = download.mock.calls.at(-1)?.[1];
    expect(JSON.stringify(payload)).not.toContain(config.apiKey);
    expect((payload as { events: unknown[] }).events.length).toBeGreaterThan(0);

    const reloaded = createController();
    reloaded.exportDetailedLogs();
    const reloadedPayload = download.mock.calls.at(-1)?.[1] as { events: unknown[] };
    expect(reloadedPayload.events.length).toBeGreaterThan(0);
    expect(JSON.stringify(reloadedPayload)).not.toContain(config.apiKey);
  });

  it('a new run classifies all videos again and snapshots the changed external table', async () => {
    const complete = vi.spyOn(defaultAIProvider, 'complete').mockImplementation(async (_system, user) => {
      const aid = JSON.parse(user.slice(user.indexOf('videos = ') + 9))[0].aid;
      const category = user.includes('"新分类"') ? '新分类' : 'MMD';
      return JSON.stringify([{ aid, category, confidence: 0.9 }]);
    });
    const controller = createController();
    await fetchModels(controller);
    await controller.classifyApply();
    const firstRun = get(controller.view).data.manifest?.runId;
    controller.save({ ...config, categories: [{ name: '新分类', description: '用户的新边界' }] });
    await controller.classifyApply();
    expect(complete).toHaveBeenCalledTimes(4);
    expect(apply).toHaveBeenCalledTimes(2);
    expect(get(controller.view).data.manifest?.runId).not.toBe(firstRun);
    expect(get(controller.view).data.manifest?.categories.map(category => category.name)).toEqual(['新分类', '不确定']);
  });
});

describe('settings upgrade', () => {
  it('migrates the exact former built-in prompt and preserves existing category tables and custom prompts', () => {
    values.set(settingsKey, { ...config, prompt: legacyPrompt });
    expect(loadSettings().prompt).toBe(DEFAULT_SETTINGS.prompt);
    values.set(settingsKey, { ...config, prompt: DEFAULT_SETTINGS.prompt });
    expect(loadSettings().prompt).toBe(DEFAULT_SETTINGS.prompt);
    expect(loadSettings().categories).toEqual(config.categories);
    values.set(settingsKey, { ...config, prompt: legacyPrompt + '\n自定义规则' });
    expect(loadSettings().prompt).toBe(legacyPrompt + '\n自定义规则');
    values.set(settingsKey, { ...config, prompt: formerDefaultPrompt });
    expect(loadSettings().prompt).toBe(DEFAULT_SETTINGS.prompt);
    values.set(settingsKey, { ...config, prompt: formerDefaultPrompt + '\nkeep custom' });
    expect(loadSettings().prompt).toBe(formerDefaultPrompt + '\nkeep custom');
  });
});
