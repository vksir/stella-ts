/**
 * 应用状态与渲染内核（React-free；组件经 useSyncExternalStore 订阅）：
 *
 * - appSource：全局快照（列表/工作区/预设/目录/连接/toast/确认框……），低频。
 * - flow：消息流节点。每 key 一个 NodeSource（快照引用不变不通知）——
 *   流式 partial 只更新 `streaming` 节点且经 rAF 合帧；历史节点零重渲。
 * - 结构判定：条目尾 id / run / inbox / tools 任一变化才算结构变更，立即发布。
 * - SSE：view 事件 → transcript.merge → 派生 flow；断线带 ?from= 重连。
 */

import {
	type ChatEntry,
	type ContentBlock,
	type ContextOccupancy,
	type ConversationList,
	type ConversationSummary,
	type EntriesPage,
	type LiveDoc,
	type LiveToolSlot,
	type ModelCatalog,
	type ModelRefPayload,
	type ModelMessage,
	type PresetsResponse,
	type SseView,
	type ToolResultMessage,
	type UsageDoc,
	type WorkspaceSettings,
	extractText,
	fetchJson,
	isToolResult,
	modelKey,
	partialToolCall,
	postJson,
	postOk,
	putJson,
	resultText,
} from "../api";
import { failureCardText, stoppedText, summarizeToolCall } from "./labels";
import { NodeBus, Source } from "./node-bus";
import { Transcript } from "./transcript";

export { failureCardText, stoppedText };

// —— 流节点 ——

/** 工具调用折叠行的展示状态。 */
export interface ToolCard {
	name: string;
	summary: string;
	argsText: string;
	output: string | undefined;
	isError: boolean;
	status: "done" | "running" | "pending" | "lost";
}

export type FlowNode =
	| { key: string; type: "user"; text: string; reveal: boolean; timestamp?: number }
	| {
			key: string;
			type: "assistant";
			text: string;
			calls: ToolCard[];
			reveal: boolean;
			durationMs?: number;
			timestamp?: number;
			tokens?: number;
			/** 该回答是被中断的（stopReason: aborted，例如服务崩溃/手动停止留下的部分回答）。 */
			aborted?: boolean;
	  }
	| { key: string; type: "assistant-error"; message: string }
	| { key: string; type: "streaming"; text: string }
	| { key: string; type: "tool"; card: ToolCard }
	| { key: string; type: "running" }
	| { key: string; type: "stopped"; text: string }
	| { key: string; type: "error"; reason: string; detail: string | undefined }
	| { key: string; type: "gap"; after: number; upTo: number }
	| { key: string; type: "load-earlier" };

// —— 全局快照 ——

export interface AppSnapshot {
	conversations: readonly ConversationSummary[];
	conversationId: number | undefined;
	connected: boolean;
	workspace: WorkspaceSettings | undefined;
	presets: PresetsResponse["presets"];
	defaultPreset: string;
	preset: string | null;
	context: ContextOccupancy | null;
	busyEnter: "queue" | "steer";
	modelCatalog: ModelCatalog | undefined;
	favorites: readonly string[];
	busy: boolean;
	/** hero 空态：有会话但无内容（composer 居中）。 */
	heroEmpty: boolean;
	/** 空白态：没有任何会话。 */
	blank: boolean;
	toast: string | null;
	confirmTarget: ConversationSummary | null;
}

// —— 微型 Source：引用不变不通知 ——

const BUSY_ENTER_KEY = "stella-busy-enter";
const PRESET_KEY = "stella-preset";
const FAVORITES_KEY = "stella.model-favorites";

function loadBusyEnter(): "queue" | "steer" {
	try {
		return localStorage.getItem(BUSY_ENTER_KEY) === "steer" ? "steer" : "queue";
	} catch {
		return "queue";
	}
}

function loadFavorites(): string[] {
	try {
		const raw = localStorage.getItem(FAVORITES_KEY);
		if (raw === null) return [];
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed.filter((item): item is string => typeof item === "string");
	} catch {
		return [];
	}
}

function isQueuedInput(item: { content?: string | ContentBlock[] }): boolean {
	return item.content !== undefined;
}

function inboxText(item: { content?: string | ContentBlock[] }): string {
	return typeof item.content === "string" ? item.content : textOfBlocks(item.content ?? []);
}

function textOfBlocks(blocks: readonly ContentBlock[]): string {
	return blocks
		.filter((block) => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text ?? "")
		.join("");
}


function callCard(
	call: ContentBlock,
	result: ToolResultMessage | undefined,
	slot: LiveToolSlot | undefined,
): ToolCard {
	const name = call.name ?? "工具";
	const args = call.arguments ?? {};
	const status: ToolCard["status"] =
		result !== undefined
			? "done"
			: slot?.status === "running" || slot?.status === "pending"
				? slot.status
				: "lost";
	return {
		name,
		summary: summarizeToolCall(name, args),
		argsText:
			call.argumentsError !== undefined
				? `（模型给出的参数不是合法 JSON：${call.argumentsError}）`
				: (JSON.stringify(args, null, 2) ?? ""),
		output: result === undefined ? (slot?.output ?? undefined) : resultText(result),
		isError: result?.isError === true,
		status,
	};
}

function slotCard(slot: LiveToolSlot, call: ContentBlock | undefined): ToolCard {
	const name = slot.name ?? call?.name ?? "工具";
	const args = call?.arguments ?? {};
	const status = slot.status === "pending" || slot.status === "running" ? slot.status : "lost";
	return {
		name,
		summary: summarizeToolCall(name, args),
		argsText: JSON.stringify(args, null, 2) ?? "",
		output: slot.output ?? undefined,
		isError: false,
		status,
	};
}

