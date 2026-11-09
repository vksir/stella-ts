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
 * - GET /api/conversations/:id/entries：向前翻页加载更早的条目（视图窗口有限）。
 * - 静态资源：生产模式伺服 web/dist（npm run build 产物），npm start 直接可用。
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Conversation, EntryId, Submission, Tx } from "@earendil-works/pi-durable";
import { AssistantEntry, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { existsSync } from "node:fs";
import { relative, resolve } from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import { ConversationMeta, initialConversationMeta, truncateTitle } from "./conversations.js";
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
