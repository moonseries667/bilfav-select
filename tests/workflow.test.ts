import { describe, expect, it, vi } from 'vitest';
import { createInitialData } from '../src/lib/storage';
import { AppError, PauseError } from '../src/lib/errors';
import { DEFAULT_SETTINGS } from '../src/defaults';
import { Workflow } from '../src/core/workflow';
import { UNCERTAIN, type AppData, type BilibiliAdapter, type ClassificationManifest, type Folder, type FolderId, type FolderVideo, type Repository, type Settings, type VideoMetadata } from '../src/types';

class MemoryRepository implements Repository {
  value: AppData;
  constructor(value = createInitialData()) { this.value = structuredClone(value); }
  load(): AppData { return structuredClone(this.value); }
  save(data: AppData): void { this.value = structuredClone(data); }
}

class FakeAdapter implements BilibiliAdapter {
  userMid = 700;
  folders: Folder[] = [
    { id: 1, title: '默认收藏夹', mediaCount: 0, isDefault: true },
    { id: 10, title: '待看', mediaCount: 2, isDefault: false },
    { id: 11, title: '待看视频-旧', mediaCount: 2, isDefault: false },
  ];
  videos = new Map<number, FolderVideo[]>([
    [10, [{ aid: 101, title: '片一' }, { aid: 102, title: '片二' }]],
    [11, [{ aid: 102, title: '片二' }, { aid: 103, title: '片三' }]],
  ]);
  metadata = new Map<number, VideoMetadata>();
  folderAids = new Map<number, Set<number>>([[1, new Set()], [10, new Set([101, 102])], [11, new Set([102, 103])]]);
  renamed: Array<{ id: number; title: string }> = [];
  deleted: number[] = [];
  created: number[] = [];
  copies: Array<{ source: number; target: number; aids: number[] }> = [];
  nextId = 50;
  renameFailure?: number;
  metadataFailure?: { aid: number; error: Error };
  pauseNextCopy = false;
  dropOnce = new Set<number>();
  missingFromSourceAfterCopy?: number;
  unavailableAids = new Set<number>();

  isVideoUnavailable(aid: number): boolean { return this.unavailableAids.has(aid); }

  async getCurrentUser(): Promise<{ mid: number; name: string }> { return { mid: this.userMid, name: 'tester' }; }
  async listFolders(): Promise<Folder[]> { return this.folders.map(folder => ({ ...folder })); }
  async renameFolder(id: FolderId, title: string): Promise<void> {
    if (this.renameFailure === id) throw new AppError('rename interrupted', 'network', undefined, true);
    const folder = this.folders.find(item => item.id === id);
    if (!folder) throw new AppError('missing folder', 'invalid');
    folder.title = title;
    this.renamed.push({ id, title });
  }
  async createFolder(title: string): Promise<Folder> {
    const folder = { id: this.nextId++, title, mediaCount: 0, isDefault: false };
    this.folders.push(folder);
    this.folderAids.set(folder.id, new Set());
    this.created.push(folder.id);
    return { ...folder };
  }
  async deleteFolder(id: FolderId): Promise<void> {
    const folder = this.folders.find(item => item.id === id);
    if (!folder || folder.isDefault) throw new AppError('cannot delete', 'safety');
    this.folders = this.folders.filter(item => item.id !== id);
    this.folderAids.delete(id);
    this.videos.delete(id);
    this.deleted.push(id);
  }
  async listFolderVideos(id: FolderId): Promise<FolderVideo[]> {
    if (!this.folders.some(folder => folder.id === id)) throw new AppError('missing source', 'safety');
    return (this.videos.get(id) ?? []).map(video => ({ ...video }));
  }
  async getVideoMetadata(aid: number, bvid?: string): Promise<VideoMetadata> {
    if (this.metadataFailure?.aid === aid) throw this.metadataFailure.error;
    return this.metadata.get(aid) ?? { aid, bvid, title: `视频${aid}`, description: '简介', tags: ['完整标签A', '完整标签B'], tname: '动画', tid: 1, tidV2: 2, upper: { mid: 8, name: 'UP' }, duration: 90 };
  }
  async copyVideos(sourceId: FolderId, targetId: FolderId, aids: number[]): Promise<void> {
    if (this.pauseNextCopy) { this.pauseNextCopy = false; throw new PauseError(); }
    this.copies.push({ source: sourceId, target: targetId, aids: [...aids] });
    const source = this.folderAids.get(sourceId);
    const target = this.folderAids.get(targetId);
    if (!source || !target) throw new AppError('missing folder', 'invalid');
    for (const aid of aids) {
      if (this.dropOnce.delete(aid)) continue;
      target.add(aid);
    }
    if (this.missingFromSourceAfterCopy !== undefined) source.delete(this.missingFromSourceAfterCopy);
  }
  async getFolderAidSet(id: FolderId): Promise<Set<number>> {
    const set = this.folderAids.get(id);
    if (!set) throw new AppError(`folder ${id} missing`, 'safety');
    return new Set(set);
  }
}