/** 失败运行的落点：runFailure.first 之后的最后一条条目 id（错误卡片锚点）。 */
function failurePlacement(entries: readonly ChatEntry[], first: number | undefined): number | undefined {
	let last: ChatEntry | undefined;
	for (const entry of entries) {
		if (first !== undefined && entry.id < first) continue;
		last = entry;
	}
	return last?.id;
}



// —— Store ——

export class AppStore {
	// app 级
	private app = new Source<AppSnapshot>({
		conversations: [],
		conversationId: undefined,
		connected: false,
		workspace: undefined,
		presets: [],
		defaultPreset: "standard",
		preset: null,
		context: null,
		busyEnter: loadBusyEnter(),
		modelCatalog: undefined,
		favorites: loadFavorites(),
		busy: false,
		heroEmpty: false,
		blank: true,
		toast: null,
		confirmTarget: null,
	});

	// flow 级
	private keys = new Source<readonly string[]>([]);
	/**
	 * 文档版本：每收到一个 SSE view 加一。
	 * 队列条（pi.inbox）与用量面板（pi.usage）的数据都在 view.docs 里，而 app 快照只在
	 * busy/heroEmpty/会话身份变化时更新 —— 若它们只订阅 app，排队项被消费、用量跳变这类
	 * 「同一运行内」的变化就不会刷新（要靠 refreshList 之类的偶然通知兜底）。
	 */
	private docVersion = new Source<number>(0);
	/** 每个 key 一个节点快照 + 订阅桶（桥接已在 NodeBus 内完成）。 */
	private nodes = new NodeBus<FlowNode>();

	// 内部状态（派生快照用）
	private view: SseView | null = null;
	private source: EventSource | undefined;
	private transcript: Transcript<ChatEntry>;
	private presetsLoadedAt = 0;
	private contextKey = "";
	private contextTimer: number | undefined;
	/** 最近一次收到 SSE 事件（view / ping）的时间；用于心跳超时后主动重连。 */
	private lastEventAt = 0;
	/** 心跳守护定时器。 */
	private watchdog: number | undefined;
	private toastTimer: number | undefined;
	/** 待处理的聚焦请求：Composer 可能在本次 emit 之后才挂载（新建会话 / 空白态）。 */
	private pendingFocus = false;
	private framePending = false;
	private pendingStreamingText: string | undefined;
	private structureSignature = "";
	/** 本次运行开始时间（busy false→true 时打点），用于「已完成，用时 N 秒」。 */
	private runStartedAt: number | undefined;
	/** 本次运行的 run.first（条目 id 下界），结束时才用得到。 */
	private activeRunFirst: number | undefined;
	/** run.first → 用时（毫秒）；仅本端观测到的运行有效（历史运行无时间戳）。 */
	private runDurations = new Map<number, number>();
	private listeners = new Map<string, Set<() => void>>();

	constructor() {
		this.transcript = new Transcript<ChatEntry>({
			before: (oldestId) => this.fetchEntries({ before: oldestId }),
			between: (afterId, upToId) => this.fetchEntries({ after: afterId, upTo: upToId }),
		});
	}

	// —— 订阅面 ——

	subscribeApp = this.app.subscribe;
	getApp = this.app.get;
	subscribeKeys = this.keys.subscribe;
	getKeys = this.keys.get;
	/** 订阅 view.docs 的版本（每次 view 到达加一）。 */
	subscribeDocs = this.docVersion.subscribe;
	getDocsVersion = this.docVersion.get;

	subscribeNode = (key: string, listener: () => void): (() => void) => this.nodes.subscribe(key, listener);

	getNode = (key: string): FlowNode | null => this.nodes.get(key);

	/** UI 事件（focus-input / scroll-instant）。 */
	on(event: string, listener: () => void): () => void {
		const name = `@${event}`;
		let set = this.listeners.get(name);
		if (set === undefined) {
			set = new Set();
			this.listeners.set(name, set);
		}
		set.add(listener);
		return () => {
			set?.delete(listener);
		};
	}

	private emit(event: string): void {
		for (const listener of this.listeners.get(`@${event}`) ?? []) listener();
	}

	private patchApp(patch: Partial<AppSnapshot>): void {
		this.app.set({ ...this.app.get(), ...patch });
	}


	// —— toast / 确认 ——

	showToast(message: string): void {
		window.clearTimeout(this.toastTimer);
		this.patchApp({ toast: message });
		this.toastTimer = window.setTimeout(() => this.patchApp({ toast: null }), 6000);
	}

	openConfirm(target: ConversationSummary): void {
		this.patchApp({ confirmTarget: target });
	}

	closeConfirm(): void {
		this.patchApp({ confirmTarget: null });
	}

	// —— 启动 ——

	async boot(): Promise<void> {
		void this.loadModelCatalog().catch((error) => this.showError(error));
		void this.loadPresets().catch((error) => this.showError(error));
		await this.refreshList();
		const first = this.app.get().conversations[0]?.id;
		if (first === undefined) {
			await this.createConversation();
		} else {
			this.switchTo(first);
		}
	}

	async refreshList(): Promise<void> {
		const list = await fetchJson<ConversationList>("/api/conversations");
		this.patchApp({ conversations: list.conversations });
	}

