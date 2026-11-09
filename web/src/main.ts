/**
 * Stella 最小聊天页：会话侧栏（列表/新建/切换/删除）+ 消息流 + 输入框 + 发送/停止，
 * EventSource 订阅当前会话的 SSE。
 *
 * 服务端权威：客户端只 POST 当前这条新消息，不带历史；条目全部来自
 * SSE 推送的 watch view（初始 view + 每次 commit 后的新 view）。
 * 运行中的回答来自 view 中 docs["pi.live"].generation.message 的流式 partial
 * （约每 100ms 一次 commit），回答落定后 partial 让位于最终 pi.assistant 条目。
 * 切换会话时关闭旧 EventSource 再重订，避免多个连接并存。
 */

// —— 服务端数据形状（SSE view / REST 翻页） ——

interface ContentBlock {
	type: string;
	text?: string;
	name?: string;
}

interface ModelMessage {
	role: string;
	content: string | ContentBlock[];
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

interface ConversationList {
	conversations: ConversationSummary[];
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

/** 切换会话：重置消息状态、关闭旧 EventSource 后重订 SSE。 */
function switchTo(id: number): void {
	if (state.source !== undefined) state.source.close(); // 释放旧连接，避免多 EventSource 并存
	state.source = undefined;
	state.conversationId = id;
	state.view = null;
	state.earlier = [];
	renderList();
	setBusyEnabled();
	subscribe(id);
	render();
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
			setConn(false);
			setBusyEnabled();
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
	for (const entry of entries) {
		const node = renderEntry(entry);
		if (node !== undefined) nodes.push(node);
	}
	if (streaming && partial !== undefined) nodes.push(renderStreaming(partial));
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

/** 条目按类型渲染：用户消息、assistant 回答；其余（工具调用等）显示占位行。 */
function renderEntry(entry: ChatEntry): Node | undefined {
	switch (entry.kind) {
		case "pi.user": {
			const text = extractText(entry.model?.[0]);
			return el("div", `msg user`, text);
		}
		case "pi.assistant": {
			const wrap = el("div", "msg stella");
			const text = extractText(entry.model?.[0]);
			if (text.length > 0) wrap.append(el("span", "text", text));
			const toolCalls = (entry.model?.[0]?.content as ContentBlock[] | undefined)?.filter(
				(block) => block.type === "toolCall",
			);
			if (toolCalls !== undefined && toolCalls.length > 0) {
				const names = toolCalls.map((block) => block.name ?? "工具").join("、");
				wrap.append(el("span", "tool", `（调用了工具：${names}）`));
			}
			if (text.length === 0 && (toolCalls === undefined || toolCalls.length === 0)) {
				wrap.append(el("span", "placeholder", "（无文本内容）"));
			}
			return wrap;
		}
		default: {
			// pi.system 是提示词/工具变化的位置记录，对用户无意义：静默跳过；
			// 其余（pi.tool-result / pi.reset / pi.compaction / 自定义类型）→ 占位行
			if (entry.kind === "pi.system") return undefined;
			return el("div", "msg placeholder", `（${entry.kind}）`);
		}
	}
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
