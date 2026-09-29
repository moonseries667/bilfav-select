<script lang="ts">
  import type { Controller } from './controller';
  import { errorMessage } from './lib/errors';
  import { redact } from './lib/logs';
  import { downloadJson } from './lib/download';
  import { normalizeCategoryTable, parseCategoryTable } from './ai/categories';
  import { sameAIConnection } from './ai/model-test';
  import { classificationSignature } from './ai/classifier';
  import { DEFAULT_SETTINGS } from './defaults';
  import type { AISettings, Settings } from './types';

  let { controller }: { controller: Controller } = $props();
  const view = $derived(controller.view);
  let open = $state($view.demo);
  let draft: Settings = $state(structuredClone($view.settings));
  let categoryRows = $state(draft.categories.filter(category => category.name !== '不确定'));
  let modelSearch = $state('');
  let categoryNotice = $state('');
  let categoryError = $state('');
  let formError = $state('');
  let configNotice = $state('');
  let launcher: HTMLButtonElement | undefined = $state();
  let panel: HTMLElement | undefined = $state();
  let categoryEditor: HTMLDetailsElement | undefined = $state();
  const sourceState = $derived($view.data.state);
  const dataset = $derived($view.data.dataset);
  const classificationDraft = $derived($view.data.classificationDraft);
  const draftApplicable = $derived.by(() => { try { return !!dataset && !!classificationDraft && classificationDraft.signature === classificationSignature(dataset, { ...draft, categories: normalizeCategoryTable(categoryRows) }); } catch { return false; } });
  const availableCount = $derived(dataset?.videos.filter(video => !video.unavailable).length ?? 0);
  const currentModels = $derived(sameAIConnection($view.modelsConnection, draft, false) ? $view.models : []);
  const filteredModels = $derived(currentModels.filter(model => model === draft.model || model.toLowerCase().includes(modelSearch.trim().toLowerCase())));
  const currentTest = $derived(sameAIConnection($view.testConnection, draft) ? $view.modelTest : null);
  const manifest = $derived($view.data.manifest);
  const manifestApplicable = $derived(!!dataset && !!manifest && manifest.datasetVersion === dataset.version && manifest.datasetUpdatedAt === dataset.updatedAt);
  const execution = $derived(sourceState.execution);
  const report = $derived(execution.verification);
  const progress = $derived($view.progress.total ? Math.min(100, Math.round($view.progress.completed / $view.progress.total * 100)) : undefined);
  const resumable = $derived(!['idle', 'completed'].includes(execution.phase) && !!execution.runId);
  const phaseLabels: Record<string, string> = { idle: '待运行', models: '获取模型', 'model-test': '测试模型', scanning: '读取收藏夹', reconciling: '核验缺失条目', metadata: '获取视频信息', dataset: '信息已更新', freezing: '冻结源收藏夹', classifying: 'AI 分类', preparing: '准备', cleanup: '清理生成结果', creating: '建立新收藏夹', copying: '复制中', verifying: '校验中', paused: '已暂停', failed: '需恢复或重试', completed: '已完成' };
  const displayedPhase = $derived($view.busy ? $view.progress.phase : execution.phase);
  function date(value?: string) { return value ? new Date(value).toLocaleString('zh-CN') : '尚未运行'; }
  function close() { open = false; launcher?.focus(); }
  function save() {
    const categories = normalizeCategoryTable($state.snapshot(categoryRows));
    controller.save({ ...$state.snapshot(draft), categories });
    configNotice = '设置已保存在此浏览器';
  }
  async function connectionAction(action: (config: AISettings) => Promise<unknown>) {
    formError = ''; configNotice = '';
    try { await action($state.snapshot(draft)); }
    catch (error) { formError = redact(errorMessage(error), [draft.apiKey]); }
  }
  async function importCategories(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0]; if (!file) return;
    try { const parsed = parseCategoryTable(await file.text()).filter(category => category.name !== '不确定'); categoryRows = parsed; categoryNotice = `已导入 ${parsed.length} 个普通类别；保存配置或开始分类后生效`; categoryError = ''; }
    catch (error) { categoryError = redact(errorMessage(error), [draft.apiKey]); }
    input.value = '';
  }
  function exportCategories() {
    categoryError = '';
    try { downloadJson('classification-categories.json', normalizeCategoryTable($state.snapshot(categoryRows)).filter(category => category.name !== '不确定')); }
    catch (error) { categoryError = redact(errorMessage(error), [draft.apiKey]); }
  }
  async function configured(action?: () => Promise<unknown>) {
    formError = ''; configNotice = '';
    try { save(); if (action) await action(); }
    catch (error) { formError = redact(errorMessage(error), [draft.apiKey]); }
  }
  function exportData(kind: 'dataset' | 'manifest' | 'logs') {
    try { controller.export(kind); formError = ''; }
    catch (error) { formError = redact(errorMessage(error), [draft.apiKey]); }
  }
  async function importFile(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0]; if (!file) return;
    try { await controller.importManifest(file); formError = ''; }
    catch (error) { formError = redact(errorMessage(error), [draft.apiKey]); }
    input.value = '';
  }
  function providerChanged() {
    if (draft.provider === 'deepseek') draft.baseUrl = 'https://api.deepseek.com';
    if (draft.provider === 'ollama') { draft.baseUrl = 'http://localhost:11434/v1'; draft.apiKey = ''; }
    draft.model = ''; controller.invalidateConnection();
  }
  function connectionChanged() { controller.invalidateConnection(); }
