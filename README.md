# Stella

Stella 是一个万用日常型 Web Agent：通过浏览器页面对话，能读写文件、运行命令来协助完成各类任务（不偏科于编程）。对话能力构建在 [`@earendil-works/pi-durable`](https://www.npmjs.com/package/@earendil-works/pi-durable)（1.5.0，精确锁定）之上：SQLite 单文件持久化、进程重启后会话与历史完整恢复、未完成的运行可续跑。

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

在 `.env` 中配置任一 provider 的 key（`DEEPSEEK_API_KEY`、`ZAI_API_KEY`、`MOONSHOT_API_KEY`、`OPENROUTER_API_KEY`、`OPENAI_API_KEY`、`ANTHROPIC_API_KEY`、`GROQ_API_KEY`、`XAI_API_KEY`），配了 key 的 provider 自动启用。注意 `STELLA_DEFAULT_MODEL` 要写成 pi-ai 模型目录里存在的 `provider/modelId`（缺省 `deepseek/deepseek-chat` 不在 1.5.0 目录中时会自动改用该 provider 的第一个模型并提示，建议显式设置，如 `deepseek/deepseek-flash`）。一个 key 都没有时启动会给出明确中文报错。

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
| `STELLA_DATA_DIR` | 数据目录（SQLite + 默认工作区），默认 `./data`（相对 server 进程 cwd） |
| `STELLA_FAUX` | `1` 时 faux provider + 内存存储（免 key 体验/测试） |

## 架构一览

- **服务端权威**：客户端只 POST 当前这条新消息，不带历史；会话、消息历史与所选模型都在服务端（pi-durable Conversation 的转写条目）。
- **SSE 下行 + POST 上行**（无 WebSocket）：`GET /api/conversations/:id/events` 先推 watch 的初始 view，之后每次 commit 推送新 view；断线由 EventSource 自动重连，历史窗口外用 `/api/conversations/:id/entries` 向前翻页。
- **工具**：自带 `CodingTools`（read/write/edit/bash），经 `NodeExecutionEnv` 在会话工作目录直接执行（本机部署、无沙箱，见 ADR）；新会话工作目录缺省为默认工作区 `data/workspace`。
- **人设**：英语 section（万用日常型助手、回复跟随用户语言），不偏向编程。
- **持久化**：`data/stella.sqlite`（`node:sqlite`）；重启后 `harness.resume()` 续跑未完成的运行。

测试：`npm test`。faux provider + MemoryStorage 进程内起 app，验证「POST 消息 → SSE 收到用户条目与回答条目」闭环，零网络零 key。
