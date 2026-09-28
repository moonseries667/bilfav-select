import { describe, expect, it } from 'vitest';
import { testModel, sameAIConnection } from '../src/ai/model-test';
import type { AISettings } from '../src/types';

const settings: AISettings = { provider: 'openai-compatible', baseUrl: 'https://ai.example/v1', model: 'demo', apiKey: 'test-key' };
const output = JSON.stringify([
  { aid: 1, category: 'MMD', confidence: 0.9 },
  { aid: 2, category: '绘画', confidence: 0.9 },
  { aid: 3, category: '科普', confidence: 0.9 },
]);

describe('model compatibility test', () => {
  it('uses one synthetic production-format batch and reports matching separately from format validity', async () => {
    let calls = 0;
    const result = await testModel(settings, { complete: async (system, user) => {
      calls++;
      expect(system).toContain('ALLOWED_CATEGORIES');
      expect(user).toContain('videos = ');
      expect(user).not.toContain(settings.apiKey);
      return output;
    } });
    expect(calls).toBe(1);
    expect(result).toMatchObject({ correct: 3, total: 3 });
    const mismatch = await testModel(settings, { complete: async () => output.replace('MMD', '不确定') });
    expect(mismatch.correct).toBe(2);
  });

  it.each(['OK', '[]', '[{"aid":1,"category":"MMD","confidence":1}]'])('rejects successful HTTP calls with unsuitable classification content: %s', async content => {
    await expect(testModel(settings, { complete: async () => content })).rejects.toThrow('调用成功，但分类格式不合格');
  });

  it('invalidates the displayed test after changing credentials, provider, endpoint or model', () => {
    expect(sameAIConnection(settings, { ...settings, baseUrl: settings.baseUrl + '/' })).toBe(true);
    expect(sameAIConnection(settings, { ...settings, model: 'other' })).toBe(false);
    expect(sameAIConnection(settings, { ...settings, apiKey: 'other' })).toBe(false);
    expect(sameAIConnection(settings, { ...settings, baseUrl: 'https://other/v1' })).toBe(false);
    expect(sameAIConnection(settings, { ...settings, provider: 'ollama' })).toBe(false);
    expect(sameAIConnection(settings, { ...settings, model: 'other' }, false)).toBe(true);
  });
});
