# 前端渲染内核重写：React 18 + 每 key 订阅 + 增量 Markdown

> **Status: 已采纳（accepted，第二轮）**。第一轮曾回退（rejected）：当时内核机制正确但
> 整体观感不及既有实现，属于"换框架级大步改造 + 观感未同步对齐"。第二轮改为
> **内核替换 + 逐项观感整改 + 第三方独立评审闭环**（`.scratch/webui-react/eval/`
> 五轮），先落地 React 内核，再由独立评审（另一个 agent，deepseek-flash）给出像素级
> 差距清单逐条修真。观感评分曲线 **6.9 → 8.4 → 8.6 → 9.0 → 9.3**（dsh 为 10 分基准），
> 终审结论「与 dsh 在纯 UI 维度上已无可指出的手艺差」。结论：内核必须换（否则流式
> 体感永远追不上），但换内核必须配一个可量化的观感验收闭环，否则会重演第一轮失败。

复刻 DeepSeek Harness（dsh）Web UI 已进行两轮，观感层（design token、布局、动效，见
`.scratch/dsh-ref/ui-report.md`）已对齐，但流式体验差距依然明显。对 dsh 的实现原理分析
（`.scratch/dsh-ref/impl-report.md`）定位根因：差距不在 CSS，在**渲染内核**——dsh 用
React 每 key 细粒度订阅（流式时只重渲最后一个节点）+ 冻结块增量 Markdown 解析
（避免整篇每 chunk 重 parse 的二次方复杂度）+ rAF 合帧节流；本仓库当前前端对每次
SSE view 全量 `replaceChildren` 重建列表并对 partial 全文重 parse，长会话必然卡顿。

_与 ADR-0001 矛盾，但值得重开：0001 否决 React 的理由是"聊天页 DOM 结构简单，
vanilla TS 足够"——该判断对流式渲染内核不成立；本 ADR 仅取代 0001 的前端选型条款，
其余（pi-durable + SSE + Vite + npm workspaces）全部维持。_

## Decision

- **UI 框架**：React 18（react + react-dom，TypeScript）。不用组件库、不用 Tailwind、
  不引入状态管理库——状态引擎用 `useSyncExternalStore` 包装自研 store（对齐 dsh 的
  "React-free store + 细粒度订阅"形态）。
- **渲染内核**（复刻 dsh 三件套）：
  1. 消息流按稳定 key（条目 ID / 调用 ID / 固定槽名）拆成 seat，每个 seat 只订阅
     自己的数据切片；流式输出时仅流式节点重渲，历史消息 DOM 不动。
  2. Markdown 用 micromark 系（mdast-util-from-markdown + GFM）按 dsh incremental.ts
     的冻结块策略增量解析：冻结除末尾 `UNSTABLE_TAIL_BLOCKS = 2` 块外的全部块，
     每 chunk 只重 parse 尾部切片，React key 取块的源文本起始偏移。
  3. 流式更新经 rAF 合帧发布（结构变更立即发布），auto-scroll 保留
     "跟随意图 + nearBottom 阈值"模型。
- **保持不变**：服务端与 SSE 协议零改动（commit 级全量 view 快照，前端 diff 后只更新
  受影响节点）；`style.css` 的 token 体系与类名平移复用（观感层已对齐，不动）；
  `transcript.ts`（框架无关）原样复用。
- **旧实现归档**：`web/src/main.ts`、`web/src/markdown.ts` 移入 `web/legacy/` 供平移
  对照，功能全部迁移后删除。

## Considered Options

- **继续 vanilla TS 加增量渲染**（否）——需要手写 reconcile 才能吃到 keyed 增量的红利，
  等于自己实现一个 React，维护成本高于直接用 React。
- **换 Vue/Svelte**（否）——dsh 是 React，照抄 seat 模式时 React 的
  `useSyncExternalStore` 语义最贴合，无翻译损耗。
- **连协议一起换成 token 级 WS**（否）——SSE 100ms 粒度对 60fps 渲染足够
  （rAF 合帧后每帧至多一次发布），先换内核再看是否需要协议升级。

## Consequences

- `web/package.json` 新增运行时依赖：react、react-dom、micromark-extension-gfm、
  mdast-util-from-markdown、mdast-util-gfm（后续议题另加 shiki）。
- 代码量短期上升（组件化拆分）；换来的是流式只动末节点、Markdown O(chunk) 解析、
  后续功能不再与手写 DOM 搏斗。
- React 严格模式下 effect 双调用等陷阱需要在开发中逐一验证（SSE 订阅、自动滚动）。
