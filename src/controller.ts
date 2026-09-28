import { get, writable } from 'svelte/store';
import type { AISettings, AppData, Progress, RuntimeHooks, Settings } from './types';
import { GMRepository, loadSettings, saveSettings } from './lib/storage';
import { Logger, sanitizeExport } from './lib/logs';
import { downloadJson } from './lib/download';
import { PauseError, AppError, errorMessage } from './lib/errors';
import { validateManifest } from './lib/manifest';
import { isUserscript } from './lib/gm';
import { Workflow } from './core/workflow';
import { HttpBilibiliAdapter } from './api/bilibili';
import { classifyDataset } from './ai/classifier';
import { normalizeCategoryTable } from './ai/categories';
import { fetchModels } from './ai/provider';
import { testModel, type ModelTestResult } from './ai/model-test';
import { DemoBilibiliAdapter, demoAI } from './demo';

export function createController() {
  const demo = !isUserscript();
  const repository = new GMRepository();
  let settings = loadSettings();
  let busy = false;
  let pauseRequested = false;
  const connectionSecrets = new Set<string>();
  const logger = new Logger(() => [settings.apiKey, ...connectionSecrets]);
  const view = writable({ demo, data: repository.load(), settings, busy: false, pauseRequested: false,
    models: [] as string[], modelsConnection: null as AISettings | null,
    modelTest: null as ModelTestResult | null, testConnection: null as AISettings | null,
    progress: { phase: 'idle', completed: 0, total: 0, message: '准备就绪' } as Progress,
    logs: logger.entries.slice(), error: '', notice: '' });
  const sync = () => view.update(value => ({ ...value, data: structuredClone(workflow.data),
    settings: structuredClone(settings), busy, pauseRequested, logs: logger.entries.slice() }));
  const hooks: RuntimeHooks = {
    checkpoint: () => { if (pauseRequested) throw new PauseError(); },
    progress: progress => { sync(); view.update(value => ({ ...value, progress })); },
    log: (message, level) => { logger.add(message, level); sync(); },
    ...(demo ? { sleep: async () => {} } : {}),
  };
  const adapter = demo ? new DemoBilibiliAdapter() : new HttpBilibiliAdapter(settings, hooks);
  const workflow = new Workflow(adapter, repository, hooks);
  function validateSettings(next: Settings): Settings {
    const result = structuredClone(next);
    result.categories = normalizeCategoryTable(result.categories);
    if (!Number.isFinite(result.confidenceThreshold) || result.confidenceThreshold < 0 || result.confidenceThreshold > 1) throw new AppError('置信度阈值必须在 0–1 之间', 'invalid');
    const ranges: [keyof Settings, number, number][] = [
      ['aiBatchSize', 1, 50], ['copyBatchSize', 1, 12], ['requestDelayMs', 500, 10000],
      ['cooldownMs', 8000, 60000], ['maxRetries', 0, 5], ['verifyRetries', 0, 3],
    ];
    for (const [key, min, max] of ranges) {
      const value = Number(result[key]);
      if (!Number.isInteger(value) || value < min || value > max) throw new AppError(`${key} 必须在 ${min}–${max} 之间`, 'invalid');
    }
    return result;
  }
  async function run(action: () => Promise<unknown>, notice: string) {
    if (busy) return;
    busy = true; pauseRequested = false;
    view.update(value => ({ ...value, busy: true, error: '', notice: '',
      progress: { phase: 'preparing', completed: 0, total: 0, message: '正在准备，请稍候…' } }));
    try { await action(); view.update(value => ({ ...value, notice })); }
    catch (error) {
      const message = sanitizeExport(`${errorMessage(error)}；当前步骤：${get(view).progress.message}`, [settings.apiKey, ...connectionSecrets]);
      logger.add(message, error instanceof PauseError ? 'info' : 'error');
      view.update(value => ({ ...value, error: error instanceof PauseError ? '' : message,
        notice: error instanceof PauseError ? '已暂停并保存，可继续分类或恢复收藏夹执行' : '' }));
    } finally { busy = false; pauseRequested = false; sync(); }
  }
  function persist(next: Settings): void {
    if (busy) throw new AppError('当前操作完成后才能保存设置', 'invalid');
    settings = validateSettings(next); saveSettings(settings); sync();
    // The real adapter reads this settings object on each request.
    Object.assign(adapterSettings, settings);
  }
  const adapterSettings = settings;
  async function classifyAndApply(resume = false) {
    const dataset = workflow.data.dataset;
    if (!workflow.data.state.sourceFrozen || !dataset) throw new AppError('请先冻结源并获取视频信息', 'invalid');
    if (resume && !workflow.data.classificationDraft) throw new AppError('没有可继续的分类进度，请重新分类', 'invalid');
    const manifest = validateManifest(sanitizeExport(await classifyDataset(dataset, settings, hooks,
      demo ? demoAI : undefined, {
        draft: resume ? workflow.data.classificationDraft : undefined,
        save: draft => {
          workflow.data.classificationDraft = sanitizeExport(draft, [settings.apiKey]);
          repository.save(workflow.data); sync();
        },
      }), [settings.apiKey]), dataset);
    // Keep the previous Manifest and generated folders until a complete new result is valid.
    workflow.data.manifest = manifest;
    delete workflow.data.classificationDraft;
    repository.save(workflow.data); sync();
    await workflow.applyManifest(manifest, settings);
  }
  return {
    view,
    save: persist,
    freeze: () => run(() => workflow.freezeSources(), '源收藏夹校验完成'),
    refresh: () => run(() => workflow.refreshDataset(true, settings.metadataCacheTtlMs), '视频信息已刷新'),
    classifyApply: () => run(() => classifyAndApply(), '本轮分类与重建已完成，请查看校验结果'),
    resumeClassification: () => run(() => classifyAndApply(true), '分类已补齐并重建，请查看校验结果'),
    fetchModels: (config: AISettings) => {
      const connection = structuredClone(config);
      connectionSecrets.add(connection.apiKey);
      return run(async () => {
        view.update(value => ({ ...value, models: [], modelsConnection: null }));
        hooks.progress?.({ phase: 'models', completed: 0, total: 1, message: '正在获取模型列表…' });
        const models = demo ? ['demo-model', 'demo-alternative'] : await fetchModels(connection);
        view.update(value => ({ ...value, models, modelsConnection: connection }));
        hooks.progress?.({ phase: 'models', completed: 1, total: 1, message: `已获取 ${models.length} 个模型` });
      }, '模型列表已更新，可搜索选择或手动填写');
    },
    testModel: (config: AISettings) => {
      const connection = structuredClone(config);
      connectionSecrets.add(connection.apiKey);
      return run(async () => {
        view.update(value => ({ ...value, modelTest: null, testConnection: null }));
        hooks.progress?.({ phase: 'model-test', completed: 0, total: 1, message: '正在测试模型调用与分类格式…' });
        const modelTest = await testModel(connection, demo ? demoAI : undefined);
        view.update(value => ({ ...value, modelTest, testConnection: connection }));
        hooks.progress?.({ phase: 'model-test', completed: 1, total: 1, message: '模型调用与分类格式测试通过' });
      }, '模型测试已完成，结果见「模型连接」区域');
    },
    reapply: () => run(async () => {
      if (!workflow.data.manifest) throw new AppError('当前没有 Manifest', 'invalid');
      await workflow.applyManifest(workflow.data.manifest, settings);
    }, '当前 Manifest 已重新应用'),
    resume: () => run(() => workflow.resume(settings), '恢复执行结束，请查看校验结果'),
    retry: () => run(() => workflow.retryFailed(settings), '失败项重试结束，请查看校验结果'),
    cleanup: () => run(() => workflow.cleanupGenerated(), '上一轮生成结果已清理'),
    pause: () => { if (busy) { pauseRequested = true; sync(); } },
    async importManifest(file: File) {
      if (busy) throw new AppError('请先等待当前操作结束', 'invalid');
      const manifest = validateManifest(JSON.parse(await file.text()), workflow.data.dataset);
      workflow.data.manifest = manifest;
      delete workflow.data.classificationDraft;
      repository.save(workflow.data); sync();
      view.update(value => ({ ...value, notice: 'Manifest 已载入，可应用或检查是否能继续旧执行', error: '' }));
    },
    export(kind: 'dataset' | 'manifest' | 'logs') {
      const payload = kind === 'logs' ? logger.export() : kind === 'dataset' ? workflow.data.dataset : workflow.data.manifest;
      if (!payload) throw new AppError('当前没有可导出的数据', 'invalid');
      downloadJson(kind === 'dataset' ? 'video-dataset.json' : kind === 'manifest' ? 'classification-manifest.json' : 'bilfav-logs.json', sanitizeExport(payload, [settings.apiKey]));
    },
  };
}
export type Controller = ReturnType<typeof createController>;
export type ControllerData = AppData;