	async loadPresets(): Promise<void> {
		const response = await fetchJson<PresetsResponse>("/api/presets");
		this.presetsLoadedAt = Date.now();
		this.patchApp({ presets: response.presets, defaultPreset: response.defaultPreset });
	}

	async createConversation(preset?: string): Promise<void> {
		// 配置文件热更新后，新会话要拿到最新预设；15s 内不重复拉。
		if (Date.now() - this.presetsLoadedAt > 15_000) await this.loadPresets().catch(() => undefined);
		const chosen = preset ?? this.lastPreset();
		const created = await postJson<{ id: number }>("/api/conversations", chosen.length > 0 ? { preset: chosen } : {});
		await this.refreshList();
		this.switchTo(created.id);
		this.requestInputFocus();
	}

	lastPreset(): string {
		try {
			return localStorage.getItem(PRESET_KEY) ?? this.app.get().defaultPreset;
		} catch {
			return this.app.get().defaultPreset;
		}
	}

	rememberPreset(id: string): void {
		try {
			localStorage.setItem(PRESET_KEY, id);
		} catch {
			/* 仅本次生效 */
		}
	}

	switchTo(id: number): void {
		this.source?.close();
		this.source = undefined;
		window.clearInterval(this.watchdog);
		this.watchdog = undefined;
		this.view = null;
		this.transcript.reset();
		this.contextKey = "";
		this.framePending = false;
		this.pendingStreamingText = undefined;
		this.structureSignature = "";
		this.runStartedAt = undefined;
		this.activeRunFirst = undefined;
		this.runDurations.clear();
		this.clearFlow();
		this.patchApp({
			conversationId: id,
			context: null,
			preset: null,
			workspace: undefined,
		});
		this.connect(id);
		this.publish();
		this.emit("scroll-instant");
		void this.loadSettings(id).catch((error) => this.showError(error));
	}

	private clearFlow(): void {
		for (const key of this.keys.get()) this.nodes.set(key, null);
		this.keys.set([]);
		// 节点源只对当前会话有效（切换会话时 ChatFlow 会整体重挂）。不清掉的话，
		// 每切换一次就留下上一条会话的全部快照（含消息正文），属于真实内存泄漏。
		this.nodes.clear();
	}

	async loadSettings(id: number): Promise<void> {
		const settings = await fetchJson<WorkspaceSettings>(`/api/conversations/${id}/settings`);
		if (this.app.get().conversationId !== id) return; // 切换会话后的迟到响应
		this.patchApp({ workspace: settings, preset: settings.preset ?? null });
	}

	async deleteConversation(id: number): Promise<void> {
		await fetchJson(`/api/conversations/${id}`, { method: "DELETE" });
		await this.refreshList();
		if (this.app.get().conversationId === id) {
			const next = this.app.get().conversations[0]?.id;
			if (next === undefined) {
				this.source?.close();
				this.source = undefined;
				window.clearInterval(this.watchdog);
				this.watchdog = undefined;
				this.view = null;
				this.transcript.reset();
				this.clearFlow();
				// 先落 "没有会话" 的身份，再 publish：publish 会据此派生 blank / heroEmpty
				//（反过来会让 publish 读到旧 conversationId，空白态按钮与禁用态都不出现）
				this.patchApp({
					conversationId: undefined,
					connected: false,
					context: null,
					preset: null,
					workspace: undefined,
				});
				this.publish();
			} else {
				this.switchTo(next);
			}
		}
	}

	// —— SSE ——

	private connect(id: number): void {
		const newest = this.transcript.newest;
		const query = newest === undefined ? "" : `?from=${newest + 1}`;
		const source = new EventSource(`/api/conversations/${id}/events${query}`);
		source.addEventListener("view", (e) => {
			const view = JSON.parse((e as MessageEvent<string>).data) as SseView;
			if (view.conversation.id !== this.app.get().conversationId) return;
			this.lastEventAt = Date.now();
			this.view = view;
			this.docVersion.set(this.docVersion.get() + 1);
			this.transcript.merge(view);
			this.setConnected(true);
			this.publish();
			this.scheduleContextRefresh(id);
		});
		source.addEventListener("ping", () => {
			this.lastEventAt = Date.now();
			this.setConnected(true);
		});
		source.onerror = () => {
			this.setConnected(false);
			if (this.source !== source) return;
			source.close();
			this.source = undefined;
			if (this.app.get().conversationId !== id) return;
			window.setTimeout(() => {
				if (this.app.get().conversationId === id && this.source === undefined) this.connect(id);
			}, 1000);
		};
		this.lastEventAt = Date.now();
		this.source = source;
		this.startWatchdog(id, source);
	}

	/**
	 * 心跳守护：服务端每 15s 发一次 ping，60s 内一个事件都没有就判定连接已死并重建。
	 * 覆盖 EventSource 不报错但流已静默中断的场景（dev server 重启后最典型：
	 * 页面还挂着 busy=true、回答永远不渲染，必须手动刷新）。
	 */
	private startWatchdog(id: number, source: EventSource): void {
		window.clearInterval(this.watchdog);
		this.watchdog = window.setInterval(() => {
			if (this.source !== source) return;
			if (this.app.get().conversationId !== id) return;
			// 运行中更灵敏（20s = 漏掉一个 ping 再多一档），空闲时宽松（60s）
			const staleMs = this.app.get().busy ? 20_000 : 60_000;
			if (Date.now() - this.lastEventAt < staleMs) return;
			// 静默超时：关旧连接、标记离线、重建（重建时不带 from，让服务端回完整窗口）
			source.close();
			this.source = undefined;
			this.setConnected(false);
			this.view = null;
			this.docVersion.set(this.docVersion.get() + 1);
			this.transcript.reset();
			this.structureSignature = "";
			this.clearFlow();
			this.connect(id);
		}, 10_000);
	}

