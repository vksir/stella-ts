# 03: 会话管理

**What to build:** 页面左侧出现会话侧栏：列表、新建、切换、删除。每个会话有独立的消息历史、模型选择与工作目录，互不串扰；会话标题取首条用户消息截断（约 30 字符）生成。重启服务后列表与各会话历史完好。

开工前必读：`GLOSSARY.md`（注意"会话"词条）、`docs/adr/0001-pi-durable-sse-vite-stack.md`，以及 pi-durable README 的 More Conversations and Forks、Storage 各节。

**Blocked by:** 01（骨架 + 首问首答闭环）

**Status:** resolved

- [x] API：会话列表（含标题、创建时间）、新建会话、删除会话
- [x] 切换会话时前端重订 SSE、恢复该会话完整历史（watch 初始 view，必要时向前翻页加载）
- [x] 新建会话后输入框聚焦、空白消息流；首条消息发出后标题更新为其截断
- [x] 删除会话有确认；删除后自动切到剩余会话（无剩余则空白态 + 新建入口）
- [x] 冒烟测试：新建两个会话各发一条消息，各自 SSE/历史互不混；删除其一后列表只剩另一个

## Answer

实现：会话元数据自持（pi-durable 会话文档）+ 宿主层归档删除 + 侧栏 UI。

- **元数据（标题/创建时间）**：pi-durable 1.5.0 的 `ConversationRecord` 只有 id 与归属关系，无标题、无创建时间。按 README「Your Own State」定义会话级文档 `stella.meta`（`defineDoc`，`history: "latest"`，`checkpointWhen: () => true`）存 `{ createdAt, title, deleted }`：创建会话的同一 commit 经 `init` 回调写入初值；首条用户消息发出时，提交 admission（`conversation.submit(tx, draft)`，必须先于其他 table write）与标题写入同一 commit，标题按码点截 30 字加 `…`。自定义文档不进 view.docs，列表端点在同一 commit 里 `scanConversations` + 逐个读文档输出 `{ id, title, createdAt }`（旧数据缺 createdAt 为 0 时不输出）。
- **删除的真实语义**：pi-durable 1.5.0 **没有删除会话的 API**——`Harness`/`Conversation`/`Tx`/Storage 各层均无 delete/destroy（`fork`/`createConversation` 可建，无对应移除），物理删除需绕过存储层直改 SQLite 表，且 faux 的 MemoryStorage 根本无表，不可行。因此 `DELETE /api/conversations/:id` 是宿主层归档：先 `conversation.abort()`（停运行、撤回排队输入，已生成 partial 保留，与「停止」同语义），再置 `deleted = true`；列表过滤后用户看不到。数据仍在存储中，API 与 UI 均按归档表述，不谎称物理删除。
- **前端**：侧栏（新建按钮 + 会话列表：标题缺省「新对话」、创建时间 M/D HH:mm、当前高亮、hover 出删除钮）；删除走确认弹层（确认/取消/点遮罩关）；删当前会话后自动切到剩余第一个，无剩余则空白态（消息区提示 + 新建入口，输入禁用）；切换会话先 `close()` 旧 EventSource 再重订（避免多连接并存），消息状态（view/earlier）重置，历史恢复走既有初始 view + 「加载更早」翻页；SSE 回调按 `view.conversation.id` 丢弃旧连接的迟到事件；发消息成功后刷新侧栏拿新标题。
- **测试**：新增 `server/test/conversations.test.ts` 3 用例——①新建（首个 root 会话、列表含创建时间、未发消息标题缺省）；②标题为首条消息 30 码点截断加 `…`；③两会话各发一条消息互不串（甲的 SSE 全程无乙的条目、重订阅初始 view 只含自己的问答、标题各取首条），删除甲后列表只剩乙、删除不存在 404。原 5 测试不涉及改动端点的响应形状，全部保留；`npm test` 8 绿、两包 tsc strict 零错误、`npm run build` + `vite build` 通过。
- **faux 自验（真实 HTTP + curl/node）**：新建两个会话列表两项带 createdAt；发超长中文消息后标题恰为 30 码点 + `…`（UTF-8 无损）；DELETE 后列表只剩另一个；DELETE 不存在返回 404；会话 SSE 正常推 user/assistant 条目。
- **SQLite 重启自验**（dummy key、不发消息、零网络）：建 2 会话 → 杀进程重启 → 列表与 createdAt 完好（元数据文档随 SQLite 持久化）；删 1 个 → 再重启 → 仍只剩 1 个（归档标记持久）。带消息历史的重启恢复沿用票 01 已验证的同一存储机制（条目本就落盘），faux（MemoryStorage）无盘无法自验，留真实模式验收。

留给用户验收：真实 key + 浏览器体验侧栏交互——切换会话（历史恢复、加载更早翻页）、新建（聚焦空白流）、删除确认与自动切换、无剩余会话的空白态；带消息的会话在服务重启后列表与历史完好；顺带确认删除语义（归档隐藏）符合预期——若需要真物理删除，得等 pi-durable 提供会话移除 API 或自行承担直改存储的风险。
