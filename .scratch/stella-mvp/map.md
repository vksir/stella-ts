# Stella MVP — Map

## Notes

- 仓库：npm workspaces（`server/` + `web/`），pi-durable 1.5.0 精确锁定（experimental）。
- 领域语言见 `GLOSSARY.md`；架构决策见 `docs/adr/`。

## Decisions-so-far

- 01-skeleton-first-answer（resolved）：pi-durable 1.5.0 的 generation 自行提交 `pi.assistant`（`settled.answer` 为 EntryId）；Quick Start 的 `commit(tx => tx.entry(...))` 是读，不是写。SSE 用 streamSSE 推送初始 view + 每次 commit 的全量 view（窗口 200/400），窗口外用 `/entries?before=` 翻页。pi-ai 1.5.0 目录无 `deepseek-chat`，缺省模型缺目录时自动回退该 provider 第一个模型并警告。faux 服务模式内置自续填固定回答（测试用 `setResponses` 覆盖）。配置读 cwd 与仓库根两级 `.env`。
- 02-streaming-and-stop（resolved）：运行态三要素都在 `pi.live`（`run` 在场即忙碌；`generation.message` 是流式 partial，约每 100ms 一次节流 commit 随 watch 全量 view 到达；`runFailure.reason` 含 `aborted`）。停止用 `conversation.abort(context)`（POST /api/conversations/:id/stop）；中止的 partial 被 pi-durable 转为 `stop=aborted` 的 `pi.assistant` 条目保留，回答条目与 run 移除/runFailure 设置在同一 commit 原子完成，前端用 `id ≥ run.first` 去重避免 partial 与最终条目重复。pi-ai faux 不配 `tokensPerSecond` 时 delta 瞬时推完，partial 节流来不及 commit（看不到 partial）；`createStella` 新增 `fauxTokensPerSecond` 供流式/停止测试。
- 03-conversation-management（resolved）：pi-durable 1.5.0 无删除会话的 API（Harness/Conversation/Tx/Storage 各层均无 delete），`ConversationRecord` 也只有 id 与归属，无标题/创建时间。据此：元数据用会话级文档 `stella.meta`（defineDoc + `submit(tx, draft)` 同 commit 写入，自定义文档不进 view.docs，列表在同 commit 里 scan + 逐个读）自持 `{ createdAt, title, deleted }`；标题为首条用户消息 30 码点截断加 `…`；删除是宿主层归档（先 abort 再置 deleted，列表过滤隐藏，数据仍在存储）——UI/API 均如实表述，不谎称物理删除。前端切换会话先 close 旧 EventSource 再重订，SSE 回调按 `view.conversation.id` 丢迟到事件。
- 04-working-directory-and-tools-display（resolved）：会话工作目录即 `pi.agent` 的 cwd：`conversation.configure({ cwd } | { cwd: null })` 一个 commit 写入，`conversation.agent()` 读 resolved 值；立即生效无需重启——pi-durable 的执行环境"每次使用时从当前 cwd 构建"（env 回调天然跟随），请求固定的只有 model/prompt/tools。工具展示三源合并（均按 callId/toolCallId 关联）：`pi.assistant` 条目的 toolCall 块（id/name/arguments）是卡片骨架，`pi.tool-result` 条目（toolCallId/toolName/content/isError）填输出全文，运行中的调用看 `pi.live.tools` 槽位（status pending/running/done + 节流 output）；run 结束时 pi-durable 清空 tools，历史展示全靠条目。faux 发工具调用需显式 `stopReason: "toolUse"`；Windows 下 bash 工具经 Git Bash 执行，命令里的 JS 代码要单引号包裹（裸括号被 bash 判语法错误）。

## Fog

- pi-ai 1.5.0 各 provider 在线刷新目录后的模型 id 集合未实测（离线静态目录为准）。
- Vite 对 SSE 的代理在长时间空闲下的行为未做长稳测试（已有 15s ping 心跳兜底）。
- 真实 provider 的 delta 到达节奏未实测：partial 频率取决于 provider 流式行为，faux 速率仅能近似（票 02 用 curl + faux 速率验证过链路本身）。