	private setConnected(online: boolean): void {
		if (this.app.get().connected !== online) this.patchApp({ connected: online });
	}

	// —— 派生与发布 ——

	/** 结构签名：条目尾 id / run / inbox 尺寸 / tools 尺寸（判定是否需要重派生）。 */
	private computeSignature(items: readonly { kind: string }[], live: LiveDoc | undefined, inboxSize: number): string {
		const lastEntry = [...items].reverse().find((item) => item.kind === "entry");
		const entryId = lastEntry && "entry" in lastEntry ? (lastEntry as { entry: ChatEntry }).entry.id : -1;
		const runFirst = live?.run?.first ?? -1;
		const toolIds = (live?.tools ?? []).map((slot) => `${slot.callId ?? "?"}:${slot.status ?? "?"}`).join(",");
		return `${entryId}|${runFirst}|${inboxSize}|${toolIds}|${this.transcript.hasEarlier ? "1" : "0"}`;
	}

	publish(): void {
		const state = this.app.get();
		const items = this.transcript.items;
		const entries = items.flatMap((item) => (item.kind === "entry" ? [item.entry] : []));
		const live = this.view?.docs["pi.live"];
		const inbox = (this.view?.docs["pi.inbox"]?.items ?? []).filter(isQueuedInput);
		const run = live?.run ?? undefined;
		const busy = run !== undefined;
		const failure = !busy ? live?.runFailure : undefined;
		const partial = live?.generation?.message;

		const signature = this.computeSignature(items, live, inbox.length);
		const structural = signature !== this.structureSignature;

		// 用时打点：busy 起始记录开始时间与该 run 的 first；结束把耗时记到 run.first 上
		if (busy && this.runStartedAt === undefined) {
			this.runStartedAt = Date.now();
			this.activeRunFirst = run?.first;
		} else if (!busy && this.runStartedAt !== undefined) {
			const elapsed = Date.now() - this.runStartedAt;
			this.runStartedAt = undefined;
			const runFirst = this.activeRunFirst;
			this.activeRunFirst = undefined;
			if (runFirst !== undefined) this.runDurations.set(runFirst, elapsed);
		}

		const heroEmpty =
			state.conversationId !== undefined && !busy && entries.length === 0 && inbox.length === 0 && failure === undefined;
		const appPatch: Partial<AppSnapshot> = { busy, heroEmpty, blank: state.conversationId === undefined };
		if (
			appPatch.busy !== state.busy ||
			appPatch.heroEmpty !== state.heroEmpty ||
			appPatch.blank !== state.blank
		) {
			this.patchApp(appPatch);
		}

		// 流式 partial：仅 rAF 合帧更新 streaming 节点（结构未变时）
		const runFirst = run?.first;
		const answerCommitted =
			runFirst !== undefined && entries.some((entry) => entry.kind === "pi.assistant" && entry.id >= runFirst);
		const streamingText = busy && partial !== undefined && !answerCommitted ? extractText(partial) : undefined;
		if (streamingText !== undefined && !structural) {
			this.pendingStreamingText = streamingText;
			// 首次出现流式文本时，结构化派生可能已经跑过（那时 partial 还是空的），
			// keys 里没有 streaming 座位 —— 必须补上，否则节点更新了却没人渲染。
			this.ensureStreamingSeat();
			if (!this.framePending) {
				this.framePending = true;
				requestAnimationFrame(() => {
					this.framePending = false;
					const text = this.pendingStreamingText;
					if (text !== undefined) this.nodes.set("streaming", { key: "streaming", type: "streaming", text });
				});
			}
			return;
		}
		this.pendingStreamingText = streamingText;
		if (streamingText === undefined && this.nodes.get("streaming") != null) {
			this.nodes.set("streaming", null);
		}

		if (!structural) {
			// 工具输出热更新（output 文本变化）也走节点快照更新
			this.updateToolNodes(entries, live, partial);
			return;
		}
		this.structureSignature = signature;

		// —— 全量重派生 ——
		const toolResults = new Map<string, ToolResultMessage>();
		for (const entry of entries) {
			if (entry.kind !== "pi.tool-result") continue;
			const message = entry.model?.[0];
			if (isToolResult(message) && message.toolCallId !== undefined) {
				toolResults.set(message.toolCallId, message);
			}
		}
		const liveSlots = new Map<string, LiveToolSlot>();
		for (const slot of live?.tools ?? []) {
			if (slot.callId !== undefined) liveSlots.set(slot.callId, slot);
		}

		const nodes: FlowNode[] = [];
		const renderedCalls = new Set<string>();
		let lastUser = -1;
		let lastResponse = -1;

		const pushEntryNode = (entry: ChatEntry, node: FlowNode): void => {
			nodes.push(node);
			if (node.type === "user") lastUser = nodes.length - 1;
			if (node.type === "assistant" || node.type === "streaming") lastResponse = nodes.length - 1;
		};

		for (const item of items) {
			if (item.kind === "gap") {
				nodes.push({ key: `g:${item.after}:${item.upTo}`, type: "gap", after: item.after, upTo: item.upTo });
				continue;
			}
			const entry = item.entry;
			switch (entry.kind) {
				case "pi.user": {
					const userMsg = entry.model?.[0];
					pushEntryNode(entry, {
						key: `e:${entry.id}`,
						type: "user",
						text: extractText(userMsg),
						reveal: false,
						timestamp: userMsg?.timestamp,
					});
					break;
				}
				case "pi.assistant": {
					const message = entry.model?.[0];
					if (message?.stopReason === "error") {
						nodes.push({
							key: `e:${entry.id}`,
							type: "assistant-error",
							message: message.errorMessage || "（模型请求出错）",
						});
						break;
					}
					const calls: ToolCard[] = [];
					const blocks = Array.isArray(message?.content) ? message.content : [];
					for (const block of blocks) {
						if (block.type !== "toolCall" || block.id === undefined) continue;
						renderedCalls.add(block.id);
						calls.push(callCard(block, toolResults.get(block.id), liveSlots.get(block.id)));
					}
					pushEntryNode(entry, {
						key: `e:${entry.id}`,
						type: "assistant",
						text: extractText(message),
						calls,
						reveal: false,
						durationMs: message?.durationMs ?? this.durationFor(entry.id),
						timestamp: message?.timestamp,
						tokens: message?.usage?.totalTokens,
						aborted: message?.stopReason === "aborted",
					});
					break;
				}
				default:
					if (entry.kind === "pi.system" || entry.kind === "pi.tool-result") break;
					// pi.reset / pi.compaction / 自定义类型 → 占位行
					nodes.push({ key: `e:${entry.id}`, type: "assistant-error", message: `（${entry.kind}）` });
					break;
			}
		}

		// reveal：最新用户行与最新回答行常显
		if (lastUser >= 0) {
			const node = nodes[lastUser];
			if (node !== undefined && node.type === "user") nodes[lastUser] = { ...node, reveal: true };
		}
		if (lastResponse >= 0) {
			const node = nodes[lastResponse];
			if (node !== undefined && node.type === "assistant") nodes[lastResponse] = { ...node, reveal: true };
		}

		// 流式节点 / 运行中工具槽位 / 运行状态行 / 错误卡片 / 停止行
		if (streamingText !== undefined) {
			this.pendingStreamingText = streamingText;
			nodes.push({ key: "streaming", type: "streaming", text: streamingText });
		}
		if (busy && live !== undefined) {
			for (const slot of live.tools ?? []) {
				if (slot.callId === undefined || renderedCalls.has(slot.callId)) continue;
				nodes.push({ key: `t:${slot.callId}`, type: "tool", card: slotCard(slot, partialToolCall(partial, slot.callId)) });
			}
		}
		if (busy) nodes.push({ key: "running", type: "running" });

		if (failure !== undefined && failure.reason !== "aborted") {
			const node: FlowNode = { key: "error:tail", type: "error", reason: failure.reason ?? "", detail: failure.detail };
			const anchor = failurePlacement(entries, failure.first);
			if (anchor === undefined) {
				nodes.push(node);
			} else {
				const index = nodes.findIndex((n) => n.key === `e:${anchor}`);
				if (index >= 0) nodes.splice(index + 1, 0, node);
				else nodes.push(node);
			}
		}
		if (failure?.reason === "aborted") nodes.push({ key: "stopped", type: "stopped", text: stoppedText() });

		if (this.transcript.hasEarlier) nodes.unshift({ key: "load-earlier", type: "load-earlier" });

		// 发布：新 key 列表 + 逐 key 快照（引用不变的不动）
		const keyList = nodes.map((node) => node.key);
		const byKey = new Map(nodes.map((node) => [node.key, node]));
		for (const key of this.keys.get()) {
			if (!byKey.has(key)) this.nodes.set(key, null);
		}
		for (const node of nodes) {
			const source = this.nodes.source(node.key);
			const prev = source.get();
			if (prev === null || prev.type !== node.type || !shallowEqualNode(prev, node)) source.set(node);
		}
		this.keys.set(keyList);
	}

