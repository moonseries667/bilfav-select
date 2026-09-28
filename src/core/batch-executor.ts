import type { BilibiliAdapter, BatchOptions, CopyItem, RuntimeHooks } from '../types';
import { AppError, PauseError, errorMessage } from '../lib/errors';
import { jitter } from '../lib/timing';

type ItemHandler = (item: CopyItem) => void | Promise<void>;
type FailureHandler = (item: CopyItem, error: string, attempts: number) => void | Promise<void>;

/**
 * Copies small groups first, retries a failed group a bounded number of times,
 * then bisects it until failures are isolated to individual videos.
 *
 * This implementation is intentionally local to this project; it does not
 * reuse code from GPL-licensed classifiers.
 */
export class BatchExecutor {
  private retries = 0;

  constructor(
    private readonly adapter: BilibiliAdapter,
    private readonly options: BatchOptions,
    private readonly hooks: RuntimeHooks = {},
  ) {}

  get retryCount(): number { return this.retries; }

  async execute(items: CopyItem[], onSuccess: ItemHandler, onFailure: FailureHandler): Promise<void> {
    const batchSize = positiveInt(this.options.batchSize, 10);
    const groups = new Map<string, CopyItem[]>();
    for (const item of items) {
      const key = `${item.sourceId}:${item.targetId}`;
      const group = groups.get(key) ?? [];
      group.push(item);
      groups.set(key, group);
    }

    for (const group of groups.values()) {
      for (let offset = 0; offset < group.length; offset += batchSize) {
        this.checkpoint();
        await this.processChunk(group.slice(offset, offset + batchSize), onSuccess, onFailure);
      }
    }
  }

  private async processChunk(items: CopyItem[], onSuccess: ItemHandler, onFailure: FailureHandler): Promise<void> {
    let lastError: unknown = new AppError('复制失败', 'api', undefined, true);
    const retries = Number.isFinite(this.options.maxRetries) ? Math.max(0, Math.floor(this.options.maxRetries)) : 0;

    for (let attempt = 0; attempt <= retries; attempt++) {
      this.checkpoint();
      try {
        await this.adapter.copyVideos(items[0].sourceId, items[0].targetId, items.map(item => item.aid));
      } catch (error) {
        if (isPause(error)) throw error;
        lastError = error;
        if (attempt < retries) this.retries++;
        await this.waitAfterFailure(error, attempt < retries);
        if (attempt < retries) continue;

        if (items.length > 1) {
          const midpoint = Math.ceil(items.length / 2);
          await this.processChunk(items.slice(0, midpoint), onSuccess, onFailure);
          await this.processChunk(items.slice(midpoint), onSuccess, onFailure);
          return;
        }

        await onFailure(items[0], errorMessage(lastError), attempt + 1);
        return;
      }

      // A callback failure must propagate. The remote copy may already have
      // succeeded, so treating it as an API failure could duplicate work.
      for (const item of items) await onSuccess(item);
      await this.waitAfterSuccess();
      return;
    }
  }

  private async waitAfterFailure(error: unknown, retrying: boolean): Promise<void> {
    const baseDelay = Math.max(0, this.options.delayMs);
    const cooldown = Math.max(0, this.options.cooldownMs);
    if (isRateLimited(error)) {
      if (cooldown > 0) await this.pause(jitter(cooldown));
      else if (retrying && baseDelay > 0) await this.pause(jitter(baseDelay));
    } else if (retrying && baseDelay > 0) {
      await this.pause(jitter(baseDelay));
    }
  }

  private async waitAfterSuccess(): Promise<void> {
    const delay = Math.max(0, this.options.delayMs);
    if (delay > 0) await this.pause(jitter(delay));
  }

  private async pause(ms: number): Promise<void> {
    this.checkpoint();
    await (this.hooks.sleep ?? (duration => new Promise(resolve => setTimeout(resolve, duration))))(ms);
    this.checkpoint();
  }

  private checkpoint(): void {
    this.hooks.checkpoint?.();
  }
}

function positiveInt(value: number, fallback: number): number {
  const integer = Math.floor(value);
  return Number.isFinite(value) && integer > 0 ? integer : fallback;
}

function isPause(error: unknown): boolean {
  return error instanceof PauseError || (error instanceof AppError && error.kind === 'paused');
}

function isRateLimited(error: unknown): boolean {
  return error instanceof AppError && (error.kind === 'rate-limit' || error.code === 412 || error.code === 429);
}
