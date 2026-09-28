/**
 * Bilibili HTTP boundary. The request flow is a clean-room adaptation of the
 * MIT-licensed madoka-chann/Bilibili-AI-Favorites-Organizer API layer.
 */
import { gmFetch, type GMXMLHttpResponse } from '../lib/gm';
import { AppError, PauseError } from '../lib/errors';
import { backoff, jitter } from '../lib/timing';
import type { RuntimeHooks, Settings } from '../types';

export type BilibiliRequestOptions = {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  timeout?: number;
  anonymous?: boolean;
};

export type BilibiliTransport = (
  url: string,
  options: BilibiliRequestOptions,
) => Promise<Pick<GMXMLHttpResponse, 'status' | 'responseText'>>;

export interface BilibiliEnvelope<T> {
  code: number;
  message?: string;
  msg?: string;
  data?: T;
}

export interface RequestJsonOptions {
  method?: 'GET' | 'POST';
  body?: string;
  retryNetwork?: boolean;
  acceptedCodes?: number[];
}

const RATE_LIMIT_CODES = new Set([-412, -429]);

export function buildBilibiliForm(values: Record<string, string | number>): string {
  const form = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) form.set(key, String(value));
  return form.toString();
}

/** Reads CSRF only at the request boundary; callers and logs never receive it. */
export function readBilibiliCsrf(): string {
  if (typeof document === 'undefined') throw new AppError('无法读取当前 B 站登录态', 'safety');
  const entry = document.cookie.split(';').map(part => part.trim()).find(part => part.startsWith('bili_jct='));
  const value = entry?.slice('bili_jct='.length);
  if (!value) throw new AppError('当前登录态缺少写操作所需的 CSRF 信息，请刷新 B 站页面后重试', 'safety');
  return value;
}

/**
 * Serializes every Bilibili request, applies request jitter and finite retry
 * handling, and never exposes request bodies or cookie values in diagnostics.
 */
export class BilibiliHttpClient {
  private queue: Promise<void> = Promise.resolve();
  private hasSentRequest = false;
  private pendingWaitMs = 0;

  constructor(
    private readonly settings: Pick<Settings, 'requestDelayMs' | 'cooldownMs' | 'maxRetries'>,
    private readonly hooks: RuntimeHooks,
    private readonly transport: BilibiliTransport = gmFetch,
  ) {}

  requestJson<T>(url: string, options: RequestJsonOptions = {}): Promise<BilibiliEnvelope<T>> {
    const queued = this.queue.then(() => this.performRequest<T>(url, options));
    this.queue = queued.then(() => undefined, () => undefined);
    return queued;
  }

  getData<T>(url: string): Promise<T> {
    return this.requestJson<T>(url).then(envelope => envelope.data as T);
  }

  postData<T>(url: string, values: Record<string, string | number>, options: Omit<RequestJsonOptions, 'method' | 'body'> = {}): Promise<T> {
    return this.requestJson<T>(url, {
      ...options,
      method: 'POST',
      body: buildBilibiliForm(values),
    }).then(envelope => envelope.data as T);
  }

