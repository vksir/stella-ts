/**
 * HTTP API：Hono 应用工厂。
 *
 * - GET /api/conversations：会话列表（含标题、创建时间；已删除的会话被过滤）。
 * - POST /api/conversations：新建会话（首个是保留的 root 会话），同一 commit 写入元数据（创建时间）。
 * - POST /api/conversations/:id/messages：提交当前消息（客户端只发新消息，不带历史——服务端权威）。
 *   提交 admission 与首条消息的标题写入在同一 commit；回答由 pi-durable 的 generation 提交为
 *   AssistantEntry；提交后按 README 用法在 commit 中读取 AssistantEntry，回答经 watch 到达前端。
 * - DELETE /api/conversations/:id：删除会话。pi-durable 1.5.0 没有移除会话的 API，删除是
 *   宿主层归档：先 abort（停运行、撤回排队输入），再置元数据 deleted 标记，列表随之隐藏。
 * - GET /api/conversations/:id/events：SSE。先推送 watch 的初始 view，之后每次 commit 推送新 view；
 *   运行中的流式 partial（pi.live.generation.message）随每次 commit 一并到达前端。
 * - POST /api/conversations/:id/stop：停止当前运行（pi-durable 的 conversation.abort）。
 * - GET/PUT /api/conversations/:id/settings：会话工作目录与当前模型。工作目录读取用
 *   conversation.agent()（resolved 值，未设置时为默认工作区）；修改用 conversation.configure()
 *   写入 pi.agent 文档——env 回调在每次工具调用使用时以当前 cwd 构建执行环境，修改立即生效于
 *   后续工具调用，无需重启会话（README「Per-Conversation Agent」）。cwd 传 null 恢复默认工作区。
 *   model 是会话当前模型（resolved；新会话创建时已写入服务端默认模型）。
 * - GET /api/models：可用模型目录——只含已装 provider 的聊天模型（provider/显示名/modelId），
 *   按装载顺序分组排序；带 ?conversationId= 时给当前会话选中的模型加 selected 标记；
 *   附 defaultModel 与配置的默认模型不可用时的回落信息（defaultModelFallback，前端提示用）。
 * - PUT /api/conversations/:id/model：会话内切换模型，configure({ model }) 写入 pi.agent，
 *   立即生效于下一次生成（README：请求固定的只有发起时 resolve 的 model/prompt/tools）；
 *   provider 未装或 modelId 不在目录时 400 拒绝（generation 对未知模型只会 model_error，提前拦截给中文提示）。
 * - GET /api/conversations/:id/entries：向前翻页加载更早的条目（视图窗口有限）。
 * - 静态资源：生产模式伺服 web/dist（npm run build 产物），npm start 直接可用。
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Conversation, EntryId, ModelRef, Submission, Tx } from "@earendil-works/pi-durable";
import { AssistantEntry, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { existsSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import { ConversationMeta, initialConversationMeta, truncateTitle } from "./conversations.js";
import { buildModelCatalog } from "./providers.js";
import type { Stella } from "./stella.js";

/** 观察窗口：初始 view 携带最近 200 条，最多 400 条，超出部分走 /entries 翻页。 */
const WATCH_WINDOW = { min: 200, max: 400 } as const;
/** 视图窗口之外的翻页单页上限。 */
const ENTRIES_PAGE_LIMIT = 200;
const SSE_PING_MS = 15_000;