</script>

<svelte:window onkeydown={event => { if (event.key === 'Escape' && open && panel?.contains(document.activeElement)) close(); }} />

{#if $view.demo}
  <div class="bf-preview">
    <span class="bf-wordmark">BILFAV SELECT <span>开发预览</span></span>
    <h1>让收藏成为<br />清晰的内容库。</h1>
    <p>按你的兴趣分类表，反复整理收藏。<br />右侧面板可演示完整流程与中断恢复。</p>
    <div class="bf-preview-note">本页使用本地示例数据与示例 AI 响应。<br />安装用户脚本后，在自己的 B站收藏页使用。</div>
  </div>
{/if}

<button class="bf-launcher" bind:this={launcher} aria-expanded={open} aria-controls="bf-panel" onclick={() => { open = !open; }}>
  <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M4 5h6v6H4zM14 5h6v6h-6zM4 15h6v5H4zM14 15h6v5h-6z" /></svg>
  收藏重建
</button>

{#if open}
  <aside id="bf-panel" class="bf-panel" bind:this={panel} aria-label="Bilibili 收藏夹语义重建器">
    <header class="bf-header">
      <div><span class="bf-kicker">BILFAV SELECT</span><h2>收藏夹语义重建</h2></div>
      <button class="bf-icon-button" aria-label="关闭面板" onclick={close}><svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.8"><path d="m6 6 12 12M18 6 6 18" /></svg></button>
    </header>
    <div class="bf-scroll">
      {#if $view.demo}<div class="bf-banner">本地演示 · 不请求 B站或 AI 服务</div>{/if}
      {#if $view.error || formError}<div class="bf-alert" role="alert">{$view.error || formError}</div>{/if}
      {#if $view.notice || configNotice}<div class="bf-notice" role="status">{$view.notice || configNotice}</div>{/if}

      <section class="bf-section">
        <div class="bf-section-title"><span class="bf-step">01</span><h3>冻结源收藏夹</h3><span class:bf-good={sourceState.sourceFrozen} class="bf-status">{sourceState.sourceFrozen ? '已冻结' : sourceState.freezePending ? '待继续冻结' : '未冻结'}</span></div>
        <p class="bf-help">首次记录全部自建收藏夹 ID，并改名为「原名-旧」。后续始终按这些 ID 读取。</p>
        <div class="bf-metrics"><div><strong>{sourceState.sourceFolderIds.length}</strong><span>源收藏夹</span></div><div><strong class="bf-time">{date(sourceState.frozenAt)}</strong><span>冻结时间</span></div></div>
        {#if $view.activeTask === 'freeze' && $view.progress.phase === 'freezing'}<p class="bf-live" aria-live="polite">{$view.progress.message}</p>{#if progress !== undefined}<progress max="100" value={progress} aria-label="冻结进度"></progress>{:else}<progress aria-label="冻结进度"></progress>{/if}<div class="bf-row"><span>{$view.progress.completed} / {$view.progress.total} 个收藏夹</span>{#if $view.busy}<button class="bf-text-button" disabled={$view.pauseRequested} onclick={() => controller.pause()}>{$view.pauseRequested ? '正在暂停…' : '暂停并保存'}</button>{/if}</div>{/if}
        <button class="bf-secondary bf-full" disabled={$view.busy} onclick={() => controller.freeze()}>{sourceState.sourceFrozen ? '校验源收藏夹' : sourceState.freezePending ? '继续冻结原始源收藏夹' : '冻结源收藏夹'}</button>
      </section>

      <section class="bf-section">
        <div class="bf-section-title"><span class="bf-step">02</span><h3>获取视频信息</h3></div>
        <div class="bf-metrics"><div><strong>{dataset?.videos.length ?? 0}</strong><span>唯一视频</span></div><div><strong>{$view.data.refreshSummary?.excluded ?? dataset?.videos.filter(video => video.unavailable).length ?? 0}</strong><span>本轮失效/排除</span></div></div>
        <p class="bf-help">最后刷新：{date(dataset?.updatedAt)}</p>
        {#if $view.activeTask === 'refresh' && ['scanning', 'reconciling', 'metadata', 'dataset'].includes($view.progress.phase)}<div class="bf-transfer-progress"><p class="bf-live" aria-live="polite">{$view.progress.message}</p>{#if progress !== undefined}<progress max="100" value={progress} aria-label="视频获取进度"></progress>{:else}<progress aria-label="视频获取进度"></progress>{/if}<div class="bf-row"><span>{$view.progress.completed} / {$view.progress.total} · {phaseLabels[$view.progress.phase]}</span>{#if $view.busy}<button class="bf-text-button" disabled={$view.pauseRequested} onclick={() => controller.pause()}>{$view.pauseRequested ? '正在暂停…' : '暂停并保存'}</button>{/if}</div></div>{/if}
        <div class="bf-actions"><button class="bf-secondary" disabled={$view.busy || !sourceState.sourceFrozen} onclick={() => controller.refresh('full')}>完整刷新</button><button class="bf-secondary" disabled={$view.busy || !sourceState.sourceFrozen} onclick={() => controller.refresh('incremental')}>增量获取</button></div>
        <p class="bf-help">完整刷新重新读取所有详情。增量获取扫描全部冻结源，只读取新增视频详情并复用已有有效记录。{#if $view.data.refreshDraft}已保存获取进度，可按原模式继续；将重新扫描来源。{/if}</p>
      </section>

      <section class="bf-section">
        <div class="bf-section-title"><span class="bf-step">03</span><h3>分类并重建</h3><span class="bf-status">可重复运行</span></div>
        <fieldset class="bf-config" disabled={$view.busy}>
          <h4>模型连接</h4>
          <label>AI Provider<select bind:value={draft.provider} onchange={providerChanged}><option value="openai-compatible">OpenAI-compatible</option><option value="deepseek">DeepSeek</option><option value="ollama">Ollama</option></select></label>
          <label>Base URL<input type="url" bind:value={draft.baseUrl} oninput={connectionChanged} placeholder="https://your-provider.example/v1" autocomplete="off" /></label>
          <label>API Key<input type="password" bind:value={draft.apiKey} oninput={connectionChanged} placeholder="仅保存在本地" autocomplete="off" /></label>
          <p class="bf-help">已保存配置在页面刷新后需重新获取模型列表。更改 Provider、地址或 Key 后，旧列表与测试结果会失效。</p>
          <div class="bf-actions"><button type="button" onclick={() => connectionAction(async config => { const previous = draft.model; await controller.fetchModels(config); if (!$view.models.includes(previous)) { draft.model = ''; configNotice = '当前服务列表中没有原模型，请重新选择。'; } })}>获取模型列表</button></div>
          {#if currentModels.length}<label>搜索模型<input type="search" bind:value={modelSearch} placeholder="筛选当前连接可用模型" /></label><label>模型<select bind:value={draft.model}><option value="">请选择模型</option>{#each filteredModels as model}<option value={model}>{model}</option>{/each}</select></label><div class="bf-actions"><button type="button" disabled={!draft.model} onclick={() => connectionAction(controller.testModel)}>测试模型</button></div>{:else}<p class="bf-help">尚无当前连接的有效模型列表。获取失败或列表为空时，请检查服务地址、权限和模型接口后重试。</p>{/if}
          <p class="bf-help">测试会向当前服务发送 3 条合成示例并产生少量 API 用量。</p>
          {#if currentTest}
            <div class="bf-notice" role="status">调用与分类格式通过 · 耗时 {(currentTest.elapsedMs / 1000).toFixed(1)} 秒<br />示例匹配 {currentTest.correct}/{currentTest.total} · {date(currentTest.testedAt)}{#if currentTest.usage?.totalTokens !== undefined}<br />本次用量：{currentTest.usage.totalTokens} tokens{/if}</div>
          {:else if $view.modelTest}<p class="bf-help">连接配置已变化，需要重新测试当前模型。</p>{/if}
          <h4>你的分类表</h4>
          <p class="bf-help">导入分类表文件后编辑。按每类说明处理交叉内容；每个视频只进入一个类别。</p>
          <details bind:this={categoryEditor}><summary>编辑分类列表（{categoryRows.length} 个普通类别）</summary><div class="bf-category-list">
            {#each categoryRows as category, index}
              <div class="bf-category-row">
                <div class="bf-category-heading"><label>类别 {index + 1}<input bind:value={category.name} placeholder="例如 MMD" /></label><button type="button" class="bf-remove" aria-label={`删除类别 ${index + 1}`} onclick={() => { categoryRows = categoryRows.filter((_, i) => i !== index); }}>删除</button></div>
                <label>收录范围与冲突规则<textarea rows="3" bind:value={category.description} placeholder="写清收录、排除范围，以及与其他类别冲突时如何判断"></textarea></label>
              </div>
            {/each}
          </div></details>
          <div class="bf-actions"><button type="button" onclick={() => { categoryRows = [...categoryRows, { name: '', description: '' }]; if (categoryEditor) categoryEditor.open = true; }}>添加类别</button><button type="button" onclick={exportCategories}>导出分类表</button></div>
          <label class="bf-import bf-category-import">导入分类表 JSON<input type="file" accept="application/json,.json" onchange={importCategories} /></label>
          {#if categoryError}<div class="bf-alert" role="alert">{categoryError}</div>{/if}
          {#if categoryNotice}<div class="bf-notice" role="status">{categoryNotice}</div>{/if}
          <div class="bf-reserved">不确定 · 程序自动保留<span>{categoryRows.length} 个普通类别</span></div>
          <p class="bf-help">最多生成 {categoryRows.length + 1} 个收藏夹（含「不确定」）；没有视频的类别不创建。</p>
          <label>置信度阈值 <span class="bf-label-hint">低于此值 → 不确定</span><input type="number" min="0" max="1" step="0.05" bind:value={draft.confidenceThreshold} /></label>
          <details><summary>高级 Prompt 与批次设置</summary><label>系统 Prompt<textarea rows="10" bind:value={draft.prompt}></textarea></label><button type="button" class="bf-text-button" onclick={() => { draft.prompt = DEFAULT_SETTINGS.prompt; }}>使用新版兴趣分类 Prompt</button><div class="bf-two-columns"><label>AI 批次<input type="number" min="1" max="50" bind:value={draft.aiBatchSize} /></label><label>复制批次<input type="number" min="1" max="12" bind:value={draft.copyBatchSize} /></label><label>请求间隔（ms）<input type="number" min="500" max="10000" step="100" bind:value={draft.requestDelayMs} /></label><label>风控冷却（ms）<input type="number" min="8000" max="60000" step="1000" bind:value={draft.cooldownMs} /></label><label>最大重试<input type="number" min="0" max="5" bind:value={draft.maxRetries} /></label><label>校验重试<input type="number" min="0" max="3" bind:value={draft.verifyRetries} /></label></div></details>
          <button class="bf-text-button" onclick={() => configured()}>保存配置</button>
        </fieldset>
        <button class="bf-primary bf-full" disabled={$view.busy || !dataset || !availableCount} onclick={() => configured(controller.classifyApply)}>重新分类并重建</button>
        <p class="bf-help">先完成并校验全部分类，再删除上一轮程序生成的收藏夹、创建新夹并从源复制。失败时保存分类进度，旧结果保留。</p>
        {#if classificationDraft}
          <div class="bf-classification-draft"><p class="bf-help">{#if draftApplicable}本轮已保存 {classificationDraft.results.length}/{availableCount} 个视频的分类。继续会跳过已完成视频。{:else}此分类进度不适用于当前数据集或连接配置，需重新分类。{/if}</p>{#if draftApplicable}<button class="bf-secondary bf-full" disabled={$view.busy} onclick={() => configured(controller.resumeClassification)}>继续分类并重建</button>{/if}</div>
        {/if}
      </section>

      {#if $view.busy || execution.phase !== 'idle' || manifest}
        <section class="bf-section bf-results" aria-label="执行进度与结果">
          <div class="bf-section-title"><h3>执行状态</h3><span class="bf-status">{phaseLabels[displayedPhase] ?? displayedPhase}</span></div>
          {#if $view.busy && ['classify', 'apply'].includes($view.activeTask)}<p class="bf-live" aria-live="polite">{$view.progress.message}</p>{#if progress !== undefined}<progress max="100" value={progress} aria-label="分类与重建进度"></progress>{:else}<progress aria-label="分类与重建进度"></progress>{/if}<div class="bf-row"><span>{$view.progress.completed} / {$view.progress.total}</span><button class="bf-text-button" disabled={$view.pauseRequested} onclick={() => controller.pause()}>{$view.pauseRequested ? '正在暂停…' : '暂停并保存'}</button></div>{/if}
          {#if resumable && !$view.busy}<button class="bf-secondary bf-full" disabled={!manifestApplicable} onclick={() => controller.resume()}>继续未完成执行（不调用 AI）</button>{/if}
          {#if manifest}{#if !manifestApplicable}<p class="bf-alert">当前数据集已变化，旧 Manifest 与执行结果不可用于恢复或重试。请重新分类后再重建。</p>{/if}<p class="bf-help">已生成 Manifest：{date(manifest.createdAt)}{classificationDraft ? ' · 下方为上一轮结果，本轮分类尚未应用' : ''}</p><div class="bf-chips">{#each Object.entries(manifest.stats) as [name, count]}<span>{name}<strong>{count}</strong></span>{/each}</div>{/if}
          <div class="bf-metrics"><div><strong>{report?.copied ?? execution.copiedAids.length}</strong><span>已复制 / 已校验</span></div><div><strong>{report?.failed ?? execution.failedItems.length}</strong><span>失败</span></div></div>
          {#if report}
            <div class:bf-report-passed={report.passed} class="bf-report">{report.passed ? '校验通过 · 源视频完整保留' : '校验未通过 · 查看差异并重试'}</div>
            <p class="bf-help">共 {report.total} 条 · 不确定 {report.uncertain} 条 · 失效 {report.unavailable} 条</p>
            <table><caption>各类别校验结果</caption><thead><tr><th>类别</th><th>预期 / 实际</th><th>缺失 / 多余</th></tr></thead><tbody>{#each Object.entries(report.perCategory) as [name, result]}<tr><td>{name}</td><td>{result.expected} / {result.actual}</td><td>{result.missing.length} / {result.unexpected.length}</td></tr>{/each}</tbody></table>
            {#if report.wrongCategory.length}<p class="bf-alert">错误分类：{report.wrongCategory.length} 条</p>{/if}
            {#each Object.entries(report.sourceMissing) as [id, aids]}{#if aids.length}<p class="bf-alert">源 {id} 缺少视频：{aids.join('、')}</p>{/if}{/each}
          {/if}
          {#if execution.failedItems.length}<details><summary>失败项（{execution.failedItems.length}）</summary><ul class="bf-failures">{#each execution.failedItems as item}<li>AV{item.aid} · {item.category}：{item.error}</li>{/each}</ul></details>{/if}
        </section>
      {/if}

      <section class="bf-section"><details><summary>高级操作</summary><div class="bf-advanced-grid"><button disabled={$view.busy || !dataset} onclick={() => exportData('dataset')}>导出 dataset</button><button disabled={$view.busy || !manifest} onclick={() => exportData('manifest')}>导出 Manifest</button><label class="bf-import">导入 Manifest<input type="file" accept="application/json,.json" disabled={$view.busy} onchange={importFile} /></label><button onclick={() => exportData('logs')}>导出普通日志</button><button onclick={() => controller.exportDetailedLogs()}>导出详细诊断日志（{$view.diagnosticsCount} 条{$view.diagnosticsTruncated ? ' · 已截断' : ''}）</button><button disabled={$view.busy || !manifest || !manifestApplicable} onclick={() => controller.reapply()}>仅重新应用当前 Manifest</button><button disabled={$view.busy || !manifest || !manifestApplicable} onclick={() => controller.retry()}>重试失败项</button><button class="bf-danger" disabled={$view.busy || !Object.keys(sourceState.generatedFolderIds).length} onclick={() => controller.cleanup()}>清理上一轮生成结果</button></div></details></section>
      <section class="bf-section bf-log-section"><div class="bf-row"><strong>运行日志</strong><button class="bf-text-button" onclick={() => controller.exportDetailedLogs()}>导出详细日志</button></div><details open={$view.busy}><summary>最近 30 条 · 详细日志 {$view.diagnosticsCount} 条{$view.diagnosticsTruncated ? '（较旧记录已截断）' : ''}</summary><ol class="bf-logs">{#each $view.logs.slice(-30) as log}<li class:bf-log-error={log.level === 'error'}><time>{new Date(log.at).toLocaleTimeString('zh-CN')}</time><span>{log.message}</span></li>{/each}{#if !$view.logs.length}<li>尚无运行记录</li>{/if}</ol></details></section>
      <footer class="bf-footer">默认收藏夹排除 · 源仅首次改名 · 应用只复制</footer>
    </div>
  </aside>
{/if}
