# 05: 模型切换 + 收藏

**What to build:** 页面提供模型下拉：只列出配置了 key 的 provider 的全部模型，按 provider 分组；用户可收藏模型（浏览器 localStorage 存储），收藏项排序在最前；会话内切换模型立即生效于后续对话，新会话回落到默认模型（`STELLA_DEFAULT_MODEL` 配置）。

开工前必读：`GLOSSARY.md`（"收藏"词条）、pi-durable README 的 Per-Conversation Agent、Settings 各节。模型列表来自 pi-ai 已装载 provider 的模型元数据；每会话模型选择经 `configure()` 持久化在 `pi.agent`。

**Blocked by:** 01（骨架 + 首问首答闭环）

**Status:** resolved

- [x] API：返回可用模型列表（provider、modelId、当前会话选中标记）与默认模型
- [x] 下拉按 provider 分组（`<optgroup>`）；当前模型高亮；切换后该会话后续回答使用新模型（可从回答条目的模型元数据验证）
- [x] 收藏：星标按钮，localStorage 持久化，刷新后保持；收藏模型排最前，组内保持稳定顺序
- [x] 未配任何 key 的 provider 不出现在列表；默认模型不可用时（未装该 provider）回落到第一个可用模型并提示
- [x] 冒烟测试：模型列表端点只含已装 provider 的模型；切换模型的 configure 生效（下一条回答条目记录新模型）

## Answer

实现：模型目录来自 pi-ai `Models`（T1 自动发现装入的已配 key provider），切换走 `configure({ model })` 写入 `pi.agent`，收藏是浏览器 localStorage 偏好。

- **模型列表数据来源与形状**：`buildModelCatalog(models, registeredProviders)`（providers.ts）遍历已装 provider（`discoverProviders` 按「provider → 环境变量」映射表装的，只含有 key 的），条目 `{ provider, providerName, modelId, name }`（pi-ai `Provider.name` / `Model.id` / `Model.name` 元数据），顺序为装载顺序 × 目录顺序，稳定可预期。`GET /api/models` → `{ models, defaultModel, defaultModelFallback? }`；带 `?conversationId=` 时当前会话选中的条目加 `selected: true`（读 `conversation.agent().model`）。未配 key 的 provider 不在 `registeredProviders` 里，自然不出现在列表。
- **默认模型回落扩展（复用 T1 的 resolveDefaultModel，逐级回落并提示）**：①配置的 provider 已装且 modelId 在目录 → 原样；②modelId 不在目录 → 该 provider 第一个模型（T1 原有）；③**provider 未装（T1 原为拒绝启动）→ 改用第一个已装 provider 的第一个模型**——服务照常启动，启动日志警告，且 `/api/models` 返回 `defaultModelFallback: { from, to }`，前端提示行展示「配置的默认模型 X 不可用（provider 未装），已改用 Y」；④一个可用模型都没有才报错（非 faux 零 key 在 stella.ts 更早拦截）。faux 模式固定 faux/faux-1 不受影响。
- **切换 API**：`PUT /api/conversations/:id/model`，body `{ provider, modelId }`；校验（中文 400）：provider 未装 →「provider "x" 未启用：没有它的 API key…」；modelId 不在该 provider 目录 → 「模型 "p/m" 不在该 provider 的目录中…」（generation 对未知模型只会 model_error，API 层提前拦截）。校验过后 `conversation.configure({ model }, context)` 在自己的 commit 写入 `pi.agent`——**立即生效于下一次生成**（README：请求发起 prepare 时固定的只有当时的 model/prompt/tools），运行中的请求不受影响。`GET /api/conversations/:id/settings` 增补 `model` 字段（resolved 值；新会话创建时 T1 起已写入服务端默认模型，所以「新会话回落默认模型」是既有行为的自然结果）。
- **前端**：侧栏设置区（与 T4 工作目录同区同风格）新增「模型」块：原生 `<select>` + `<optgroup>` 按 provider 分组（label 用 providerName），当前会话模型 `selected`（浏览器高亮机制，收起态显示的就是它）；选中即 PUT 切换，banner 提示「对下一条消息生效」；提示行显示当前模型全名与回落提示。**取舍**：原生 `<option>` 内放不了按钮，验收的 optgroup 优先——星标按钮放在下拉旁，作用于当前会话模型（☆ 收藏 / ★ 取消），收藏归属在下拉里以置顶分组呈现。
- **收藏（GLOSSARY「收藏」）**：localStorage 键 `stella.model-favorites`，存 `"provider/modelId"` 字符串数组（按收藏先后），刷新保持；读入时过滤掉目录里已不存在的模型、坏数据静默回退空表。下拉分组取「收藏组置顶」方案：置顶 `<optgroup label="★ 收藏">`（组内按收藏先后，稳定），其余 provider 组内按目录顺序并跳过已收藏项——每个模型在下拉里只出现一次。已卸载 provider 的收藏残留不显示但保留在 localStorage（重新装上后恢复）。
- **测试**：新增 `server/test/models.test.ts` 5 用例（faux + MemoryStorage + vitest）：①列表端点只含已装 provider（faux 两模型目录）、元数据完整、defaultModel、selected 与 settings 一致、不带会话查询无 selected；②纯函数级 `discoverProviders` 只装了 key 的 provider（DEEPSEEK_API_KEY 触发，零网络）+ buildModelCatalog 全为 deepseek；③切换 configure 生效——PUT faux-2 后 settings/selected 更新，**发消息后回答条目 `model[0].provider/model` 记录 faux-2**，且新建第二会话回落默认 faux-1；④未装 provider/不存在 modelId/非法 body 均 400 中文提示且原模型不变；⑤resolveDefaultModel 回落三态 + 无 provider 报错。faux 多模型靠 `fauxProvider` 原生 `models` 选项（默认仅 faux-1），`installFauxProvider`/`createStella` 新增 `fauxModels` 透传。原 14 测试不动，`npm test` 19 绿、两包 tsc strict 零错误、vite build 通过。
- **faux 自验要点**：回答条目的模型元数据是 pi-ai faux 的 stream 实现填的（`provider: model.provider, model: model.id`，即请求模型的 id），与脚本回答内容无关，所以切换验证只需两模型目录 + 一条固定回答。进程内端到端（Hono `app.request`，不经端口）：目录/切换/settings/selected/提交/回答条目/400 校验七步全部符合预期。
- **留给用户验收**：真实 key + 浏览器——①配置两个 provider 的 key，下拉应只见这两个 provider 的模型且按 provider 分组；②切到另一个模型发消息，回答风格/模型名可辨（也可展开 DevTools 看 settings.model）；③点星标收藏、刷新页面确认收藏组置顶仍在；④换台未配默认模型 provider 的机器启动（或把 STELLA_DEFAULT_MODEL 指向未配 key 的 provider），确认回落提示出现且服务可用；⑤新建会话应回到默认模型。
