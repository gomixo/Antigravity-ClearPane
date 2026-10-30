# ClearPane 的 Codex 版本可行性研究

核查日期：2026-10-28，Asia/Shanghai。

可以做 Codex 桌面版本，阅读器和批注逻辑有较好的复用基础。但“在侧边阅读、本地文件实时更新、累积批注”与“点击插件按钮直接发送到当前 Codex 会话”应分别判断。前者可实现，后者的第三方宿主接口仍需验证，不能承诺直接替换 Antigravity SDK 即可交付。

本轮只做源码阅读、官方资料核查和一次浏览器只读能力检查。没有安装插件、修改原有功能、发送测试会话消息，或完成 Codex 运行验收。仓库已有的未提交修改保持原状。

## 现有实现与复用范围

README 的主要功能已对照实现核查。实际发送流程为：正文选区 → `PreviewSession` 保存引用 → 累积评论 → 组装一条消息 → 保存发送中快照 → `bridge.agent.sendMessage(message, id)` → 依据结果清空、保留或锁定待确认。

| 模块 | 现有文件 | Codex 迁移判断 |
| --- | --- | --- |
| Markdown、代码、公式、Mermaid | `src/render.mjs` | 可复用渲染实现，重新验证资源加载和宿主 CSP |
| 选区锚点、高亮 | `src/anchors.mjs`、`src/app.js` | 自有阅读页面可复用；接入原生批注时可能无需保留全部交互 |
| 批注、统一指令、超时保护 | `src/session.mjs` | 主要逻辑可复用，发送语义和确认结果需适配 |
| 文件读取、文章列表 | `plugin/sidecars/panel/files.mjs`、`workspace-files.mjs` | Node 逻辑可复用，工作区来源和授权边界需重新接入 |
| 本地与网络图片 | 后端 `images.mjs`、`src/images.mjs` | 路径校验可复用，图片传输方式取决于本地网页或 MCP UI |
| 设置、会话内存缓存 | `settings.mjs`、`sessions.mjs` | 可复用校验与缓存逻辑，替换宿主数据目录和会话标识来源 |
| 页面与排版 | `index.html`、`styles.css` | 大部分可复用，移除 Antigravity preload 和主题依赖 |
| 宿主接入 | `main.mjs`、`src/app.js` | 必须改造，不能直接运行在 Codex |
| 构建、安装 | `scripts/build.mjs`、`package.mjs`、`install-local.mjs` | 构建依赖可继续用，安装布局和清单需要 Codex 版本 |

耦合点集中在 `window.sidecar`、`sidecar_sdk`、`conversationId`、`getWorkspaceUris`、`onWorkspaceChange` 以及 Antigravity 环境变量。正文渲染、文件读写限制和消息组装没有依赖模型厂商，迁移不需要重写整套产品，也不需要额外接入模型 API。

不能把“技术模块可以复用”换算成有依据的整体复用百分比，主要工作量取决于会话和 UI 接入方式。

## Codex 官方支持范围

### 插件和本地服务有正式路径

官方插件文档支持打包技能、MCP 服务和资源。当前便携格式使用根目录 `plugin.json` 和 `mcp.json`，旧 `.codex-plugin/plugin.json` 仍兼容。本地 Codex 客户端支持通过命令启动 stdio MCP 服务。[1][2]

因此可以把现有 Node 文件服务包装为本地 MCP 能力，分发为个人或项目插件。只做 Skill 无法自行提供完整的交互式阅读器；它适合作为打开阅读器和交付评审内容的入口。

公开上架与个人安装不是同一条件。官方规定本地 MCP 的公开提交目前限已批准合作伙伴，需要组织获准后再提交。这个限制影响公开目录发布，不否定本地开发路线。[3]

### 自定义 MCP UI 有标准，但不能据此承诺 Codex 完整侧栏能力

官方 UI 文档提供 `_meta.ui.resourceUri`、HTML UI resource、`tools/call`、`ui/message` 等机制。但该文档明确描述的 iframe UI 宿主是 ChatGPT，扩展文档中的会话面板、文件查看器和扩展消息发送也以 ChatGPT 为对象。[4][5]

这些资料足以把 MCP Apps 列为候选方案，尚不足以确认当前 Codex 桌面会为第三方本地 MCP 提供与 Antigravity 相同的常驻入口、当前会话标识和发送回执。必须在目标版本实测。

本机已有的 `codex-app-tools` 提供打开面板和向聊天发消息的工具，但它依赖宿主注入的 `CODEX_APP_TOOLS_PIPE_PATH`。这说明第一方集成有相关能力，不能把第一方管道视为已公开的第三方插件 SDK，也不应让 ClearPane 依赖该私有通道。

### 内置浏览器批注是一条更小的接入路线

官方浏览器支持在聊天旁以分屏方式展示网页，包括 localhost 页面。用户可以保存网页批注，再随聊天消息发送。[6]

官方 Browser Annotation API 进一步明确，选区和评论可以进入 Codex 或 ChatGPT Work 的上下文。网页可通过 `oai-annotation-container-text` 支持文本划选，或在用户点击时调用 `document.oai.annotation.request(range, options)`。[7]

因此可让 ClearPane 作为受保护的本地网页在内置浏览器运行，继续负责排版、文件读取和更新，把评审上下文交付给宿主。

这条路线有明确限制：