export function createApp(stella: Stella): Hono {
	const app = new Hono();
	const { harness } = stella;

	app.onError((error, c) => {
		console.error("[stella] 接口错误：", error);
		return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
	});
	app.notFound((c) => c.json({ error: "接口不存在" }, 404));

	app.get("/api/health", (c) => c.json({ ok: true }));

	// —— 模型目录：可用模型列表 + 默认模型 ——

	app.get("/api/models", async (c) => {
		const catalog = buildModelCatalog(stella.models, stella.registeredProviders);
		// 带会话 id 时给当前会话选中的模型加 selected 标记；会话不存在时全部不标（前端另行兜底）
		const conversationId = Number.parseInt(c.req.query("conversationId") ?? "", 10);
		let current: ModelRef | undefined;
		if (Number.isInteger(conversationId) && conversationId >= 1) {
			const conversation = await stella.harness.conversation(
				conversationId as Conversation["id"],
				BACKGROUND_CONTEXT,
			);
			current = (await conversation?.agent(BACKGROUND_CONTEXT))?.model;
		}
		const models = catalog.map((entry) => ({
			...entry,
			...(current !== undefined && entry.provider === current.provider && entry.modelId === current.modelId
				? { selected: true }
				: {}),
		}));
		const fallback = stella.defaultModel.fallbackFrom;
		return c.json({
			models,
			defaultModel: { provider: stella.defaultModel.provider, modelId: stella.defaultModel.modelId },
			...(fallback !== undefined
				? {
						defaultModelFallback: {
							from: fallback,
							to: { provider: stella.defaultModel.provider, modelId: stella.defaultModel.modelId },
						},
					}
				: {}),
		});
	});

	// —— 会话 ——

	app.get("/api/conversations", async (c) => {
		// 同一 commit 扫描全部会话并读各自元数据：标题、创建时间都在会话文档里（conversations.ts）
		const conversations = await harness.commit(async (tx) => {
			const page = await tx.scanConversations({}, 100);
			const items: { id: number; title: string | null; createdAt?: number }[] = [];
			for (const record of page.items) {
				const meta = await tx.doc(ConversationMeta, record.id);
				if (meta.deleted) continue; // 已删除（归档）的会话不进列表
				items.push({
					id: record.id,
					title: meta.title,
					...(meta.createdAt > 0 ? { createdAt: meta.createdAt } : {}),
				});
			}
			return items;
		}, BACKGROUND_CONTEXT);
		return c.json({ conversations });
	});

	app.post("/api/conversations", async (c) => {
		const agent = { model: stella.defaultModel };
		// 创建会话的同一 commit 写入元数据（创建时间）；首个会话是保留的 root 会话，之后是独立普通会话。
		const root = await harness.conversation(ROOT_CONVERSATION_ID, BACKGROUND_CONTEXT);
		const conversation =
			root === undefined
				? await harness.root(BACKGROUND_CONTEXT, { agent, init: writeMeta })
				: await harness.createConversation(
						{ ownership: { kind: "ownerless" }, agent, init: writeMeta },
						BACKGROUND_CONTEXT,
					);
		return c.json({ id: conversation.id }, 201);
	});

	// —— 删除：pi-durable 1.5.0 无移除会话的 API，删除为宿主层归档（见 conversations.ts）——

	app.delete("/api/conversations/:id", async (c) => {
		const conversation = await requireConversation(stella, c.req.param("id"));
		if (conversation === undefined) return notFoundConversation(c);
		// 先停掉运行、撤回排队输入（已生成的部分保留，语义与「停止」一致），再置归档标记。
		await conversation.abort(BACKGROUND_CONTEXT);
		await conversation.commit(async (tx) => {
			(await tx.doc(ConversationMeta, conversation.id)).deleted = true;
		}, BACKGROUND_CONTEXT);
		return c.json({ ok: true });
	});

	// —— 会话设置：工作目录 + 当前模型 ——

	app.get("/api/conversations/:id/settings", async (c) => {
		const conversation = await requireConversation(stella, c.req.param("id"));
		if (conversation === undefined) return notFoundConversation(c);
		const agent = await conversation.agent(BACKGROUND_CONTEXT);
		return c.json(settingsPayload(stella, agent));
	});

	app.put("/api/conversations/:id/settings", async (c) => {
		const conversation = await requireConversation(stella, c.req.param("id"));
		if (conversation === undefined) return notFoundConversation(c);
		let body: unknown;
		try {
			body = await c.req.json();
		} catch {
			return c.json({ error: "请求体应为 JSON" }, 400);
		}
		const cwd = readCwdChange(body);
		if (cwd === undefined) return c.json({ error: '请求体应为 { cwd: "绝对路径" } 或 { cwd: null }（恢复默认）' }, 400);
		if (cwd !== null) {
			const invalid = validateWorkspaceDir(cwd);
			if (invalid !== undefined) return c.json({ error: invalid }, 400);
		}
		// configure() 在自己的 commit 里写入 pi.agent；env 回调按当前 cwd 构建执行环境，
		// 后续工具调用（含已在运行的运行发出的新调用）立即用上新目录。
		await conversation.configure({ cwd }, BACKGROUND_CONTEXT);
		const agent = await conversation.agent(BACKGROUND_CONTEXT);
		return c.json(settingsPayload(stella, agent));
	});

	// —— 模型切换：configure({ model }) 写入 pi.agent，立即生效于下一次生成 ——

	app.put("/api/conversations/:id/model", async (c) => {
		const conversation = await requireConversation(stella, c.req.param("id"));
		if (conversation === undefined) return notFoundConversation(c);
		let body: unknown;
		try {
			body = await c.req.json();
		} catch {
			return c.json({ error: "请求体应为 JSON" }, 400);
		}
		const model = readModelRef(body);
		if (model === undefined) {
			return c.json({ error: '请求体应为 { provider: "provider id", modelId: "模型 id" }' }, 400);
		}
		const invalid = validateModelChoice(stella, model);
		if (invalid !== undefined) return c.json({ error: invalid }, 400);
		await conversation.configure({ model }, BACKGROUND_CONTEXT);
		const agent = await conversation.agent(BACKGROUND_CONTEXT);
		return c.json({ model: agent.model ?? null });
	});

	// —— 消息提交 ——

	app.post("/api/conversations/:id/messages", async (c) => {
		const conversation = await requireConversation(stella, c.req.param("id"));
		if (conversation === undefined) return notFoundConversation(c);
		let body: unknown;
		try {
			body = await c.req.json();
		} catch {
			return c.json({ error: "请求体应为 JSON" }, 400);
		}
		const content = readContent(body);
		if (content === undefined) return c.json({ error: "缺少非空的消息文本 content" }, 400);
		const requestId = readRequestId(body);

		// 同一 commit：先 admit 提交（README：admission 必须先于其他 table write），
		// 再写首条消息的会话标题（GLOSSARY「会话标题」）。
		const draft = { type: "input", content, ...(requestId !== undefined ? { requestId } : {}) } as const;
		const submissionId = await conversation.commit(async (tx) => {
			const id = await conversation.submit(tx, draft);
			const meta = await tx.doc(ConversationMeta, conversation.id);
			if (meta.title === null) meta.title = truncateTitle(content);
			return id;
		}, BACKGROUND_CONTEXT);
		// 运行在后台进行；条目（用户消息与回答）经 watch/SSE 到达前端。
		const submission = await stella.harness.submission(submissionId, BACKGROUND_CONTEXT);
		if (submission !== undefined) void settleSubmission(conversation, submission);
		return c.json({ conversationId: conversation.id, submissionId }, 202);
	});

	// —— 停止：中断当前运行 ——

	// pi-durable README「Abort and Subagents」：abort 撤回排队输入、中止当前运行的全部任务，
	// 等到会话空闲才 resolve；已生成的 partial 由 pi-durable 转为 aborted assistant 条目保留，
	// 运行结束状态（runFailure.reason "aborted"）经 watch/SSE 到达前端。
	app.post("/api/conversations/:id/stop", async (c) => {
		const conversation = await requireConversation(stella, c.req.param("id"));
		if (conversation === undefined) return notFoundConversation(c);
		await conversation.abort(BACKGROUND_CONTEXT);
		return c.json({ ok: true });
	});

	// —— SSE：初始 view + 每次 commit 的新 view ——

	app.get("/api/conversations/:id/events", async (c) => {
		const conversation = await requireConversation(stella, c.req.param("id"));
		if (conversation === undefined) return notFoundConversation(c);

		return streamSSE(c, async (stream) => {
			const watch = await conversation.watch(BACKGROUND_CONTEXT, WATCH_WINDOW);
			let stopped = false;
			const stop = (): void => {
				stopped = true;
			};
			const ping = setInterval(() => {
				if (!stopped) void stream.writeSSE({ event: "ping", data: "1" }).catch(stop);
			}, SSE_PING_MS);
			stream.onAbort(() => {
				stop();
				clearInterval(ping);
			});

			const ended = new Promise<void>((resolveEnd) => {
				watch.closed.then(() => resolveEnd());
				stream.onAbort(() => resolveEnd());
			});

			watch.start(async (call) => {
				if (stopped) return;
				if (call.kind !== "value") return; // pi-durable 的 watch 失败即终结，不会发 failed call
				try {
					await stream.writeSSE({ event: "view", data: JSON.stringify(call.value) });
				} catch {
					stop();
					clearInterval(ping);
				}
			});

			// 初始 view：客户端连接即拿到当前状态（含历史窗口）
			await stream.writeSSE({ event: "view", data: JSON.stringify(watch.value) });
			await ended;
			clearInterval(ping);
			await watch.stop();
		});
	});

	// —— 向前翻页：视图窗口之外的更早条目 ——

	app.get("/api/conversations/:id/entries", async (c) => {
		const conversation = await requireConversation(stella, c.req.param("id"));
		if (conversation === undefined) return notFoundConversation(c);
		const before = Number.parseInt(c.req.query("before") ?? "", 10);
		if (!Number.isInteger(before) || before < 1) {
			return c.json({ error: "查询参数 before 应为条目 ID（正整数）" }, 400);
		}
		const page = await conversation.entries(
			{ maxEntryId: before - 1 as EntryId, order: "descending" },
			ENTRIES_PAGE_LIMIT,
			undefined,
			BACKGROUND_CONTEXT,
		);
		return c.json({ entries: [...page.items].reverse(), hasMore: page.next !== undefined });
	});

	// —— 生产模式静态资源：伺服 web/dist ——

	const webDist = resolve(process.cwd(), "..", "web", "dist");
	if (existsSync(webDist)) {
		const root = relative(process.cwd(), webDist).split("\\").join("/");
		app.use("*", serveStatic({ root }));
		app.get("/", (c) =>
			c.text("Stella 正在运行，但 web/dist 缺少 index.html。请先在仓库根执行 npm run build。", 500),
		);
	} else {
		app.get("/", (c) =>
			c.text(
				"Stella API 正在运行。开发模式请用仓库根的 npm run dev（Vite 端口见控制台）；" +
					"生产模式请先 npm run build 再 npm start。",
				200,
			),
		);
	}

	return app;
}

