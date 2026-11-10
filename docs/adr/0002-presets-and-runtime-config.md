# 预设与运行配置：创建时解析、首轮锁定、文件热更新

Stella 的会话能力由「预设」决定，运行策略由可选的 `data/stella.config.json` 决定。两者都不进 `.env`，也都不在运行中重写已有会话。

## 问题

pi-durable 的 agent 组装（扩展、工具、指令、`maxTurns`）按会话存储在 `pi.agent` 里，但产品层需要一个用户能理解、能选择、能随部署调整的**能力包**：日常使用不该每次手工勾选工具；部署方也希望能调超时、重试、压缩阈值而不改代码。同时，Stella 是单用户本机常驻进程，配置文件应当可以改完即生效，而不是重启。

这里有三组相互牵制的选择：

1. **预设存什么**：只存名字，还是把整个 `AgentChange` 快照存进会话？
2. **预设何时生效**：创建时一次性解析，还是每次运行重新解析？
3. **运行配置放哪**：`.env`、数据库、还是单独的文件？热更新影响谁？

## 决策

**预设是一个命名的 `AgentChange` 模板**：`extensions` / `tools` / `modelTools` / `instructions` / `maxTurns`，按**名字**引用已安装的扩展与工具。模型与 `cwd` 不属于预设——它们由会话设置独立控制，随时可改。压缩策略也不属于预设，留在全局 `settings`（见下）。

**创建会话时解析一次**，写进 `pi.agent`；预设 id 只写进 `ConversationMeta` 供显示与排障。首个运行开始后不再允许换预设（当前 API 也不提供换预设入口）；改预设定义只影响之后新建的会话。已有会话的 `pi.agent` 是它自己的事实，重启、恢复、模型切换都不会重新套用预设。

**运行配置放在 `data/stella.config.json`**（`$STELLA_DATA_DIR/stella.config.json`），与 `.env` 分工：

- `.env`：provider key、端口、数据目录、默认模型、attribution URL——变更需要重启。
- `stella.config.json`：`HarnessSettings`、`defaultPreset`、`defaultMaxTurns`、`presets`——热更新。

`settings` 以 **getter** 形式传给 `Harness.open`（pi-durable 每次使用时重新读取），因此文件变更不需要重启 Harness。`fs.watch` 监听所在目录（编辑器常用替换文件的方式保存），防抖后重读；解析失败保留上一份生效配置并记录错误；文件不存在时静默使用内置默认值；**从不写回**。文件里的扩展/工具名字未安装时跳过并记录，不阻止会话创建。

## 考虑过的替代方案

**把预设做成进程级 `settings.extensions`。** 那是所有会话共享的默认选择，无法让一个会话只读、另一个会话全工具；也表达不了各自的 `maxTurns` 与 `instructions`。

**把整个 `AgentChange` 快照存进 `ConversationMeta`。** 快照会冻结当时的对象集合，配置升级/工具改名后无法解释；pi-durable 的 `pi.agent` 本来就按名字存储，再存一份对象快照只会产生两个真相。

**每次运行都重新解析预设。** 这会让改预设悄悄改变已有会话的工具集，而历史里的 tool call 是在旧工具集下产生的；也违背“预设是创建时的选择”。

**把预设放进 `.env`。** `.env` 是扁平字符串，表达不了嵌套的 `extensions`/`tools`/`maxTurns`；而且它不热更新。

**用 pi-durable 1.5.1 的按会话 compaction。** 能力上可行，但压缩阈值属于部署级资源策略（模型窗口、成本），不属于“这套会话能做什么”的产品语义；放进预设会让每个预设重复一份压缩配置。留在全局 `settings`，需要时再按会话覆盖。

**Web 端编辑预设。** 需要一个带权限与校验的创作面；当前单用户本机部署用配置文件足够，UI 只做只读展示。

## 后果

- **改预设不影响已有会话。** 运维要改一套能力，得新建会话；这是有意的，避免历史与工具集错位。
- **热更新只影响之后的使用。** `settings` 的下一次读取（下一次请求/工具/压缩）用新值；已经开始的运行不重启。
- **坏配置不会拖垮进程。** 解析失败继续用上一份；未安装的名字跳过；`defaultPreset` 不存在时回落到 `standard`。
- **`ConversationMeta.preset` 可能指向已删除的预设。** 只影响显示；能力已在 `pi.agent` 里，不会失效。
- **子代理创建的子会话没有预设 id。** 它继承父会话的 `pi.agent`，`conversationCreated` 只补元数据；会话列表按 `owner` 过滤，子会话不进侧栏。
- **配置文件的字段名跟随 pi-durable。** `settings` 直接是 `HarnessSettings` 的形状，升级 pi-durable 时按 CHANGELOG 核对；未知字段被忽略。
