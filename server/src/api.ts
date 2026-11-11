/**
 * HTTP API：Hono 应用工厂。
 *
 * - GET /api/conversations：会话列表（含标题、创建时间；已删除的会话被过滤）。
 * - POST /api/conversations：新建会话（首个是保留的 root 会话），同一 commit 写入元数据（创建时间）。
 * - POST /api/conversations/:id/messages：提交当前消息（客户端只发新消息，不带历史——服务端权威）。
 *   提交 admission 与首条消息的标题写入在同一 commit；回答由 pi-durable 的 generation 提交为
 *   AssistantEntry；提交后按 README 用法在 commit 中读取 AssistantEntry，回答经 watch 到达前端。
 *   排队（README「Busy Conversations」）：whenBusy 决定 busy 时的投递方式——
 *   steer 在当前工具轮次后插入、followUp（缺省）排队进 pi.inbox、reject 直接 409；
 *   运行结束（回答或失败）后按入队顺序依次执行。
 *   请求体可带 requestId：相同 requestId 的重复提交被 pi-durable 幂等去重，返回原提交（GLOSSARY「提交」）。
 * - DELETE /api/conversations/:id：删除会话。pi-durable 没有移除会话的 API，删除是
 *   宿主层归档：先 abort（停运行、撤回排队输入），再置元数据 deleted 标记，列表随之隐藏。
 * - GET /api/conversations/:id/events：SSE。先推送 watch 的初始 view，之后每次 commit 推送新 view；
 *   运行中的流式 partial（pi.live.generation.message）随每次 commit 一并到达前端。
 *   初始 view 在 `watch.start()` 之前推送（watch 会缓存 start 前的帧并随后补发，顺序不会颠倒）。
 *   可选 `?from=<条目 ID>`：断线重连时从客户端已持有的最新条目 + 1 开始取窗口
 *   （pi-durable `ConversationWindow.from` / `ConversationTranscript.resume`），只补断线期间的新条目。
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
 * - GET /api/conversations/:id/entries：视图窗口有限，两个方向翻页——`before` 取更早的一页
 *   （"加载更早"），`after` + `upTo` 取缺口内的一页（断线重连后补齐中间缺失）。
 *   条目 ID 有空洞，客户端只用开区间边界（`before`/`after`/`upTo`）与 `hasMore`，
 *   不按 ID 推算条目数，语义对齐 pi-durable `ConversationTranscript`。
 * - GET /api/presets：预设列表（内置 + 配置文件）、默认预设、默认 maxTurns；
 *   POST /api/conversations 可带 { preset }，创建时解析进 pi.agent（首轮后能力不再变）。
 * - POST /api/conversations/:id/messages 支持 { continue: true }（续跑，不新增用户消息）
 *   与 whenBusy（steer/followUp/reject）；reject 在忙时返回 409。
 * - POST /api/conversations/:id/compact：手动压缩（可带 instructions），返回任务 id。
 * - DELETE /api/conversations/:id/submissions/:submissionId：撤回一条排队提交。
 * - GET /api/conversations/:id/context：上下文占用（已用 token / 窗口 / 系统·工具·消息分解），
 *   优先用最近一次模型请求的 input usage，否则按字符启发式估算。
 * - 静态资源：生产模式伺服 web/dist（npm run build 产物），npm start 直接可用。
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Conversation, EntryId, ModelRef, Submission, SubmissionId, Tx } from "@earendil-works/pi-durable";
import { AssistantEntry, ConversationBusy, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { existsSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import { ConversationMeta, initialConversationMeta, truncateTitle } from "./conversations.js";
import { resolvePresetAgent, presetSummaries } from "./presets.js";
import { buildModelCatalog } from "./providers.js";
import type { Stella } from "./stella.js";

/** 观察窗口上限：初始 view 携带最近 config.entryWindow 条（默认 200），
 *  最多 400 条，超出部分走 /entries 翻页。 */
const WATCH_WINDOW_MAX = { max: 400 } as const;
/** 视图窗口之外的翻页单页上限。 */
const ENTRIES_PAGE_LIMIT = 200;
const SSE_PING_MS = 15_000;