const settings = (overrides: Partial<Settings> = {}): Settings => ({
  ...structuredClone(DEFAULT_SETTINGS), copyBatchSize: 10, requestDelayMs: 0, cooldownMs: 0,
  maxRetries: 0, verifyRetries: 0, ...overrides,
});

async function frozenDataset(adapter = new FakeAdapter(), repo = new MemoryRepository()) {
  const workflow = new Workflow(adapter, repo, { sleep: async () => undefined });
  await workflow.freezeSources();
  const dataset = await workflow.refreshDataset(true);
  return { adapter, repo, workflow, dataset };
}

function makeManifest(dataset: NonNullable<AppData['dataset']>, categories: string[], runId = 'run-one'): ClassificationManifest {
  const names = [...new Set([UNCERTAIN, ...categories])];
  const results = dataset.videos.map((video, index) => ({
    aid: video.aid, category: categories[index % categories.length] ?? UNCERTAIN, confidence: 0.95,
  }));
  return {
    version: 1, runId, createdAt: '2026-09-28T00:00:00.000Z', datasetVersion: dataset.version,
    datasetUpdatedAt: dataset.updatedAt, categories: names.map(name => ({ name, description: name })),
    confidenceThreshold: 0.7, promptVersion: 1, prompt: 'test', results, stats: {},
  };
}

