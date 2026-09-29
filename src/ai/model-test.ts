import { DEFAULT_SETTINGS } from '../defaults';
import type { AISettings, CategoryDefinition, RuntimeHooks, VideoRecord } from '../types';
import { AppError } from '../lib/errors';
import { buildSystemPrompt, buildUserPrompt, parseClassificationBatch } from './classifier';
import { defaultAIProvider, type AIProvider } from './provider';

export interface ModelTestResult {
  testedAt: string;
  elapsedMs: number;
  correct: number;
  total: number;
  model?: string;
  usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
}

export function sameAIConnection(a: AISettings | null, b: AISettings, includeModel = true): boolean {
  return !!a && a.provider === b.provider && a.baseUrl.trim().replace(/\/+$/, '') === b.baseUrl.trim().replace(/\/+$/, '') &&
    a.apiKey === b.apiKey && (!includeModel || a.model.trim() === b.model.trim());
}

const categories: CategoryDefinition[] = [
  { name: 'MMD', description: '使用 MMD 制作的模型舞蹈或演出成片' },
  { name: '绘画', description: '绘画过程、技巧与教学' },
  { name: '科普', description: '科学原理或现象的解释' },
  { name: '不确定', description: '信息不足或无法可靠判断' },
];
const samples = [
  { aid: 1, title: 'MMD 模型舞蹈展示', description: '使用 MMD 制作的三维模型舞蹈成片', tags: ['MMD', '舞蹈'], category: 'MMD' },
  { aid: 2, title: '数字绘画：人物上色教程', description: '演示画笔、配色与人物上色的绘画技巧', tags: ['绘画', '教程'], category: '绘画' },
  { aid: 3, title: '为什么天空是蓝色的？', description: '讲解光的散射及天空颜色的科学原理', tags: ['科普', '物理'], category: '科普' },
];

/** One small synthetic batch exercises the production request and strict result parser. */
export async function testModel(settings: AISettings, provider: AIProvider = defaultAIProvider, hooks: RuntimeHooks = {}): Promise<ModelTestResult> {
  const videos: VideoRecord[] = samples.map(sample => ({
    aid: sample.aid, title: sample.title, description: sample.description, tags: sample.tags,
    sourceFolderIds: [], primarySourceFolderId: 0, metadataFetchedAt: '2026-09-28T00:00:00.000Z',
  }));
  const system = buildSystemPrompt(DEFAULT_SETTINGS.prompt, categories);
  const user = buildUserPrompt(videos, categories);
  const started = Date.now();
  let response;
  try {
    response = provider === defaultAIProvider
      ? await defaultAIProvider.completeWithMetadata(system, user, settings, hooks)
      : { content: await provider.complete(system, user, settings), model: settings.model, usage: undefined };
  } catch (error) {
    hooks.diagnostic?.({ task: 'model-test', phase: 'ai-test', outcome: 'request-error', method: 'POST', endpoint: '/chat/completions', durationMs: Date.now() - started, status: error instanceof AppError ? error.code : undefined, reason: error instanceof AppError ? error.kind : 'network' });
    throw error;
  }
  let parsed;
  try { parsed = parseClassificationBatch(response.content, videos, categories, 0); }
  catch { hooks.diagnostic?.({ task: 'model-test', phase: 'ai-test', outcome: 'output-invalid', method: 'POST', endpoint: '/chat/completions', durationMs: Date.now() - started }); throw new AppError('模型调用成功，但分类格式不合格：需完整返回 3 个视频、有效类别与 0–1 置信度', 'invalid'); }
  hooks.diagnostic?.({ task: 'model-test', phase: 'ai-test', outcome: 'completed', method: 'POST', endpoint: '/chat/completions', durationMs: Date.now() - started });
  return {
    testedAt: new Date().toISOString(), elapsedMs: Date.now() - started,
    correct: parsed.filter(result => samples.find(sample => sample.aid === result.aid)?.category === result.category).length,
    total: samples.length, model: response.model, usage: response.usage,
  };
}