	/** 确保 keys 里有 streaming 座位（插在 running 之前，保持"状态行在末"的视觉顺序）。 */
	private ensureStreamingSeat(): void {
		const keys = this.keys.get();
		if (keys.includes("streaming")) return;
		const runningAt = keys.indexOf("running");
		const next = runningAt < 0 ? [...keys, "streaming"] : [...keys.slice(0, runningAt), "streaming", ...keys.slice(runningAt)];
		this.keys.set(next);
	}

	/** assistant 条目 id → 其所属运行的用时（取 ≤ id 的最大 run.first）。 */
	private durationFor(entryId: number): number | undefined {
		let bestKey: number | undefined;
		for (const key of this.runDurations.keys()) {
			if (key <= entryId && (bestKey === undefined || key > bestKey)) bestKey = key;
		}
		return bestKey === undefined ? undefined : this.runDurations.get(bestKey);
	}

	/** 非结构变更时：更新工具槽位节点的 output（运行中工具输出流）。 */
	private updateToolNodes(entries: readonly ChatEntry[], live: LiveDoc | undefined, partial: ModelMessage | undefined): void {
		if (live?.run == null) return;
		const liveSlots = new Map<string, LiveToolSlot>();
		for (const slot of live.tools ?? []) {
			if (slot.callId !== undefined) liveSlots.set(slot.callId, slot);
		}
		if (liveSlots.size === 0) return;
		const toolResults = new Map<string, ToolResultMessage>();
		for (const entry of entries) {
			if (entry.kind !== "pi.tool-result") continue;
			const message = entry.model?.[0];
			if (isToolResult(message) && message.toolCallId !== undefined) toolResults.set(message.toolCallId, message);
		}
		for (const [callId, slot] of liveSlots) {
			const key = `t:${callId}`;
			const prev = this.nodes.get(key);
			if (prev?.type !== "tool") continue;
			const candidate: FlowNode = { key, type: "tool", card: slotCard(slot, partialToolCall(partial, callId)) };
			if (!shallowEqualNode(prev, candidate)) this.nodes.set(key, candidate);
		}
		// assistant 条目内的工具行（运行态 output 变化；done 落定走结构变更重派生）
		for (const entry of entries) {
			if (entry.kind !== "pi.assistant") continue;
			const message = entry.model?.[0];
			const blocks = Array.isArray(message?.content) ? message.content : [];
			if (!blocks.some((block) => block.type === "toolCall")) continue;
			const key = `e:${entry.id}`;
			const prev = this.nodes.get(key);
			if (prev?.type !== "assistant") continue;
			const calls: ToolCard[] = [];
			for (const block of blocks) {
				if (block.type !== "toolCall" || block.id === undefined) continue;
				calls.push(callCard(block, toolResults.get(block.id), liveSlots.get(block.id)));
			}
			const candidate: FlowNode = { ...prev, calls };
			if (!shallowEqualNode(prev, candidate)) this.nodes.set(key, candidate);
		}
	}

