import { get, writable } from 'svelte/store';
import type { AppData, Progress, RuntimeHooks, Settings } from './types';
import { GMRepository, loadSettings, saveSettings } from './lib/storage';
import { Logger, sanitizeExport } from './lib/logs';
import { downloadJson } from './lib/download';
import { PauseError, AppError, errorMessage } from './lib/errors';
import { validateManifest } from './lib/manifest';
import { isUserscript } from './lib/gm';
import { Workflow } from './core/workflow';
import { HttpBilibiliAdapter } from './api/bilibili';
import { classifyDataset, validateCategories } from './ai/classifier';
import { DemoBilibiliAdapter, demoAI } from './demo';

export function createController() {
  const demo = !isUserscript();
  const repository = new GMRepository();
  let settings = loadSettings();
  let busy = false;
  let pauseRequested = false;
  const logger = new Logger(() => [settings.apiKey]);
  const view = writable({ demo, data: repository.load(), settings, busy: false, pauseRequested: false,
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
    result.categories = validateCategories(result.categories);
    if (!Number.isFinite(result.confidenceThreshold) || result.confidenceThreshold < 0 || result.confidenceThreshold > 1) throw new AppError('置信度阈值必须在 0–1 之间', 'invalid');
    const ranges: [keyof Settings, number, number][] = [
      ['aiBatchSize', 1, 100], ['copyBatchSize', 1, 12], ['requestDelayMs', 500, 10000],
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
      const message = sanitizeExport(`${errorMessage(error)}；当前步骤：${get(view).progress.message}`, [settings.apiKey]);
      logger.add(message, error instanceof PauseError ? 'info' : 'error');
      view.update(value => ({ ...value, error: error instanceof PauseError ? '' : message,
        notice: error instanceof PauseError ? '已暂停；应用阶段可从已保存进度继续' : '' }));
    } finally { busy = false; pauseRequested = false; sync(); }
  }
  function persist(next: Settings): void {
    if (busy) throw new AppError('当前操作完成后才能保存设置', 'invalid');
    settings = validateSettings(next); saveSettings(settings); sync();
    // The real adapter reads this settings object on each request.
    Object.assign(adapterSettings, settings);
  }
  const adapterSettings = settings;
  return {
    view,
    save: persist,
    freeze: () => run(() => workflow.freezeSources(), '源收藏夹校验完成'),
    refresh: () => run(() => workflow.refreshDataset(true, settings.metadataCacheTtlMs), '视频信息已刷新'),
    classifyApply: () => run(async () => {
      if (!workflow.data.state.sourceFrozen || !workflow.data.dataset) throw new AppError('请先冻结源并获取视频信息', 'invalid');
      const manifest = sanitizeExport(await classifyDataset(workflow.data.dataset, settings, hooks, demo ? demoAI : undefined), [settings.apiKey]);
      workflow.data.manifest = manifest; repository.save(workflow.data); sync();
      await workflow.applyManifest(manifest, settings);
    }, '分类与应用已完成，请查看校验结果'),
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
      workflow.data.manifest = manifest; repository.save(workflow.data); sync();
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
