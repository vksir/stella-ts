# 01: 骨架 + 首问首答闭环

**What to build:** 从零搭起 Stella：`npm run dev` 一键启动前后端，浏览器打开页面即可与 Stella 对话——发一条消息、收到回答；刷新页面历史还在；重启服务进程，会话与历史从 SQLite 完整恢复。这是贯穿全部层次的 tracer bullet：workspaces 骨架、pi-durable Harness、provider 自动发现、POST 上行 + SSE 下行、最小聊天页、测试基建，一次打通。

开工前必读：`GLOSSARY.md`、`docs/adr/0001-pi-durable-sse-vite-stack.md`、`AGENTS.md`。pi-durable 用法以 `node_modules/@earendil-works/pi-durable/README.md` 为准（Quick Start、Watching a Conversation、Extensions、Tools、Environment、Storage 各节），锁精确版本 1.5.0（experimental，勿装其他版本）。

**Blocked by:** 无（可立即开始）

**Status:** resolved

- [x] npm workspaces：`server/`（Node 24、TS ESM、strict、tsx 热重载、Hono + @hono/node-server）与 `web/`（Vite + vanilla TS，无 UI 框架），根 `package.json` 提供 `dev`（并行起前后端）/ `build` / `start`，web dev server 将 `/api` 代理到 server
- [x] Harness：`openNodeSqliteStorage("./data/stella.sqlite")` + `harness.resume()`；registry 安装自带 `CodingTools`（read/write/edit/bash，不自己写工具）；英语人设 extension section（Stella 定位万用日常型助手，回复跟随用户语言，提及可用文件与命令工具但**不偏向编程**）；`env` 回调按会话 agent 的 cwd 构建 `NodeExecutionEnv`，cwd 默认 `./data/workspace`
- [x] provider 自动发现：只读当前目录 `.env`（dotenv 或等价），映射表 `DEEPSEEK_API_KEY→deepseek`、`ZAI_API_KEY→zai`、`MOONSHOT_API_KEY→moonshotai-cn`、`OPENROUTER_API_KEY→openrouter`、`OPENAI_API_KEY→openai`、`ANTHROPIC_API_KEY→anthropic`、`GROQ_API_KEY→groq`、`XAI_API_KEY→xai`（以 pi-ai 实际 provider 名为准核对）；有 key 才 `models.setProvider(...)`；默认模型 `STELLA_DEFAULT_MODEL`（`provider/modelId` 形式，缺省 `deepseek/deepseek-chat`）；一个 key 都没有时启动给出明确中文报错；`.env.example` 含全部映射示例
- [x] HTTP API：新建会话（首个 root 会话）、`POST /api/conversations/:id/messages` 提交当前消息（客户端只发新消息，不带历史——服务端权威）、`GET /api/conversations/:id/events` SSE 端点推送 watch 的初始 view 与后续每次 commit（submit 的回答按 pi-durable 用法 commit 为 AssistantEntry 后经 watch 到达前端）
- [x] 最小聊天页：消息流 + 输入框 + 发送；条目按类型渲染（用户消息、assistant 回答；未知类型如工具调用显示占位行）；`EventSource` 订阅 SSE
- [x] 测试基建 + 1 条 happy path 冒烟测试（vitest）：进程内起 app，faux provider（`@earendil-works/pi-ai/providers/faux`）+ `MemoryStorage`，POST 消息后从 SSE 收到用户条目与回答条目；零网络零 key 可跑，`npm test` 绿
- [x] `.env`、`data/`、构建产物均已 gitignore；`npm run build` 产物可被 `npm start` 直接运行；tsc strict 零错误

## Answer

实现：npm workspaces 双包（`server/`：Hono + @hono/node-server + tsx 热重载；`web/`：Vite + vanilla TS）。根 `dev` 用 concurrently 并行起前后端；web dev 代理 `/api` → server（`STELLA_PORT`，默认 7090）。

- Harness：`openNodeSqliteStorage(data/stella.sqlite)` + `harness.resume()`；registry 装 `CodingTools` + 英语人设 extension（万用日常型、回复跟随用户语言、提及文件与命令工具但不偏编程）；`env` 回调按会话 agent cwd 建 `NodeExecutionEnv`，缺省默认工作区 `data/workspace`。
- Provider 自动发现：dotenv 读 cwd 与仓库根的 `.env`，按映射表有 key 才注册；provider 名已对照 pi-ai 1.5.0 实际导出（deepseek/zai/moonshotai-cn/openrouter/openai/anthropic/groq/xai）。注意：pi-ai 1.5.0 模型目录中没有 `deepseek-chat`，缺省 `STELLA_DEFAULT_MODEL=deepseek/deepseek-chat` 不在目录时自动改用该 provider 第一个模型并在启动日志警告。
- HTTP API：`POST /api/conversations`（首个为保留 root 会话）、`GET /api/conversations`、`POST /api/conversations/:id/messages`（202；只发新消息；settled 后按 README 用法 `commit(tx => tx.entry(AssistantEntry, settled.answer))` 读取回答条目）、`GET /api/conversations/:id/events`（streamSSE：初始 view + 每次 commit 的新 view + ping 心跳）、`GET /api/conversations/:id/entries`（视图窗口外向前翻页）。
- 聊天页：消息流 + 输入框 + EventSource；条目按类型渲染（user/assistant 文本、工具调用等占位行），运行中/失败提示，「加载更早」按钮。
- 测试：vitest + faux + MemoryStorage 进程内起 app，先订阅 SSE 再 POST，断言收到用户条目与回答条目，另验证重新订阅的初始 view 含历史；零 key 启动中文报错单独覆盖。`npm test` 绿、tsc strict 零错误、`npm run build` + `npm start` 实测可跑（faux 模式含排队 follow-up 双轮对话验证）。

实现备注：pi-durable 1.5.0 的 generation 自行提交 `pi.assistant` 条目（`settled.answer` 即其 EntryId），Quick Start 里的 commit 是在 commit 中**读取**该条目（`tx.entry(token, id)` 为读），非手动写入；实现按此用法落实。faux 服务模式内置自续填固定回答脚本，测试可用 `setResponses` 覆盖为确定性脚本。

留给用户验收：真实 key 的浏览器对话——复制 `.env.example` 为 `.env` 配置任一 provider key（建议同时设 `STELLA_DEFAULT_MODEL` 为目录中存在的模型，如 `deepseek/deepseek-flash`），`npm run dev` 或 `npm run build && npm start`。
