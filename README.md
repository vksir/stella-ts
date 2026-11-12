# Stella

Stella 是一个万用日常型 Web Agent：通过浏览器页面对话，能读写文件、运行命令来协助完成各类任务（不偏科于编程）。对话能力构建在 [`@earendil-works/pi-durable`](https://www.npmjs.com/package/@earendil-works/pi-durable)（1.5.1，精确锁定）之上：SQLite 单文件持久化、进程重启后会话与历史完整恢复、未完成的运行可续跑。

领域术语见 [`GLOSSARY.md`](GLOSSARY.md)，架构决策见 [`docs/adr/`](docs/adr/)。

## 目录结构

```
server/   服务端（Node 24、TS ESM、Hono + @hono/node-server、pi-durable Harness）
web/      前端（React 18 + Vite 6；渲染内核复刻 dsh：每 key 订阅 + 增量 Markdown）
data/     运行时数据（SQLite 数据库、默认工作区 data/workspace、技能目录 data/skills，已 gitignore）
```

## 快速开始

需要 Node ≥ 24（用了内置 `node:sqlite`）。

```bash
npm install
npm run dev        # 并行起 server(:7090) 与 Vite(:5173)，浏览器打开 http://localhost:5173
```

生产模式：

```bash
npm run build
npm start          # node server/dist/main.js，同时伺服 web/dist，打开 http://localhost:7090
```

### 免 key 体验（faux 模式）

没有 API key 也能体验页面与消息流程：

```bash
# Windows (cmd)：set STELLA_FAUX=1&& npm run dev
# 或写入 .env：STELLA_FAUX=1
```

faux 模式使用固定示例回答与内存存储，不读 key、不落盘。

### 真实对话

```bash
cp .env.example .env   # 然后编辑 .env
```

在 `.env` 中配置任一 provider 的 key（`DEEPSEEK_API_KEY`、`ZAI_API_KEY`、`MOONSHOT_API_KEY`、`OPENROUTER_API_KEY`、`OPENCODE_API_KEY`、`OPENAI_API_KEY`、`ANTHROPIC_API_KEY`、`GROQ_API_KEY`、`XAI_API_KEY`），配了 key 的 provider 自动启用。注意 `STELLA_DEFAULT_MODEL` 要写成 pi-ai 模型目录里存在的 `provider/modelId`（缺省 `deepseek/deepseek-chat` 不在 1.5.1 目录中时会自动改用该 provider 的第一个模型并提示，建议显式设置，如 `opencode-go/deepseek-v4.1-flash` 或 `deepseek/deepseek-flash`）。一个 key 都没有时启动会给出明确中文报错。

## 常用命令（仓库根）

| 命令 | 作用 |
|---|---|
| `npm run dev` | 并行启动 server（tsx watch）与 web（Vite），`/api` 代理到 server |
| `npm run build` | 构建 server（tsc）与 web（vite build） |
| `npm start` | 运行构建产物（同时伺服 web/dist） |
| `npm test` | 跑全部测试（零网络零 key）；`test:server` / `test:web` 可单跑 |
| `npm run typecheck` | 两个 workspace 的 tsc strict 检查 |

## 访问控制（登录密钥）

Stella 没有用户系统，只有一把锁：**登录密钥**（`STELLA_TOKEN`）。凡能访问端口的人必须先在登录页
输入它，才能使用页面对话、文件与命令工具。

- **首次启动自动生成**：没有 `STELLA_TOKEN` 时，服务端生成一枚 32 字节随机密钥并追加进
  **已存在的那个 `.env`**（当前目录优先，其次仓库根），只在启动日志里打印一次。两个位置都没有
  可写的 `.env` 时启动失败，提示手动写：`npm run token:gen` 生成后粘贴 `STELLA_TOKEN=<那一串>`。
- **浏览器不持有密钥**：登录时用它换一枚 HMAC 签名的**票据**（30 天固定过期），之后请求带
  `Authorization: Bearer <票据>`；密钥本身始终只在服务端。
- **退出**只清掉本浏览器的票据；服务端不存会话表，因此无法单独吊销某一台设备。
  要让所有浏览器重新登录：改 `.env` 的 `STELLA_TOKEN` 后**重启**（配置只在启动时读取）。
- **faux 模式**（`STELLA_FAUX=1`）与测试，在**未配 `STELLA_TOKEN` 时**不启用登录；两者同时存在时以显式配置的密钥为准（E2E 验证就靠这个组合）。
- 登录失败按来源限速（60 秒内 5 次）。来源取连接地址；直连方是本机（即经本地反向代理）时取 `X-Forwarded-For` 的最右一项。
- `/api/health` 免鉴权（监控探针用，只返回 `{ok:true}`）。
- **TLS 由反向代理终止**：Stella 自身不提供 HTTPS，直连公网等于明文传密钥。
- 实现取舍见 [`docs/adr/0004-login-key-over-trusted-localhost.md`](docs/adr/0004-login-key-over-trusted-localhost.md)。

## 配置项（`.env`，只读 cwd 与仓库根两级）

| 变量 | 说明 |
|---|---|
| `<PROVIDER>_API_KEY` | 见 `.env.example` 的九个映射（deepseek / zai / moonshotai-cn / openrouter / opencode-go / openai / anthropic / groq / xai） |
| `STELLA_DEFAULT_MODEL` | 默认模型 `provider/modelId`，缺省 `deepseek/deepseek-chat` |
| `STELLA_PORT` | server 端口，默认 7090（Vite 代理目标） |
| `STELLA_HOST` | 监听地址，默认 `127.0.0.1`（**只有本机能连**）。对外（局域网、Docker 端口映射、反代）必须显式设 `0.0.0.0` 或具体网卡地址；非回环时启动日志会告警 |
| `STELLA_TOKEN` | 登录密钥。缺省时首次启动自动生成并写入 `.env`；改这一行并重启可让所有浏览器重新登录 |
| `STELLA_DATA_DIR` | 数据目录（SQLite + 默认工作区 + `stella.config.json`），默认 `./data`（相对 server 进程 cwd） |
| `STELLA_ATTRIBUTION_URL` | 模型请求 attribution 的 url（OpenRouter 排行分组），缺省 `http://localhost` |
| `STELLA_FAUX` | `1` 时 faux provider + 内存存储（免 key 体验/测试） |
| `STELLA_FAUX_RATE` | faux 模式下的流式速率（tokens/s），用于观察排队/停止；不配则瞬时完成 |
| `STELLA_ENTRY_WINDOW` | SSE view 携带的最近条目数，默认 200（范围 4–400）。调小便于在短会话上验证「加载更早」与断线补页，调大用于长会话压测 |
| `STELLA_ORIGIN` | 仅 Vite dev 使用：`/api` 代理目标，默认 `http://localhost:7090`（例如给沙箱实例换端口） |

## 运行配置（`data/stella.config.json`）

`.env` 管部署与密钥；运行策略与预设放在**可选的** `data/stella.config.json`（复制仓库根的
`stella.config.example.json`）。文件热更新，不需要重启服务；解析失败保留上一份生效配置。
文件里的 `settings` 直接对应 pi-durable `HarnessSettings`（`stream` / `retry` / `compaction` /
`progress` / `toolExecution` / `followUpMode` / `afterFailedRun` / `restartLimit` 等）。

```json
{
  "defaultPreset": "standard",
  "defaultMaxTurns": 128,
  "settings": { "stream": { "timeoutMs": 120000 } },
  "presets": [
    { "id": "standard", "name": "标准", "extensions": null, "skills": null, "tools": null, "maxTurns": 128 },
    { "id": "readonly", "name": "只读", "extensions": ["stella-persona"], "skills": [], "tools": ["read"], "maxTurns": 16 }
  ]
}
```

### 预设的三个轴：`extensions`、`skills` 与 `tools`

三者**互不推导**，配置时要自己保持一致：

- `tools` 过滤**工具列表**（模型能调用什么）。
- `extensions` 决定装载哪些**扩展**；扩展还会往系统提示里注入 section（例如 `codemode`
  扩展注入的 code mode 说明段、`stella-persona` 注入人设段）。
- `skills` 决定哪些**技能**可用；技能只把名字、描述与 `SKILL.md` 路径放进系统提示，
  正文由模型用 `read` 按需读取。
- 因此「只保留 `read` 工具」不会自动删掉 code mode 的提示词段——模型会读到一份指向
  不存在工具的说明。示例配置里的 `readonly` 预设因此同时把 `extensions` 收窄为
  `["stella-persona"]`。

已安装扩展名：`stella-persona`（人设）、`stella-skills`（技能索引）、`codemode`（代码模式）、
`subagent`（子代理）。`null` / 缺省 = 跟随宿主默认（全部装载）；`[]` = 全部不装。
`stella-skills` 在预设有可用技能时自动加入，不需要手写。

### 技能（skills）

技能放在 `data/skills/<名字>/SKILL.md`（`$STELLA_DATA_DIR/skills`），格式与 pi / Claude Code
的 Agent Skills 规范一致：

```markdown
---
name: meeting-notes
description: 把散乱的会议记录整理成结构化纪要。需要整理会议记录时使用。
---

# 会议纪要

按 `references/template.md` 的模板输出……
```

- 只有 `name`、`description`（必需）与 SKILL.md 的绝对路径进入系统提示；正文由模型用
  `read` 按需读取。`disable-model-invocation: true` 的技能不进提示，留给 `/skill:<名字>`
  手动加载。
- **创建会话时把技能清单定格**：之后往目录里增删技能只影响新会话。系统提示是模型请求的
  前缀，中途变化会让 provider 的前缀缓存失效（见 ADR-0005）。
- 侧栏底部的「技能」按钮打开管理页：按预设勾选可用技能。开关写回
  `stella.config.json` 的 `presets[].skills`（`null` = 全部；全选保存时写 `null`，
  以后新增的技能才自动启用）。改预设只影响之后新建的会话。
- `GET /api/skills` 返回扫描结果与坏文件诊断（每次请求重扫一次）；坏技能只记警告，不阻止启动。
- 升级前创建的会话没有技能快照，系统提示里不会有技能段；新建会话即可。子代理子会话同样
  不继承父会话的技能快照。

- **预设**：创建会话时选择的一套能力与人设（扩展、工具、`instructions`、`maxTurns`），按名字
  引用已安装的扩展/工具；模型与工作目录仍由会话设置独立控制。解析结果写进 `pi.agent`，
  因此改预设只影响之后新建的会话。内置 `standard`（全部工具）；配置文件可覆盖同名或新增。
- **`/compact [说明]`**：手动压缩当前上下文，可带保留提示；忙时摘要按 pi-durable 语义在下一
  轮次边界落位。
- **`/skill:<名字> [要求]`**（也接受 `/skill 名字`）：把该技能的 `SKILL.md` 正文拼在要求前面
  发给模型；只在本会话创建时的技能清单里查找。`disable-model-invocation` 的技能不进系统提示，
  只能这样手动加载。
- **续跑**：失败后重试改为 `POST /messages { "continue": true }`，不新增用户消息。
- **排队/插话**：运行中发送默认排队；`whenBusy: "steer"` 在当前工具轮次后插入，
  `"reject"` 忙时返回 409。`DELETE /conversations/:id/submissions/:id` 撤回排队提交。
- **上下文占用**：`GET /api/conversations/:id/context` 返回已用 token、窗口、百分比与
  系统/工具/消息分解（优先 provider usage，缺失时启发式估算）。

## 架构一览

- **服务端权威**：客户端只 POST 当前这条新消息，不带历史；会话、消息历史与所选模型都在服务端（pi-durable Conversation 的转写条目）。
- **SSE 下行 + POST 上行**（无 WebSocket）：`GET /api/conversations/:id/events` 先推 watch 的初始 view，之后每次 commit 推送新 view。view 的 `entries` 只是窗口：客户端用 `web/src/store/transcript.ts`（与 pi-durable `ConversationTranscript` 同构）累加整段转写，断线重连带 `?from=` 只补错过的新条目，超过窗口上限的部分显式标缺口并用 `/entries?after=&upTo=` 补齐；向前翻页用 `hasMore`，不按条目 ID 推算。
- **交互**：运行中发送默认排队（composer 上方的队列条，逐项插话/编辑/删除），Ctrl/Cmd+Enter 用另一种投递方式；失败后的「续跑」走 `{ continue: true }`，不重复用户消息；`/compact [说明]` 是手动压缩指令。
- **指令**：输入框里以 `/` 开头的单行输入由客户端本地执行，不进消息流。敲下 `/`（尚未输入到参数）时 composer 上方弹出可选指令表，↑↓ 选、Enter/Tab 补全、Esc 关闭、点选也行；当前有 `/compact [说明]`（压缩）、`/new`（新建会话）与运行中才出现的 `/stop`（停止）。未登记的名字（`/usr/bin`）仍当普通消息发给模型。
- **预设**：创建会话时从侧栏选择（配置文件可新增），能力解析进 `pi.agent` 后显示为 composer 的只读 chip。
- **上下文/花费**：composer 下方的小环显示上下文占用（优先 provider usage，缺失时启发式估算），点开看系统/工具/消息分解与累计 token/成本。
- **工具**：`read`/`write`/`edit`/`bash`（read 带图片处理器）、`codemode`（QuickJS 沙箱，脚本调用工具）、`subagent`（前台子代理，子会话拥有独立上下文）；经 `NodeExecutionEnv` 在会话工作目录直接执行（本机部署、无沙箱，见 ADR）。`StellaGuard` 只拦毁灭性命令，能力边界由预设负责。新会话工作目录缺省为默认工作区 `data/workspace`。
- **技能**：`data/skills/<名字>/SKILL.md` 里的 name/description 被渲染进系统提示，正文由模型 `read` 按需读取；清单在创建会话时定格进会话文档，目录变化只影响新会话（ADR-0005）。
- **人设**：英语 section（万用日常型助手、回复跟随用户语言），不偏向编程。
- **持久化**：`data/stella.sqlite`（`node:sqlite`）；重启后 `harness.resume()` 续跑未完成的运行。
- **前端渲染内核**（复刻 DeepSeek Harness，见 ADR-0003）：React 18 + 自研 store（`useSyncExternalStore`，不引状态管理库/组件库/Tailwind）。
  - 消息流按稳定 key 拆成 seat，**每个 seat 只订阅自己的数据切片**：流式输出时只有流式节点重渲，历史消息 DOM 不动（实测 200+ 次采样、历史节点变化 0）。
  - Markdown 走**冻结块增量解析**（`mdast-util-from-markdown` + GFM，末尾 2 块之外冻结），每 chunk 只重 parse 尾部切片；React key 取块源文本起始偏移，跨冻结边界不 remount。
  - 流式更新走 rAF 合帧（一帧至多一次）；受控输入同步通知，textarea 不跳光标。
  - 代码高亮用 shiki（JS 正则引擎、无 WASM），按需动态加载（主包 ~300KB）；落定整块高亮，流式中走 `StreamingHighlightSession`（行级缓存 + grammar 状态续接）。
  - 观感层为单一 `style.css`（三层 token 体系），与 dsh 逐项对齐；明暗双主题经 `html[data-theme]` 切换。

测试：`npm test`（186 项，零网络零 key）。

- **server（76）**：faux provider + MemoryStorage 进程内起 app，验证「POST 消息 → SSE 收到用户条目与回答条目」闭环，以及翻页/`?from=` 续订、排队与错误重试、工作目录工具、上下文占用、续跑、压缩、技能扫描与预设白名单/会话快照等契约。
- **web（110）**：增量 Markdown 冻结块（7）、Markdown 渲染类名契约（13）、转写窗口合并与缺口（10）、节点总线（10）、失败文案与工具摘要（19）、斜杠指令匹配与拦截（15）、流式高亮（12，含真实 shiki）、键盘/输入法判定（4）、主题（5）。