  private async performRequest<T>(url: string, options: RequestJsonOptions): Promise<BilibiliEnvelope<T>> {
    const method = options.method ?? 'GET';
    const retryNetwork = options.retryNetwork ?? method === 'GET';
    const retries = this.normalizedRetries();

    for (let attempt = 0; attempt <= retries; attempt++) {
      this.hooks.checkpoint?.();
      await this.waitBeforeRequest();

      let response: Pick<GMXMLHttpResponse, 'status' | 'responseText'>;
      try {
        this.hasSentRequest = true;
        response = await this.transport(url, {
          method,
          ...(method === 'POST' ? {
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
              Referer: 'https://www.bilibili.com/',
            },
            body: options.body,
          } : {}),
          timeout: 30_000,
          anonymous: false,
        });
      } catch (error) {
        if (error instanceof PauseError || (error instanceof AppError && error.kind === 'paused')) throw error;
        if (retryNetwork && attempt < retries) {
          this.pendingWaitMs = Math.max(this.pendingWaitMs, jitter(backoff(attempt)));
          this.hooks.log?.('B 站请求暂时失败，等待后重试', 'warning');
          continue;
        }
        throw new AppError('B 站网络请求失败，请检查连接后重试', 'network', undefined, retryNetwork);
      }

      if (response.status === 412 || response.status === 429) {
        const error = new AppError('B 站请求触发限流，已进入冷却', 'rate-limit', response.status, true);
        this.scheduleCooldown(attempt);
        if (attempt < retries) {
          this.hooks.log?.('B 站请求触发限流，等待冷却后重试', 'warning');
          continue;
        }
        throw error;
      }
      if (response.status === 408 || response.status >= 500) {
        if (retryNetwork && attempt < retries) {
          this.pendingWaitMs = Math.max(this.pendingWaitMs, jitter(backoff(attempt)));
          this.hooks.log?.('B 站服务暂时不可用，等待后重试', 'warning');
          continue;
        }
        throw new AppError(
          `B 站服务暂时不可用（HTTP ${response.status}）`,
          'network',
          response.status,
          retryNetwork,
        );
      }
      if (response.status < 200 || response.status >= 300) {
        throw new AppError(
          `B 站请求失败（HTTP ${response.status}）`,
          'api',
          response.status,
          response.status >= 500,
        );
      }

      let envelope: BilibiliEnvelope<T>;
      try {
        envelope = JSON.parse(response.responseText) as BilibiliEnvelope<T>;
      } catch {
        throw new AppError('B 站返回了无法解析的响应', 'api', undefined, false);
      }
      if (!envelope || typeof envelope !== 'object' || !Number.isInteger(envelope.code)) {
        throw new AppError('B 站返回了不完整的响应', 'api', undefined, false);
      }

      if (RATE_LIMIT_CODES.has(envelope.code)) {
        this.scheduleCooldown(attempt);
        if (attempt < retries) {
          this.hooks.log?.('B 站请求触发限流，等待冷却后重试', 'warning');
          continue;
        }
        throw new AppError('B 站请求触发限流，已进入冷却', 'rate-limit', envelope.code, true);
      }

      if (envelope.code !== 0 && !options.acceptedCodes?.includes(envelope.code)) {
        const kind = envelope.code === -404 || envelope.code === 11010 ? 'unavailable' : 'api';
        throw new AppError(`B 站 API 请求失败（code ${envelope.code}）`, kind, envelope.code, false);
      }
      return envelope;
    }

    throw new AppError('B 站请求已达到重试上限', 'network', undefined, true);
  }

  private async waitBeforeRequest(): Promise<void> {
    if (this.hasSentRequest) {
      const delay = this.delayValue(this.settings.requestDelayMs);
      if (delay > 0) await this.wait(delay);
    }
    const pending = this.pendingWaitMs;
    this.pendingWaitMs = 0;
    if (pending > 0) await this.wait(pending);
    this.hooks.checkpoint?.();
  }

  private scheduleCooldown(attempt: number): void {
    const configured = Math.max(0, Number(this.settings.cooldownMs) || 0);
    const delay = Math.max(configured, backoff(attempt, configured || 1000), jitter(configured));
    this.pendingWaitMs = Math.max(this.pendingWaitMs, delay);
  }

  private delayValue(value: number): number {
    const delay = Number.isFinite(value) ? Math.max(0, value) : 0;
    return delay > 0 ? jitter(delay) : 0;
  }

  private normalizedRetries(): number {
    const value = Number.isFinite(this.settings.maxRetries) ? Math.floor(this.settings.maxRetries) : 0;
    return Math.max(0, Math.min(5, value));
  }

  private wait(ms: number): Promise<void> {
    return this.hooks.sleep ? this.hooks.sleep(ms) : new Promise(resolve => setTimeout(resolve, ms));
  }
}