export function createApp(stella: Stella): Hono {
	const app = new Hono();
	const { harness } = stella;
	/** 上下文占用缓存：键 = 最新条目 + 模型 + 工具集，流式 partial 不触发重算。 */
	const contextCache = new Map<number, { key: string; value: ContextOccupancy }>();

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

	// —— 预设：内置 + 配置文件，按名字引用扩展/工具；创建会话时解析 ——

	app.get("/api/presets", (c) =>
		c.json({
			presets: presetSummaries(stella.settings, stella.registry),
			defaultPreset: stella.settings.runtime.defaultPreset,
			defaultMaxTurns: stella.settings.runtime.defaultMaxTurns,
		}),
	);

	// —— 会话 ——

	app.get("/api/conversations", async (c) => {
		// 同一 commit 扫描会话并读各自元数据：标题、创建时间、预设都在会话文档里（conversations.ts）。
		// 只列宿主会话（ownerless）；子代理创建的子会话带 owner，不进侧栏。
		const conversations = await harness.commit(async (tx) => {
			const page = await tx.scanConversations({}, 500);
			const items: { id: number; title: string | null; createdAt?: number; preset: string | null }[] = [];
			for (const record of page.items) {
				if (record.owner !== undefined) continue; // 子代理子会话不列
				const meta = await tx.doc(ConversationMeta, record.id);
				if (meta.deleted) continue; // 已删除（归档）的会话不进列表
				items.push({
					id: record.id,
					title: meta.title,
					...(meta.createdAt > 0 ? { createdAt: meta.createdAt } : {}),
					preset: meta.preset ?? null,
				});
			}
			return items;
		}, BACKGROUND_CONTEXT);
		return c.json({ conversations });
	});

	app.post("/api/conversations", async (c) => {
		let body: unknown = {};
		try {
			body = await c.req.json();
		} catch {
			// 空请求体：使用默认预设
		}
		const requestedPreset = readOptionalString(body, "preset");
		if (requestedPreset === null) return c.json({ error: "preset 应为非空字符串" }, 400);
		if (requestedPreset !== undefined && stella.settings.preset(requestedPreset) === undefined) {
			return c.json(
				{ error: `预设 "${requestedPreset}" 不存在。可用：${stella.settings.runtime.presets.map((p) => p.id).join("、")}` },
				400,
			);
		}
		const presetId = requestedPreset ?? stella.settings.runtime.defaultPreset;
		// 预设只决定能力与人设；模型仍用服务端默认值（之后由模型选择器独立切换）。
		const { agent } = resolvePresetAgent(stella.settings, stella.registry, presetId, {
			provider: stella.defaultModel.provider,
			modelId: stella.defaultModel.modelId,
		});
		const init = (tx: Tx, conversationId: Conversation["id"]): Promise<void> =>
			writeMeta(tx, conversationId, presetId);
		// 创建会话的同一 commit 写入元数据（创建时间、预设）；首个会话是保留的 root 会话，之后是独立普通会话。
		const root = await harness.conversation(ROOT_CONVERSATION_ID, BACKGROUND_CONTEXT);
		const conversation =
			root === undefined
				? await harness.root(BACKGROUND_CONTEXT, { agent, init })
				: await harness.createConversation(
						{ ownership: { kind: "ownerless" }, agent, init },
						BACKGROUND_CONTEXT,
					);
		return c.json({ id: conversation.id, preset: presetId }, 201);
	});

	// —— 删除：pi-durable 无移除会话的 API，删除为宿主层归档（见 conversations.ts）——

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
		const meta = await harness.snapshot(ConversationMeta, conversation.id, BACKGROUND_CONTEXT);
		return c.json(settingsPayload(stella, agent, meta?.preset ?? null));
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
		const meta = await harness.snapshot(ConversationMeta, conversation.id, BACKGROUND_CONTEXT);
		return c.json(settingsPayload(stella, agent, meta?.preset ?? null));
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

		// 续跑：不新增用户消息，让模型接着回答停住的上下文（README「Busy Conversations」）。
		// 只在空闲时可用；忙时 pi-durable 抛 ConversationBusy（409），不会排队。
		if (readContinue(body)) {
			try {
				const submission = await conversation.submit({ type: "continue" }, BACKGROUND_CONTEXT);
				void settleSubmission(conversation, submission);
				return c.json({ conversationId: conversation.id, submissionId: submission.id }, 202);
			} catch (error) {
				if (error instanceof ConversationBusy) {
					return c.json({ error: "会话正在运行，无法续跑" }, 409);
				}
				throw error;
			}
		}

		const content = readContent(body);
		if (content === undefined) return c.json({ error: "缺少非空的消息文本 content" }, 400);
		const requestId = readRequestId(body);
		const whenBusy = readWhenBusy(body);
		if (whenBusy === null) {
			return c.json({ error: 'whenBusy 只能是 "steer"、"followUp" 或 "reject"' }, 400);
		}

		// 同一 commit：先 admit 提交（README：admission 必须先于其他 table write），
		// 再写首条消息的会话标题（GLOSSARY「会话标题」）。
		const draft = {
			type: "input",
			content,
			...(requestId !== undefined ? { requestId } : {}),
			...(whenBusy !== undefined ? { whenBusy } : {}),
		} as const;
		try {
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
		} catch (error) {
			// whenBusy: "reject" 在忙时抛 ConversationBusy（写入前拒绝）。
			if (error instanceof ConversationBusy) {
				return c.json({ error: "会话正在运行，已拒绝这条消息（whenBusy = reject）" }, 409);
			}
			throw error;
		}
	});

	// —— 手动压缩：任何时候可用；忙时摘要按 pi-durable 语义在下一轮次边界落位 ——

	app.post("/api/conversations/:id/compact", async (c) => {
		const conversation = await requireConversation(stella, c.req.param("id"));
		if (conversation === undefined) return notFoundConversation(c);
		let body: unknown = {};
		try {
			body = await c.req.json();
		} catch {
			// 空请求体：无额外说明
		}
		const instructions = readCompactInstructions(body);
		if (instructions === null) return c.json({ error: "instructions 应为字符串" }, 400);
		const taskId = await conversation.compact(instructions, BACKGROUND_CONTEXT);
		return c.json({ taskId }, 202);
	});

	// —— 撤回排队提交（队列条的删除/编辑/插话前置操作）——

	app.delete("/api/conversations/:id/submissions/:submissionId", async (c) => {
		const conversation = await requireConversation(stella, c.req.param("id"));
		if (conversation === undefined) return notFoundConversation(c);
		const submissionId = Number.parseInt(c.req.param("submissionId"), 10);
		if (!Number.isInteger(submissionId) || submissionId < 1) {
			return c.json({ error: "submissionId 应为正整数" }, 400);
		}
		const result = await harness.abortSubmission(
			submissionId as SubmissionId,
			BACKGROUND_CONTEXT,
			conversation.id,
		);
		if (result === "not_found") return c.json({ error: "排队消息不存在或不属于该会话" }, 404);
		return c.json({ result });
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

		// from：断线重连时客户端给出它已持有的最新条目 + 1（`ConversationTranscript.resume`），
		// 窗口从那里开始，只补断线期间的新条目；缺失超过窗口上限时 pi-durable 回落到最新 min 条，
		// 中间的缺口由客户端的转写显式标出并补页。
		const from = readEntryBound(c.req.query("from"));
		const window =
			from === undefined
				? { ...WATCH_WINDOW_MAX, min: stella.config.entryWindow }
				: { ...WATCH_WINDOW_MAX, min: stella.config.entryWindow, from: from as EntryId };

		return streamSSE(c, async (stream) => {
			const watch = await conversation.watch(BACKGROUND_CONTEXT, window);
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

			// 初始 view 先于 start 推送：pi-durable 的 watch 会缓存 start 之前的帧，
			// start 之后按顺序补发，客户端因此不会先收到增量、再收到更旧的初始值。
			// 官方示例（test/examples/18-json.ts、31-transcript.ts）同样是先取 watch.value 再 start。
			await stream.writeSSE({ event: "view", data: JSON.stringify(watch.value) });

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

			await ended;
			clearInterval(ping);
			await watch.stop();
		});
	});

	// —— 向前翻页：视图窗口之外的更早条目 ——

	app.get("/api/conversations/:id/entries", async (c) => {
		const conversation = await requireConversation(stella, c.req.param("id"));
		if (conversation === undefined) return notFoundConversation(c);
		const after = readEntryBound(c.req.query("after"));
		const upTo = readEntryBound(c.req.query("upTo"));
		if (after !== undefined && upTo !== undefined && upTo > after) {
			// 缺口补页：严格在 (after, upTo) 之间，升序（窗口两端的条目客户端已持有）。
			// ID 有空洞，开区间换算成 EntryQuery 的闭区间，不按差值推算条目数。
			const page = await conversation.entries(
				{
					minEntryId: (after + 1) as EntryId,
					maxEntryId: (upTo - 1) as EntryId,
					order: "ascending",
				},
				ENTRIES_PAGE_LIMIT,
				undefined,
				BACKGROUND_CONTEXT,
			);
			return c.json({ entries: page.items, hasMore: page.next !== undefined });
		}
		const before = readEntryBound(c.req.query("before"));
		if (before === undefined) {
			return c.json(
				{ error: "查询参数应为 before（条目 ID，正整数），或 after + upTo（缺口两端，正整数且 upTo > after）" },
				400,
			);
		}
		const page = await conversation.entries(
			{ maxEntryId: (before - 1) as EntryId, order: "descending" },
			ENTRIES_PAGE_LIMIT,
			undefined,
			BACKGROUND_CONTEXT,
		);
		return c.json({ entries: [...page.items].reverse(), hasMore: page.next !== undefined });
	});

	// —— 上下文占用：给 composer 底部的 dsh 风格上下文环 + 分解面板 ——

	app.get("/api/conversations/:id/context", async (c) => {
		const conversation = await requireConversation(stella, c.req.param("id"));
		if (conversation === undefined) return notFoundConversation(c);
		const occupancy = await contextOccupancy(stella, conversation, contextCache);
		return c.json(occupancy);
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
	preset: string | null,
): {
	cwd: string;
	defaultWorkspace: string;
	custom: boolean;
	model: ModelRef | null;
	preset: string | null;
} {
	return {
		cwd: agent.cwd ?? stella.config.workspaceDir,
		defaultWorkspace: stella.config.workspaceDir,
		custom: agent.cwd !== undefined,
		model: agent.model ?? null, // 创建会话时已写入默认模型；null 仅在旧数据/异常兜底时出现
		preset,
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

/** 可选字符串字段：缺失返回 undefined，非法（不是字符串/空串）返回 null。 */
function readOptionalString(body: unknown, key: string): string | undefined | null {
	if (typeof body !== "object" || body === null) return undefined;
	const value = (body as Record<string, unknown>)[key];
	if (value === undefined) return undefined;
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

/** 请求体 { continue: true }：续跑当前上下文，不新增用户消息。 */
function readContinue(body: unknown): boolean {
	return typeof body === "object" && body !== null && (body as { continue?: unknown }).continue === true;
}

/** 请求体 { whenBusy?: "steer" | "followUp" | "reject" }：缺失返回 undefined，非法返回 null。 */
function readWhenBusy(body: unknown): "steer" | "followUp" | "reject" | undefined | null {
	if (typeof body !== "object" || body === null) return undefined;
	const value = (body as { whenBusy?: unknown }).whenBusy;
	if (value === undefined) return undefined;
	return value === "steer" || value === "followUp" || value === "reject" ? value : null;
}

/** 请求体 { instructions?: string }：缺失/空串返回 undefined，非字符串返回 null。 */
function readCompactInstructions(body: unknown): string | undefined | null {
	if (typeof body !== "object" || body === null) return undefined;
	const value = (body as { instructions?: unknown }).instructions;
	if (value === undefined) return undefined;
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

/** 条目翻页边界：条目 ID 为正整数；缺失或非法时 undefined。 */
function readEntryBound(raw: string | undefined): number | undefined {
	if (raw === undefined) return undefined;
	const value = Number.parseInt(raw, 10);
	return Number.isInteger(value) && value >= 1 ? value : undefined;
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

/** 创建会话的 init 回调：在创建 commit 里写入会话元数据初值（创建时间、预设）。 */
async function writeMeta(tx: Tx, conversationId: Conversation["id"], preset: string): Promise<void> {
	Object.assign(await tx.doc(ConversationMeta, conversationId), initialConversationMeta(), { preset });
}

function notFoundConversation(c: Context): Response {
	return c.json({ error: "会话不存在" }, 404);
}

/**
 * 等待一次提交尘埃落定，并按 pi-durable README 的用法在 commit 中读取 AssistantEntry：
 * 回答由 generation 提交为 pi.assistant 条目，经 watch 到达前端；此处读取既是 README
 * 用法的落实，也保证回答条目落定后才结束这次提交的处理。
 *
 * settled.status 非 done 时（unanswered：运行失败、被停止，或排队中的提交随停止被撤回）
 * 不产生回答条目；失败原因（runFailure）与排队状态都在 view.docs 里，前端据此渲染错误卡片
 * 与「等待中」，此处只留服务端日志。
 */
async function settleSubmission(conversation: Conversation, submission: Submission): Promise<void> {
	try {
		const settled = await submission.wait(BACKGROUND_CONTEXT);
		if (settled.status === "done" && settled.type !== "write") {
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

// —— 上下文占用估算（dsh ContextMeter 的等价物） ——

/** `GET /api/conversations/:id/context` 的响应。 */
interface ContextOccupancy {
	/** 已用上下文 token：优先最近一次模型请求的 `usage.input`，没有时用估算。 */
	readonly usedTokens: number;
	/** 当前模型的 contextWindow；未知为 null。 */
	readonly windowTokens: number | null;
	/** usedTokens / windowTokens，0–100；窗口未知为 null。 */
	readonly percent: number | null;
	/** 系统提示 / 工具定义 / 消息的估算分解，按 usedTokens 等比缩放。 */
	readonly breakdown: { readonly system: number; readonly tools: number; readonly messages: number };
	readonly model: ModelRef | null;
	/** 是否没有 provider usage、只能用字符启发式估算。 */
	readonly estimated: boolean;
}

type OccupancyCache = Map<number, { readonly key: string; readonly value: ContextOccupancy }>;

/**
 * 计算一个会话的上下文占用。缓存键 = 最新条目 + 模型 + 工具集，流式 partial 不触发重算。
 * 「已用」优先用最近一次 assistant 请求的 `usage.input`（provider 报的 prompt tokens），
 * 没有时按字符启发式（ASCII 4 字符/token，CJK 约 1 token/1.5 字符）估算。
 */
async function contextOccupancy(
	stella: Stella,
	conversation: Conversation,
	cache: OccupancyCache,
): Promise<ContextOccupancy> {
	const agent = await conversation.agent(BACKGROUND_CONTEXT);
	const model = agent.model ?? null;
	const newestPage = await conversation.entries({}, 1, undefined, BACKGROUND_CONTEXT);
	const newest = newestPage.items[0];
	const key = `${newest?.id ?? 0}:${model?.provider ?? ""}/${model?.modelId ?? ""}:${agent.tools
		.map((tool) => tool.name)
		.join(",")}`;
	const cached = cache.get(conversation.id);
	if (cached?.key === key) return cached.value;

	const [context, recent] = await Promise.all([
		conversation.context(BACKGROUND_CONTEXT),
		conversation.entries({}, 20, undefined, BACKGROUND_CONTEXT),
	]);
	const estimate = estimateContext(context.messages, agent.tools);
	let usageInput: number | undefined;
	for (const entry of recent.items) {
		if (entry.kind !== "pi.assistant") continue;
		const message = entry.model?.[0] as { usage?: { input?: unknown } } | undefined;
		if (typeof message?.usage?.input === "number" && message.usage.input > 0) {
			usageInput = message.usage.input;
			break;
		}
	}
	const usedTokens = usageInput ?? estimate.total;
	const windowTokens =
		model === null ? null : (stella.models.getModel(model.provider, model.modelId)?.contextWindow ?? null);
	const percent =
		windowTokens === null || windowTokens <= 0 ? null : Math.min(100, (usedTokens / windowTokens) * 100);
	const value: ContextOccupancy = {
		usedTokens,
		windowTokens,
		percent,
		breakdown: scaleBreakdown(estimate.breakdown, usedTokens, estimate.total),
		model,
		estimated: usageInput === undefined,
	};
	cache.set(conversation.id, { key, value });
	if (cache.size > 200) {
		const oldest = cache.keys().next().value;
		if (oldest !== undefined) cache.delete(oldest);
	}
	return value;
}

function estimateContext(
	messages: readonly unknown[],
	tools: readonly { readonly name: string; readonly description?: string; readonly parameters?: unknown }[],
): { readonly total: number; readonly breakdown: { readonly system: number; readonly tools: number; readonly messages: number } } {
	let system = 0;
	let toolsTokens = 0;
	let messagesTokens = 0;
	for (const tool of tools) {
		toolsTokens += estimateTokens(tool.name);
		toolsTokens += estimateTokens(tool.description ?? "");
		if (tool.parameters !== undefined) {
			try {
				toolsTokens += estimateTokens(JSON.stringify(tool.parameters));
			} catch {
				// 非 JSON 的 schema 不可能，防御性忽略
			}
		}
	}
	for (const message of messages) {
		const tokens = estimateMessage(message);
		const role = (message as { role?: unknown }).role;
		if (role === "system") system += tokens;
		else messagesTokens += tokens;
	}
	return { total: system + toolsTokens + messagesTokens, breakdown: { system, tools: toolsTokens, messages: messagesTokens } };
}

function estimateMessage(message: unknown): number {
	if (typeof message !== "object" || message === null) return 0;
	const content = (message as { content?: unknown }).content;
	let total = 0;
	if (typeof content === "string") {
		total += estimateTokens(content);
	} else if (Array.isArray(content)) {
		for (const block of content) {
			if (typeof block === "string") {
				total += estimateTokens(block);
				continue;
			}
			if (typeof block !== "object" || block === null) continue;
			const value = block as { type?: unknown; text?: unknown; name?: unknown; arguments?: unknown };
			if (typeof value.text === "string") total += estimateTokens(value.text);
			if (typeof value.name === "string") total += estimateTokens(value.name);
			if (value.arguments !== undefined) {
				try {
					total += estimateTokens(JSON.stringify(value.arguments));
				} catch {
					// 防御性忽略
				}
			}
			if (value.type === "image") total += 800; // 图片按固定估算，不读像素
		}
	}
	// 系统消息的正文在 sections 里（content 为空串）；人设与 codemode 段都在这里。
	const sections = (message as { sections?: unknown }).sections;
	if (typeof sections === "object" && sections !== null) {
		for (const text of Object.values(sections)) {
			if (typeof text === "string") total += estimateTokens(text);
		}
	}
	return total;
}

/** 粗略 token 估算：ASCII 4 字符/token，CJK 约 1 token/1.5 字符。 */
function estimateTokens(text: string): number {
	let ascii = 0;
	let wide = 0;
	for (const char of text) {
		const code = char.codePointAt(0) ?? 0;
		if (code < 0x2e80) ascii += 1;
		else wide += 1;
	}
	return Math.ceil(ascii / 4 + wide * 1.5);
}

/** 把估算分解按实际 usedTokens 等比缩放，保证三段之和接近 usedTokens。 */
function scaleBreakdown(
	breakdown: { readonly system: number; readonly tools: number; readonly messages: number },
	usedTokens: number,
	estimatedTotal: number,
): ContextOccupancy["breakdown"] {
	if (estimatedTotal <= 0) return { system: usedTokens, tools: 0, messages: 0 };
	const scale = usedTokens / estimatedTotal;
	const system = Math.round(breakdown.system * scale);
	const tools = Math.round(breakdown.tools * scale);
	return { system, tools, messages: Math.max(0, usedTokens - system - tools) };
}
