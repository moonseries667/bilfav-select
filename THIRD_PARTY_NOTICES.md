# Third-party notices

本项目基于 [madoka-chann/Bilibili-AI-Favorites-Organizer](https://github.com/madoka-chann/Bilibili-AI-Favorites-Organizer) 精简改造。

- 基底提交：`f4b73ca48475d4247dbde3c3f87e3e2fdaa3df6b`。
- 上游 README 的许可证声明原文：`MIT License`；该提交未提供独立 LICENSE 文件。本项目保留该声明、作者署名和完整 MIT 许可条款（见 LICENSE）。
- 上游作者署名：`B站-是小圆_喲 & 感谢b站某不知名的根号三提供的最初模板`。
- `src/lib/gm.ts` 直接改造其 `src/utils/gm.ts`；API 请求构建、分页与 AI provider 分层参考并改造其 `src/api/`；JSON 括号扫描参考其 `src/utils/json-extract.ts`。保留 TypeScript / Svelte / Vite / Vitest / vite-plugin-monkey 工程路线，重新实现只复制且可恢复的业务流程和简洁 UI。
- `leida1024/bilibili-favs-manage` 与 B站 API 社区资料仅用于接口核对；若后续直接复用代码，需另保留其许可证声明。
- 未复制 `jqwgt/bilibili-favlist-classifier` 的 GPL 源码，未复制没有明确许可证的参考仓库源码。

第三方 npm 依赖保留各自许可证，版本见 `package-lock.json`。
独立用户脚本包含 Svelte runtime，其 MIT copyright 与许可条款同时嵌入构建产物。