	// —— 发送 ——

	send(content: string, gesture: "primary" | "alternate" = "primary"): void {
		const text = content.trim();
		if (text.length === 0 || this.app.get().conversationId === undefined) return;
		void this.submitMessage(text, gesture);
	}

	private modeForGesture(gesture: "primary" | "alternate"): "steer" | "followUp" {
		const preferred = this.app.get().busyEnter === "steer";
		const steer = gesture === "primary" ? preferred : !preferred;
		return steer ? "steer" : "followUp";
	}

	setBusyEnter(value: "queue" | "steer"): void {
		try {
			localStorage.setItem(BUSY_ENTER_KEY, value);
		} catch {
			/* 仅本次生效 */
		}
		this.patchApp({ busyEnter: value });
	}

	private async submitMessage(content: string, gesture: "primary" | "alternate"): Promise<void> {
		const compact = /^\/compact(?:\s+([\s\S]*))?$/.exec(content);
		if (compact !== null) {
			const instructions = compact[1]?.trim();
			await this.runCompact(instructions === undefined || instructions.length === 0 ? undefined : instructions);
			return;
		}
		const busy = this.view?.docs["pi.live"]?.run != null;
		const whenBusy = busy ? this.modeForGesture(gesture) : undefined;
		await this.submitWithRequest(content, crypto.randomUUID(), whenBusy);
	}

	async submitWithRequest(
		content: string,
		requestId: string,
		whenBusy?: "steer" | "followUp",
	): Promise<boolean> {
		const id = this.app.get().conversationId;
		if (id === undefined) return false;
		const result = await postOk(`/api/conversations/${id}/messages`, { content, requestId, ...(whenBusy === undefined ? {} : { whenBusy }) });
		if (!result.ok) {
			this.showToast(result.error);
			return false;
		}
		this.emit("scroll-instant");
		void this.refreshList().catch(() => undefined); // 首条消息更新了会话标题
		return true;
	}

	async retryContinue(): Promise<void> {
		const id = this.app.get().conversationId;
		if (id === undefined) return;
		const result = await postOk(`/api/conversations/${id}/messages`, { continue: true });
		if (!result.ok) this.showToast(result.error);
	}

	private async runCompact(instructions: string | undefined): Promise<void> {
		const id = this.app.get().conversationId;
		if (id === undefined) return;
		const result = await postOk(`/api/conversations/${id}/compact`, instructions === undefined ? {} : { instructions });
		if (!result.ok) {
			this.showToast(result.error);
			return;
		}
		this.showToast("已提交压缩，摘要将在下一个轮次边界落位");
	}

	async stopRun(): Promise<void> {
		const id = this.app.get().conversationId;
		if (id === undefined) return;
		const queued = (this.view?.docs["pi.inbox"]?.items ?? []).filter(isQueuedInput).length;
		const result = await postOk(`/api/conversations/${id}/stop`);
		if (!result.ok) this.showToast(result.error);
		else if (queued > 0) this.showToast(`已停止：${queued} 条排队消息已撤回`);
	}

	// —— 排队 ——

	getInbox(): readonly { id: number; mode?: string; text: string }[] {
		return (this.view?.docs["pi.inbox"]?.items ?? [])
			.filter(isQueuedInput)
			.map((item) => ({ id: item.id, mode: item.mode, text: inboxText(item) }));
	}

	/** 用量文档（引用稳定：同一 view 的 docs 对象不变）。 */
	getUsageDoc(): UsageDoc | undefined {
		return this.view?.docs["pi.usage"];
	}

	/** 轮次数与回答步数（引用稳定：值不变则返回同一快照，供 useSyncExternalStore 使用）。 */
	getRunStats(): { rounds: number; steps: number } {
		const entries = this.transcript.items.flatMap((item) => (item.kind === "entry" ? [item.entry] : []));
		const rounds = entries.filter((entry) => entry.kind === "pi.user").length;
		const steps = entries.filter((entry) => entry.kind === "pi.assistant").length;
		const prev = this.runStats;
		if (prev.rounds === rounds && prev.steps === steps) return prev;
		this.runStats = { rounds, steps };
		return this.runStats;
	}

