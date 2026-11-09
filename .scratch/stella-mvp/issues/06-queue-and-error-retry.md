# 06: 排队 + 错误重试

**What to build:** 会话运行中用户仍可继续输入：新提交排队并显示"等待中"状态，前一条回答完成后自动依次执行。模型请求失败时，消息流内嵌错误卡片（含失败原因）与"重试"按钮；点击重试以新 requestId 重新提交最后一条用户消息，不做自动重试。

开工前必读：`GLOSSARY.md`（"提交（Submission）"、"运行"词条）、pi-durable README 的 Busy Conversations、Errors、Persist and Resume（requestId 幂等）各节。排队中的提交在 `pi.inbox` 文档；失败原因在 `pi.live` 的 runFailure。

**Blocked by:** 02（流式渲染 + 停止——依赖其运行状态展示）

**Status:** resolved

- [x] 运行中发送新消息：不报错不清空，入队显示"等待中"，运行结束后自动执行
- [x] 错误卡片：失败原因可读（中文文案包裹底层错误），出现在对应提交位置
- [x] 重试按钮：以新 requestId 重发该用户消息；重试成功后错误卡片被正常回答取代
- [x] 停止（02 已有）与排队协同：停止当前运行后，排队消息继续执行而非被丢弃（若 pi-durable 语义不同，按其语义实现并在 UI 如实呈现）
- [x] 冒烟测试（faux provider，注入失败）：失败时 SSE 出现 runFailure/错误事件；排队两条消息按序各得回答

## Answer

实现：服务端零新端点（POST /messages 的 pi-durable 缺省语义已如实透传，只补了注释说明）；前端 `web/src/main.ts` 排队气泡 + 内嵌错误卡片 + 重试按钮；测试 `server/test/queue-retry.test.ts` 4 用例。

- **排队（pi-durable 缺省语义，README「Busy Conversations」）**：`submit` 缺省 `whenIdle` 启动运行、`whenBusy` 以 follow-up 排队进会话收件箱 `view.docs["pi.inbox"]`（`{ items: [{ id, mode, content }] }`，入队顺序即 id 序）。API 层不覆写这两个缺省值即为如实透传：运行中 POST 新消息不报错（202），运行结束（回答或失败）后 pi-durable 在下一个 boundary 自动按序放置并依次执行，无需宿主干预。前端把 inbox 项渲染为带"等待中"标记的半透明虚线用户气泡（真实 pi.user 条目在放置后才出现，气泡只是预告）。
- **停止与排队的真实协同语义（票面预期与 pi-durable 不同，按实呈现）**：`conversation.abort()` **撤回全部排队输入**（`withdrawQueuedInputs`：每项 settle `unanswered`/`aborted`、离开 inbox、不产生条目；排队 writes 保留）。所以"停止后排队消息继续执行"在 pi-durable 语义下不成立——消息不会被丢弃成悬空状态，而是原样退回（未发送）。前端如实呈现：发送时运行中的消息记入内存（`state.queuedSent`），随 view 对账——仍在 inbox 或已出现为条目的移出记录，其余判定为已随停止撤回并横幅提示"已撤回，未发送，可重新输入"（仅存内存，刷新即忘，不遮挡真实状态）。
- **错误卡片**：运行无回答结束时 `docs["pi.live"].runFailure`（`reason` + `detail` + `first`（失败 run 首条目 id），下次运行开始才清除）。前端在非 aborted 失败时渲染内嵌错误卡片，位置＝`runFailure.first` 之后最后一条条目之后（失败 run 会留下一条 `stopReason: "error"` + `errorMessage` 的 `pi.assistant` 条目——pi-durable 保留的错误 attempt，前端以错误气泡如实渲染而非当正常回答），窗口外锚点时兜底流末尾；`aborted` 维持票 02 的"已停止"提示行。文案 `failureCardText` 按原因给中文（model_error/no_model/turn_limit…）并包裹底层错误（"，底层错误："+ detail）。
- **重试的真实呈现**：以**新 requestId**（`crypto.randomUUID()`）重发同文本——相同 requestId 只会幂等找回原提交（实测 admit 对已知 requestId 直接返回原 submission 不写入，测试固化了这一语义）。重试的提交按 pi-durable 语义再次放置为一条新 `pi.user` 条目：transcript 如实出现重复的用户消息（不隐藏），新 run 开始时 runFailure 清除、错误卡片消失，回答落定后由正常回答取代；旧的错误回答条目作为历史保留。发送统一带 requestId（网络层重发防重复）；所有发送（含重试）走同一 `submitWithRequest`。
- **faux 下如何自验**：`fauxTokensPerSecond: 200` 控速让首条长回答流式数秒，制造排队窗口（连发两条 → 断言 inbox 两项、落定后 transcript 三问三答按序对应）；注入失败用 `setResponses([fauxAssistantMessage(msg, { stopReason: "error", errorMessage })])`（不匹配 pi-ai 的可重试错误模式，fail fast 无 backoff 等待）；"队列为空"本身就是失败注入（faux 返回 "No more faux responses queued"）。停止测试等 partial 非空再 stop（否则无内容可保留，与票 02 同手法）；谓词一律锚定终态字段（runFailure reason），避免初始 view 提前命中。
- **测试**：`server/test/queue-retry.test.ts` 4 用例——①运行中连发两条：202 不报错、inbox 按序两项、落定后三问三答顺序对应；②停止撤回排队输入：inbox 清空、无该消息条目、runFailure "aborted"、已生成 partial 保留；③注入失败：SSE 出现失败态（run 消失 + runFailure model_error + detail 底层错误 + 错误 attempt 条目形状），新 requestId 重试成功、错误清除、重复 pi.user 如实出现；④同 requestId 幂等去重：返回原 submissionId、无新条目无新运行。`npm test` 6 文件 23 用例全绿，`npm run typecheck` 零错误，build 通过；另经真实 HTTP（faux 服务模式 + curl）验证幂等重发与 SSE 终态。

留给用户真实 key 验收：配真实 provider 后在运行中连发消息看"等待中"气泡依次变为回答；制造失败（如断网/错 key）看错误卡片与"重试"；运行中点停止，确认排队的消息被提示已撤回（pi-durable 语义：撤回而非继续执行）。

## Comments

