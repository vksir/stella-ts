/**
 * Stella 聊天页：会话侧栏（列表/新建/切换/删除 + 工作目录设置）+ 消息流 + 输入框 + 发送/停止，
 * EventSource 订阅当前会话的 SSE。
 *
 * 服务端权威：客户端只 POST 当前这条新消息，不带历史；条目全部来自
 * SSE 推送的 watch view（初始 view + 每次 commit 后的新 view）。
 * 运行中的回答来自 view 中 docs["pi.live"].generation.message 的流式 partial
 * （约每 100ms 一次 commit），回答落定后 partial 让位于最终 pi.assistant 条目。
 * 工具调用以折叠卡片展示：assistant 条目的 toolCall 块给出名称与参数摘要，
 * pi.tool-result 条目（按 toolCallId 关联）给出输出全文；运行中的调用来自
 * docs["pi.live"].tools 槽位（状态：排队/运行中，输出随节流 commit 到达）。
 * 切换会话时关闭旧 EventSource 再重订，避免多个连接并存。
 */

// —— 服务端数据形状（SSE view / REST 翻页） ——

interface ContentBlock {
	type: string;
	text?: string;
	name?: string;
	// 工具调用块（pi.assistant 里）：id 关联 pi.tool-result 条目与 pi.live.tools 槽位
	id?: string;
	arguments?: Record<string, unknown>;
	argumentsError?: string;
}

interface ModelMessage {
	role: string;
	content: string | ContentBlock[];
}

/** pi.tool-result 条目的 model[0]：工具结果，与 assistant 的 toolCall 块按 toolCallId 关联。 */
interface ToolResultMessage {
	role: "toolResult";
	toolCallId?: string;
	toolName?: string;
	content: ContentBlock[];
	isError?: boolean;
}

/** pi.live.tools 槽位：当前工具轮次一个调用的运行态。 */
interface LiveToolSlot {
	callId?: string;
	name?: string;
	status?: "pending" | "running" | "done";
	output?: string;
}

interface ChatEntry {
	id: number;
	kind: string;
	model?: ModelMessage[];
}

interface LiveRun {
	/** 本次运行的第一个条目：回答条目的 id 必不小于它，用于 partial 去重。 */
	first?: number;
}

interface LiveDoc {
	run?: LiveRun | null;
	generation?: { message?: ModelMessage } | null;
	tools?: LiveToolSlot[] | null;
	runFailure?: { reason?: string; detail?: unknown };
}

interface SseView {
	conversation: { id: number };
	entries: ChatEntry[];
	before?: number;
	docs: Record<string, LiveDoc>;
}

interface EntriesPage {
	entries: ChatEntry[];
	hasMore: boolean;
}

interface ConversationSummary {
	id: number;
	title: string | null;
	createdAt?: number;
}

/** GET/PUT 会话设置的响应体：cwd 为当前生效值，defaultWorkspace 为服务端配置的默认工作区。 */
interface WorkspaceSettings {
	cwd: string;
	defaultWorkspace: string;
	custom: boolean;
}

interface ConversationList {
	conversations: ConversationSummary[];
}

/** 收集到的单个工具调用的展示状态：调用参数 + 结果（或运行中）。 */
interface ToolCard {
	/** 工具名（read / write / edit / bash …）。 */
	name: string;
	/** 关键参数摘要（一行）。 */
	summary: string;
	/** 参数原文（JSON），展开后可看。 */
	argsText: string;
	/** 结果输出全文；undefined 表示尚未落定。 */
	output: string | undefined;
	/** 是否失败（isError）。 */
	isError: boolean;
	/** 运行态：done 有结果；running 运行中；pending 排队中；lost 表示槽位已清且无结果（历史边缘）。 */
	status: "done" | "running" | "pending" | "lost";
}

// —— 页面状态 ——