describe('Workflow source freeze and dataset refresh', () => {
  it('freezes only non-default folders once and keeps already suffixed folders', async () => {
    const adapter = new FakeAdapter();
    const repo = new MemoryRepository();
    const workflow = new Workflow(adapter, repo);
    await workflow.freezeSources();
    expect(workflow.data.state.sourceFolderIds).toEqual([10, 11]);
    expect(adapter.renamed).toEqual([{ id: 10, title: '待看-旧' }]);
    expect(workflow.data.state.sourceFoldersSnapshot.map(folder => folder.originalTitle)).toEqual(['待看', '待看视频-旧']);

    adapter.folders.push({ id: 12, title: '电影', mediaCount: 0, isDefault: false });
    await workflow.freezeSources();
    expect(workflow.data.state.sourceFolderIds).toEqual([10, 11]);
    expect(adapter.renamed).toHaveLength(1);
    expect(adapter.folders.find(folder => folder.id === 12)?.title).toBe('电影');
  });

  it('resumes a partial freeze using its persisted IDs and ignores folders added later', async () => {
    const adapter = new FakeAdapter();
    const repo = new MemoryRepository();
    adapter.renameFailure = 10;
    await expect(new Workflow(adapter, repo).freezeSources()).rejects.toThrow('rename interrupted');
    expect(repo.value.state.freezePending).toBe(true);
    expect(repo.value.state.sourceFolderIds).toEqual([10, 11]);

    adapter.renameFailure = undefined;
    adapter.folders.push({ id: 12, title: '后来创建', mediaCount: 0, isDefault: false });
    await new Workflow(adapter, repo).freezeSources();
    expect(repo.value.state.sourceFolderIds).toEqual([10, 11]);
    expect(adapter.renamed.some(item => item.id === 12)).toBe(false);
    expect(adapter.folders.find(folder => folder.id === 12)?.title).toBe('后来创建');
  });

  it('does not refresh or apply while a partial freeze is pending', async () => {
    const adapter = new FakeAdapter();
    const repo = new MemoryRepository();
    adapter.renameFailure = 10;
    const partial = new Workflow(adapter, repo);
    await expect(partial.freezeSources()).rejects.toThrow('rename interrupted');
    await expect(partial.refreshDataset()).rejects.toThrow('尚未完成冻结');
    const manifest = {
      version: 1, runId: 'pending', createdAt: '2026-09-28T00:00:00.000Z', datasetVersion: 1,
      datasetUpdatedAt: '2026-09-28T00:00:00.000Z', categories: [{ name: UNCERTAIN, description: '' }],
      confidenceThreshold: 0.7, promptVersion: 1, prompt: '', results: [], stats: {},
    } as ClassificationManifest;
    await expect(partial.applyManifest(manifest, settings())).rejects.toThrow('尚未完成冻结');
    expect(repo.value.state.sourceFrozen).toBe(false);
    expect(adapter.deleted).toEqual([]);
  });

  it('validates sources by ID after a manual rename and rejects a same-name replacement', async () => {
    const { adapter, workflow } = await frozenDataset();
    adapter.folders.find(folder => folder.id === 10)!.title = '用户后来改名';
    expect((await workflow.validateSources()).map(folder => folder.id)).toEqual([10, 11]);
    adapter.folders = adapter.folders.filter(folder => folder.id !== 10);
    adapter.folders.push({ id: 99, title: '用户后来改名', mediaCount: 2, isDefault: false });
    await expect(workflow.validateSources()).rejects.toThrow('不会按名称替换');
  });

  it('rejects a different signed-in owner before source access', async () => {
    const { adapter, workflow } = await frozenDataset();
    adapter.userMid = 701;
    await expect(workflow.validateSources()).rejects.toThrow('不一致');
  });

  it('deduplicates aid values, merges source IDs, and chooses the first containing source', async () => {
    const { dataset } = await frozenDataset();
    expect(dataset.videos.map(video => video.aid)).toEqual([101, 102, 103]);
    const shared = dataset.videos.find(video => video.aid === 102)!;
    expect(shared.sourceFolderIds).toEqual([10, 11]);
    expect(shared.primarySourceFolderId).toBe(10);
    expect(dataset.videos[0].tags).toEqual(['完整标签A', '完整标签B']);
    expect(dataset.videos[0].upper).toEqual({ mid: 8, name: 'UP' });
  });

  it('skips an unavailable video without blocking other metadata and excludes its aid from the dataset and copies', async () => {
    const adapter = new FakeAdapter();
    adapter.metadataFailure = { aid: 102, error: new AppError('视频不可用', 'unavailable') };
    const { workflow, dataset } = await frozenDataset(adapter);
    expect(dataset.videos.map(video => video.aid)).toEqual([101, 103]);
    const manifest = makeManifest(dataset, ['电影']);
    const report = await workflow.applyManifest(manifest, settings());
    expect(report.passed).toBe(true);
    expect(report.total).toBe(2);
    expect(adapter.copies.flatMap(copy => copy.aids)).not.toContain(102);
  });

  it('never requests metadata for a list-marked unavailable aid even when another source lists it as available', async () => {
    const adapter = new FakeAdapter();
    adapter.videos.get(11)![0].unavailable = true;
    const getMetadata = vi.spyOn(adapter, 'getVideoMetadata');
    const { dataset } = await frozenDataset(adapter);
    expect(dataset.videos.map(video => video.aid)).toEqual([101, 103]);
    expect(getMetadata.mock.calls.map(call => call[0])).toEqual([101, 103]);
  });

  it('omits metadata marked unavailable from the dataset', async () => {
    const adapter = new FakeAdapter();
    adapter.metadata.set(102, { aid: 102, title: 'gone', description: '', tags: [], unavailable: true });
    expect((await frozenDataset(adapter)).dataset.videos.map(video => video.aid)).toEqual([101, 103]);
  });

  it('uses fresh metadata cache when allowed and force refreshes details', async () => {
    const adapter = new FakeAdapter();
    const workflow = new Workflow(adapter, new MemoryRepository(), { now: () => new Date('2026-09-28T00:00:00.000Z') });
    await workflow.freezeSources();
    const first = await workflow.refreshDataset(true);
    const firstCalls = first.videos.length;
    const original = adapter.getVideoMetadata.bind(adapter);
    let calls = 0;
    adapter.getVideoMetadata = async (...args) => { calls++; return original(...args); };
    await workflow.refreshDataset(false, 86400000);
    expect(calls).toBe(0);
    await workflow.refreshDataset(true);
    expect(calls).toBe(firstCalls);
  });

  it('does not reuse fresh metadata once the adapter has confirmed the aid unavailable', async () => {
    const adapter = new FakeAdapter();
    let now = new Date('2026-09-28T00:00:00.000Z');
    const workflow = new Workflow(adapter, new MemoryRepository(), { now: () => now });
    await workflow.freezeSources();
    await workflow.refreshDataset(true);
    // Force a new list scan while the individual metadata is still within TTL.
    workflow.data.dataset!.updatedAt = '2026-09-26T00:00:00.000Z';
    now = new Date('2026-09-28T01:00:00.000Z');
    adapter.unavailableAids.add(102);
    const getMetadata = vi.spyOn(adapter, 'getVideoMetadata');
    const refreshed = await workflow.refreshDataset(false, 86400000);
    expect(refreshed.videos.map(video => video.aid)).toEqual([101, 103]);
    expect(getMetadata).not.toHaveBeenCalled();
  });

  it('preserves the last good dataset when a transient metadata request fails', async () => {
    const adapter = new FakeAdapter();
    const { workflow, dataset } = await frozenDataset(adapter);
    adapter.metadataFailure = { aid: 102, error: new AppError('network down', 'network', undefined, true) };
    await expect(workflow.refreshDataset(true)).rejects.toThrow('network down');
    expect(workflow.data.dataset).toEqual(dataset);
  });

  it('does not treat a metadata schema error as an unavailable video', async () => {
    const adapter = new FakeAdapter();
    const { workflow, dataset } = await frozenDataset(adapter);
    adapter.metadataFailure = { aid: 102, error: new AppError('unexpected metadata shape', 'invalid') };
    await expect(workflow.refreshDataset(true)).rejects.toThrow('unexpected metadata shape');
    expect(workflow.data.dataset).toEqual(dataset);
    expect(workflow.data.dataset?.videos.some(video => video.unavailable)).toBe(false);
  });
});

