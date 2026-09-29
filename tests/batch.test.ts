import { describe, expect, it, vi } from 'vitest';
import { BatchExecutor } from '../src/core/batch-executor';
import { AppError, PauseError } from '../src/lib/errors';
import type { BilibiliAdapter, CopyItem, DiagnosticEvent, RuntimeHooks } from '../src/types';

function adapter(copyVideos: BilibiliAdapter['copyVideos']): BilibiliAdapter {
  return {
    getCurrentUser: async () => ({ mid: 1, name: 'test' }),
    listFolders: async () => [], renameFolder: async () => undefined,
    createFolder: async title => ({ id: 1, title, mediaCount: 0, isDefault: false }),
    deleteFolder: async () => undefined, listFolderVideos: async () => [],
    getVideoMetadata: async aid => ({ aid, title: '', description: '', tags: [] }),
    copyVideos, getFolderAidSet: async () => new Set<number>(),
  };
}

const item = (aid: number, sourceId = 10, targetId = 20): CopyItem => ({ aid, category: '电影', sourceId, targetId });
const options = (overrides: Partial<{ batchSize: number; maxRetries: number; delayMs: number; cooldownMs: number }> = {}) => ({
  batchSize: 10, maxRetries: 2, delayMs: 0, cooldownMs: 0, ...overrides,
});

describe('BatchExecutor', () => {
  it('retries a failed batch, bisects it, then succeeds with single-item fallbacks', async () => {
    const calls: number[][] = [];
    const copied: number[] = [];
    const failed = vi.fn();
    const fake = adapter(async (_source, _target, aids) => {
      calls.push([...aids]);
      if (aids.length > 1) throw new AppError('batch rejected', 'api', 500, true);
      copied.push(aids[0]);
    });
    const executor = new BatchExecutor(fake, options({ batchSize: 4, maxRetries: 1 }));
    await executor.execute([1, 2, 3, 4].map(aid => item(aid)), async entry => { copied.push(entry.aid); }, failed);

    expect(calls.filter(batch => batch.length === 4)).toHaveLength(2);
    expect(calls.some(batch => batch.length === 1)).toBe(true);
    expect(copied.sort((a, b) => a - b)).toEqual([1, 1, 2, 2, 3, 3, 4, 4]);
    expect(failed).not.toHaveBeenCalled();
    expect(executor.retryCount).toBeGreaterThan(0);
  });

  it('retries a transient batch error without splitting after the request succeeds', async () => {
    let attempts = 0;
    const success = vi.fn();
    const fake = adapter(async () => {
      attempts++;
      if (attempts < 3) throw new AppError('temporary', 'network', undefined, true);
    });
    const executor = new BatchExecutor(fake, options({ batchSize: 3, maxRetries: 2 }));
    await executor.execute([item(1), item(2)], success, () => undefined);
    expect(attempts).toBe(3);
    expect(success).toHaveBeenCalledTimes(2);
    expect(executor.retryCount).toBe(2);
  });

  it('keeps items from different source-target pairs in separate batches', async () => {
    const calls: Array<{ source: number; target: number; aids: number[] }> = [];
    const fake = adapter(async (source, target, aids) => { calls.push({ source, target, aids: [...aids] }); });
    const executor = new BatchExecutor(fake, options({ batchSize: 10 }));
    await executor.execute([item(1, 10, 20), item(2, 10, 20), item(3, 11, 20), item(4, 10, 21)], () => undefined, () => undefined);
    expect(calls).toEqual([
      { source: 10, target: 20, aids: [1, 2] },
      { source: 11, target: 20, aids: [3] },
      { source: 10, target: 21, aids: [4] },
    ]);
  });

  it('waits for a cooldown after a rate-limit response before retrying', async () => {
    let attempts = 0;
    const sleeps: number[] = [];
    const fake = adapter(async () => {
      attempts++;
      if (attempts === 1) throw new AppError('slow down', 'rate-limit', 429, true);
    });
    const executor = new BatchExecutor(fake, options({ maxRetries: 1, cooldownMs: 1000 }), { sleep: async ms => { sleeps.push(ms); } });
    await executor.execute([item(1)], () => undefined, () => undefined);
    expect(attempts).toBe(2);
    expect(sleeps).toHaveLength(1);
    expect(sleeps[0]).toBeGreaterThanOrEqual(700);
    expect(sleeps[0]).toBeLessThanOrEqual(1300);
  });

  it('propagates PauseError immediately instead of treating it as a failed batch', async () => {
    const copy = vi.fn(async () => { throw new PauseError(); });
    const failed = vi.fn();
    const events: DiagnosticEvent[] = [];
    const hooks: RuntimeHooks = { diagnostic: event => events.push(event) };
    const executor = new BatchExecutor(adapter(copy), options({ batchSize: 4, maxRetries: 4 }), hooks);
    await expect(executor.execute([item(1), item(2), item(3)], () => undefined, failed)).rejects.toBeInstanceOf(PauseError);
    expect(copy).toHaveBeenCalledTimes(1);
    expect(failed).not.toHaveBeenCalled();
    expect(hooks.requestContext).toBeUndefined();
    expect(events.at(-1)).toMatchObject({ outcome: 'paused', folderId: 10, targetFolderId: 20, aids: [1, 2, 3] });
    expect(events.at(-1)).not.toHaveProperty('endpoint');
  });

  it('records the actual retry wait and batch IDs without inventing an HTTP endpoint', async () => {
    const events: DiagnosticEvent[] = [];
    const waits: number[] = [];
    let attempts = 0;
    const copy = adapter(async () => { if (++attempts === 1) throw new AppError('temporary', 'network', 503, true); });
    await new BatchExecutor(copy, options({ delayMs: 100, cooldownMs: 9000, maxRetries: 1 }), {
      diagnostic: event => events.push(event), sleep: async ms => { waits.push(ms); },
    }).execute([item(1), item(2)], () => undefined, () => undefined);
    expect(events.find(event => event.outcome === 'retry-wait')).toMatchObject({ waitMs: waits[0], aids: [1, 2], folderId: 10, targetFolderId: 20 });
    expect(waits[0]).toBeGreaterThanOrEqual(70);
    expect(waits[0]).toBeLessThanOrEqual(130);
    expect(events.every(event => event.endpoint === undefined && event.status === undefined)).toBe(true);
  });

  it('does not repeat a remote copy when a durable success callback fails', async () => {
    const copy = vi.fn(async () => undefined);
    const failed = vi.fn();
    const executor = new BatchExecutor(adapter(copy), options({ maxRetries: 3 }));
    await expect(executor.execute([item(1)], () => { throw new Error('save failed'); }, failed)).rejects.toThrow('save failed');
    expect(copy).toHaveBeenCalledTimes(1);
    expect(failed).not.toHaveBeenCalled();
  });
});
