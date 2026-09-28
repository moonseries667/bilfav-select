<script lang="ts">
  import type { Controller } from './controller';
  import { errorMessage } from './lib/errors';
  import { redact } from './lib/logs';
  import type { Settings } from './types';

  let { controller }: { controller: Controller } = $props();
  const view = $derived(controller.view);
  let open = $state($view.demo);
  let draft: Settings = $state(structuredClone($view.settings));
  let categoryText = $state(JSON.stringify(draft.categories.filter(category => category.name !== '不确定'), null, 2));
  let formError = $state('');
  let configNotice = $state('');
  let launcher: HTMLButtonElement | undefined = $state();
  let panel: HTMLElement | undefined = $state();
  const sourceState = $derived($view.data.state);
  const dataset = $derived($view.data.dataset);
  const manifest = $derived($view.data.manifest);
  const execution = $derived(sourceState.execution);
  const report = $derived(execution.verification);
  const progress = $derived($view.progress.total ? Math.min(100, Math.round($view.progress.completed / $view.progress.total * 100)) : 0);
  const resumable = $derived(!['idle', 'completed'].includes(execution.phase) && !!execution.runId);
  const phaseLabels: Record<string, string> = { idle: '待运行', scanning: '读取收藏夹', reconciling: '核验缺失条目', metadata: '获取视频信息', dataset: '信息已更新', classifying: 'AI 分类', preparing: '准备', cleanup: '清理生成结果', creating: '建立新收藏夹', copying: '复制中', verifying: '校验中', paused: '已暂停', failed: '需恢复或重试', completed: '已完成' };
  const displayedPhase = $derived($view.busy ? $view.progress.phase : execution.phase);
  function date(value?: string) { return value ? new Date(value).toLocaleString('zh-CN') : '尚未运行'; }
  function close() { open = false; launcher?.focus(); }
  function save() {
    const categories = JSON.parse(categoryText);
    if (!Array.isArray(categories)) throw new Error('分类表必须是 JSON 数组');
    controller.save({ ...$state.snapshot(draft), categories: [...categories, { name: '不确定', description: '信息不足或无法可靠归类' }] });
    configNotice = '设置已保存在此浏览器';
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
    if (draft.provider === 'deepseek') { draft.baseUrl = 'https://api.deepseek.com/v1'; draft.model = 'deepseek-chat'; }
    if (draft.provider === 'ollama') { draft.baseUrl = 'http://localhost:11434/v1'; draft.apiKey = ''; draft.model = ''; }
  }
</script>

<svelte:window onkeydown={event => { if (event.key === 'Escape' && open && panel?.contains(document.activeElement)) close(); }} />

