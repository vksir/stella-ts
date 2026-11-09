# 06: 排队 + 错误重试

**What to build:** 会话运行中用户仍可继续输入：新提交排队并显示"等待中"状态，前一条回答完成后自动依次执行。模型请求失败时，消息流内嵌错误卡片（含失败原因）与"重试"按钮；点击重试以新 requestId 重新提交最后一条用户消息，不做自动重试。

开工前必读：`GLOSSARY.md`（"提交（Submission）"、"运行"词条）、pi-durable README 的 Busy Conversations、Errors、Persist and Resume（requestId 幂等）各节。排队中的提交在 `pi.inbox` 文档；失败原因在 `pi.live` 的 runFailure。

**Blocked by:** 02（流式渲染 + 停止——依赖其运行状态展示）

**Status:** ready-for-agent

- [ ] 运行中发送新消息：不报错不清空，入队显示"等待中"，运行结束后自动执行
- [ ] 错误卡片：失败原因可读（中文文案包裹底层错误），出现在对应提交位置
- [ ] 重试按钮：以新 requestId 重发该用户消息；重试成功后错误卡片被正常回答取代
- [ ] 停止（02 已有）与排队协同：停止当前运行后，排队消息继续执行而非被丢弃（若 pi-durable 语义不同，按其语义实现并在 UI 如实呈现）
- [ ] 冒烟测试（faux provider，注入失败）：失败时 SSE 出现 runFailure/错误事件；排队两条消息按序各得回答