- 文档面向 DevDay 2026 及之后的桌面版本，实际可用性仍受版本和权限影响。
- API 面向安全的顶层网页，如 HTTPS 或 localhost，不能假设放入 MCP iframe 仍然可用。
- `request()` 打开批注编辑器，不会替网页发送聊天消息。最终由用户提交。
- `initialComment` 上限为 240 个 UTF-16 单元，不能把现有最长 14,000 字符的批注消息塞进它。
- DOM Range 请求忽略 metadata，文件路径和文档版本不能只依赖该参数传递。
- 返回 `{ accepted: true }` 只说明接收请求，不代表批注已保存或消息已发送。

本轮在本机内置浏览器打开官方示例页，页面读取检查得到 `request`、`toggle`、`isActive` 均为 `undefined`。没有改权限、尝试发送或修改配置。该结果仅说明本次检查未观察到 API 暴露，原因未确定；不能把文档能力写成本机已验证通过，也不能据此断言所有 Codex 版本不支持。浏览器原生批注按钮是否可用仍需单独验证。

### App Server 可做独立客户端，不宜默认用来连接桌面当前聊天

官方 App Server 提供 `thread/start`、`thread/resume`、`turn/start` 等接口，适合在自己的产品内集成 Codex。[8]

但启动一个新 App Server 进程并不等于获得当前桌面聊天的连接和运行上下文。官方资料未建立这种等价关系。为迁移阅读器而自建聊天客户端、审批处理和事件消费，改动明显更多，首版不推荐。

## 功能可行性

| 目标体验 | 判断 | 条件或差异 |
| --- | --- | --- |
| 舒适排版、公式、图表、图片 | 可实现 | 复用现有前端和 Node 模块 |
| 搜索工作区文章 | 可实现 | 首版显式传入工作区目录；自动跟随聊天目录另验 |
| 文件更新保留阅读位置 | 可实现 | 沿用现有读取和交互暂停策略 |
| 划词、多条评论、统一指令 | 可实现 | 保留自有队列，或验证宿主原生批注能否满足需求 |
| 在聊天旁阅读 | 有官方浏览器分屏路线 | 不等同于注册一个与 Antigravity 一样的专属扩展侧栏 |
| 用户一次提交本轮评审 | 有可行路线 | 原生批注随用户消息提交，或先采用复制合并文本 |
| ClearPane 按钮直接触发当前聊天 | 待验证 | 原生网页批注 API 不提供这个保证；需核实 MCP UI 消息能力 |
| 自动跟随聊天且草稿不串会话 | 待验证 | 需要可靠会话身份和生命周期；不能只凭页面 URL 猜测 |
| 纯本地处理文档 | 可实现 | 本地服务提供内容，选中的评审上下文提交给 Codex |
| 面向所有人公开安装 | 有分发限制 | 本地 MCP 公开上架目前需要合作伙伴准入 |

## 建议路线

先以 Codex 桌面版为目标，保留现有 Antigravity 版本。首选验证“ClearPane 本地阅读页 + 内置浏览器 + 原生批注”，验证后再决定是否需要完整 MCP Apps UI。

最小验证应先完成：

1. 在目标桌面版本确认原生浏览器批注和网页 Annotation API 的实际支持情况。
2. 用一份含公式、图表和本地图片的 Markdown 验证分屏阅读及文件更新。
3. 累积两处批注，确认不会逐条触发 Agent，并检查一次提交后是否完整包含引用、评论、源文件路径和统一指令。
4. 切换聊天、关闭并重开页面，检查草稿隔离、保留情况和评审是否发到正确聊天。

如果原生批注满足要求，首版只需适配本地服务、阅读页启动和必要的上下文，不必再维护一套宿主消息桥接。

如果必须保留现有“待发送清单 → 一键统一发送”的完整体验，再验证本地 MCP Apps 的 UI 加载、当前聊天消息发送、回执和会话绑定。只有这些通过后才实施完整迁移。不能把“填入输入框”“发出用户消息”“向模型更新上下文”视为同一件事。

若目标版本暂不支持相关 UI，可以保留自有批注清单并复制整批文本供用户提交。它能完成评审，但需要明确标为功能降级，不能宣称与现有版体验相同。

本地网页服务必须延续鉴权、路径校验和读取上限。绑定回环地址本身不等于鉴权；文件正文和图片不能变成任意网页都可读取的公开接口。首版继续采用现有内存草稿，无需引入数据库、云端同步或另一个 Agent 运行后端。

## 官方来源

1. [Package your plugin](https://developers.openai.com/plugins/build/plugins)，插件清单、MCP 打包与本地分发。
2. [Model Context Protocol](https://learn.chatgpt.com/docs/extend/mcp)，本地 Codex 客户端及 stdio/HTTP 支持。
3. [Submit desktop-only plugins](https://developers.openai.com/plugins/deploy/desktop-only)，本地 MCP 公开发布准入。
4. [Add UI to your MCP server](https://developers.openai.com/plugins/build/chatgpt-ui)，MCP Apps UI 与消息机制。
5. [Plugin Extensions](https://developers.openai.com/plugins/build/extensions)，面板、文件查看器和扩展入口的文档范围。
6. [Browser](https://learn.chatgpt.com/docs/browser)，本地页面、分屏和原生批注流程。
7. [Annotations Extensibility](https://learn.chatgpt.com/docs/annotations-extensibility)，文本选区、API 限制和用户提交语义。
8. [Codex App Server](https://learn.chatgpt.com/docs/app-server)，独立客户端的会话和运行接口。