describe('Workflow generated-folder safety, apply, and resume', () => {
  it('skips legacy unavailable results and creates no category solely for them, including after resume', async () => {
    const { adapter, repo, workflow, dataset } = await frozenDataset();
    dataset.videos.find(video => video.aid === 102)!.unavailable = true;
    adapter.folderAids.get(10)!.delete(102);
    adapter.folderAids.get(11)!.delete(102);
    const manifest = makeManifest(dataset, ['电影', UNCERTAIN, '电影']);
    adapter.pauseNextCopy = true;
    await expect(workflow.applyManifest(manifest, settings())).rejects.toBeInstanceOf(PauseError);
    // Old versions may have captured unavailable aids in their source snapshot.
    repo.value.state.execution.sourceBefore['10'].push(102);
    const resumed = new Workflow(adapter, repo, { sleep: async () => undefined });
    const report = await resumed.resume(settings());
    expect(report.passed).toBe(true);
    expect(report.total).toBe(2);
    expect(report.uncertain).toBe(0);
    expect(Object.keys(resumed.data.state.generatedFolderIds)).toEqual(['电影']);
    expect(adapter.copies.flatMap(copy => copy.aids)).toEqual([101, 103]);
    expect(resumed.data.manifest?.results.map(result => result.aid)).toEqual([101, 102, 103]);
  });

  it('excludes a video confirmed unavailable after refresh from cached-manifest apply', async () => {
    const { adapter, workflow, dataset } = await frozenDataset();
    adapter.unavailableAids.add(102);
    adapter.folderAids.get(10)!.delete(102);
    adapter.folderAids.get(11)!.delete(102);
    const report = await workflow.applyManifest(makeManifest(dataset, ['电影', UNCERTAIN, '电影']), settings());
    expect(report.passed).toBe(true);
    expect(report.total).toBe(2);
    expect(Object.keys(workflow.data.state.generatedFolderIds)).toEqual(['电影']);
    expect(adapter.copies.flatMap(copy => copy.aids)).toEqual([101, 103]);
  });

  it('prevalidates every cleanup ID so source and default folders cannot be deleted', async () => {
    const { adapter, workflow } = await frozenDataset();
    workflow.data.state.generatedFolderIds = { badSource: 10, badDefault: 1 };
    await expect(workflow.cleanupGenerated()).rejects.toThrow('与冻结源 ID 冲突');
    expect(adapter.deleted).toEqual([]);
    expect(adapter.folders.some(folder => folder.id === 1)).toBe(true);
  });

  it('cleans only recorded generated IDs and leaves manually created folders untouched', async () => {
    const { adapter, workflow, dataset } = await frozenDataset();
    const manifest = makeManifest(dataset, ['电影']);
    await workflow.applyManifest(manifest, settings());
    const generatedId = workflow.data.state.generatedFolderIds['电影'];
    const manual = await adapter.createFolder('手工分类');
    await workflow.cleanupGenerated();
    expect(adapter.deleted).toEqual([generatedId]);
    expect(adapter.folders.some(folder => folder.id === manual.id)).toBe(true);
    expect(adapter.folders.some(folder => folder.id === 10 || folder.id === 11 || folder.id === 1)).toBe(true);
  });

  it('pauses durably during copy and resumes without recreating targets or deleting sources', async () => {
    const adapter = new FakeAdapter();
    const repo = new MemoryRepository();
    const { workflow, dataset } = await frozenDataset(adapter, repo);
    const manifest = makeManifest(dataset, ['电影']);
    adapter.pauseNextCopy = true;
    await expect(workflow.applyManifest(manifest, settings())).rejects.toBeInstanceOf(PauseError);
    expect(repo.value.state.execution.phase).toBe('paused');
    expect(repo.value.state.execution.resumePhase).toBe('copying');
    const targetIds = { ...repo.value.state.execution.targetFolderIds };
    const createdCount = adapter.created.length;
    const deletedCount = adapter.deleted.length;

    const resumed = new Workflow(adapter, repo, { sleep: async () => undefined });
    const report = await resumed.resume(settings());
    expect(report.passed).toBe(true);
    expect(resumed.data.state.execution.targetFolderIds).toEqual(targetIds);
    expect(adapter.created).toHaveLength(createdCount);
    expect(adapter.deleted).toHaveLength(deletedCount);
    expect(adapter.folders.some(folder => folder.id === 10 || folder.id === 11)).toBe(true);
  });

  it('rejects a changed manifest hash without altering the saved execution or targets', async () => {
    const adapter = new FakeAdapter();
    const repo = new MemoryRepository();
    const { workflow, dataset } = await frozenDataset(adapter, repo);
    const manifest = makeManifest(dataset, ['电影']);
    await workflow.applyManifest(manifest, settings());
    const before = structuredClone(workflow.data.state.execution);
    const foldersBefore = adapter.folders.map(folder => folder.id);
    workflow.data.manifest = { ...manifest, prompt: 'changed' };
    await expect(workflow.resume(settings())).rejects.toThrow('Manifest 与中断任务不一致');
    expect(workflow.data.state.execution).toEqual(before);
    expect(adapter.folders.map(folder => folder.id)).toEqual(foldersBefore);
    expect(adapter.deleted).toEqual([]);
  });

  it('retryFailed resumes a paused cleanup phase before creating targets or copying', async () => {
    const adapter = new FakeAdapter();
    const repo = new MemoryRepository();
    let checkpoints = 0;
    const { workflow, dataset } = await frozenDataset(adapter, repo);
    const oldFolder = await adapter.createFolder('old generated');
    workflow.data.state.generatedFolderIds = { old: oldFolder.id };
    repo.save(workflow.data);
    const manifest = makeManifest(dataset, ['电影']);
    const pausing = new Workflow(adapter, repo, {
      checkpoint: () => { checkpoints++; if (checkpoints === 3) throw new PauseError(); },
      sleep: async () => undefined,
    });
    await expect(pausing.applyManifest(manifest, settings())).rejects.toBeInstanceOf(PauseError);
    expect(repo.value.state.execution.resumePhase).toBe('cleanup');
    expect(adapter.folders.some(folder => folder.id === oldFolder.id)).toBe(true);

    const report = await pausing.retryFailed(settings());
    expect(report.passed).toBe(true);
    expect(adapter.folders.some(folder => folder.id === oldFolder.id)).toBe(false);
    expect(pausing.data.state.execution.phase).toBe('completed');
  });

  it('rebuilds a second manifest by ID without leaving old generated folders or touching manual folders', async () => {
    const { adapter, workflow, dataset } = await frozenDataset();
    const manual = await adapter.createFolder('手工收藏');
    const first = makeManifest(dataset, ['电影']);
    await workflow.applyManifest(first, settings());
    const firstGenerated = Object.values(workflow.data.state.generatedFolderIds);
    const second = makeManifest(dataset, [UNCERTAIN], 'run-two');
    const secondReport = await workflow.applyManifest(second, settings());
    expect(secondReport.passed).toBe(true);
    expect(firstGenerated.every(id => !adapter.folders.some(folder => folder.id === id))).toBe(true);
    expect(Object.keys(workflow.data.state.generatedFolderIds)).toEqual([UNCERTAIN]);
    expect(adapter.folders.some(folder => folder.id === manual.id)).toBe(true);
    expect(adapter.deleted).toEqual(firstGenerated);
  });

  it('clears the old successful report after explicit generated-folder cleanup', async () => {
    const { workflow, dataset } = await frozenDataset();
    await workflow.applyManifest(makeManifest(dataset, ['电影']), settings());
    expect(workflow.data.state.execution.verification?.passed).toBe(true);
    await workflow.cleanupGenerated();
    expect(workflow.data.state.generatedFolderIds).toEqual({});
    expect(workflow.data.state.execution.phase).toBe('idle');
    expect(workflow.data.state.execution.verification).toBeUndefined();
    expect(workflow.data.manifest).toBeDefined();
  });

  it('retries a one-time missing copy and finishes with a verified report', async () => {
    const adapter = new FakeAdapter();
    adapter.dropOnce.add(101);
    const { workflow, dataset } = await frozenDataset(adapter);
    const report = await workflow.applyManifest(makeManifest(dataset, ['电影']), settings({ verifyRetries: 1 }));
    expect(report.passed).toBe(true);
    expect(report.failed).toBe(0);
    expect(adapter.folderAids.get(workflow.data.state.generatedFolderIds['电影'])?.has(101)).toBe(true);
    expect(adapter.copies.some(copy => copy.aids.includes(101))).toBe(true);
  });
});
