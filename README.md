# Bilfav Select · Bilibili 收藏夹语义重建器

Tampermonkey / Violentmonkey 用户脚本。按 `codex_kit/kit_0` 的规格实现：**一次冻结源 ID → 刷新完整元数据 → AI 唯一大类 Manifest → 重建程序生成的收藏夹 → 从源复制 → 自动校验**。

## 安装与首次运行

```powershell
cd D:\Code\Other\bilfav-select
npm install
npm run build
```

在 Tampermonkey 或 Violentmonkey 中新建脚本，将 `dist/bilfav-select.user.js` 的全部内容粘贴并保存。然后登录 B站，打开自己的空间收藏页 `https://space.bilibili.com/<你的 mid>/favlist`，点击右下角「收藏重建」。

1. 点击「冻结源收藏夹」。当前全部自建收藏夹 ID 会先持久化，包括已经带 `-旧` 的收藏夹；其他源改为 `原名-旧`。默认收藏夹完全排除。
2. 点击「重新获取视频信息」。仅扫描已记录的源 ID，按 aid 去重，合并所有源位置，并获取完整标签、简介、分区、UP 主和时长。
3. 填写 OpenAI-compatible 的 Base URL、Model 和 API Key，按需要编辑分类表、置信度阈值和高级 Prompt。`不确定` 始终保留。也可选择 DeepSeek 或 Ollama 预设。
4. 点击「重新分类并应用」。分类完成后直接应用，无人工逐条确认。**上一轮记录在 generatedFolderIds 的生成收藏夹会被删除并重建**，然后只从源复制，不移动或删除源视频。
5. 查看执行状态、分类统计与校验表。成功标准是所有可用视频进入指定的唯一生成收藏夹，且源 aid 集合没有减少。

用户脚本使用当前浏览器 B站登录态，写操作在 adapter 内附 CSRF，不需要手工复制 Cookie。第一次访问自定义 AI 域名时，脚本管理器可能要求允许跨域访问。AI 服务将收到视频元数据；付费情况由用户选择的服务决定。API Key 仅保存于本机脚本设置，不进入 dataset、Manifest 或日志导出。

## 重复运行与恢复

- 冻结完成后，按钮变为「校验源收藏夹」；后续新建的收藏夹永远不会自动进入源集合。源即使改名仍按 ID 识别；源缺失会报错，不按同名替代。
- 修改分类表或 Prompt 后可直接再次「重新分类并应用」，不必再次抓取元数据。重新获取按钮始终强制刷新；工作流同时支持成功元数据的 TTL 缓存。
- 可「暂停并保存」。页面刷新后点击「继续未完成执行」，直接继续同一 Manifest 的清理、创建、复制或校验，不重新调用 AI。暂停需等当前在途请求结束。
- 「重试失败项」仅重试当前执行的失败或缺失视频；「仅重新应用当前 Manifest」会完整重建生成结果，且不调用 AI。
- 导入 Manifest 会校验版本、类别、aid 唯一性、完整覆盖和当前数据集标识。Manifest 改变后禁止误恢复旧执行；应重新应用当前 Manifest。
- Freeze 途中中断会保留第一次记录的 ID，下一次继续这些源，不重新发现。清理仅按记录 ID，拒绝源和默认 ID；用户手动新建而未记录的收藏夹不会被清理。
- 使用一个浏览器标签页执行长操作；不要在运行中手工修改源或生成收藏夹。切换账号会被已冻结状态的 ownerMid 检查拒绝。
- 创建请求若已在远端成功但响应丢失，未知 ID 的收藏夹不会按名称认领或删除。执行会停止；继续前应由用户核查这类可能的孤立结果。
- 「清理上一轮生成结果」只处理记录的生成收藏夹。dataset、Manifest、运行日志均可通过高级操作导出。

失效视频记录为 unavailable，仍进入 Manifest 的「不确定」，但不计入可复制集合。临时网络错误不会被伪装成失效，也不会覆盖已有成功数据。API 写入返回成功后仍会读取目标集合，missing 会有限重试；unexpected、wrong-category 或源减少均不能通过校验。

## 开发与验证

```powershell
npm run dev
npm run typecheck
npm test
npm run build
```

打开终端打印的本地 Vite 地址可使用**演示模式**：本地示例数据、示例 AI 响应，不请求 B站或 AI 服务。浏览器刷新保留演示状态，便于检查冻结、重建与恢复。用户脚本通过 `npm run build` 生成后安装；开发服务器直接显示演示面板。

测试覆盖工具包列出的核心逻辑：冻结与默认排除、ID 身份和缺失源、去重和源合并、类别解析与置信度回退、生成 ID 清理保护、拆批退避、执行恢复和 Manifest hash、集合差异与源保护。B站 API、AI HTTP 均使用模拟响应测试。

真实账号下的 B站写接口、Tampermonkey / Violentmonkey 安装执行、自定义 AI 端点及长时间大规模运行需在用户环境验证；本地测试和构建不能证明这些远程结果。社区接口可能变化，相关参数、分页、默认夹识别、CSRF、限流及 copy fallback 都集中在 `src/api/`。

## 模块与 Credits

| 位置 | 职责 |
| --- | --- |
| `src/api/` | B站 HTTP、登录、默认夹保护、文件夹、完整元数据和复制 |
| `src/ai/` | OpenAI-compatible provider、性质 Prompt、严格 JSON 分类 |
| `src/core/` | Freeze、Refresh、可恢复 Apply、BatchExecutor、Verify |
| `src/lib/` | GM 持久化、Manifest 校验及摘要、脱敏和导出 |
| `src/App.svelte` | 简洁三步面板与高级操作 |

基于指定的 MIT 项目 [Bilibili-AI-Favorites-Organizer](https://github.com/madoka-chann/Bilibili-AI-Favorites-Organizer) 改造 GM 包装、API / AI 分层与工程配置；原来的 move、逐条确认、Undo 和动画流程没有接入。批次拆分与恢复根据工具包独立实现。许可及具体归属见 `LICENSE` 和 `THIRD_PARTY_NOTICES.md`。构建包保持原样，不作为运行依赖。