	private runStats: { rounds: number; steps: number } = { rounds: 0, steps: 0 };

	/** 轨迹视图：全部工具调用按时间线（含运行中槽位）。 */
	getTraceCards(): { key: string; card: ToolCard }[] {
		const items = this.transcript.items;
		const entries = items.flatMap((item) => (item.kind === "entry" ? [item.entry] : []));
		const live = this.view?.docs["pi.live"];
		const toolResults = new Map<string, ToolResultMessage>();
		for (const entry of entries) {
			if (entry.kind !== "pi.tool-result") continue;
			const message = entry.model?.[0];
			if (isToolResult(message) && message.toolCallId !== undefined) toolResults.set(message.toolCallId, message);
		}
		const liveSlots = new Map<string, LiveToolSlot>();
		for (const slot of live?.tools ?? []) {
			if (slot.callId !== undefined) liveSlots.set(slot.callId, slot);
		}
		const partial = live?.generation?.message;
		const out: { key: string; card: ToolCard }[] = [];
		const rendered = new Set<string>();
		for (const entry of entries) {
			if (entry.kind !== "pi.assistant") continue;
			const message = entry.model?.[0];
			const blocks = Array.isArray(message?.content) ? message.content : [];
			for (const block of blocks) {
				if (block.type !== "toolCall" || block.id === undefined) continue;
				rendered.add(block.id);
				out.push({ key: `e:${entry.id}:${block.id}`, card: callCard(block, toolResults.get(block.id), liveSlots.get(block.id)) });
			}
		}
		if (live?.run != null) {
			for (const slot of live.tools ?? []) {
				if (slot.callId === undefined || rendered.has(slot.callId)) continue;
				out.push({ key: `t:${slot.callId}`, card: slotCard(slot, partialToolCall(partial, slot.callId)) });
			}
		}
		return out;
	}

	private async deleteSubmission(id: number): Promise<string> {
		const conversationId = this.app.get().conversationId;
		if (conversationId === undefined) return "failed";
		const response = await fetch(`/api/conversations/${conversationId}/submissions/${id}`, { method: "DELETE" });
		if (!response.ok) {
			const body = (await response.json().catch(() => ({}))) as { error?: string };
			this.showToast(body.error ?? `撤回失败（${response.status}）`);
			return "failed";
		}
		return ((await response.json()) as { result: string }).result;
	}

	private explainWithdrawFailure(result: string): void {
		if (result === "already_placed") this.showToast("这条消息已经开始执行，无法撤回");
		else if (result === "settled") this.showToast("这条消息已经结束，无法撤回");
	}

	async withdrawQueued(item: { id: number }): Promise<void> {
		const result = await this.deleteSubmission(item.id);
		if (result === "aborted") this.showToast("已撤回排队消息");
		else this.explainWithdrawFailure(result);
	}

	async promoteQueued(item: { id: number; mode?: string; text: string }): Promise<void> {
		const result = await this.deleteSubmission(item.id);
		if (result !== "aborted") {
			this.explainWithdrawFailure(result);
			return;
		}
		const ok = await this.submitWithRequest(item.text, crypto.randomUUID(), "steer");
		if (ok) this.showToast("已改为插话发送");
	}

	async requeueEdited(item: { id: number; mode?: string }, text: string): Promise<void> {
		const result = await this.deleteSubmission(item.id);
		if (result !== "aborted") {
			this.explainWithdrawFailure(result);
			return;
		}
		await this.submitWithRequest(text, crypto.randomUUID(), item.mode === "steer" ? "steer" : undefined);
	}

	// —— 模型 ——

	async loadModelCatalog(): Promise<void> {
		const catalog = await fetchJson<ModelCatalog>("/api/models");
		this.patchApp({ modelCatalog: catalog });
		if (catalog.defaultModelFallback !== undefined) {
			const fallback = catalog.defaultModelFallback;
			this.showToast(
				`配置的默认模型 ${fallback.from} 不可用（provider 未装），已改用 ${this.displayNameOf(fallback.to)}。`,
			);
		}
	}

	displayNameOf(model: ModelRefPayload): string {
		const info = this.app
			.get()
			.modelCatalog?.models.find((item) => item.provider === model.provider && item.modelId === model.modelId);
		return info !== undefined ? `${info.name}（${info.providerName}）` : modelKey(model);
	}

	async switchModel(key: string): Promise<void> {
		const id = this.app.get().conversationId;
		if (id === undefined) return;
		const slash = key.indexOf("/");
		if (slash <= 0) return;
		const provider = key.slice(0, slash);
		const modelId = key.slice(slash + 1);
		try {
			const result = await putJson<{ model: ModelRefPayload | null }>(`/api/conversations/${id}/model`, { provider, modelId });
			const workspace = this.app.get().workspace;
			if (workspace !== undefined) this.patchApp({ workspace: { ...workspace, model: result.model } });
			if (result.model !== null) {
				this.showToast(`模型已切换：${this.displayNameOf(result.model)}，对下一条消息生效。`);
			}
		} catch (error) {
			this.showError(error);
		}
	}

	toggleFavorite(): void {
		const model = this.app.get().workspace?.model;
		if (model == null) return;
		const key = modelKey(model);
		const favorites = this.app.get().favorites;
		const wasFavorite = favorites.includes(key);
		const next = wasFavorite ? favorites.filter((item) => item !== key) : [...favorites, key];
		try {
			localStorage.setItem(FAVORITES_KEY, JSON.stringify(next));
		} catch {
			/* 仅本次生效 */
		}
		this.patchApp({ favorites: next });
		this.showToast(
			wasFavorite ? `已取消收藏 ${this.displayNameOf(model)}` : `已收藏 ${this.displayNameOf(model)}，排在列表最前`,
		);
	}

