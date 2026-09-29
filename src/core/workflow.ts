import { BatchExecutor } from './batch-executor';
import { DEFAULT_SETTINGS } from '../defaults';
import { AppError, PauseError, errorMessage } from '../lib/errors';
import { emptyExecution } from '../lib/storage';
import { manifestHash, validateManifest } from '../lib/manifest';
import { UNCERTAIN, type AppData, type BilibiliAdapter, type ClassificationManifest, type CopyItem, type RefreshMode,
  type ExecutionPhase, type Folder, type FolderId, type RuntimeHooks, type Settings, type VerificationReport,
  type VideoDataset, type VideoMetadata, type VideoRecord } from '../types';

const OLD_SUFFIX = '-旧';

/** Coordinates durable source freeze, dataset refresh, rebuild, resume, and verification. */
export class Workflow {
  public data: AppData;

  constructor(
    private readonly adapter: BilibiliAdapter,
    private readonly repository: { load(): AppData; save(data: AppData): void },
    private readonly hooks: RuntimeHooks = {},
  ) {
    this.data = repository.load();
  }

  async freezeSources(options: { maxRetries?: number; cooldownMs?: number } = {}): Promise<void> {
    const state = this.data.state;
    const canBindOwner = !state.ownerMid && !state.sourceFrozen && !state.freezePending && state.sourceFolderIds.length === 0;
    await this.assertOwner(canBindOwner);

    if (state.sourceFrozen) {
      await this.validateSourcesForOwner();
      return;
    }

    if (!state.freezePending) {
      const folders = await this.adapter.listFolders();
      const sources = uniqueFolders(folders.filter(folder => !folder.isDefault));
      state.sourceFolderIds = sources.map(folder => folder.id);
      state.sourceFoldersSnapshot = sources.map(folder => ({
        id: folder.id,
        originalTitle: folder.title,
        frozenTitle: folder.title.endsWith(OLD_SUFFIX) ? folder.title : `${folder.title}${OLD_SUFFIX}`,
        mediaCount: folder.mediaCount,
        renamed: folder.title.endsWith(OLD_SUFFIX),
      }));
      state.freezePending = true;
      this.persist();
    }

    const folders = await this.adapter.listFolders();
    const byId = new Map(folders.map(folder => [folder.id, folder]));
    for (const snapshot of state.sourceFoldersSnapshot) {
      this.checkpoint();
      const current = byId.get(snapshot.id);
      if (!current) throw safety(`源收藏夹 ID ${snapshot.id} 在冻结过程中消失`);
      if (current.isDefault) throw safety(`源收藏夹 ID ${snapshot.id} 被识别为默认收藏夹，已停止冻结`);
      if (snapshot.renamed && current.title === snapshot.frozenTitle) { this.progress('freezing', state.sourceFoldersSnapshot.filter(item => item.renamed).length, state.sourceFoldersSnapshot.length, `已确认：${snapshot.frozenTitle}（ID ${snapshot.id}）`); continue; }

      // A previous rename may have succeeded even if the page stopped before
      // persisting its acknowledgement. Reconcile by the recorded ID.
      if (current.title !== snapshot.frozenTitle) {
        const retries = Math.max(0, Math.min(5, Math.floor(options.maxRetries ?? DEFAULT_SETTINGS.maxRetries)));
        for (let attempt = 1; ; attempt++) {
          this.progress('freezing', state.sourceFoldersSnapshot.filter(item => item.renamed).length, state.sourceFoldersSnapshot.length,
            `正在冻结 ${state.sourceFoldersSnapshot.filter(item => item.renamed).length + 1}/${state.sourceFoldersSnapshot.length}：${snapshot.originalTitle}（ID ${snapshot.id}）`);
          try { this.hooks.requestContext = { folderId: snapshot.id }; await this.adapter.renameFolder(snapshot.id, snapshot.frozenTitle); break; }
          catch (error) {
            if (!isRetryableRename(error)) throw error;
            const latest = (await this.refreshFolders()).find(folder => folder.id === snapshot.id);
            if (!latest) throw safety(`源收藏夹 ID ${snapshot.id} 在改名后消失`);
            if (latest.title === snapshot.frozenTitle) break;
            if (attempt > retries) throw error;
            const waitMs = Math.min(60_000, Math.max(options.cooldownMs ?? 0, 1000 * 2 ** (attempt - 1)));
            this.hooks.log?.(`改名响应失败，${Math.ceil(waitMs / 1000)} 秒后重试收藏夹 ${snapshot.originalTitle}（ID ${snapshot.id}）`, 'warning');
            this.hooks.diagnostic?.({ task: 'freeze', phase: 'rename', outcome: 'retry', folderId: snapshot.id, attempt, waitMs, reason: errorMessage(error) });
            this.progress('freezing', state.sourceFoldersSnapshot.filter(item => item.renamed).length, state.sourceFoldersSnapshot.length, `等待 ${Math.ceil(waitMs / 1000)} 秒后重试：${snapshot.originalTitle}（ID ${snapshot.id}）`);
            await (this.hooks.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms))))(waitMs);
          } finally {
            delete this.hooks.requestContext;
          }
        }
      }
      snapshot.renamed = true;
      this.persist();
      this.progress('freezing', state.sourceFoldersSnapshot.filter(item => item.renamed).length, state.sourceFoldersSnapshot.length, `已冻结：${snapshot.frozenTitle}（ID ${snapshot.id}）`);
    }

    const confirmed = new Map((await this.refreshFolders()).map(folder => [folder.id, folder]));
    for (const snapshot of state.sourceFoldersSnapshot) {
      const folder = confirmed.get(snapshot.id);
      if (!folder || folder.isDefault || folder.title !== snapshot.frozenTitle) {
        const target = state.sourceFoldersSnapshot.find(item => item.id === snapshot.id);
        if (target) target.renamed = false;
        this.persist();
        throw safety(`冻结复核失败：${snapshot.originalTitle}（ID ${snapshot.id}）`);
      }
    }

    state.sourceFrozen = true;
    state.freezePending = false;
    state.frozenAt = this.now().toISOString();
    this.persist();
  }

  async validateSources(): Promise<Folder[]> {
    await this.assertOwner(false);
    return this.validateSourcesForOwner();
  }

  async refreshDataset(modeOrForce: RefreshMode | boolean = 'full', ttlMs = 86400000): Promise<VideoDataset> {
    await this.assertOwner(false);
    await this.validateSourcesForOwner();

    const mode: RefreshMode = typeof modeOrForce === 'boolean' ? (modeOrForce ? 'full' : 'incremental') : modeOrForce;
    const oldDataset = this.data.dataset;
    const sourceIds = [...this.data.state.sourceFolderIds];
    const signature = JSON.stringify({ ownerMid: this.data.state.ownerMid, mode, sourceIds, baseVersion: oldDataset?.version ?? 0, baseUpdatedAt: oldDataset?.updatedAt ?? '' });
    const draft = this.data.refreshDraft?.signature === signature ? this.data.refreshDraft : undefined;
    this.adapter.beginRefreshTask?.();
    const ttl = Math.max(0, ttlMs);

    const sourceVideos = new Map<number, { video: { aid: number; bvid?: string; title: string; description?: string; upper?: { mid?: number; name?: string }; duration?: number; unavailable?: boolean }; sourceFolderIds: number[]; primarySourceFolderId: number }>();
    const unavailableAids = new Set<number>();
    // Build locally and only replace the saved dataset after every source page
    // and every retryable metadata request has completed successfully.
    let foldersRead = 0;
    for (const sourceId of this.data.state.sourceFolderIds) {
      this.checkpoint();
      this.progress('scanning', foldersRead, this.data.state.sourceFolderIds.length, `正在扫描源收藏夹 ${foldersRead + 1}/${this.data.state.sourceFolderIds.length}（ID ${sourceId}）`);
      this.hooks.requestContext = { folderId: sourceId };
      let folderVideos;
      try { folderVideos = await this.adapter.listFolderVideos(sourceId); }
      finally { delete this.hooks.requestContext; }
      const seenInFolder = new Set<number>();
      for (const video of folderVideos) {
        if (video.unavailable) {
          unavailableAids.add(video.aid);
          continue;
        }
        if (!Number.isSafeInteger(video.aid) || video.aid <= 0 || seenInFolder.has(video.aid)) continue;
        seenInFolder.add(video.aid);
        const prior = sourceVideos.get(video.aid);
        if (prior) {
          if (!prior.sourceFolderIds.includes(sourceId)) prior.sourceFolderIds.push(sourceId);
        } else {
          sourceVideos.set(video.aid, { video, sourceFolderIds: [sourceId], primarySourceFolderId: sourceId });
        }
      }
      foldersRead++;
    }

    this.hooks.log?.(`已扫描 ${foldersRead} 个源收藏夹，去重后 ${sourceVideos.size} 个视频；开始获取详情与完整标签`, 'info');
    const fetchedAt = this.now().toISOString();
    const videos: VideoRecord[] = [];
    let metadataCompleted = 0;
    const draftByAid = new Map((draft?.completed ?? []).map(video => [video.aid, video]));
    const oldByAid = new Map((oldDataset?.videos ?? []).filter(video => !video.unavailable).map(video => [video.aid, video]));
    let reused = 0, fetched = 0;
    this.data.refreshDraft = draft ?? { signature, mode, baseVersion: oldDataset?.version ?? 0, baseUpdatedAt: oldDataset?.updatedAt ?? '', completed: [] };
    this.persist();
    let metadataIndex = 0;
    try { for (const [aid, row] of sourceVideos) {
      this.checkpoint();
      this.progress('metadata', metadataIndex, sourceVideos.size, `正在处理视频信息 ${++metadataIndex}/${sourceVideos.size}（aid ${aid}）`);
      if (unavailableAids.has(aid) || this.adapter.isVideoUnavailable?.(aid)) {
        unavailableAids.add(aid);
        metadataCompleted++;
        continue;
      }
      const cached = draftByAid.get(aid) ?? (mode === 'incremental' ? oldByAid.get(aid) : undefined);
      let metadata: VideoMetadata;
      const cachedAt = cached ? Date.parse(cached.metadataFetchedAt) : Number.NaN;
      const cacheFresh = Boolean(cached && !cached.unavailable && Number.isFinite(cachedAt) && (mode === 'incremental' || this.now().getTime() - cachedAt < ttl));
      if (cacheFresh && cached) {
        metadata = {
          aid, bvid: cached.bvid, title: cached.title, description: cached.description,
          tags: [...cached.tags], tname: cached.tname, tid: cached.tid, tidV2: cached.tidV2,
          upper: cached.upper ? { ...cached.upper } : undefined, duration: cached.duration,
        };
        videos.push({ ...metadata, sourceFolderIds: [...row.sourceFolderIds], primarySourceFolderId: row.primarySourceFolderId, metadataFetchedAt: cached.metadataFetchedAt });
        reused++;
        metadataCompleted++;
        this.hooks.diagnostic?.({ task: 'refresh', phase: 'metadata', outcome: 'reused', aid, folderId: row.primarySourceFolderId });
        continue;
      }

      this.hooks.requestContext = { folderId: row.primarySourceFolderId, aid };
      try {
        metadata = await this.adapter.getVideoMetadata(aid, row.video.bvid);
      } catch (error) {
        if (!isUnavailable(error)) { this.hooks.diagnostic?.({ task: 'refresh', phase: 'metadata', outcome: 'failed', aid, folderId: row.primarySourceFolderId, reason: errorMessage(error) }); throw error; }
        unavailableAids.add(aid);
        metadataCompleted++;
        this.hooks.diagnostic?.({ task: 'refresh', phase: 'metadata', outcome: 'unavailable', aid, folderId: row.primarySourceFolderId });
        continue;
      } finally {
        delete this.hooks.requestContext;
      }
      if (metadata.unavailable) {
        unavailableAids.add(aid);
        metadataCompleted++;
        this.hooks.diagnostic?.({ task: 'refresh', phase: 'metadata', outcome: 'unavailable', aid, folderId: row.primarySourceFolderId });
        continue;
      }

      const record: VideoRecord = {
        aid,
        bvid: metadata.bvid ?? row.video.bvid,
        title: metadata.title ?? row.video.title,
        description: metadata.description ?? row.video.description ?? '',
        tags: Array.isArray(metadata.tags) ? [...metadata.tags] : [],
        tname: metadata.tname,
        tid: metadata.tid,
        tidV2: metadata.tidV2,
        upper: metadata.upper ? { ...metadata.upper } : row.video.upper ? { ...row.video.upper } : undefined,
        duration: metadata.duration ?? row.video.duration,
        sourceFolderIds: [...row.sourceFolderIds],
        primarySourceFolderId: row.primarySourceFolderId,
        metadataFetchedAt: fetchedAt,
      };
      videos.push(record);
      fetched++;
      metadataCompleted++;
      this.hooks.diagnostic?.({ task: 'refresh', phase: 'metadata', outcome: 'fetched', aid, folderId: row.primarySourceFolderId });
      draftByAid.set(aid, record);
      this.data.refreshDraft.completed = [...draftByAid.values()];
      if (fetched % 10 === 0) this.persist();
    } } catch (error) { this.data.refreshDraft.completed = [...draftByAid.values()]; this.persist(); throw error; }

    const unchanged = mode === 'incremental' && oldDataset && sameDatasetContent(oldDataset.videos, videos) && sameIds(oldDataset.sourceFolderIds, sourceIds);
    const dataset: VideoDataset = unchanged ? oldDataset : {
      version: unchanged ? oldDataset.version : (oldDataset?.version ?? 0) + 1,
      updatedAt: unchanged ? oldDataset.updatedAt : this.now().toISOString(),
      sourceFolderIds: sourceIds,
      videos,
    };
    this.data.dataset = dataset;
    this.data.refreshSummary = { mode, completedAt: this.now().toISOString(), fetched, reused, excluded: unavailableAids.size, total: videos.length };
    delete this.data.refreshDraft;
    if (!unchanged && this.data.classificationDraft) this.hooks.log?.('视频数据已变化，之前的分类进度不再适用；请重新分类', 'warning');
    this.persist();
    if (unavailableAids.size) this.hooks.log?.(`已跳过 ${unavailableAids.size} 个失效视频，不参与分类或复制`, 'info');
    this.hooks.log?.(`获取完成：模式 ${mode}，${mode === 'full' ? '重新获取' : '新增'} ${fetched}，复用 ${reused}，失效/排除 ${unavailableAids.size}，总计 ${videos.length}`, 'info');
    this.progress('dataset', metadataCompleted, sourceVideos.size, `获取完成：处理 ${metadataCompleted}/${sourceVideos.size}，可用 ${videos.length}，${mode === 'full' ? '重新获取' : '新增'} ${fetched}，复用 ${reused}，排除 ${unavailableAids.size}`);
    return dataset;
  }

  async applyManifest(manifest: ClassificationManifest, settings: Settings): Promise<VerificationReport> {
    await this.assertOwner(false);
    await this.validateSourcesForOwner();
    const dataset = this.requireDataset();
    const validated = validateManifest(manifest, dataset);
    const hash = await manifestHash(validated);

    // Persist the validated manifest before any generated-folder deletion.
    this.data.manifest = validated;
    this.data.state.execution = {
      ...emptyExecution(), runId: validated.runId, manifestHash: hash, phase: 'preparing',
    };
    this.persist();
    return this.runFromPhase(settings, 'preparing');
  }

  async resume(settings: Settings): Promise<VerificationReport> {
    await this.assertOwner(false);
    await this.validateSourcesForOwner();
    const manifest = this.requireManifest();
    const dataset = this.requireDataset();
    const validated = validateManifest(manifest, dataset);
    const hash = await manifestHash(validated);
    const execution = this.data.state.execution;
    if (!execution.manifestHash || execution.manifestHash !== hash || execution.runId !== validated.runId) {
      throw new AppError('保存的 Manifest 与中断任务不一致，已保留原执行状态；请显式重新应用当前 Manifest', 'invalid');
    }
    const phase = execution.phase === 'paused' || execution.phase === 'failed' ? execution.resumePhase : execution.phase;
    if (!phase || !['preparing', 'cleanup', 'creating', 'copying', 'verifying'].includes(phase)) {
      throw new AppError('当前没有可恢复的未完成执行', 'invalid');
    }
    return this.runFromPhase(settings, phase);
  }

  async retryFailed(settings: Settings): Promise<VerificationReport> {
    await this.assertOwner(false);
    await this.validateSourcesForOwner();
    const manifest = this.requireManifest();
    const dataset = this.requireDataset();
    const validated = validateManifest(manifest, dataset);
    const hash = await manifestHash(validated);
    const execution = this.data.state.execution;
    if (execution.manifestHash !== hash || execution.runId !== validated.runId) {
      throw new AppError('Manifest 已变化，不能重试旧任务的失败项', 'invalid');
    }
    const resumePhase = execution.phase === 'paused' || execution.phase === 'failed' ? execution.resumePhase : execution.phase;
    if (resumePhase === 'cleanup' || resumePhase === 'creating' || resumePhase === 'preparing') {
      return this.runFromPhase(settings, resumePhase);
    }

    execution.phase = 'copying';
    execution.resumePhase = undefined;
    this.persist();
    try {
      await this.copyRemaining(settings, validated);
      return await this.verifyAndRetry(settings, validated);
    } catch (error) {
      return this.recordExecutionError(error, 'copying');
    }
  }

  async cleanupGenerated(): Promise<void> {
    await this.assertOwner(false);
    await this.validateSourcesForOwner();
    try {
      await this.cleanupGeneratedInternal();
      this.data.state.execution = emptyExecution();
      this.persist();
    } catch (error) {
      this.data.state.execution.error = errorMessage(error);
      this.persist();
      throw error;
    }
  }

  async verify(settings: Settings): Promise<VerificationReport> {
    await this.assertOwner(false);
    await this.validateSourcesForOwner();
    const manifest = validateManifest(this.requireManifest(), this.requireDataset());
    const hash = await manifestHash(manifest);
    if (this.data.state.execution.manifestHash !== hash) throw new AppError('Manifest 与当前执行状态不一致，不能校验旧目标', 'invalid');
    this.data.state.execution.phase = 'verifying';
    this.persist();
    try {
      return await this.verifyAndRetry(settings, manifest);
    } catch (error) {
      return this.recordExecutionError(error, 'verifying');
    }
  }

  private async runFromPhase(settings: Settings, startPhase: ExecutionPhase): Promise<VerificationReport> {
    let phase: ExecutionPhase = startPhase;
    try {
      while (true) {
        this.data.state.execution.phase = phase;
        this.data.state.execution.resumePhase = undefined;
        this.data.state.execution.error = undefined;
        this.persist();
        if (phase === 'preparing') {
          await this.captureSourceBefore();
          phase = 'cleanup';
        } else if (phase === 'cleanup') {
          await this.cleanupGeneratedInternal();
          phase = 'creating';
        } else if (phase === 'creating') {
          await this.createTargets(this.categoriesInManifest());
          phase = 'copying';
        } else if (phase === 'copying') {
          await this.copyRemaining(settings, this.requireManifest());
          phase = 'verifying';
        } else if (phase === 'verifying') {
          return await this.verifyAndRetry(settings, this.requireManifest());
        } else {
          throw new AppError(`无法从阶段 ${phase} 继续执行`, 'invalid');
        }
      }
    } catch (error) {
      if (isPause(error)) {
        this.data.state.execution.phase = 'paused';
        this.data.state.execution.resumePhase = phase;
        this.data.state.execution.error = errorMessage(error);
        this.persist();
        throw error;
      }
      this.data.state.execution.phase = 'failed';
      this.data.state.execution.resumePhase = phase;
      this.data.state.execution.error = errorMessage(error);
      this.persist();
      throw error;
    }
  }

  private async captureSourceBefore(): Promise<void> {
    const execution = this.data.state.execution;
    for (const sourceId of this.data.state.sourceFolderIds) {
      this.checkpoint();
      const key = String(sourceId);
      if (Object.prototype.hasOwnProperty.call(execution.sourceBefore, key)) continue;
      const aids = await this.adapter.getFolderAidSet(sourceId);
      execution.sourceBefore[key] = sorted(aids);
      this.syncUnavailableVideos();
      this.persist();
    }
  }

  private async cleanupGeneratedInternal(): Promise<void> {
    const recorded = Object.entries(this.data.state.generatedFolderIds);
    const folders = await this.adapter.listFolders();
    const byId = new Map(folders.map(folder => [folder.id, folder]));
    const sourceIds = new Set(this.data.state.sourceFolderIds);
    const ids = recorded.map(([category, id]) => ({ category, id }));

    // Validate the full deletion set before the first delete call.
    for (const entry of ids) {
      if (!Number.isSafeInteger(entry.id) || entry.id <= 0) throw safety(`生成收藏夹“${entry.category}”记录了无效 ID`);
      if (sourceIds.has(entry.id)) throw safety(`生成收藏夹 ID ${entry.id} 与冻结源 ID 冲突，拒绝清理`);
      if (byId.get(entry.id)?.isDefault) throw safety(`生成收藏夹 ID ${entry.id} 是默认收藏夹，拒绝清理`);
    }

    let completed = 0;
    for (const { category, id } of ids) {
      this.checkpoint();
      if (!byId.has(id)) {
        // The complete folder list confirms this recorded generated ID is gone.
        delete this.data.state.generatedFolderIds[category];
        delete this.data.state.execution.targetFolderIds[category];
        this.persist();
        completed++;
        this.progress('cleanup', completed, ids.length, `已确认生成收藏夹 ${category} 不存在`);
        continue;
      }
      await this.adapter.deleteFolder(id);
      delete this.data.state.generatedFolderIds[category];
      delete this.data.state.execution.targetFolderIds[category];
      this.persist();
      completed++;
      this.progress('cleanup', completed, ids.length, `已清理生成收藏夹 ${category}`);
    }
  }

  private async createTargets(categories: string[]): Promise<void> {
    const execution = this.data.state.execution;
    const folders = await this.adapter.listFolders();
    const byId = new Map(folders.map(folder => [folder.id, folder]));
    const sourceIds = new Set(this.data.state.sourceFolderIds);

    for (const category of categories) {
      this.checkpoint();
      const existingId = execution.targetFolderIds[category];
      if (existingId !== undefined) {
        if (!Number.isSafeInteger(existingId) || sourceIds.has(existingId) || byId.get(existingId)?.isDefault) {
          throw safety(`目标分类“${category}”的收藏夹 ID 无效或受保护`);
        }
        if (byId.has(existingId)) {
          this.data.state.generatedFolderIds[category] = existingId;
          this.persist();
          continue;
        }
        // A successful list confirms a previously created target was removed.
        delete execution.targetFolderIds[category];
        delete this.data.state.generatedFolderIds[category];
        this.persist();
      }

      const folder = await this.adapter.createFolder(category);
      if (!Number.isSafeInteger(folder.id) || folder.id <= 0 || folder.isDefault || sourceIds.has(folder.id) || byId.has(folder.id)) {
        throw safety(`新建分类“${category}”返回了无效或受保护的收藏夹 ID`);
      }
      execution.targetFolderIds[category] = folder.id;
      this.data.state.generatedFolderIds[category] = folder.id;
      byId.set(folder.id, folder);
      this.persist();
      this.progress('creating', Object.keys(execution.targetFolderIds).length, categories.length, `已创建目标收藏夹 ${category}`);
    }
  }

  private async copyRemaining(settings: Settings, manifest: ClassificationManifest): Promise<void> {
    const dataset = this.requireDataset();
    const execution = this.data.state.execution;
    // Recheck sources before a copy or resumed copy: cached metadata cannot
    // make a video eligible once the list has confirmed it is unavailable.
    for (const sourceId of this.data.state.sourceFolderIds) {
      this.checkpoint();
      await this.adapter.getFolderAidSet(sourceId);
    }
    this.syncUnavailableVideos();
    const byAid = new Map(dataset.videos.map(video => [video.aid, video]));
    const copyItems = manifest.results.flatMap(result => {
      const video = byAid.get(result.aid);
      if (!video || video.unavailable) return [];
      const targetId = execution.targetFolderIds[result.category];
      if (!targetId) throw safety(`分类“${result.category}”没有持久化的目标收藏夹 ID`);
      if (!this.data.state.sourceFolderIds.includes(video.primarySourceFolderId) || !video.sourceFolderIds.includes(video.primarySourceFolderId)) {
        throw safety(`视频 ${video.aid} 的 primary source 不属于冻结源 ID 集合`);
      }
      return [{ aid: video.aid, category: result.category, sourceId: video.primarySourceFolderId, targetId } satisfies CopyItem];
    });

    const targetSets = await this.readTargetSets(execution.targetFolderIds);
    const toCopy: CopyItem[] = [];
    for (const item of copyItems) {
      if (targetSets.get(item.category)?.has(item.aid)) {
        this.markCopied(item);
      } else {
        if (!execution.pendingAids.includes(item.aid)) execution.pendingAids.push(item.aid);
        toCopy.push(item);
      }
    }
    this.persist();
    if (!toCopy.length) return;

    const executor = new BatchExecutor(this.adapter, batchOptions(settings), this.hooks);
    await executor.execute(toCopy,
      item => this.markCopied(item),
      (item, error, attempts) => {
        execution.pendingAids = execution.pendingAids.filter(aid => aid !== item.aid);
        execution.failedItems = execution.failedItems.filter(failed => failed.aid !== item.aid);
        execution.failedItems.push({ aid: item.aid, category: item.category, error, attempts });
        this.persist();
      });
    execution.retryCount += executor.retryCount;
    this.persist();
  }

  private async verifyAndRetry(settings: Settings, manifest: ClassificationManifest): Promise<VerificationReport> {
    const retries = Math.max(0, Math.floor(settings.verifyRetries));
    let report = await this.computeVerification(manifest);
    for (let attempt = 0; attempt < retries && reportMissingCount(report) > 0; attempt++) {
      this.checkpoint();
      const missing = this.missingCopyItems(report);
      if (!missing.length) break;
      const executor = new BatchExecutor(this.adapter, batchOptions(settings), this.hooks);
      await executor.execute(missing,
        item => this.markCopied(item),
        (item, error, attempts) => {
          const execution = this.data.state.execution;
          execution.failedItems = execution.failedItems.filter(failed => failed.aid !== item.aid);
          execution.failedItems.push({ aid: item.aid, category: item.category, error, attempts });
          this.persist();
        });
      this.data.state.execution.retryCount += executor.retryCount;
      this.persist();
      report = await this.computeVerification(manifest);
    }

    const execution = this.data.state.execution;
    execution.verification = report;
    execution.phase = report.passed ? 'completed' : 'failed';
    execution.resumePhase = report.passed ? undefined : 'verifying';
    execution.error = report.passed ? undefined : '验证未通过：存在缺失、额外、错类视频或源内容减少';
    execution.pendingAids = reportMissingAids(report);
    execution.failedItems = execution.failedItems.filter(item => execution.pendingAids.includes(item.aid));
    this.persist();
    this.progress('verifying', report.copied, report.total, report.passed ? '验证通过' : '验证未通过');
    return report;
  }

  private async computeVerification(manifest: ClassificationManifest): Promise<VerificationReport> {
    const dataset = this.requireDataset();
    const execution = this.data.state.execution;
    const targetSets = await this.readTargetSets(execution.targetFolderIds);
    const sourceSets = new Map<FolderId, Set<number>>();
    for (const sourceId of this.data.state.sourceFolderIds) {
      this.checkpoint();
      sourceSets.set(sourceId, await this.adapter.getFolderAidSet(sourceId));
    }
    this.syncUnavailableVideos();
    const availableByAid = new Map(dataset.videos.filter(video => !video.unavailable).map(video => [video.aid, video]));
    const unavailableAids = new Set(dataset.videos.filter(video => video.unavailable).map(video => video.aid));
    const resultByAid = new Map(manifest.results.map(result => [result.aid, result]));
    const categories = [...new Set([...this.categoriesInManifest(), ...Object.keys(execution.targetFolderIds)])];
    const perCategory: VerificationReport['perCategory'] = {};
    const wrongCategory: VerificationReport['wrongCategory'] = [];
    const correctlyPlaced = new Set<number>();
    let hasUnexpected = false;

    for (const category of categories) {
      const expected = new Set(manifest.results.filter(result => result.category === category && availableByAid.has(result.aid)).map(result => result.aid));
      const actual = new Set([...(targetSets.get(category) ?? [])].filter(aid => !unavailableAids.has(aid)));
      const missing = sorted([...expected].filter(aid => !actual.has(aid)));
      const unexpected = sorted([...actual].filter(aid => !expected.has(aid)));
      if (unexpected.length) hasUnexpected = true;
      perCategory[category] = { expected: expected.size, actual: actual.size, missing, unexpected };
      for (const aid of expected) if (actual.has(aid)) correctlyPlaced.add(aid);
      for (const aid of actual) {
        const expectedResult = resultByAid.get(aid);
        if (expectedResult && expectedResult.category !== category) {
          wrongCategory.push({ aid, expected: expectedResult.category, actual: category });
        }
      }
    }

    const sourceMissing: Record<string, number[]> = {};
    for (const sourceId of this.data.state.sourceFolderIds) {
      this.checkpoint();
      if (!Object.prototype.hasOwnProperty.call(execution.sourceBefore, String(sourceId))) {
        throw safety(`冻结源 ID ${sourceId} 缺少 Apply 前的 aid 快照，不能报告 Verify 通过`);
      }
      const actual = sourceSets.get(sourceId)!;
      const expected = execution.sourceBefore[String(sourceId)] ?? [];
      const missing = sorted(expected.filter(aid => !unavailableAids.has(aid) && !actual.has(aid)));
      if (missing.length) sourceMissing[String(sourceId)] = missing;
    }

    const unavailable = dataset.videos.filter(video => video.unavailable).length;
    const missingAids = new Set(Object.values(perCategory).flatMap(category => category.missing));
    const report: VerificationReport = {
      verifiedAt: this.now().toISOString(),
      total: availableByAid.size,
      copied: correctlyPlaced.size,
      uncertain: manifest.results.filter(result => result.category === UNCERTAIN && availableByAid.has(result.aid)).length,
      unavailable,
      failed: missingAids.size,
      perCategory,
      wrongCategory: wrongCategory.sort((a, b) => a.aid - b.aid || a.actual.localeCompare(b.actual)),
      sourceMissing,
      passed: missingAids.size === 0 && !hasUnexpected && wrongCategory.length === 0 && Object.keys(sourceMissing).length === 0,
    };
    return report;
  }

  private missingCopyItems(report: VerificationReport): CopyItem[] {
    const dataset = this.requireDataset();
    const byAid = new Map(dataset.videos.map(video => [video.aid, video]));
    const execution = this.data.state.execution;
    const missing: CopyItem[] = [];
    for (const [category, summary] of Object.entries(report.perCategory)) {
      for (const aid of summary.missing) {
        const video = byAid.get(aid);
        const targetId = execution.targetFolderIds[category];
        if (!video || video.unavailable || targetId === undefined) continue;
        missing.push({ aid, category, sourceId: video.primarySourceFolderId, targetId });
      }
    }
    return missing;
  }

  private async readTargetSets(targetFolderIds: Record<string, FolderId>): Promise<Map<string, Set<number>>> {
    const folders = await this.adapter.listFolders();
    const byId = new Map(folders.map(folder => [folder.id, folder]));
    const sourceIds = new Set(this.data.state.sourceFolderIds);
    const sets = new Map<string, Set<number>>();
    for (const [category, id] of Object.entries(targetFolderIds)) {
      if (!Number.isSafeInteger(id) || id <= 0 || sourceIds.has(id) || byId.get(id)?.isDefault || this.data.state.generatedFolderIds[category] !== id) {
        throw safety(`目标分类“${category}”指向无效、源或默认收藏夹 ID`);
      }
      if (!byId.has(id)) throw safety(`目标收藏夹 ID ${id} 不存在，不能安全校验或复制`);
      sets.set(category, await this.adapter.getFolderAidSet(id));
    }
    return sets;
  }

  private markCopied(item: CopyItem): void {
    const execution = this.data.state.execution;
    if (!execution.copiedAids.includes(item.aid)) execution.copiedAids.push(item.aid);
    execution.pendingAids = execution.pendingAids.filter(aid => aid !== item.aid);
    execution.failedItems = execution.failedItems.filter(failed => failed.aid !== item.aid);
    this.persist();
    this.progress('copying', execution.copiedAids.length, this.requireDataset().videos.filter(video => !video.unavailable).length, `已确认复制 ${item.aid}`);
  }

  private async validateSourcesForOwner(): Promise<Folder[]> {
    const state = this.data.state;
    if (!state.sourceFrozen) throw new AppError('源收藏夹尚未完成冻结，请先完成“冻结源收藏夹”', 'invalid');
    const folders = await this.adapter.listFolders();
    const byId = new Map(folders.map(folder => [folder.id, folder]));
    const missing = state.sourceFolderIds.filter(id => !byId.has(id));
    if (missing.length) throw safety(`以下冻结源收藏夹已不存在：${missing.join(', ')}；不会按名称替换`);
    const defaults = state.sourceFolderIds.filter(id => byId.get(id)?.isDefault);
    if (defaults.length) throw safety(`冻结源 ID 被识别为默认收藏夹：${defaults.join(', ')}`);
    return state.sourceFolderIds.map(id => byId.get(id) as Folder);
  }

  private async assertOwner(allowBind: boolean): Promise<void> {
    const user = await this.adapter.getCurrentUser();
    const ownerMid = this.data.state.ownerMid;
    if (ownerMid !== undefined && ownerMid !== user.mid) {
      throw safety(`当前登录账号 mid ${user.mid} 与冻结状态所属账号 mid ${ownerMid} 不一致`);
    }
    if (ownerMid === undefined) {
      if (!allowBind) throw safety('持久状态缺少 ownerMid，不能确认收藏夹所属账号');
      this.data.state.ownerMid = user.mid;
      this.persist();
    }
  }

  private categoriesInManifest(): string[] {
    const manifest = this.requireManifest();
    const availableAids = new Set(this.requireDataset().videos.filter(video => !video.unavailable).map(video => video.aid));
    return [...new Set(manifest.results.filter(result => availableAids.has(result.aid)).map(result => result.category))];
  }

  private syncUnavailableVideos(): void {
    for (const video of this.requireDataset().videos) {
      if (this.adapter.isVideoUnavailable?.(video.aid)) video.unavailable = true;
    }
  }

  private requireDataset(): VideoDataset {
    if (!this.data.dataset) throw new AppError('请先刷新源收藏夹视频信息', 'invalid');
    const currentSources = new Set(this.data.state.sourceFolderIds);
    if (this.data.dataset.sourceFolderIds.length !== currentSources.size || this.data.dataset.sourceFolderIds.some(id => !currentSources.has(id))) {
      throw safety('视频数据集的源 ID 与冻结源集合不一致');
    }
    for (const video of this.data.dataset.videos) {
      if (!currentSources.has(video.primarySourceFolderId) || !video.sourceFolderIds.includes(video.primarySourceFolderId) ||
          video.sourceFolderIds.some(id => !currentSources.has(id))) {
        throw safety(`视频 ${video.aid} 的来源不属于当前冻结源集合`);
      }
    }
    return this.data.dataset;
  }

  private requireManifest(): ClassificationManifest {
    if (!this.data.manifest) throw new AppError('没有可执行的分类 Manifest', 'invalid');
    return this.data.manifest;
  }

  private async recordExecutionError(error: unknown, phase: ExecutionPhase): Promise<never> {
    this.data.state.execution.phase = isPause(error) ? 'paused' : 'failed';
    this.data.state.execution.resumePhase = phase;
    this.data.state.execution.error = errorMessage(error);
    this.persist();
    throw error;
  }

  private checkpoint(): void { this.hooks.checkpoint?.(); }
  private refreshFolders(): Promise<Folder[]> { return this.adapter.refreshFolders?.() ?? this.adapter.listFolders(); }
  private now(): Date { return this.hooks.now?.() ?? new Date(); }
  private persist(): void { this.repository.save(this.data); }
  private progress(phase: string, completed: number, total: number, message: string): void {
    this.hooks.progress?.({ phase, completed, total, message });
  }
}

