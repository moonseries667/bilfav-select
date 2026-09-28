import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '../src/lib/errors';
import type { AISettings } from '../src/types';
import { OpenAICompatibleProvider, buildAIRequest, fetchModels } from '../src/ai/provider';

const baseSettings: AISettings = {
  provider: 'openai-compatible',
  baseUrl: 'https://ai.example.test/v1/',
  apiKey: 'secret-test-key',
  model: 'model-a',
};

function mockResponse(response: Partial<{
  status: number;
  responseText: string;
}> = {}) {
  const request = vi.fn((details: {
    method: string;
    url: string;
    headers?: Record<string, string>;
    data?: string;
    anonymous?: boolean;
    onload?: (response: unknown) => void;
  }) => {
    queueMicrotask(() => details.onload?.({
      status: response.status ?? 200,
      statusText: '',
      responseText: response.responseText ?? '{}',
      response: null,
      responseHeaders: '',
      finalUrl: details.url,
    }));
    return undefined;
  });
  vi.stubGlobal('GM_xmlhttpRequest', request);
  return request;
}

afterEach(() => vi.unstubAllGlobals());

describe('fetchModels', () => {
  it('fetches models without a selected model, preserves /v1 and sends anonymous authorization', async () => {
    const request = mockResponse({ responseText: JSON.stringify({ data: [{ id: 'one' }] }) });
    await expect(fetchModels({ ...baseSettings, model: '' })).resolves.toEqual(['one']);
    expect(request).toHaveBeenCalledWith(expect.objectContaining({
      method: 'GET',
      url: 'https://ai.example.test/v1/models',
      headers: expect.objectContaining({ Authorization: `Bearer ${baseSettings.apiKey}` }),
      anonymous: true,
    }));
  });

  it('allows Ollama without a key and trims duplicate model ids', async () => {
    const request = mockResponse({ responseText: JSON.stringify({ data: [
      { id: 'llama3' }, { id: 'llama3' }, { id: ' llama3 ' }, { id: '' },
    ] }) });
    await expect(fetchModels({
      ...baseSettings, provider: 'ollama', baseUrl: 'http://localhost:11434/v1///', apiKey: '', model: '',
    })).resolves.toEqual(['llama3']);
    expect(request).toHaveBeenCalledWith(expect.objectContaining({
      url: 'http://localhost:11434/v1/models',
      headers: { 'Content-Type': 'application/json' },
    }));
  });

  it('supports a base URL without a version path and returns an empty list', async () => {
    mockResponse({ responseText: '{"data":[]}' });
    await expect(fetchModels({ ...baseSettings, baseUrl: 'https://ai.example.test///' })).resolves.toEqual([]);
  });

  it.each([
    [401, '鉴权'], [403, '权限'], [404, 'Base URL'], [429, '频繁'], [503, '不可用'],
  ])('maps model-list HTTP %i to a safe message', async (status, message) => {
    mockResponse({ status, responseText: `sensitive response ${baseSettings.apiKey}` });
    const error = await fetchModels(baseSettings).catch(value => value);
    expect(error).toBeInstanceOf(AppError);
    expect((error as Error).message).toContain(message);
    expect((error as Error).message).not.toContain(baseSettings.apiKey);
    expect((error as Error).message).not.toContain('sensitive response');
  });

  it('rejects malformed model envelopes without exposing response text', async () => {
    mockResponse({ responseText: '{"error":"private detail"}' });
    await expect(fetchModels(baseSettings)).rejects.toThrow('模型列表响应格式无效');
    await expect(fetchModels(baseSettings)).rejects.not.toThrow('private detail');
  });

  it('rejects credentials, query strings, and fragments in the URL', async () => {
    for (const baseUrl of [
      'https://user:pass@ai.example.test/v1',
      'https://ai.example.test/v1?key=secret',
      'https://ai.example.test/v1#token',
    ]) {
      await expect(fetchModels({ ...baseSettings, baseUrl })).rejects.toThrow(AppError);
    }
  });

  it('uses safe messages for transport exceptions and timeouts', async () => {
    vi.stubGlobal('GM_xmlhttpRequest', vi.fn((details: {
      onerror?: (response: unknown) => void;
    }) => {
      queueMicrotask(() => details.onerror?.({ responseText: `private ${baseSettings.apiKey}` }));
      return undefined;
    }));
    await expect(fetchModels(baseSettings)).rejects.toThrow('模型列表网络请求失败');

    vi.stubGlobal('GM_xmlhttpRequest', vi.fn((details: {
      ontimeout?: () => void;
    }) => {
      queueMicrotask(() => details.ontimeout?.());
      return undefined;
    }));
    await expect(fetchModels(baseSettings)).rejects.toThrow('模型列表请求超时');
  });
});

describe('OpenAI-compatible provider', () => {
  it('returns parsed content, model, and only valid non-negative finite token counts', async () => {
    mockResponse({ responseText: JSON.stringify({
      model: 'returned-model',
      choices: [{ message: { content: 'result' } }],
      usage: { prompt_tokens: 3, completion_tokens: -1, total_tokens: '4', extra: 9 },
    }) });
    const provider = new OpenAICompatibleProvider();
    await expect(provider.completeWithMetadata('system', 'user', baseSettings)).resolves.toEqual({
      content: 'result', model: 'returned-model', usage: { promptTokens: 3 },
    });
  });

  it('keeps complete compatible and sends only basic model/messages parameters', async () => {
    const request = mockResponse({ responseText: '{"choices":[{"message":{"content":"done"}}]}' });
    const provider = new OpenAICompatibleProvider();
    await expect(provider.complete('system', 'user', baseSettings)).resolves.toBe('done');
    const body = JSON.parse(request.mock.calls[0][0].data ?? '{}');
    expect(body).toEqual({
      model: baseSettings.model,
      messages: [{ role: 'system', content: 'system' }, { role: 'user', content: 'user' }],
    });
    expect(body).not.toHaveProperty('temperature');
    expect(buildAIRequest('system', 'user', baseSettings).body).not.toContain('temperature');
  });

  it.each([
    ['not-json', '不是有效 JSON'],
    ['{"error":"private detail"}', '缺少有效的 choices'],
    ['{"choices":[]}', '缺少有效的 choices'],
    ['{"choices":[{"message":{"content":"  "}}]}', '空内容'],
  ])('rejects invalid completion envelope %s', async (responseText, message) => {
    mockResponse({ responseText });
    await expect(new OpenAICompatibleProvider().complete('system', 'user', baseSettings))
      .rejects.toThrow(message);
  });
});