	// —— 工作目录 ——

	async saveWorkspace(cwd: string): Promise<{ ok: boolean; error?: string; settings?: WorkspaceSettings }> {
		const id = this.app.get().conversationId;
		if (id === undefined) return { ok: false };
		try {
			const settings = await putJson<WorkspaceSettings>(`/api/conversations/${id}/settings`, { cwd });
			this.patchApp({ workspace: settings });
			this.showToast(`工作目录已更新：${settings.cwd}`);
			return { ok: true, settings };
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
	}

	async resetWorkspace(): Promise<void> {
		const id = this.app.get().conversationId;
		if (id === undefined) return;
		try {
			const settings = await putJson<WorkspaceSettings>(`/api/conversations/${id}/settings`, { cwd: null });
			this.patchApp({ workspace: settings });
			this.showToast(`已恢复默认工作区：${settings.cwd}`);
		} catch (error) {
			this.showError(error);
		}
	}

	// —— 翻页 / 缺口 ——

	async loadEarlier(): Promise<void> {
		try {
			if (await this.transcript.loadEarlier()) this.publish();
		} catch (error) {
			this.showError(error);
		}
	}

	async fillGap(after: number, upTo: number): Promise<void> {
		try {
			await this.transcript.fillGap(after, upTo);
			this.publish();
		} catch (error) {
			this.showError(error);
		}
	}

	private async fetchEntries(query: { before?: number; after?: number; upTo?: number }): Promise<EntriesPage> {
		const params = new URLSearchParams();
		if (query.before !== undefined) params.set("before", String(query.before));
		if (query.after !== undefined) params.set("after", String(query.after));
		if (query.upTo !== undefined) params.set("upTo", String(query.upTo));
		const id = this.app.get().conversationId;
		return fetchJson<EntriesPage>(`/api/conversations/${id}/entries?${params.toString()}`);
	}

	// —— 上下文占用 ——

	scheduleContextRefresh(id: number): void {
		window.clearTimeout(this.contextTimer);
		this.contextTimer = window.setTimeout(() => {
			void (async () => {
				if (this.app.get().conversationId !== id) return;
				const newest = this.transcript.newest ?? 0;
				const model = this.view?.docs["pi.agent"]?.model;
				const key = `${newest}:${model?.provider ?? ""}/${model?.modelId ?? ""}`;
				if (key === this.contextKey) return;
				this.contextKey = key;
				try {
					const context = await fetchJson<ContextOccupancy>(`/api/conversations/${id}/context`);
					if (this.app.get().conversationId !== id) return;
					this.patchApp({ context });
				} catch {
					// 上下文占用失败不打扰聊天（旧值继续显示）
				}
			})();
		}, 250);
	}

	/** 请求输入框聚焦：置标志并通知；Composer 未挂载时由挂载后的 effect 消费。 */
	requestInputFocus(): void {
		this.pendingFocus = true;
		this.emit("focus-input");
	}

	/** Composer 消费聚焦请求（挂载或收到通知时调用）。 */
	consumeInputFocus(): boolean {
		const pending = this.pendingFocus;
		this.pendingFocus = false;
		return pending;
	}

	/** 引用到输入框：把消息文本填入 composer 草稿（纯前端，不外发）。 */
	quoteToInput(text: string): void {
		this.draft = text;
		this.emit("draft-set");
		this.requestInputFocus();
	}

	/** composer 草稿（引用功能写入；Composer 订阅 draft-set 后同步到本地 state）。 */
	private draft = "";

	takeDraft(): string {
		const value = this.draft;
		this.draft = "";
		return value;
	}

	showError(error: unknown): void {
		this.showToast(error instanceof Error ? error.message : String(error));
	}
}

/** 节点浅比较（calls 数组逐项比较；text 直接比较）。 */
function shallowEqualNode(a: FlowNode, b: FlowNode): boolean {
	if (a.type !== b.type) return false;
	if (a.type === "user" && b.type === "user") return a.text === b.text && a.reveal === b.reveal && a.timestamp === b.timestamp;
	if (a.type === "assistant" && b.type === "assistant") {
		if (a.durationMs !== b.durationMs || a.timestamp !== b.timestamp || a.tokens !== b.tokens) return false;
		if (a.aborted !== b.aborted) return false;
		return a.text === b.text && a.reveal === b.reveal && a.calls.length === b.calls.length && a.calls.every((card, index) => {
			const other = b.calls[index];
			return other !== undefined && card.name === other.name && card.summary === other.summary && card.status === other.status && card.isError === other.isError && card.output === other.output && card.argsText === other.argsText;
		});
	}
	if (a.type === "streaming" && b.type === "streaming") return a.text === b.text;
	if (a.type === "tool" && b.type === "tool") {
		return a.card.name === b.card.name && a.card.summary === b.card.summary && a.card.status === b.card.status && a.card.output === b.card.output && a.card.isError === b.card.isError;
	}
	if (a.type === "error" && b.type === "error") return a.reason === b.reason && a.detail === b.detail;
	if (a.type === "stopped" && b.type === "stopped") return a.text === b.text;
	if (a.type === "gap" && b.type === "gap") return a.after === b.after && a.upTo === b.upTo;
	return true;
}

/** 全局单例（main.tsx 创建）。 */
export const store = new AppStore();
