# 05: 模型切换 + 收藏

**What to build:** 页面提供模型下拉：只列出配置了 key 的 provider 的全部模型，按 provider 分组；用户可收藏模型（浏览器 localStorage 存储），收藏项排序在最前；会话内切换模型立即生效于后续对话，新会话回落到默认模型（`STELLA_DEFAULT_MODEL` 配置）。

开工前必读：`GLOSSARY.md`（"收藏"词条）、pi-durable README 的 Per-Conversation Agent、Settings 各节。模型列表来自 pi-ai 已装载 provider 的模型元数据；每会话模型选择经 `configure()` 持久化在 `pi.agent`。

**Blocked by:** 01（骨架 + 首问首答闭环）

**Status:** ready-for-agent

- [ ] API：返回可用模型列表（provider、modelId、当前会话选中标记）与默认模型
- [ ] 下拉按 provider 分组（`<optgroup>`）；当前模型高亮；切换后该会话后续回答使用新模型（可从回答条目的模型元数据验证）
- [ ] 收藏：星标按钮，localStorage 持久化，刷新后保持；收藏模型排最前，组内保持稳定顺序
- [ ] 未配任何 key 的 provider 不出现在列表；默认模型不可用时（未装该 provider）回落到第一个可用模型并提示
- [ ] 冒烟测试：模型列表端点只含已装 provider 的模型；切换模型的 configure 生效（下一条回答条目记录新模型）