const state = {
	/** 侧栏会话列表（服务端已过滤已删除会话）。 */
	conversations: [] as ConversationSummary[],
	conversationId: undefined as number | undefined,
	view: null as SseView | null,
	/** 视图窗口之外的更早条目（升序）。 */
	earlier: [] as ChatEntry[],
	/** 当前会话的 SSE 连接；切换会话时先 close 旧的再重订。 */
	source: undefined as EventSource | undefined,
	/** 当前会话的工作目录设置。 */
	workspace: undefined as WorkspaceSettings | undefined,
};

const messagesEl = document.getElementById("messages") as HTMLElement;
const inputEl = document.getElementById("input") as HTMLTextAreaElement;
const sendEl = document.getElementById("send") as HTMLButtonElement;
const stopEl = document.getElementById("stop") as HTMLButtonElement;
const connEl = document.getElementById("conn") as HTMLElement;
const bannerEl = document.getElementById("banner") as HTMLElement;
const listEl = document.getElementById("conversation-list") as HTMLElement;
const newEl = document.getElementById("new-conversation") as HTMLButtonElement;
const confirmEl = document.getElementById("confirm") as HTMLElement;
const confirmTextEl = document.getElementById("confirm-text") as HTMLElement;
const confirmDeleteEl = document.getElementById("confirm-delete") as HTMLButtonElement;
const confirmCancelEl = document.getElementById("confirm-cancel") as HTMLButtonElement;
const workspaceInputEl = document.getElementById("workspace-dir") as HTMLInputElement;
const workspaceHintEl = document.getElementById("workspace-hint") as HTMLElement;
const workspaceSaveEl = document.getElementById("save-workspace") as HTMLButtonElement;
const workspaceResetEl = document.getElementById("reset-workspace") as HTMLButtonElement;

// —— 启动：加载列表，无会话则建一个，然后订阅 ——

void boot();

async function boot(): Promise<void> {
	try {
		await refreshList();
		const first = state.conversations[0]?.id;
		if (first === undefined) {
			await createConversation();
		} else {
			switchTo(first);
		}
	} catch (error) {
		showBanner(error instanceof Error ? error.message : String(error));
	}
}

/** 拉取会话列表并重绘侧栏（不动当前订阅）。 */
async function refreshList(): Promise<void> {
	const list = (await fetchJson("/api/conversations")) as ConversationList;
	state.conversations = list.conversations;
	renderList();
}

/** 新建会话：POST 后刷新列表并切换过去，输入框聚焦、空白消息流。 */
async function createConversation(): Promise<void> {
	const created = (await fetchJson("/api/conversations", { method: "POST" })) as { id: number };
	await refreshList();
	switchTo(created.id);
	inputEl.focus();
}

/** 切换会话：重置消息状态、关闭旧 EventSource 后重订 SSE，并拉取会话设置。 */
function switchTo(id: number): void {
	if (state.source !== undefined) state.source.close(); // 释放旧连接，避免多 EventSource 并存
	state.source = undefined;
	state.conversationId = id;
	state.view = null;
	state.earlier = [];
	state.workspace = undefined;
	renderList();
	setBusyEnabled();
	renderWorkspace();
	subscribe(id);
	render();
	void loadWorkspace(id).catch(showError);
}

function subscribe(id: number): void {
	const source = new EventSource(`/api/conversations/${id}/events`);
	source.addEventListener("view", (e) => {
		const view = JSON.parse((e as MessageEvent<string>).data) as SseView;
		if (view.conversation.id !== state.conversationId) return; // 旧连接的迟到事件，忽略
		state.view = view;
		setConn(true);
		render();
	});
	source.addEventListener("ping", () => setConn(true));
	source.onerror = () => setConn(false); // EventSource 自动重连
	state.source = source;
}