/** 会话设置的响应体：cwd 是当前生效的工作目录（未显式设置时即默认工作区），model 是会话当前模型。 */
function settingsPayload(
	stella: Stella,
	agent: { cwd?: string; model?: ModelRef },
): {
	cwd: string;
	defaultWorkspace: string;
	custom: boolean;
	model: ModelRef | null;
} {
	return {
		cwd: agent.cwd ?? stella.config.workspaceDir,
		defaultWorkspace: stella.config.workspaceDir,
		custom: agent.cwd !== undefined,
		model: agent.model ?? null, // 创建会话时已写入默认模型；null 仅在旧数据/异常兜底时出现
	};
}

/** 请求体 { provider: string, modelId: string }：两个字段都为非空字符串才算合法，否则返回 undefined。 */
function readModelRef(body: unknown): ModelRef | undefined {
	if (typeof body !== "object" || body === null) return undefined;
	const provider = (body as { provider?: unknown }).provider;
	const modelId = (body as { modelId?: unknown }).modelId;
	if (typeof provider !== "string" || provider.trim().length === 0) return undefined;
	if (typeof modelId !== "string" || modelId.trim().length === 0) return undefined;
	return { provider: provider.trim(), modelId: modelId.trim() };
}

/** 校验待切换的模型：provider 必须已装，modelId 最好在该 provider 目录里；不合法时返回中文提示。 */
function validateModelChoice(stella: Stella, model: ModelRef): string | undefined {
	if (!stella.registeredProviders.includes(model.provider)) {
		return (
			`provider "${model.provider}" 未启用：没有它的 API key，无法切换到它的模型。` +
			`已启用的 provider：${stella.registeredProviders.join("、") || "（无）"}。`
		);
	}
	if (stella.models.getModel(model.provider, model.modelId) === undefined) {
		const known = stella.models
			.getModels(model.provider)
			.slice(0, 5)
			.map((m) => m.id)
			.join("、");
		return (
			`模型 "${model.provider}/${model.modelId}" 不在该 provider 的目录中。` +
			`可用的模型如：${known}…（完整列表见模型下拉）。`
		);
	}
	return undefined;
}

