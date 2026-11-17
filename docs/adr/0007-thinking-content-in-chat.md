# 对话流展示模型思考内容

> **Status: 已采纳（accepted）**。取代 [ADR-0006](0006-paper-workbench-redesign.md) 中「不摆假按钮」一条里「思考过程折叠一律不做」的结论；其余条目不变。

Stella 现在真的会向 provider 请求模型的推理文本，并在对话流里**折叠展示**。ADR-0006 当时把「思考过程折叠」列进「一律不做」的清单，理由是缺服务端数据；服务端补上数据后，这条结论不再成立，本 ADR 记录为什么改、改到什么程度。

## 为什么改

此前 Stella 从来没拿到过思考内容，不是 UI 藏着，而是服务端根本没请求：

- pi-durable 的 agent 默认 `thinkingLevel` 是 `state?.thinkingLevel ?? "off"`（`dist/harness/agent.js`）。
- generation 只在 `thinkingLevel !== "off"` 时才给 provider 传 `reasoning`。

于是 `AgentChange` 里可选的 `thinkingLevel` 一直没人填，标准预设创建出来的会话全都跑在 `"off"`，思考块永远不会产生。ADR-0006 说的「不做思考过程折叠」在数据层面是自洽的，但它把「还没有数据」当成了「不需要数据」：对万用日常型 Agent，思考内容对排查「模型为什么这么答」有明显价值，而代价仅是一段可选展示。

## Decision

- **服务端默认开中等思考**：内置标准预设 `STANDARD_PRESET` 带 `thinkingLevel: "medium"`，因此 `DEFAULT_RUNTIME_CONFIG` 与 `resolveRuntimeConfig(undefined)` 一致；没有配置文件的部署也直接有思考内容。
- **思考等级按预设配置，可关**：`PresetDefinition` 新增可选 `thinkingLevel`，合法值为 `off` / `minimal` / `low` / `medium` / `high` / `xhigh` / `max`（pi-ai `ModelThinkingLevel`）。缺省 = 不指定，按 pi-durable 的 `"off"` 处理；显式写 `"off"` = 关闭。与预设的其它能力一样，它在**创建会话时**解析进 `pi.agent`，之后改预设只影响新会话。
- **非法值只忽略该字段**：`readPreset` 校验失败时打印中文警告并丢掉 `thinkingLevel`，预设的其余能力照旧生效——与 `skills` 的容错风格一致，不让一个拼错的等级把整个预设拖掉。
- **思考块只做折叠展示，不改上下文语义**：思考块本来就随条目存储、并作为 assistant 消息的一部分回传 provider；Stella 只是把它在 UI 里折叠在前面，不参与「正文」的 Markdown 增量渲染，也不改变提交 / 排队 / 插话 / 压缩的语义。折叠是表现层决定，不是数据层决定。
- **术语进 GLOSSARY**：「思考块」与「思考等级」两条词条固定用词，避免正文里出现「推理文本」「reasoning」「思维链」等混用。

## Considered Options

- **服务端保持 `off`，只做空态占位**：改动最小，但那就是 ADR-0006 已经否掉的「假按钮」——UI 有位置、数据永远没有。放弃。
- **默认开到 `high` 或 `max`**：思考更充分，但延迟与 token 成本对日常对话偏重，且多数 provider 的 `max` 是实验性等级。选择 `medium` 作为「明显有用、代价可接受」的折中，需要更深的场景在预设里显式调高。
- **只在管理页加一个全局开关**：少一个字段，但与 ADR-0002 的「能力配置按预设、创建时锁定」相冲突——同一个部署里「闲聊预设关思考、调研预设开高思考」是常见需求，全局开关表达不了。
- **思考内容不落存储，只在流式期间显示**：会与「reload 后仍可查看该轮做了什么」的既有取向打架（轨迹视图同理），而且 pi-ai 的 assistant 消息本身就带思考块，硬删反而要做额外裁剪。

## Consequences

- 默认 `medium` 下，每次创建的标准预设会话都会请求 reasoning；不支持思考的模型/provider 由 pi-ai 自行降级，Stella 不做特判。想省 token 的部署应把预设写成 `"thinkingLevel": "off"`。
- 思考块让单条回答的体积变大：折叠默认收起，但它仍随条目进入上下文与存储，上下文用量（详情栏）会比以前高一些。
- 已有会话不受影响：它们的 agent 在创建时已经定格为 `"off"`，要拿到思考内容得新建会话；这是 ADR-0002「预设创建时锁定」的既有代价，不做回填。
- `stella.config.example.json` 的 standard 预设显式写出 `"thinkingLevel": "medium"` 并附中文 `$comment` 说明；readonly 预设不写该字段（等于 `off`），体现「缺省即关闭」。
