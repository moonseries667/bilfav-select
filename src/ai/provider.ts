/** Request builder is adapted from madoka-chann/Bilibili-AI-Favorites-Organizer
 * src/api/ai-providers.ts (MIT), simplified for the OpenAI-compatible providers here.
 */
import { gmFetch } from '../lib/gm';
import { AppError } from '../lib/errors';
import type { AISettings } from '../types';

export interface AIProvider {
  complete(system: string, user: string, settings: AISettings): Promise<string>;
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

/** Builds the standard chat-completions request shared by OpenAI, DeepSeek and Ollama. */
export function buildAIRequest(system: string, user: string, settings: AISettings): AIRequest {
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

  if (!settings.model.trim()) throw new AppError('请先设置 AI 模型名称', 'invalid');
  if (settings.provider !== 'ollama' && !settings.apiKey.trim()) {
    throw new AppError('请先设置 AI API Key', 'invalid');
  }
  if (/[\r\n]/.test(settings.apiKey)) throw new AppError('AI API Key 格式无效', 'invalid');

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (settings.apiKey) headers.Authorization = `Bearer ${settings.apiKey}`;

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
      temperature: 0.1,
    }),
    timeout: REQUEST_TIMEOUT_MS,
    anonymous: true,
  };
}

export class OpenAICompatibleProvider implements AIProvider {
  async complete(system: string, user: string, settings: AISettings): Promise<string> {
    const request = buildAIRequest(system, user, settings);
    let response;
    try {
      response = await gmFetch(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
        timeout: request.timeout,
        anonymous: true,
      });
    } catch (error) {
      const code = error instanceof AppError ? error.code : undefined;
      const retryable = error instanceof AppError ? error.retryable : true;
      const kind = error instanceof AppError ? error.kind : 'network';
      throw new AppError('AI 网络请求失败', kind, code, retryable);
    }

    if (response.status < 200 || response.status >= 300) {
      const retryable = response.status === 412 || response.status === 429 ||
        response.status === 408 || response.status === 425 || response.status >= 500;
      throw new AppError('AI 服务请求失败',
        response.status === 412 || response.status === 429 ? 'rate-limit' : 'api',
        response.status, retryable);
    }

    let envelope: unknown;
    try {
      envelope = JSON.parse(response.responseText) as unknown;
    } catch {
      throw new AppError('AI 服务响应格式无效', 'invalid');
    }

    const content = getMessageContent(envelope);
    if (content === null) throw new AppError('AI 服务未返回分类内容', 'invalid');
    return content;
  }
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
