import { UNCERTAIN, type ClassificationManifest, type VideoDataset } from '../types';
import { AppError } from './errors';

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
export async function manifestHash(manifest: ClassificationManifest): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(manifest)));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
export function validateManifest(input: unknown, dataset?: VideoDataset): ClassificationManifest {
  const fail = (message: string): never => { throw new AppError(`Manifest 无效：${message}`, 'invalid'); };
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('必须为 JSON 对象');
  const obj = input as Record<string, unknown>;
  if (obj.version !== 1 || typeof obj.runId !== 'string' || !obj.runId.trim()) fail('版本或 runId 不合法');
  if (typeof obj.createdAt !== 'string' || !Number.isFinite(Date.parse(obj.createdAt))) fail('创建时间不合法');
  if (!Number.isSafeInteger(obj.datasetVersion) || Number(obj.datasetVersion) < 1 || typeof obj.datasetUpdatedAt !== 'string' || !Number.isFinite(Date.parse(obj.datasetUpdatedAt))) fail('数据集标识不合法');
  if (typeof obj.confidenceThreshold !== 'number' || !Number.isFinite(obj.confidenceThreshold) || obj.confidenceThreshold < 0 || obj.confidenceThreshold > 1) fail('阈值不合法');
  if ((obj.promptVersion !== 1 && obj.promptVersion !== 2) || typeof obj.prompt !== 'string') fail('Prompt 信息不合法');
  if (!Array.isArray(obj.categories) || !obj.categories.length) fail('分类表为空');
  const names = new Set<string>();
  const unsafe = new Set(['__proto__', 'constructor', 'prototype']);
  for (const category of obj.categories as unknown[]) {
    if (!category || typeof category !== 'object') fail('分类格式不合法');
    const c = category as Record<string, unknown>;
    if (typeof c.name !== 'string' || !c.name.trim() || c.name !== c.name.trim() || typeof c.description !== 'string' || unsafe.has(c.name) || names.has(c.name)) fail('分类名称重复或不合法');
    names.add(c.name as string);
  }
  if (!names.has(UNCERTAIN)) fail('缺少保留类别“不确定”');
  if (!Array.isArray(obj.results)) fail('缺少分类结果');
  const seen = new Set<number>();
  const stats: Record<string, number> = Object.fromEntries([...names].map(name => [name, 0]));
  const results = (obj.results as unknown[]).map(item => {
    if (!item || typeof item !== 'object') fail('结果格式不合法');
    const r = item as Record<string, unknown>;
    if (!Number.isSafeInteger(r.aid) || Number(r.aid) <= 0 || seen.has(Number(r.aid))) fail('aid 无效或重复');
    if (typeof r.category !== 'string' || !names.has(r.category)) fail('结果包含未知类别');
    if (typeof r.confidence !== 'number' || !Number.isFinite(r.confidence) || r.confidence < 0 || r.confidence > 1) fail('置信度无效');
    if (r.category !== UNCERTAIN && Number(r.confidence) < Number(obj.confidenceThreshold)) fail('结果低于置信度阈值');
    if (r.bvid !== undefined && typeof r.bvid !== 'string') fail('bvid 无效');
    if (r.reason !== undefined && typeof r.reason !== 'string') fail('理由格式不合法');
    seen.add(Number(r.aid)); stats[r.category as string]++;
    return { aid: Number(r.aid), ...(r.bvid ? { bvid: String(r.bvid) } : {}), category: String(r.category), confidence: Number(r.confidence), ...(r.reason ? { reason: String(r.reason) } : {}) };
  });
  if (dataset) {
    if (obj.datasetVersion !== dataset.version || obj.datasetUpdatedAt !== dataset.updatedAt) fail('与当前数据集版本不一致，请重新分类');
    const datasetAids = new Set(dataset.videos.map(video => video.aid));
    // Legacy manifests may contain unavailable records. Keep their normalized
    // contents for resume hashes, but only require coverage of available videos.
    if (results.some(result => !datasetAids.has(result.aid)) || dataset.videos.some(video => !video.unavailable && !seen.has(video.aid))) fail('必须完整覆盖当前可用数据集且每个 aid 恰好一次');
  }
  return {
    version: 1, runId: obj.runId as string, createdAt: obj.createdAt as string,
    datasetVersion: obj.datasetVersion as number, datasetUpdatedAt: obj.datasetUpdatedAt as string,
    categories: (obj.categories as { name: string; description: string }[]).map(c => ({ name: c.name, description: c.description })),
    confidenceThreshold: obj.confidenceThreshold as number, promptVersion: obj.promptVersion as number, prompt: obj.prompt as string, results, stats,
  };
}
