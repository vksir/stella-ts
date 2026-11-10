# 服务端权威架构：@earendil-works/pi-durable + SSE + Vite

Stella 的对话能力构建在 `@earendil-works/pi-durable` 之上：Harness/Conversation/Entry 模型，SQLite（`node:sqlite`，Node ≥ 24）单文件持久化，进程崩溃后未完成的运行可恢复。浏览器与服务端的实时通道用 **SSE 下行 + 普通 POST 上行**（无 WebSocket）：pi-durable 的 `watch()` 产出的 view 本就面向远程客户端，SSE 足以承载；view 的 `entries` 只是窗口，断线重连按 `ConversationTranscript` 的语义补齐——客户端持有整段转写（`web/src/transcript.ts`，与官方类同构：窗口合并、缺口标记、`hasMore` 翻页），重连时以 `?from=` 从已持有的最新条目续订，超过窗口上限的部分显式记为缺口并按页补齐。前端选 **Vite + vanilla TS（无 UI 框架）**，仓库为 npm workspaces 双包（`server/` + `web/`）。

配置只读当前目录（项目内 `.env`）：服务需部署到其他机器，不读取 `~/.pi/agent/auth.json` 等 pi 私有文件。启动时按"provider → 环境变量"映射表自动发现并装载所有配了 key 的 provider，界面按会话切换模型。

## Considered Options

- **传输**：WebSocket + SSE 两个方向都能承载 watch 增量；选 SSE 因上行本来就走 POST，且用户明确希望避开 WebSocket。
- **Provider 配置**：复用 `~/.pi/agent/auth.json`（否——耦合 pi 私有数据，部署到其他机器不可用）；单一固定 provider（否——pi-ai 天然多 provider，自动发现成本为零）。
- **存储**：JSONL / MemoryStorage 被否——SQLite 单文件即可获得崩溃恢复与会话持久化。
- **前端**：React/Vue 被否——聊天页 DOM 结构简单，vanilla TS 足够；Vite 工具链按用户要求上全。

## Consequences

- pi-durable 处于 experimental 阶段（API 随版本可能变化），锁定精确版本，升级时按 CHANGELOG 逐版本核对。
- 工具（read/write/bash/edit 用自带 `CodingTools`）经 `NodeExecutionEnv` 在本机直接执行、无沙箱；单用户本机部署下接受此风险，见 GLOSSARY「工作目录」。
