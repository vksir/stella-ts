# 02: 流式渲染 + 停止

**What to build:** 回复进行中，页面逐字流式显示模型的部分输出（来自 watch view 中 `pi.live` 文档的流式 partial，约每 100ms 一次 commit）；用户点"停止"立即中断当前运行，已生成的部分保留在消息流中。

开工前必读：`GLOSSARY.md`、`docs/adr/0001-pi-durable-sse-vite-stack.md`，以及 pi-durable README 的 Watching a Conversation、Abort and Subagents、Busy Conversations 各节。运行态（忙碌、运行中的生成、流式 partial）都在 `value.docs["pi.live"]`。

**Blocked by:** 01（骨架 + 首问首答闭环）

**Status:** resolved

- [x] SSE 通道在 `pi.live` 变化时把流式 partial 推给前端；回答完成后 partial 让位于最终 assistant 条目，无重复渲染
- [x] 前端流式渲染：进行中的回答可见逐字增长，带“生成中”指示
- [x] 停止按钮：运行中出现，点击调用 abort；中断后已生成内容保留，UI 回到可输入状态
- [x] 冒烟测试（沿用 01 的 faux + MemoryStorage 基建）：流式期间 SSE 至少收到一个含 partial 的事件；停止后 SSE 出现运行结束状态

## Answer

实现：服务端 `POST /api/conversations/:id/stop`（`conversation.abort(context)`，等空闲才 resolve）+ 前端流式渲染与停止按钮；SSE 通道零改动——T1 的每次 commit 全量 view 推送天然携带 `pi.live` 的流式 partial。

- **SSE 与前端衔接**：运行中的回答在 `docs["pi.live"].generation.message`（约每 100ms 一次节流 commit，watch 每次推送全量 view，partial 随之到达）。前端去重规则：本运行已提交回答条目（`id ≥ run.first`）就不再渲染 partial，气泡让位于最终 `pi.assistant` 条目；回答条目与 run 移除、runFailure 设置在同一 commit 原子完成（实测确认），即使存在一瞬的中间态也被去重规则覆盖。
- **停止**：前端停止按钮仅 `run` 在场时显示，点击 POST `/stop`；pi-durable 的 abort 撤回排队输入、中止运行、等空闲。中断后已生成的 partial 被 pi-durable 转为 `stop=aborted` 的 `pi.assistant` 条目保留（实测 288 字保留），`runFailure.reason "aborted"` 经 SSE 到达，前端显示“已停止本次运行，已生成的部分已保留。”，run 消失后按钮隐藏、可继续输入（测试验证停止后再发消息正常回答）。
- **faux 流式的关键发现**：pi-ai faux 不配 `tokensPerSecond` 时 delta 用 `queueMicrotask` 瞬时推完，pi-durable 的 100ms partial 节流来不及 commit，**看不到任何 partial**（stop 也成了空操作）。配速率后 delta 用真实定时器推进。为此 `installFauxProvider`/`createStella` 增加 `fauxTokensPerSecond` 选项（测试用，生产不配）；真实 provider 的 delta 随网络逐批到达，节流正常触发，无此问题。
- **测试**：`server/test/streaming-stop.test.ts` 3 用例——①流式期间 SSE 收到逐次增长的 partial（run 在场），回答落定后 partial 清空、run 结束、最终条目含完整回答；②停止后 SSE 出现运行结束状态（run 消失 + `runFailure.reason "aborted"`）、已生成内容保留为条目（前缀校验）、停止后再发消息正常回答；③空闲时 stop 无害、未知会话 404。`npm test` 5 绿、tsc strict 两包零错误。
- **e2e 自验（faux + 速率，真实 HTTP）**：curl 消费 SSE 实测 partial 20→72→…→288 字增长；stop 后最终 view `run` 消失、`runFailure.reason "aborted"`、`pi.assistant(len=288, stop=aborted)` 保留、partial 清空。

留给用户真实 key 验收：浏览器对话看回答逐字增长与“生成中”指示（partial 频率取决于 provider delta 节奏）；回答进行中点停止，确认已生成部分保留、可继续提问；faux 模式（`STELLA_FAUX=1`）下回答瞬时完成，需真实 provider（或多轮工具调用）才能观察到明显的流式过程。
