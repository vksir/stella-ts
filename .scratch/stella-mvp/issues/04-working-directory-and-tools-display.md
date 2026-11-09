# 04: 工作目录 + 工具调用展示

**What to build:** 用户可以查看并修改会话的工作目录（默认 `data/workspace`，可指到任意路径）；Stella 调用 read/write/edit/bash 的过程在消息流中以折叠卡片展示（bash 显示命令与输出，read/write/edit 显示路径与摘要），展开可看全文。让 Stella"在当前工作目录建一个文件并运行一条命令"，全过程可见、文件落在所选目录。

开工前必读：`GLOSSARY.md`（重点区分"工作目录"/"默认工作区"与仓库的 npm workspaces，二者无关）、pi-durable README 的 Environment、Tools、Per-Conversation Agent 各节。工作目录是会话 agent 配置的一部分（`pi.agent` 的 cwd），经 `configure()` 修改，`env` 回调据此构建 `NodeExecutionEnv`。

**Blocked by:** 01（骨架 + 首问首答闭环）

**Status:** resolved

- [x] 会话设置暴露工作目录：显示当前值、可修改为任意绝对路径、立即生效于后续工具调用
- [x] 指向不存在目录时给出明确提示；恢复默认 `data/workspace` 一键可达
- [x] 工具调用卡片：工具名 + 关键参数（命令/路径/编辑摘要）+ 输出（折叠，可展开）；运行中状态可见
- [x] 工具实际读写/执行发生在会话工作目录（01 已挂 `CodingTools`，本票只做配置与展示，不写新工具）
- [x] 冒烟测试（faux provider）：faux 模型发起工具调用时 SSE 事件携带工具条目与结果，UI 契约字段完整

## Answer

实现：工作目录的查看/修改/恢复走 `pi.agent` 文档（`configure`），工具展示走 transcript 条目 + `pi.live.tools` 合并渲染，零新工具。

- **cwd 修改的 API 语义**：`conversation.configure({ cwd } | { cwd: null }, context)` 在自己的一个 commit 里写入会话的 `pi.agent` 文档（README「Per-Conversation Agent」）；`conversation.agent(context)` 读 resolved 值（未设置时 `cwd` 为 undefined）。**立即生效、无需重启**：pi-durable 的执行环境是"每次使用时从当前 cwd 构建"（原文 "the environment is built from the current `cwd` at each use"），T1 的 env 回调 `({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? config.workspaceDir })` 因此天然跟随——修改后从下一次工具调用起就用新目录，已在运行的运行发出的新调用也不例外（请求固定的只有 model/prompt/tools，不含 cwd）。`cwd: null` 清除显式设置回到宿主默认（即 STELLA_DATA_DIR 决定的 `data/workspace`）。
- **API**：`GET /api/conversations/:id/settings` → `{ cwd（当前生效值）, defaultWorkspace, custom }`；`PUT` body `{ cwd: "绝对路径" | null }`。服务端校验（中文 400 提示）：非绝对路径 → "应为绝对路径"；`existsSync`/`statSync` 不存在 → "目录不存在：…请先创建该目录，或改用其他已有路径"；是文件 → "该路径不是目录"；校验失败不改动当前值。恢复默认走 `PUT { cwd: null }`（不校验存在性——启动时已 mkdir，用户手动删掉目录后恢复默认仍可用）。
- **会话设置 UI**：侧栏底部设置块——当前目录（等宽字体输入框）+ 提示行（"默认工作区" / "已自定义（后续工具调用立即生效）"）+ 保存 / 恢复默认按钮；切换会话时 GET 填充，空白态禁用；保存/恢复的 400 中文提示直接经 banner 展示；输入框回车等同保存。
- **工具调用卡片（前端合并三个数据源，均按 callId/toolCallId 关联）**：① assistant 条目（`pi.assistant`）content 里的 `toolCall` 块（`{ id, name, arguments }`）→ 卡片收起态：工具名 + 关键参数摘要（bash 显示命令、read 显示路径、write "路径（写入 N 字）"、edit "路径（替换 N 字 → M 字）"，其他工具 JSON 截断 80 字）+ 状态徽标；② `pi.tool-result` 条目（`{ role:"toolResult", toolCallId, toolName, content, isError }`）按 toolCallId 填充输出全文（展开 `<details>` 可见，`isError` 卡片标红"失败"），不再显示占位行；③ 运行中的调用来自 `docs["pi.live"].tools` 槽位（`{ callId, name, status: pending|running|done, output }`）：条目里已有对应 toolCall 块的槽位只更新卡片状态徽标（排队中/运行中），尚未落到条目的（assistant 条目未提交时）在消息流末尾渲染运行卡片，参数从流式 partial 的 toolCall 块取。run 结束时 pi-durable 清空 `tools`，历史展示完全依赖 ①②，二者无缝衔接。
- **测试**：新增 `server/test/workspace-tools.test.ts` 6 用例（faux + MemoryStorage）：①GET 默认 = defaultWorkspace、custom=false；②PUT 新目录后 GET 反映且 custom=true，faux 脚本（`fauxAssistantMessage([fauxToolCall("write",…)], { stopReason: "toolUse" })` + 第二步文本回答）发起 write 相对路径，文件落在新目录而非默认工作区（验证立即生效）；③不存在目录/相对路径/文件路径均 400 且含对应中文词、原值不变；④PUT null 恢复默认；⑤工具调用 SSE 契约全断言——assistant 条目 toolCall 块（id/arguments）、两条 pi.tool-result（toolCallId 关联、toolName、isError=false、write 输出含路径）、运行期 `pi.live.tools` 有 bash 槽位且 status 非 done（bash 跑 `node -e 'setTimeout(...,800)'` 制造 800ms 窗口）、运行结束槽位清空 + 回答落定 + 文件真的在工作目录；⑥手动删掉默认工作区后恢复默认成功、重建目录后工具可写。原 8 测试不动，`npm test` 14 绿、两包 tsc strict 零错误、`npm run build`（vite）通过。
- **faux 自验要点**：faux 发起工具调用需显式 `stopReason: "toolUse"`（默认 "stop" 不会触发工具轮）；faux 服务模式内置自续填是纯文本回答，不含工具调用，工具链路只能靠测试脚本或真实 provider。Windows 下 bash 工具经 Git Bash 执行（`NodeExecutionEnv` 在 win32 依次找 Git Bash/PATH 上的 bash），faux 脚本里的命令若带 JS 代码需单引号包裹（`node -e '…'`），裸的括号会被 bash 判语法错误。真实 HTTP 冒烟（STELLA_FAUX=1 起 server）：settings 三态（默认/自定义/恢复）与中文 400 提示全部符合预期。
- **留给用户验收**：真实 key + 浏览器——①设置区改目录到任意项目路径，让 Stella"在当前工作目录建一个 notes.txt 写几行字，再用命令显示它的内容"，观察折叠卡片（write 卡片带路径与字数、bash 卡片带命令与输出）且文件真实落在所选目录；②把目录改成不存在路径看中文提示；③恢复默认后让 Stella 再建文件，确认落回 `data/workspace`；④工具运行期间卡片应显示"运行中"（长命令更明显），失败命令卡片标"失败"并可展开错误输出。

## Comments

- 2026-11-10（断点恢复记录）：上一会话因额度中断于调研阶段（无代码改动），本次从零实现完成。调试中确认的两个 faux/环境事实已写入 Answer（toolUse stopReason、Windows Git Bash 引号），避免后来者重踩。
