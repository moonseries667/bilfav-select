/** Request builder is adapted from madoka-chann/Bilibili-AI-Favorites-Organizer
 * src/api/ai-providers.ts (MIT), simplified for the OpenAI-compatible providers here.
 */
import { gmFetch } from '../lib/gm';
import { AppError } from '../lib/errors';
import type { AISettings, RuntimeHooks } from '../types';

export interface AIProvider {
  complete(system: string, user: string, settings: AISettings, hooks?: RuntimeHooks): Promise<string>;
}

export interface AIRequest {
  url: string;
  method: 'POST';
  headers: Record<string, string>;
  body: string;
  timeout: number;
  anonymous: true;
}

const DEFAULT_BASE_URLS: Record<AISettings['provider'], string> = {
  'openai-compatible': 'https://api.openai.com/v1',
  deepseek: 'https://api.deepseek.com',
  ollama: 'http://localhost:11434/v1',
};

const REQUEST_TIMEOUT_MS = 90_000;

function getBaseUrl(settings: AISettings): URL {
  const baseUrl = (settings.baseUrl.trim() || DEFAULT_BASE_URLS[settings.provider]).replace(/\/+$/, '');
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new AppError('AI 服务地址格式无效', 'invalid');
  }

  if ((parsed.protocol !== 'https:' && parsed.protocol !== 'http:') ||
      parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new AppError('AI 服务地址只能包含 HTTP(S) 主机和路径', 'invalid');
  }
  return parsed;
}

function getHeaders(settings: AISettings): Record<string, string> {
  if (settings.provider !== 'ollama' && !settings.apiKey.trim()) {
    throw new AppError('请先设置 AI API Key', 'invalid');
  }
  if (/[\r\n]/.test(settings.apiKey)) throw new AppError('AI API Key 格式无效', 'invalid');
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (settings.apiKey) headers.Authorization = `Bearer ${settings.apiKey}`;
  return headers;
}

function safeRequestError(error: unknown, operation: '模型列表' | 'AI'): AppError {
  if (error instanceof AppError && error.code === 408) {
    return new AppError(`${operation}请求超时，请检查服务地址后重试`, 'network', 408, true);
  }
  return new AppError(`${operation}网络请求失败，请检查服务地址和网络连接`, 'network', undefined, true);
}

function statusError(status: number, operation: '模型列表' | 'AI'): AppError {
  const kind = status === 429 ? 'rate-limit' : 'api';
  const retryable = status === 429 || status === 408 || status === 425 || status >= 500;
  const message = status === 401 ? 'AI 服务鉴权失败，请检查 API Key' :
    status === 403 ? 'AI 服务拒绝访问，请检查权限' :
    status === 404 ? 'AI 服务接口不存在，请检查 Base URL' :
    status === 429 ? 'AI 服务请求过于频繁，请稍后重试' :
    status >= 500 ? 'AI 服务暂时不可用，请稍后重试' :
    `${operation}请求失败，请检查服务设置`;
  return new AppError(message, kind, status, retryable);
}

/** Lists model identifiers from the provider's OpenAI-compatible /models endpoint. */
export async function fetchModels(settings: AISettings, hooks: RuntimeHooks = {}): Promise<string[]> {
  const parsed = getBaseUrl(settings);
  const headers = getHeaders(settings);
  const url = `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}/models`;
  let response;
  const startedAt = Date.now();
  const endpoint = new URL(url).pathname;
  try {
    response = await gmFetch(url, { method: 'GET', headers, timeout: REQUEST_TIMEOUT_MS, anonymous: true });
  } catch (error) {
    hooks.diagnostic?.({ task: 'models', phase: 'model-list', outcome: 'network-error', method: 'GET', endpoint, durationMs: Date.now() - startedAt, reason: error instanceof AppError ? error.kind : 'network' });
    throw safeRequestError(error, '模型列表');
  }
  if (response.status < 200 || response.status >= 300) { hooks.diagnostic?.({ task: 'models', phase: 'model-list', outcome: 'http-error', method: 'GET', endpoint, durationMs: Date.now() - startedAt, status: response.status }); throw statusError(response.status, '模型列表'); }

  let envelope: unknown;
  try {
    envelope = JSON.parse(response.responseText) as unknown;
  } catch {
    hooks.diagnostic?.({ task: 'models', phase: 'model-list', outcome: 'invalid-json', method: 'GET', endpoint, durationMs: Date.now() - startedAt, status: response.status });
    throw new AppError('模型列表响应格式无效', 'invalid');
  }
  if (!isRecord(envelope) || !Array.isArray(envelope.data) ||
      envelope.data.some(item => !isRecord(item) || typeof item.id !== 'string')) {
    { hooks.diagnostic?.({ task: 'models', phase: 'model-list', outcome: 'invalid-shape', method: 'GET', endpoint, durationMs: Date.now() - startedAt, status: response.status }); throw new AppError('模型列表响应格式无效', 'invalid'); }
  }
  const models = [...new Set(envelope.data.map(item => (item as Record<string, unknown>).id as string)
    .map(id => id.trim()).filter(Boolean))];
  hooks.diagnostic?.({ task: 'models', phase: 'model-list', outcome: models.length ? 'completed' : 'empty', method: 'GET', endpoint, durationMs: Date.now() - startedAt, status: response.status });
  return models;
}

