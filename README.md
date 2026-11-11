# Stella

Stella 是一个万用日常型 Web Agent：通过浏览器页面对话，能读写文件、运行命令来协助完成各类任务（不偏科于编程）。对话能力构建在 [`@earendil-works/pi-durable`](https://www.npmjs.com/package/@earendil-works/pi-durable)（1.5.1，精确锁定）之上：SQLite 单文件持久化、进程重启后会话与历史完整恢复、未完成的运行可续跑。

领域术语见 [`GLOSSARY.md`](GLOSSARY.md)，架构决策见 [`docs/adr/`](docs/adr/)。

## 目录结构

```
server/   服务端（Node 24、TS ESM、Hono + @hono/node-server、pi-durable Harness）
web/      前端（Vite + vanilla TS，无 UI 框架）
data/     运行时数据（SQLite 数据库与默认工作区 data/workspace，已 gitignore）
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
| `npm test` | 跑服务端测试（vitest，零网络零 key） |
| `npm run typecheck` | 两个 workspace 的 tsc strict 检查 |

## 配置项（`.env`，只读 cwd 与仓库根两级）

| 变量 | 说明 |
|---|---|
| `<PROVIDER>_API_KEY` | 见 `.env.example` 的八个映射 |
| `STELLA_DEFAULT_MODEL` | 默认模型 `provider/modelId`，缺省 `deepseek/deepseek-chat` |
| `STELLA_PORT` | server 端口，默认 7090（Vite 代理目标） |
| `STELLA_DATA_DIR` | 数据目录（SQLite + 默认工作区 + `stella.config.json`），默认 `./data`（相对 server 进程 cwd） |
| `STELLA_ATTRIBUTION_URL` | 模型请求 attribution 的 url（OpenRouter 排行分组），缺省 `http://localhost` |
| `STELLA_FAUX` | `1` 时 faux provider + 内存存储（免 key 体验/测试） |

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
    { "id": "standard", "name": "标准", "extensions": null, "tools": null, "maxTurns": 128 },
    { "id": "readonly", "name": "只读", "tools": ["read"], "maxTurns": 16 }
  ]
}
```

- **预设**：创建会话时选择的一套能力与人设（扩展、工具、`instructions`、`maxTurns`），按名字
  引用已安装的扩展/工具；模型与工作目录仍由会话设置独立控制。解析结果写进 `pi.agent`，
  因此改预设只影响之后新建的会话。内置 `standard`（全部工具）；配置文件可覆盖同名或新增。
- **`/compact [说明]`**：手动压缩当前上下文，可带保留提示；忙时摘要按 pi-durable 语义在下一
  轮次边界落位。
- **续跑**：失败后重试改为 `POST /messages { "continue": true }`，不新增用户消息。
- **排队/插话**：运行中发送默认排队；`whenBusy: "steer"` 在当前工具轮次后插入，
  `"reject"` 忙时返回 409。`DELETE /conversations/:id/submissions/:id` 撤回排队提交。
- **上下文占用**：`GET /api/conversations/:id/context` 返回已用 token、窗口、百分比与
  系统/工具/消息分解（优先 provider usage，缺失时启发式估算）。

## 架构一览

- **服务端权威**：客户端只 POST 当前这条新消息，不带历史；会话、消息历史与所选模型都在服务端（pi-durable Conversation 的转写条目）。
- **SSE 下行 + POST 上行**（无 WebSocket）：`GET /api/conversations/:id/events` 先推 watch 的初始 view，之后每次 commit 推送新 view。view 的 `entries` 只是窗口：客户端用 `web/src/transcript.ts`（与 pi-durable `ConversationTranscript` 同构）累加整段转写，断线重连带 `?from=` 只补错过的新条目，超过窗口上限的部分显式标缺口并用 `/entries?after=&upTo=` 补齐；向前翻页用 `hasMore`，不按条目 ID 推算。
- **交互**：运行中发送默认排队（composer 上方的队列条，逐项插话/编辑/删除），Ctrl/Cmd+Enter 用另一种投递方式；失败后的「续跑」走 `{ continue: true }`，不重复用户消息；`/compact [说明]` 是手动压缩指令。
- **预设**：创建会话时从侧栏选择（配置文件可新增），能力解析进 `pi.agent` 后显示为 composer 的只读 chip。
- **上下文/花费**：composer 下方的小环显示上下文占用（优先 provider usage，缺失时启发式估算），点开看系统/工具/消息分解与累计 token/成本。
- **工具**：`read`/`write`/`edit`/`bash`（read 带图片处理器）、`codemode`（QuickJS 沙箱，脚本调用工具）、`subagent`（前台子代理，子会话拥有独立上下文）；经 `NodeExecutionEnv` 在会话工作目录直接执行（本机部署、无沙箱，见 ADR）。`StellaGuard` 只拦毁灭性命令，能力边界由预设负责。新会话工作目录缺省为默认工作区 `data/workspace`。
- **人设**：英语 section（万用日常型助手、回复跟随用户语言），不偏向编程。
- **持久化**：`data/stella.sqlite`（`node:sqlite`）；重启后 `harness.resume()` 续跑未完成的运行。

测试：`npm test`。faux provider + MemoryStorage 进程内起 app，验证「POST 消息 → SSE 收到用户条目与回答条目」闭环，零网络零 key。