/** 删除会话（服务端为归档语义）：确认后调用，删的是当前会话则自动切换或进入空白态。 */
async function deleteConversation(id: number): Promise<void> {
	await fetchJson(`/api/conversations/${id}`, { method: "DELETE" });
	await refreshList();
	if (state.conversationId === id) {
		const next = state.conversations[0]?.id;
		if (next === undefined) {
			// 无剩余会话：空白态（订阅仍挂着，但会话已隐藏；直接释放）
			if (state.source !== undefined) state.source.close();
			state.source = undefined;
			state.conversationId = undefined;
			state.view = null;
			state.earlier = [];
			state.workspace = undefined;
			setConn(false);
			setBusyEnabled();
			renderWorkspace();
			render();
		} else {
			switchTo(next);
		}
	}
}

// —— 发送：只发当前这条新消息 ——

function send(): void {
	const content = inputEl.value.trim();
	if (content.length === 0 || state.conversationId === undefined || inputEl.disabled) return;
	void submitMessage(content);
}

async function submitMessage(content: string): Promise<void> {
	sendEl.disabled = true;
	try {
		const response = await fetch(`/api/conversations/${state.conversationId}/messages`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ content }),
		});
		if (!response.ok) {
			const body = (await response.json().catch(() => ({}))) as { error?: string };
			showBanner(body.error ?? `发送失败（${response.status}）`);
		} else {
			inputEl.value = "";
			void refreshList().catch(() => undefined); // 首条消息更新了会话标题，刷新侧栏
		}
	} catch (error) {
		showBanner(error instanceof Error ? error.message : String(error));
	} finally {
		sendEl.disabled = state.conversationId === undefined;
		inputEl.focus();
	}
}

// —— 会话设置：工作目录 ——

/** 拉取当前会话的工作目录设置并填充输入框。 */
async function loadWorkspace(id: number): Promise<void> {
	state.workspace = (await fetchJson(`/api/conversations/${id}/settings`)) as WorkspaceSettings;
	renderWorkspace();
}

/** 将工作目录设置反映到设置区（输入框 + 提示行）。 */
function renderWorkspace(): void {
	const settings = state.workspace;
	const none = state.conversationId === undefined;
	workspaceInputEl.disabled = none || settings === undefined;
	workspaceSaveEl.disabled = none || settings === undefined;
	workspaceResetEl.disabled = none || settings === undefined;
	if (settings === undefined) {
		workspaceInputEl.value = none ? "" : "加载中…";
		workspaceHintEl.textContent = "";
		return;
	}
	if (workspaceInputEl.value !== settings.cwd) workspaceInputEl.value = settings.cwd;
	workspaceHintEl.textContent = settings.custom
		? "已自定义（后续工具调用立即生效）"
		: "默认工作区（服务端 data/workspace）";
}

/** 保存工作目录：传输入框值；服务端校验失败时返回中文提示，直接展示。 */
async function saveWorkspace(): Promise<void> {
	if (state.conversationId === undefined) return;
	const value = workspaceInputEl.value.trim();
	workspaceSaveEl.disabled = true;
	try {
		state.workspace = (await fetchJson(`/api/conversations/${state.conversationId}/settings`, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ cwd: value }),
		})) as WorkspaceSettings;
		workspaceInputEl.value = state.workspace.cwd;
		showBanner(`工作目录已更新：${state.workspace.cwd}`);
	} finally {
		renderWorkspace();
	}
}

/** 恢复默认工作区：cwd 传 null，服务端清除会话上的显式设置。 */
async function resetWorkspace(): Promise<void> {
	if (state.conversationId === undefined) return;
	workspaceResetEl.disabled = true;
	try {
		state.workspace = (await fetchJson(`/api/conversations/${state.conversationId}/settings`, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ cwd: null }),
		})) as WorkspaceSettings;
		workspaceInputEl.value = state.workspace.cwd;
		showBanner(`已恢复默认工作区：${state.workspace.cwd}`);
	} finally {
		renderWorkspace();
	}
}

// —— 渲染 ——

