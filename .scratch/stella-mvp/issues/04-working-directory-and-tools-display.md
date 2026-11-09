# 04: 工作目录 + 工具调用展示

**What to build:** 用户可以查看并修改会话的工作目录（默认 `data/workspace`，可指到任意路径）；Stella 调用 read/write/edit/bash 的过程在消息流中以折叠卡片展示（bash 显示命令与输出，read/write/edit 显示路径与摘要），展开可看全文。让 Stella"在当前工作目录建一个文件并运行一条命令"，全过程可见、文件落在所选目录。

开工前必读：`GLOSSARY.md`（重点区分"工作目录"/"默认工作区"与仓库的 npm workspaces，二者无关）、pi-durable README 的 Environment、Tools、Per-Conversation Agent 各节。工作目录是会话 agent 配置的一部分（`pi.agent` 的 cwd），经 `configure()` 修改，`env` 回调据此构建 `NodeExecutionEnv`。

**Blocked by:** 01（骨架 + 首问首答闭环）

**Status:** claimed

- [ ] 会话设置暴露工作目录：显示当前值、可修改为任意绝对路径、立即生效于后续工具调用
- [ ] 指向不存在目录时给出明确提示；恢复默认 `data/workspace` 一键可达
- [ ] 工具调用卡片：工具名 + 关键参数（命令/路径/编辑摘要）+ 输出（折叠，可展开）；运行中状态可见
- [ ] 工具实际读写/执行发生在会话工作目录（01 已挂 `CodingTools`，本票只做配置与展示，不写新工具）
- [ ] 冒烟测试（faux provider）：faux 模型发起工具调用时 SSE 事件携带工具条目与结果，UI 契约字段完整