{#if $view.demo}
  <div class="bf-preview">
    <span class="bf-wordmark">BILFAV SELECT <span>开发预览</span></span>
    <h1>让收藏成为<br />清晰的内容库。</h1>
    <p>冻结源收藏夹，按视频的内容性质重建分类。<br />右侧面板可演示完整流程与中断恢复。</p>
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
        <button class="bf-secondary bf-full" disabled={$view.busy} onclick={() => controller.freeze()}>{sourceState.sourceFrozen ? '校验源收藏夹' : sourceState.freezePending ? '继续冻结原始源收藏夹' : '冻结源收藏夹'}</button>
      </section>

      <section class="bf-section">
        <div class="bf-section-title"><span class="bf-step">02</span><h3>获取视频信息</h3></div>
        <div class="bf-metrics"><div><strong>{dataset?.videos.length ?? 0}</strong><span>唯一视频</span></div><div><strong>{dataset?.videos.filter(video => video.unavailable).length ?? 0}</strong><span>失效视频</span></div></div>
        <p class="bf-help">最后刷新：{date(dataset?.updatedAt)}</p>
        <button class="bf-secondary bf-full" disabled={$view.busy || !sourceState.sourceFrozen} onclick={() => controller.refresh()}>重新获取视频信息</button>
      </section>

      <section class="bf-section">
        <div class="bf-section-title"><span class="bf-step">03</span><h3>分类并重建</h3></div>
        <fieldset class="bf-config" disabled={$view.busy}>
          <label>AI Provider<select bind:value={draft.provider} onchange={providerChanged}><option value="openai-compatible">OpenAI-compatible</option><option value="deepseek">DeepSeek</option><option value="ollama">Ollama</option></select></label>
          <label>Base URL<input type="url" bind:value={draft.baseUrl} placeholder="https://your-provider.example/v1" autocomplete="off" /></label>
          <div class="bf-two-columns"><label>Model<input bind:value={draft.model} placeholder="模型名称" autocomplete="off" /></label><label>API Key<input type="password" bind:value={draft.apiKey} placeholder="仅保存在本地" autocomplete="off" /></label></div>
          <label>置信度阈值 <span class="bf-label-hint">低于此值 → 不确定</span><input type="number" min="0" max="1" step="0.05" bind:value={draft.confidenceThreshold} /></label>
          <details><summary>编辑分类表</summary><p class="bf-help">每类填写 name 与 description，视频将只进入一个类别。</p><textarea aria-label="分类表 JSON" class="bf-code" rows="10" bind:value={categoryText} spellcheck="false"></textarea><div class="bf-reserved">保留类别：不确定 <span>始终存在</span></div></details>
          <details><summary>高级 Prompt 与批次设置</summary><label>系统 Prompt<textarea rows="10" bind:value={draft.prompt}></textarea></label><div class="bf-two-columns"><label>AI 批次<input type="number" min="1" max="100" bind:value={draft.aiBatchSize} /></label><label>复制批次<input type="number" min="1" max="12" bind:value={draft.copyBatchSize} /></label><label>请求间隔（ms）<input type="number" min="500" max="10000" step="100" bind:value={draft.requestDelayMs} /></label><label>风控冷却（ms）<input type="number" min="8000" max="60000" step="1000" bind:value={draft.cooldownMs} /></label><label>最大重试<input type="number" min="0" max="5" bind:value={draft.maxRetries} /></label><label>校验重试<input type="number" min="0" max="3" bind:value={draft.verifyRetries} /></label></div></details>
          <button class="bf-text-button" onclick={() => configured()}>保存配置</button>
        </fieldset>
        <button class="bf-primary bf-full" disabled={$view.busy || !dataset} onclick={() => configured(controller.classifyApply)}>重新分类并应用</button>
        <p class="bf-help">生成 Manifest 后自动应用；上一轮已记录的生成收藏夹会被重建。</p>
      </section>

      {#if $view.busy || execution.phase !== 'idle' || manifest}
        <section class="bf-section bf-results" aria-label="执行进度与结果">
          <div class="bf-section-title"><h3>执行状态</h3><span class="bf-status">{phaseLabels[displayedPhase] ?? displayedPhase}</span></div>
          {#if $view.busy}<p class="bf-live" aria-live="polite">{$view.progress.message}</p><progress max="100" value={progress} aria-label="当前阶段进度"></progress><div class="bf-row"><span>{$view.progress.completed} / {$view.progress.total}</span><button class="bf-text-button" disabled={$view.pauseRequested} onclick={() => controller.pause()}>{$view.pauseRequested ? '正在暂停…' : '暂停并保存'}</button></div>{/if}
          {#if resumable && !$view.busy}<button class="bf-secondary bf-full" onclick={() => controller.resume()}>继续未完成执行（不调用 AI）</button>{/if}
          {#if manifest}<div class="bf-chips">{#each Object.entries(manifest.stats) as [name, count]}<span>{name}<strong>{count}</strong></span>{/each}</div>{/if}
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

      <section class="bf-section"><details><summary>高级操作</summary><div class="bf-advanced-grid"><button disabled={$view.busy || !dataset} onclick={() => exportData('dataset')}>导出 dataset</button><button disabled={$view.busy || !manifest} onclick={() => exportData('manifest')}>导出 Manifest</button><label class="bf-import">导入 Manifest<input type="file" accept="application/json,.json" disabled={$view.busy} onchange={importFile} /></label><button onclick={() => exportData('logs')}>导出日志</button><button disabled={$view.busy || !manifest} onclick={() => controller.reapply()}>仅重新应用当前 Manifest</button><button disabled={$view.busy || !manifest} onclick={() => controller.retry()}>重试失败项</button><button class="bf-danger" disabled={$view.busy || !Object.keys(sourceState.generatedFolderIds).length} onclick={() => controller.cleanup()}>清理上一轮生成结果</button></div></details></section>
      <section class="bf-section bf-log-section"><details open={$view.busy}><summary>运行日志</summary><ol class="bf-logs">{#each $view.logs.slice(-30) as log}<li class:bf-log-error={log.level === 'error'}><time>{new Date(log.at).toLocaleTimeString('zh-CN')}</time><span>{log.message}</span></li>{/each}{#if !$view.logs.length}<li>尚无运行记录</li>{/if}</ol></details></section>
      <footer class="bf-footer">默认收藏夹排除 · 源仅首次改名 · 应用只复制</footer>
    </div>
  </aside>
{/if}