function render(): void {
	const entries = [...state.earlier, ...(state.view?.entries ?? [])];
	const live = state.view?.docs["pi.live"];
	const run = live?.run ?? undefined;
	const busy = run !== undefined;
	const failure = !busy ? live?.runFailure : undefined;
	const partial = live?.generation?.message;
	// partial 去重：本运行已提交回答条目（id ≥ run.first）就不再渲染 partial，避免与最终条目重复
	const runFirst = run?.first;
	const answerCommitted =
		runFirst !== undefined && entries.some((entry) => entry.kind === "pi.assistant" && entry.id >= runFirst);
	const streaming = busy && partial !== undefined && !answerCommitted;

	const nodes: Node[] = [];
	if (state.conversationId === undefined) {
		// 空白态：没有会话（全部被删除），给出新建入口
		const button = el("button", "empty-new", "＋ 新建一个会话") as HTMLButtonElement;
		button.type = "button";
		button.addEventListener("click", () => void createConversation().catch(showError));
		nodes.push(el("div", "empty", "没有会话。"));
		nodes.push(button);
		messagesEl.replaceChildren(...nodes);
		return;
	}
	if (entries.length === 0 && !busy) {
		nodes.push(el("div", "empty", "还没有消息。向 Stella 说点什么吧。"));
	}
	// 工具调用展示的数据源：结果条目与运行态槽位都按 callId 关联到 assistant 的 toolCall 块
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
	const renderedCalls = new Set<string>();
	for (const entry of entries) {
		const node = renderEntry(entry, toolResults, liveSlots, renderedCalls);
		if (node !== undefined) nodes.push(node);
	}
	if (streaming && partial !== undefined) nodes.push(renderStreaming(partial));
	// 运行中的工具调用：还没落到任何条目的槽位（模型刚发起调用、assistant 条目未提交时）在这显示
	if (busy && live !== undefined) {
		for (const slot of live.tools ?? []) {
			if (slot.callId === undefined || renderedCalls.has(slot.callId)) continue;
			nodes.push(renderToolCard(slotCard(slot, partialToolCall(partial, slot.callId))));
		}
	}
	if (busy && !streaming) nodes.push(el("div", "status", "Stella 正在运行…"));
	if (failure !== undefined) {
		nodes.push(el("div", "error-line", failureText(failure.reason)));
	}
	if (canLoadEarlier()) {
		const button = el("button", "load-earlier", "加载更早") as HTMLButtonElement;
		button.type = "button";
		button.addEventListener("click", () => void loadEarlier());
		nodes.unshift(button);
	}

	stopEl.hidden = !busy;

	const nearBottom = isNearBottom();
	messagesEl.replaceChildren(...nodes);
	if (nearBottom) messagesEl.scrollTop = messagesEl.scrollHeight;
}

/** 侧栏：会话列表（标题缺省显示占位名，附创建时间），当前会话高亮，每项带删除按钮。 */
function renderList(): void {
	const nodes: Node[] = [];
	for (const conversation of state.conversations) {
		const item = el("li", conversation.id === state.conversationId ? "active" : "");
		const main = el("button", "conversation-main") as HTMLButtonElement;
		main.type = "button";
		const title = el("span", "conversation-title", conversation.title ?? "新对话");
		const time = el("span", "conversation-time", formatTime(conversation.createdAt));
		main.append(title, time);
		main.addEventListener("click", () => {
			if (conversation.id !== state.conversationId) switchTo(conversation.id);
		});
		const remove = el("button", "conversation-delete", "✕") as HTMLButtonElement;
		remove.type = "button";
		remove.title = "删除会话";
		remove.setAttribute(
			"aria-label",
			`删除会话：${conversation.title ?? "新对话"}`,
		);
		remove.addEventListener("click", () => confirmDelete(conversation));
		item.append(main, remove);
		nodes.push(item);
	}
	listEl.replaceChildren(...nodes);
}