/** 请求体 { cwd: string | null }：null 表示恢复默认工作区；空串等写法非法返回 undefined。 */
function readCwdChange(body: unknown): string | null | undefined {
	if (typeof body !== "object" || body === null) return undefined;
	const cwd = (body as { cwd?: unknown }).cwd;
	if (cwd === null) return null;
	if (typeof cwd !== "string") return undefined;
	const trimmed = cwd.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

/** 校验待设置的工作目录：绝对路径、存在且是目录；不合法时返回中文提示。 */
function validateWorkspaceDir(dir: string): string | undefined {
	if (!isAbsolute(dir)) {
		return `工作目录应为绝对路径，收到的是相对路径："${dir}"。例如 D:\\projects\\demo。`;
	}
	if (!existsSync(dir)) {
		return `目录不存在："${dir}"。请先创建该目录，或改用其他已有路径。`;
	}
	if (!statSync(dir).isDirectory()) {
		return `该路径不是目录："${dir}"。请改用一个目录路径。`;
	}
	return undefined;
}

/** 读取当前消息文本：请求体 { content: string }。 */
function readContent(body: unknown): string | undefined {
	if (typeof body !== "object" || body === null) return undefined;
	const content = (body as { content?: unknown }).content;
	if (typeof content !== "string") return undefined;
	const trimmed = content.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

/** 请求体 { requestId?: string }：相同 requestId 的重复提交会被去重（GLOSSARY「提交」）。 */
function readRequestId(body: unknown): string | undefined {
	if (typeof body !== "object" || body === null) return undefined;
	const requestId = (body as { requestId?: unknown }).requestId;
	return typeof requestId === "string" && requestId.length > 0 ? requestId : undefined;
}

async function requireConversation(stella: Stella, rawId: string): Promise<Conversation | undefined> {
	const id = Number.parseInt(rawId, 10);
	if (!Number.isInteger(id) || id < 1) return undefined;
	return stella.harness.conversation(id as Conversation["id"], BACKGROUND_CONTEXT);
}

/** 创建会话的 init 回调：在创建 commit 里写入会话元数据初值（创建时间）。 */
async function writeMeta(tx: Tx, conversationId: Conversation["id"]): Promise<void> {
	Object.assign(await tx.doc(ConversationMeta, conversationId), initialConversationMeta());
}

function notFoundConversation(c: Context): Response {
	return c.json({ error: "会话不存在" }, 404);
}

/**
 * 等待一次提交尘埃落定，并按 pi-durable README 的用法在 commit 中读取 AssistantEntry：
 * 回答由 generation 提交为 pi.assistant 条目，经 watch 到达前端；此处读取既是 README
 * 用法的落实，也保证回答条目落定后才结束这次提交的处理。
 */
async function settleSubmission(conversation: Conversation, submission: Submission): Promise<void> {
	try {
		const settled = await submission.wait(BACKGROUND_CONTEXT);
		if (settled.status === "done" && settled.type === "input") {
			await conversation.commit((tx) => tx.entry(AssistantEntry, settled.answer), BACKGROUND_CONTEXT);
		} else if (settled.status === "unanswered") {
			if (settled.reason === "aborted") {
				console.info(`[stella] 提交 ${submission.id} 已被用户停止，已生成的部分已保留`);
			} else {
				console.error(`[stella] 提交 ${submission.id} 未获回答：${settled.reason}`, settled.detail);
			}
		}
	} catch (error) {
		console.error(`[stella] 提交 ${submission.id} 处理失败：`, error);
	}
}