function uniqueFolders(folders: Folder[]): Folder[] {
  const ids = new Set<number>();
  return folders.filter(folder => {
    if (!Number.isSafeInteger(folder.id) || folder.id <= 0 || ids.has(folder.id)) return false;
    ids.add(folder.id);
    return true;
  });
}

function sorted(values: Iterable<number>): number[] { return [...new Set(values)].sort((a, b) => a - b); }

function isRetryableRename(error: unknown): boolean {
  return error instanceof AppError && (error.retryable || error.kind === 'network' || error.kind === 'rate-limit' || (error.code !== undefined && error.code >= 500));
}
function sameIds(a: number[], b: number[]): boolean { return a.length === b.length && a.every((id, index) => id === b[index]); }
function sameDatasetContent(a: VideoRecord[], b: VideoRecord[]): boolean {
  if (a.length !== b.length) return false;
  const byAid = new Map(a.map(video => [video.aid, video]));
  return b.every(video => {
    const old = byAid.get(video.aid);
    if (!old) return false;
    const { metadataFetchedAt: _oldFetchedAt, ...oldContent } = old;
    const { metadataFetchedAt: _newFetchedAt, ...newContent } = video;
    return JSON.stringify(oldContent) === JSON.stringify(newContent);
  });
}

function isUnavailable(error: unknown): boolean {
  return error instanceof AppError && error.kind === 'unavailable';
}

function isPause(error: unknown): boolean {
  return error instanceof PauseError || (error instanceof AppError && error.kind === 'paused');
}

function safety(message: string): AppError { return new AppError(message, 'safety'); }

function batchOptions(settings: Settings) {
  return {
    batchSize: sane(settings.copyBatchSize, DEFAULT_SETTINGS.copyBatchSize),
    maxRetries: Math.max(0, Math.floor(sane(settings.maxRetries, DEFAULT_SETTINGS.maxRetries))),
    delayMs: Math.max(0, sane(settings.requestDelayMs, DEFAULT_SETTINGS.requestDelayMs)),
    cooldownMs: Math.max(0, sane(settings.cooldownMs, DEFAULT_SETTINGS.cooldownMs)),
  };
}

function sane(value: number, fallback: number): number { return Number.isFinite(value) ? value : fallback; }

function reportMissingCount(report: VerificationReport): number {
  return Object.values(report.perCategory).reduce((total, category) => total + category.missing.length, 0);
}

function reportMissingAids(report: VerificationReport): number[] {
  return sorted(Object.values(report.perCategory).flatMap(category => category.missing));
}
