import { describe, expect, it } from 'vitest';
import { Workflow } from '../src/core/workflow';
import { AppError } from '../src/lib/errors';
import { createInitialData } from '../src/lib/storage';
import { DEFAULT_SETTINGS } from '../src/defaults';
import { UNCERTAIN, type AppData, type BilibiliAdapter, type ClassificationManifest, type Folder, type FolderId, type FolderVideo, type Repository, type Settings, type VideoMetadata } from '../src/types';

class MemoryRepository implements Repository {
  value: AppData = createInitialData();
  load(): AppData { return structuredClone(this.value); }
  save(data: AppData): void { this.value = structuredClone(data); }
}

class VerifyAdapter implements BilibiliAdapter {
  folders: Folder[] = [
    { id: 1, title: '默认', mediaCount: 0, isDefault: true },
    { id: 10, title: '源-旧', mediaCount: 3, isDefault: false },
  ];
  sourceVideos: FolderVideo[] = [101, 102, 103].map(aid => ({ aid, title: `视频${aid}` }));
  aids = new Map<number, Set<number>>([[1, new Set()], [10, new Set([101, 102, 103])]]);
  nextId = 20;
  copies: Array<{ source: number; target: number; aids: number[] }> = [];
  dropOnce = new Set<number>();

  async getCurrentUser(): Promise<{ mid: number; name: string }> { return { mid: 88, name: 'verify' }; }
  async listFolders(): Promise<Folder[]> { return this.folders.map(folder => ({ ...folder })); }
  async renameFolder(id: FolderId, title: string): Promise<void> {
    const folder = this.folders.find(value => value.id === id);
    if (!folder) throw new AppError('missing', 'safety');
    folder.title = title;
  }
  async createFolder(title: string): Promise<Folder> {
    const folder = { id: this.nextId++, title, mediaCount: 0, isDefault: false };
    this.folders.push(folder);
    this.aids.set(folder.id, new Set());
    return { ...folder };
  }
  async deleteFolder(id: FolderId): Promise<void> {
    const folder = this.folders.find(value => value.id === id);
    if (!folder || folder.isDefault || id === 10) throw new AppError('protected', 'safety');
    this.folders = this.folders.filter(value => value.id !== id);
    this.aids.delete(id);
  }
  async listFolderVideos(id: FolderId): Promise<FolderVideo[]> {
    if (id !== 10) return [];
    return this.sourceVideos.map(value => ({ ...value }));
  }
  async getVideoMetadata(aid: number, bvid?: string): Promise<VideoMetadata> {
    return { aid, bvid, title: `视频${aid}`, description: '', tags: ['tag-a', 'tag-b'] };
  }
  async copyVideos(sourceId: FolderId, targetId: FolderId, aids: number[]): Promise<void> {
    if (sourceId === 1 || targetId === 1 || sourceId !== 10) throw new AppError('forbidden target/source', 'safety');
    const target = this.aids.get(targetId);
    if (!target) throw new AppError('missing target', 'safety');
    this.copies.push({ source: sourceId, target: targetId, aids: [...aids] });
    for (const aid of aids) if (!this.dropOnce.delete(aid)) target.add(aid);
  }
  async getFolderAidSet(id: FolderId): Promise<Set<number>> {
    const result = this.aids.get(id);
    if (!result) throw new AppError('missing folder', 'safety');
    return new Set(result);
  }
}

const settings = (overrides: Partial<Settings> = {}): Settings => ({
  ...structuredClone(DEFAULT_SETTINGS), requestDelayMs: 0, cooldownMs: 0, maxRetries: 0,
  verifyRetries: 0, ...overrides,
});

async function setup(dropAid?: number) {
  const adapter = new VerifyAdapter();
  if (dropAid !== undefined) adapter.dropOnce.add(dropAid);
  const repository = new MemoryRepository();
  const workflow = new Workflow(adapter, repository, { sleep: async () => undefined });
  await workflow.freezeSources();
  const dataset = await workflow.refreshDataset();
  const manifest: ClassificationManifest = {
    version: 1, runId: 'verify-run', createdAt: '2026-09-28T00:00:00.000Z',
    datasetVersion: dataset.version, datasetUpdatedAt: dataset.updatedAt,
    categories: [{ name: '电影', description: '' }, { name: UNCERTAIN, description: '' }],
    confidenceThreshold: 0.7, promptVersion: 1, prompt: '', stats: {},
    results: [
      { aid: 101, category: '电影', confidence: 0.9 },
      { aid: 102, category: '电影', confidence: 0.9 },
      { aid: 103, category: UNCERTAIN, confidence: 0.2 },
    ],
  };
  return { adapter, repository, workflow, manifest, settings: settings() };
}

describe('Workflow verification', () => {
  it('reports missing, unexpected, and wrong-category aids as set differences', async () => {
    const { adapter, workflow, manifest, settings: config } = await setup();
    await workflow.applyManifest(manifest, config);
    const movieId = workflow.data.state.generatedFolderIds['电影'];
    const uncertainId = workflow.data.state.generatedFolderIds[UNCERTAIN];
    const movie = adapter.aids.get(movieId)!;
    movie.delete(101);
    movie.add(999);
    movie.add(103);

    const report = await workflow.verify(config);
    expect(report.passed).toBe(false);
    expect(report.perCategory['电影'].missing).toEqual([101]);
    expect(report.perCategory['电影'].unexpected).toEqual([103, 999]);
    expect(report.wrongCategory).toEqual([{ aid: 103, expected: UNCERTAIN, actual: '电影' }]);
    expect(report.perCategory[UNCERTAIN].actual).toBe(1);
    expect(adapter.aids.get(uncertainId)?.has(103)).toBe(true);
    expect(workflow.data.state.execution.verification).toEqual(report);
    expect(workflow.data.state.execution.phase).toBe('failed');
  });

  it('automatically retries a missing item a finite number of times', async () => {
    const { adapter, workflow, manifest, settings: config } = await setup(101);
    const report = await workflow.applyManifest(manifest, { ...config, verifyRetries: 1 });
    expect(report.passed).toBe(true);
    expect(report.perCategory['电影'].missing).toEqual([]);
    expect(adapter.copies.filter(copy => copy.aids.includes(101))).toHaveLength(2);
  });

  it('fails when any source aid from the pre-apply set is removed', async () => {
    const { adapter, workflow, manifest, settings: config } = await setup();
    await workflow.applyManifest(manifest, config);
    adapter.aids.get(10)!.delete(102);
    const report = await workflow.verify(config);
    expect(report.passed).toBe(false);
    expect(report.sourceMissing).toEqual({ '10': [102] });
  });

  it('counts copied and uncertain videos while leaving the default folder untouched', async () => {
    const { adapter, workflow, manifest, settings: config } = await setup();
    const report = await workflow.applyManifest(manifest, config);
    expect(report.passed).toBe(true);
    expect(report.total).toBe(3);
    expect(report.copied).toBe(3);
    expect(report.uncertain).toBe(1);
    expect(adapter.aids.get(1)).toEqual(new Set());
    expect(adapter.copies.every(copy => copy.source !== 1 && copy.target !== 1)).toBe(true);
  });
});