/** Builds the standard chat-completions request shared by OpenAI, DeepSeek and Ollama. */
export function buildAIRequest(system: string, user: string, settings: AISettings): AIRequest {
  const parsed = getBaseUrl(settings);

  if (!settings.model.trim()) throw new AppError('请先设置 AI 模型名称', 'invalid');
  const headers = getHeaders(settings);

  return {
    url: `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}/chat/completions`,
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: settings.model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
    timeout: REQUEST_TIMEOUT_MS,
    anonymous: true,
  };
}

export class OpenAICompatibleProvider implements AIProvider {
  async complete(system: string, user: string, settings: AISettings, hooks: RuntimeHooks = {}): Promise<string> {
    return (await this.completeWithMetadata(system, user, settings, hooks)).content;
  }

  async completeWithMetadata(system: string, user: string, settings: AISettings, hooks: RuntimeHooks = {}): Promise<{
    content: string;
    model?: string;
    usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
  }> {
    const request = buildAIRequest(system, user, settings);
    let response;
    const startedAt = Date.now();
    const endpoint = new URL(request.url).pathname;
    try {
      response = await gmFetch(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
        timeout: request.timeout,
        anonymous: true,
      });
    } catch (error) {
      hooks.diagnostic?.({ task: hooks.currentTask?.() ?? 'ai', phase: 'ai-http', outcome: 'network-error', method: 'POST', endpoint, durationMs: Date.now() - startedAt, status: error instanceof AppError ? error.code : undefined, reason: error instanceof AppError ? error.kind : 'network' });
      throw safeRequestError(error, 'AI');
    }

    if (response.status < 200 || response.status >= 300) {
      hooks.diagnostic?.({ task: hooks.currentTask?.() ?? 'ai', phase: 'ai-http', outcome: 'http-error', method: 'POST', endpoint, durationMs: Date.now() - startedAt, status: response.status });
      throw statusError(response.status, 'AI');
    }
    hooks.diagnostic?.({ task: hooks.currentTask?.() ?? 'ai', phase: 'ai-http', outcome: 'http-response', method: 'POST', endpoint, durationMs: Date.now() - startedAt, status: response.status });

    let envelope: unknown;
    try {
      envelope = JSON.parse(response.responseText) as unknown;
    } catch {
      hooks.diagnostic?.({ task: hooks.currentTask?.() ?? 'ai', phase: 'ai-http', outcome: 'invalid-json', method: 'POST', endpoint, durationMs: Date.now() - startedAt, status: response.status });
      throw new AppError('AI 服务响应不是有效 JSON', 'invalid');
    }

    const content = getMessageContent(envelope);
    if (content === null) { hooks.diagnostic?.({ task: hooks.currentTask?.() ?? 'ai', phase: 'ai-http', outcome: 'invalid-shape', method: 'POST', endpoint, durationMs: Date.now() - startedAt, status: response.status }); throw new AppError('AI 服务响应缺少有效的 choices 内容', 'invalid'); }
    if (!content.trim()) { hooks.diagnostic?.({ task: hooks.currentTask?.() ?? 'ai', phase: 'ai-http', outcome: 'empty-content', method: 'POST', endpoint, durationMs: Date.now() - startedAt, status: response.status }); throw new AppError('AI 服务返回了空内容', 'invalid'); }
    return {
      content,
      ...(isRecord(envelope) && typeof envelope.model === 'string' ? { model: envelope.model } : {}),
      ...(isRecord(envelope) ? { usage: getUsage(envelope.usage) } : {}),
    };
  }
}

function getUsage(value: unknown): { promptTokens?: number; completionTokens?: number; totalTokens?: number } | undefined {
  if (!isRecord(value)) return undefined;
  const usage: { promptTokens?: number; completionTokens?: number; totalTokens?: number } = {};
  if (typeof value.prompt_tokens === 'number' && Number.isFinite(value.prompt_tokens) && value.prompt_tokens >= 0) {
    usage.promptTokens = value.prompt_tokens;
  }
  if (typeof value.completion_tokens === 'number' && Number.isFinite(value.completion_tokens) && value.completion_tokens >= 0) {
    usage.completionTokens = value.completion_tokens;
  }
  if (typeof value.total_tokens === 'number' && Number.isFinite(value.total_tokens) && value.total_tokens >= 0) {
    usage.totalTokens = value.total_tokens;
  }
  return Object.keys(usage).length ? usage : undefined;
}

function getMessageContent(value: unknown): string | null {
  if (!isRecord(value) || !Array.isArray(value.choices)) return null;
  const choice = value.choices[0];
  if (!isRecord(choice) || !isRecord(choice.message)) return null;
  const content = choice.message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;

  const textParts = content.flatMap(part =>
    isRecord(part) && typeof part.text === 'string' ? [part.text] : []);
  return textParts.length ? textParts.join('\n') : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export const defaultAIProvider = new OpenAICompatibleProvider();