/** 无会话时禁用输入与发送（空白态不接收消息）。 */
function setBusyEnabled(): void {
	const none = state.conversationId === undefined;
	inputEl.disabled = none;
	sendEl.disabled = none;
	if (none) {
		inputEl.value = "";
		inputEl.placeholder = "先新建一个会话…";
	} else {
		inputEl.placeholder = "给 Stella 发消息…（Enter 发送，Shift+Enter 换行）";
	}
}

/** 删除确认弹层：记录待删会话，确认后执行。 */
let pendingDelete: number | undefined;

function confirmDelete(conversation: ConversationSummary): void {
	pendingDelete = conversation.id;
	confirmTextEl.textContent = `删除会话「${conversation.title ?? "新对话"}」？该会话的消息将不再显示。`;
	confirmEl.hidden = false;
	confirmDeleteEl.focus();
}

function closeConfirm(): void {
	pendingDelete = undefined;
	confirmEl.hidden = true;
}

/** 确认删除：服务端归档后，删除的是当前会话则自动切换或进入空白态。 */
async function performDelete(): Promise<void> {
	const id = pendingDelete;
	closeConfirm();
	if (id === undefined) return;
	try {
		await deleteConversation(id);
	} catch (error) {
		showError(error);
	}
}

/** epoch 毫秒 →「M/D HH:mm」；缺失（旧数据）返回空串。 */
function formatTime(createdAt?: number): string {
	if (createdAt === undefined || createdAt <= 0) return "";
	const date = new Date(createdAt);
	const pad = (n: number): string => String(n).padStart(2, "0");
	return `${date.getMonth() + 1}/${date.getDate()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 运行结束（无回答）的提示文案。 */
function failureText(reason?: string): string {
	switch (reason) {
		case "aborted":
			return "已停止本次运行，已生成的部分已保留。";
		case "model_error":
			return "本次运行未能完成（模型请求失败）。";
		case "no_model":
			return "本次运行未能完成（未配置可用模型）。";
		case "turn_limit":
			return "本次运行未能完成（达到工具轮次上限）。";
		default:
			return `本次运行未能完成（${reason ?? "未知原因"}）。`;
	}
}

/** 进行中的回答：流式 partial + “生成中”指示。 */
function renderStreaming(message: ModelMessage): HTMLElement {
	const wrap = el("div", "msg stella streaming");
	const text = extractText(message);
	if (text.length > 0) wrap.append(el("span", "text", text));
	wrap.append(el("span", "generating", "生成中…"));
	return wrap;
}

/** 条目按类型渲染：用户消息、assistant 回答（含工具卡片）；tool-result 并入卡片，不单独显示。 */
function renderEntry(
	entry: ChatEntry,
	toolResults: ReadonlyMap<string, ToolResultMessage>,
	liveSlots: ReadonlyMap<string, LiveToolSlot>,
	renderedCalls: Set<string>,
): Node | undefined {
	switch (entry.kind) {
		case "pi.user": {
			const text = extractText(entry.model?.[0]);
			return el("div", `msg user`, text);
		}
		case "pi.assistant": {
			const message = entry.model?.[0];
			const wrap = el("div", "msg stella");
			const text = extractText(message);
			if (text.length > 0) wrap.append(el("span", "text", text));
			const blocks = Array.isArray(message?.content) ? message.content : [];
			for (const block of blocks) {
				if (block.type !== "toolCall" || block.id === undefined) continue;
				renderedCalls.add(block.id);
				wrap.append(renderToolCard(callCard(block, toolResults.get(block.id), liveSlots.get(block.id))));
			}
			if (text.length === 0 && !blocks.some((block) => block.type === "toolCall")) {
				wrap.append(el("span", "placeholder", "（无文本内容）"));
			}
			return wrap;
		}
		default: {
			// pi.system 是提示词/工具变化的位置记录，对用户无意义：静默跳过；
			// pi.tool-result 已并入 assistant 条目的工具卡片：跳过；
			// 其余（pi.reset / pi.compaction / 自定义类型）→ 占位行
			if (entry.kind === "pi.system" || entry.kind === "pi.tool-result") return undefined;
			return el("div", "msg placeholder", `（${entry.kind}）`);
		}
	}
}

/** assistant 条目里的一个工具调用块 → 卡片状态（参数 + 结果/运行态）。 */
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
				: JSON.stringify(args, null, 2) ?? "",
		output: result === undefined ? (slot?.output ?? undefined) : resultText(result),
		isError: result?.isError === true,
		status,
	};
}

/** 运行区槽位（条目里还没有对应调用块时）→ 卡片状态；参数从流式 partial 里找。 */
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

/** 工具调用折叠卡片：收起显示名称+摘要+状态，展开显示参数与输出全文。 */
function renderToolCard(card: ToolCard): HTMLElement {
	const details = document.createElement("details");
	details.className = `tool-card ${card.status}${card.isError ? " error" : ""}`;
	const summary = document.createElement("summary");
	summary.append(
		el("span", "tool-name", card.name),
		el("span", "tool-args", card.summary),
		el("span", "tool-state", toolStateText(card)),
	);
	details.append(summary);
	const body = el("div", "tool-body");
	body.append(el("div", "tool-section", "参数"), el("pre", "tool-pre", card.argsText || "（无）"));
	if (card.output !== undefined && card.output.length > 0) {
		body.append(
			el("div", "tool-section", card.isError ? "错误输出" : "输出"),
			el("pre", "tool-pre", card.output),
		);
	} else if (card.status === "running" || card.status === "pending") {
		body.append(el("div", "tool-section", "输出"), el("pre", "tool-pre", "（等待输出…）"));
	}
	details.append(body);
	return details;
}

/** 卡片状态文案。 */
function toolStateText(card: ToolCard): string {
	switch (card.status) {
		case "running":
			return "运行中";
		case "pending":
			return "排队中";
		case "done":
			return card.isError ? "失败" : "完成";
		default:
			return "已结束";
	}
}

/** 工具调用的关键参数摘要（一行，过长截断）：bash 显示命令，read/write/edit 显示路径与编辑摘要。 */
function summarizeToolCall(name: string, args: Readonly<Record<string, unknown>>): string {
	const str = (key: string): string => (typeof args[key] === "string" ? (args[key] as string) : "");
	let summary: string;
	switch (name) {
		case "bash":
			summary = str("command");
			break;
		case "read":
			summary = str("path");
			break;
		case "write": {
			const content = str("content");
			summary = `${str("path")}（写入 ${content.length} 字）`;
			break;
		}
		case "edit": {
			summary = `${str("path")}（替换 ${str("oldText").length} 字 → ${str("newText").length} 字）`;
			break;
		}
		default:
			summary = JSON.stringify(args) ?? "";
	}
	const oneLine = summary.split("\n")[0] ?? "";
	return oneLine.length > 80 ? `${oneLine.slice(0, 80)}…` : oneLine;
}

/** 工具结果的输出文本（content 里的 text 块）。 */
function resultText(result: ToolResultMessage): string {
	return (result.content ?? [])
		.filter((block) => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text ?? "")
		.join("");
}

/** 流式 partial 里 id 匹配的 toolCall 块（运行中槽位的参数来源）。 */
function partialToolCall(partial: ModelMessage | undefined, callId: string): ContentBlock | undefined {
	const content = partial?.content;
	if (!Array.isArray(content)) return undefined;
	return content.find((block) => block.type === "toolCall" && block.id === callId);
}

function isToolResult(message: ModelMessage | undefined): message is ToolResultMessage {
	return message?.role === "toolResult";
}

function extractText(message: ModelMessage | undefined): string {
	const content = message?.content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter((block) => block.type === "text" && typeof block.text === "string")
			.map((block) => block.text ?? "")
			.join("");
	}
	return "";
}

function canLoadEarlier(): boolean {
	const view = state.view;
	if (view?.before === undefined) return false;
	const firstEarlier = state.earlier[0];
	if (firstEarlier === undefined) return true;
	return firstEarlier.id > view.before;
}

async function loadEarlier(): Promise<void> {
	const { conversationId, view } = state;
	if (conversationId === undefined || view?.before === undefined) return;
	const all = [...state.earlier, ...(view.entries ?? [])];
	const oldest = all[0];
	if (oldest === undefined) return;
	try {
		const page = (await fetchJson(
			`/api/conversations/${conversationId}/entries?before=${oldest.id}`,
		)) as EntriesPage;
		state.earlier = [...page.entries, ...state.earlier];
		render();
	} catch (error) {
		showBanner(error instanceof Error ? error.message : String(error));
	}
}

// —— 小工具 ——

async function fetchJson(url: string, init?: RequestInit): Promise<unknown> {
	const response = await fetch(url, init);
	if (!response.ok) {
		const body = (await response.json().catch(() => ({}))) as { error?: string };
		throw new Error(body.error ?? `请求失败（${response.status}）：${url}`);
	}
	return (await response.json()) as unknown;
}

function el(tag: string, className: string, text = ""): HTMLElement {
	const node = document.createElement(tag);
	node.className = className;
	node.textContent = text; // 一律 textContent，不拼 HTML
	return node;
}

function isNearBottom(): boolean {
	return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 120;
}

function setConn(online: boolean): void {
	connEl.textContent = online ? "已连接" : "重连中…";
	connEl.classList.toggle("conn-online", online);
	connEl.classList.toggle("conn-offline", !online);
}

let bannerTimer: ReturnType<typeof setTimeout> | undefined;

function showBanner(message: string): void {
	bannerEl.textContent = message;
	bannerEl.hidden = false;
	if (bannerTimer !== undefined) clearTimeout(bannerTimer);
	bannerTimer = setTimeout(() => {
		bannerEl.hidden = true;
	}, 6000);
}

// —— 事件绑定 ——

sendEl.addEventListener("click", send);
stopEl.addEventListener("click", () => void stopRun());
newEl.addEventListener("click", () => void createConversation().catch(showError));
workspaceSaveEl.addEventListener("click", () => void saveWorkspace().catch(showError));
workspaceResetEl.addEventListener("click", () => void resetWorkspace().catch(showError));
workspaceInputEl.addEventListener("keydown", (e) => {
	if (e.key === "Enter") {
		e.preventDefault();
		void saveWorkspace().catch(showError);
	}
});
confirmCancelEl.addEventListener("click", closeConfirm);
confirmDeleteEl.addEventListener("click", () => void performDelete());
confirmEl.addEventListener("click", (e) => {
	if (e.target === confirmEl) closeConfirm(); // 点遮罩关闭
});
inputEl.addEventListener("keydown", (e) => {
	if (e.key === "Enter" && !e.shiftKey) {
		e.preventDefault();
		send();
	}
});

function showError(error: unknown): void {
	showBanner(error instanceof Error ? error.message : String(error));
}

/** 停止当前运行：服务端 abort 后，已生成的部分保留，UI 随 view 更新回到可输入状态。 */
async function stopRun(): Promise<void> {
	if (state.conversationId === undefined) return;
	stopEl.disabled = true;
	try {
		const response = await fetch(`/api/conversations/${state.conversationId}/stop`, { method: "POST" });
		if (!response.ok) {
			const body = (await response.json().catch(() => ({}))) as { error?: string };
			showBanner(body.error ?? `停止失败（${response.status}）`);
		}
	} catch (error) {
		showBanner(error instanceof Error ? error.message : String(error));
	} finally {
		stopEl.disabled = false;
	}
}
