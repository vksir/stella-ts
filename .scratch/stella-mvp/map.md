# Stella MVP — Map

## Notes

- 仓库：npm workspaces（`server/` + `web/`），pi-durable 1.5.0 精确锁定（experimental）。
- 领域语言见 `GLOSSARY.md`；架构决策见 `docs/adr/`。

## Decisions-so-far

- 01-skeleton-first-answer（resolved）：pi-durable 1.5.0 的 generation 自行提交 `pi.assistant`（`settled.answer` 为 EntryId）；Quick Start 的 `commit(tx => tx.entry(...))` 是读，不是写。SSE 用 streamSSE 推送初始 view + 每次 commit 的全量 view（窗口 200/400），窗口外用 `/entries?before=` 翻页。pi-ai 1.5.0 目录无 `deepseek-chat`，缺省模型缺目录时自动回退该 provider 第一个模型并警告。faux 服务模式内置自续填固定回答（测试用 `setResponses` 覆盖）。配置读 cwd 与仓库根两级 `.env`。
- 02-streaming-and-stop（resolved）：运行态三要素都在 `pi.live`（`run` 在场即忙碌；`generation.message` 是流式 partial，约每 100ms 一次节流 commit 随 watch 全量 view 到达；`runFailure.reason` 含 `aborted`）。停止用 `conversation.abort(context)`（POST /api/conversations/:id/stop）；中止的 partial 被 pi-durable 转为 `stop=aborted` 的 `pi.assistant` 条目保留，回答条目与 run 移除/runFailure 设置在同一 commit 原子完成，前端用 `id ≥ run.first` 去重避免 partial 与最终条目重复。pi-ai faux 不配 `tokensPerSecond` 时 delta 瞬时推完，partial 节流来不及 commit（看不到 partial）；`createStella` 新增 `fauxTokensPerSecond` 供流式/停止测试。
- 03-conversation-management（resolved）：pi-durable 1.5.0 无删除会话的 API（Harness/Conversation/Tx/Storage 各层均无 delete），`ConversationRecord` 也只有 id 与归属，无标题/创建时间。据此：元数据用会话级文档 `stella.meta`（defineDoc + `submit(tx, draft)` 同 commit 写入，自定义文档不进 view.docs，列表在同 commit 里 scan + 逐个读）自持 `{ createdAt, title, deleted }`；标题为首条用户消息 30 码点截断加 `…`；删除是宿主层归档（先 abort 再置 deleted，列表过滤隐藏，数据仍在存储）——UI/API 均如实表述，不谎称物理删除。前端切换会话先 close 旧 EventSource 再重订，SSE 回调按 `view.conversation.id` 丢迟到事件。
- 04-working-directory-and-tools-display（resolved）：会话工作目录即 `pi.agent` 的 cwd：`conversation.configure({ cwd } | { cwd: null })` 一个 commit 写入，`conversation.agent()` 读 resolved 值；立即生效无需重启——pi-durable 的执行环境“每次使用时从当前 cwd 构建”（env 回调天然跟随），请求固定的只有 model/prompt/tools。工具展示三源合并（均按 callId/toolCallId 关联）：`pi.assistant` 条目的 toolCall 块（id/name/arguments）是卡片骨架，`pi.tool-result` 条目（toolCallId/toolName/content/isError）填输出全文，运行中的调用看 `pi.live.tools` 槽位（status pending/running/done + 节流 output）；run 结束时 pi-durable 清空 tools，历史展示全靠条目。faux 发工具调用需显式 `stopReason: "toolUse"`；Windows 下 bash 工具经 Git Bash 执行，命令里的 JS 代码要单引号包裹（裸括号被 bash 判语法错误）。
- 05-model-switching-and-favorites（resolved）：模型目录来自 pi-ai `Models`（只含已装 provider），`buildModelCatalog` 产出 `{ provider, providerName, modelId, name }`（装载顺序 × 目录顺序）；切换走 `conversation.configure({ model })` 写入 `pi.agent`，立即生效于下一次生成，回答条目 `model[0].provider/model` 即验证点（faux 的 stream 也会填请求模型 id）。默认模型回落扩展为逐级：provider 未装（原拒绝启动）→ 第一个已装 provider 第一个模型，`fallbackFrom` 经 `/api/models` 的 `defaultModelFallback` 透传前端提示；新会话回落默认模型是创建时写入 `agent.model` 的既有行为。收藏是 localStorage 偏好（键 `stella.model-favorites`，"provider/modelId" 数组），下拉用原生 optgroup（option 内放不了按钮，星标按钮放下拉旁作用于当前会话模型），分组取“收藏组置顶 + 其余组内目录顺序”方案。faux 多模型靠 `fauxProvider` 原生 `models` 选项（`installFauxProvider`/`createStella` 透传 `fauxModels`），模型切换测试的必要条件。
- 06-queue-and-error-retry（resolved）：排队走 pi-durable 缺省语义（`whenIdle` 启动运行、`whenBusy` follow-up 进 `view.docs["pi.inbox"]`），API 层不覆写即如实透传，运行结束（回答或失败）后 boundary 自动按序放置依次执行。**停止撤回排队输入**（票面预期“继续执行”与 pi-durable 语义相反）：`abort` 对每个排队输入 settle `unanswered`/`aborted`、离开 inbox、不留条目——前端发送时 busy 的消息记内存，随 view 对账（在 inbox 或已成条目的移出），判定为撤回时横幅提示。失败 run 留两处痕迹：`runFailure`（`reason`/`detail`/`first`，下次 run 开始才清除）与一条 `stopReason "error"` + `errorMessage` 的 `pi.assistant` 条目（pi-durable 保留的错误 attempt，前端渲染为错误气泡）。错误卡片内嵌在 `runFailure.first` 之后最后一条条目之后，中文文案包裹 detail；重试用**新 requestId**重发同文本（同 requestId 只会幂等找回原提交，admit 实测不写入），新 `pi.user` 条目如实重复出现，runFailure 随新 run 清除、卡片消失。faux 自验：`fauxTokensPerSecond` 制造排队窗口；注入失败＝`setResponses([fauxAssistantMessage(msg, { stopReason: "error", errorMessage })])`（不匹配可重试模式，fail fast）或直接空队列（"No more faux responses queued"）；停止测试等 partial 非空再停，谓词锚定终态字段（runFailure reason）避免初始 view 提前命中。

## Fog

- pi-ai 1.5.0 各 provider 在线刷新目录后的模型 id 集合未实测（离线静态目录为准）。
- Vite 对 SSE 的代理在长时间空闲下的行为未做长稳测试（已有 15s ping 心跳兜底）。
- 真实 provider 的 delta 到达节奏未实测：partial 频率取决于 provider 流式行为，faux 速率仅能近似（票 02 用 curl + faux 速率验证过链路本身）。
- 真实 provider 下可重试错误（429/5xx 等）会触发 pi-durable generation 的指数退避重试（默认 maxRetries 3、baseDelayMs 2000），失败卡片出现的时延未实测；faux 注入的不匹配可重试模式，fail fast。
- 前端停止撤回的横幅提示基于发送时内存记录 + 文本匹配对账，刷新后丢失记录（不再提示）；同文本消息与撤回消息混用时可能漏报，不误报。
