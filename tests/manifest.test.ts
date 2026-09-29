import { describe, expect, it } from 'vitest';
import { manifestHash, validateManifest } from '../src/lib/manifest';
import { Logger, sanitizeExport } from '../src/lib/logs';
import type { ClassificationManifest, VideoDataset } from '../src/types';

const dataset: VideoDataset = {
  version: 1, updatedAt: '2026-09-28T00:00:00.000Z', sourceFolderIds: [11],
  videos: [{ aid: 1, title: '电影', description: '', tags: ['电影'], sourceFolderIds: [11], primarySourceFolderId: 11, metadataFetchedAt: '2026-09-28T00:00:00.000Z' }],
};
function fixture(): ClassificationManifest {
  return { version: 1, runId: 'test-run', createdAt: '2026-09-28T00:00:00.000Z', datasetVersion: 1,
    datasetUpdatedAt: dataset.updatedAt, promptVersion: 1, prompt: '按内容性质分类',
    categories: [{ name: '电影', description: '正片' }, { name: '不确定', description: '无法判断' }],
    confidenceThreshold: 0.7, results: [{ aid: 1, category: '电影', confidence: 0.9 }], stats: { '电影': 1 } };
}
describe('Manifest boundary and recovery fingerprint', () => {
  it('checks the complete dataset and derives statistics rather than trusting imported counts', () => {
    const manifest = fixture(); manifest.stats = { '电影': 999 };
    expect(validateManifest(manifest, dataset).stats).toEqual({ '电影': 1, '不确定': 0 });
  });
  it('accepts both prompt generations and preserves the imported version in normalized manifests', () => {
    const legacy = validateManifest(fixture(), dataset);
    expect(legacy.promptVersion).toBe(1);
    expect(validateManifest({ ...fixture(), promptVersion: 2 }, dataset).promptVersion).toBe(2);
  });
  it('rejects duplicate, foreign or missing aids before apply', () => {
    const manifest = fixture(); manifest.results.push(manifest.results[0]);
    expect(() => validateManifest(manifest, dataset)).toThrow('aid');
    manifest.results = [{ aid: 2, category: '电影', confidence: 0.9 }];
    expect(() => validateManifest(manifest, dataset)).toThrow('完整覆盖');
    manifest.results = [];
    expect(() => validateManifest(manifest, dataset)).toThrow('完整覆盖');
  });
  it('rejects stale dataset identity, unknown category and low confidence', () => {
    const manifest = fixture(); manifest.datasetVersion = 2;
    expect(() => validateManifest(manifest, dataset)).toThrow('数据集版本');
    manifest.datasetVersion = 1; manifest.results[0].category = '新类别';
    expect(() => validateManifest(manifest, dataset)).toThrow('未知类别');
    manifest.results[0].category = '电影'; manifest.results[0].confidence = 0.4;
    expect(() => validateManifest(manifest, dataset)).toThrow('阈值');
  });
  it('requires only available aids, accepts legacy unavailable results without changing the resume hash, and rejects foreign aids', async () => {
    const mixed = structuredClone(dataset);
    mixed.videos.push({ ...mixed.videos[0], aid: 2, unavailable: true });
    const manifest = fixture();
    expect(validateManifest(manifest, mixed).results.map(result => result.aid)).toEqual([1]);
    manifest.results.push({ aid: 2, category: '不确定', confidence: 0, reason: '视频不可用' });
    const legacy = validateManifest(manifest, mixed);
    expect(await manifestHash(validateManifest(legacy, mixed))).toBe(await manifestHash(legacy));
    manifest.results = [{ aid: 2, category: '不确定', confidence: 0 }];
    expect(() => validateManifest(manifest, mixed)).toThrow('完整覆盖');
    manifest.results = [...fixture().results, { aid: 999, category: '不确定', confidence: 0 }];
    expect(() => validateManifest(manifest, mixed)).toThrow('完整覆盖');
  });
  it('hash ignores object property order but changes when prompt/results change', async () => {
    const manifest = fixture();
    const reordered = Object.fromEntries(Object.entries(manifest).reverse()) as unknown as ClassificationManifest;
    expect(await manifestHash(reordered)).toBe(await manifestHash(manifest));
    reordered.prompt = 'changed';
    expect(await manifestHash(reordered)).not.toBe(await manifestHash(manifest));
  });
});
describe('export credentials boundary', () => {
  it('redacts the configured API key including echoed model reasons and error messages', () => {
    const secret = 'test-private-key'; const logger = new Logger(() => [secret]);
    logger.add(`remote echoed ${secret}; Cookie=private-cookie`);
    expect(JSON.stringify(logger.export())).not.toContain(secret);
    expect(JSON.stringify(logger.export())).not.toContain('private-cookie');
    expect(sanitizeExport({ apiKey: secret, results: [{ reason: `echo ${secret}` }], title: '电影' }, [secret]))
      .toEqual({ results: [{ reason: 'echo [已隐藏凭据]' }], title: '电影' });
  });
});
