/**
 * Stella 聊天页：会话侧栏（列表/新建/切换/删除 + 模型/工作目录设置）+ 消息流 + 输入框 + 发送/停止，
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
 *
 * 排队（GLOSSARY「提交」/ pi-durable「Busy Conversations」）：会话运行中发送的消息
 * 不报错，以 follow-up 排队进 docs["pi.inbox"]，前端渲染为带「等待中」标记的用户气泡，
 * 当前运行结束后由 pi-durable 按入队顺序自动依次执行。停止（abort）会撤回排队输入：
 * 排队项从 inbox 消失且不产生条目——本端不在流里静默吞掉它，发送时 busy 的消息记录在
 * 内存（state.queuedSent），随 view 对账：仍在 inbox 或已出现为条目的移出记录，
 * 其余判定为已随停止撤回并横幅提示（记录仅存内存，刷新后不再提示）。
 *
 * 错误卡片 + 重试：运行结束无回答且非用户停止时，docs["pi.live"].runFailure 给出原因
 * （reason/detail，直到下一次运行开始才清除），前端在失败那次提交的位置（runFailure.first
 * 之后的最后一条 pi.user 条目之后）渲染内嵌错误卡片：中文文案包裹底层错误 + 重试按钮。
 * 重试以新 requestId 重新提交同一条用户消息（相同 requestId 只会幂等找回原失败提交）；
 * 重试的提交按 pi-durable 语义再次放置为一条 pi.user 条目（transcript 中出现重复的用户
 * 消息，如实呈现不隐藏），新运行开始时 runFailure 清除、错误卡片消失，回答落定后由
 * 正常回答取代。
 *
 * 模型切换（GLOSSARY「会话」：会话属性含所选模型）：下拉只列已装 provider 的模型，
 * 按 provider 分组（optgroup）；选中即 PUT /api/conversations/:id/model，服务端
 * configure({ model }) 写入 pi.agent，立即生效于下一条消息——可从回答条目的
 * 模型元数据（provider/model）验证。新会话由服务端写入默认模型。
 * 收藏（GLOSSARY「收藏」）：星标按钮收藏当前会话模型，localStorage 持久化
 * （键 stella.model-favorites，存 "provider/modelId" 数组），刷新保持；
 * 收藏项在顶部「★ 收藏」分组置顶，组内按收藏先后，其余组内保持目录顺序。
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
	/** 回答条目的停止原因："error" 表示这次尝试失败（pi-durable 保留的错误 attempt）。 */
	stopReason?: string;
	/** stopReason 为 "error" 时的底层错误文本。 */
	errorMessage?: string;
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
	/** 运行结束无回答时的失败原因（含 detail 与失败运行的首条目 id），下一次运行开始时清除。 */
	runFailure?: { reason?: string; detail?: string; first?: number; inputs?: number[] };
}

/** pi.inbox 排队项：等待放置的提交（用户输入，mode 为 steer/followUp）。 */
interface InboxItemView {
	id: number;
	mode?: string;
	/** 用户消息内容（string 或内容块数组）；write 型排队项无此字段，本端不发送。 */
	content?: string | ContentBlock[];
}

interface SseView {
	conversation: { id: number };
	entries: ChatEntry[];
	before?: number;
	docs: { "pi.live"?: LiveDoc; "pi.inbox"?: { items?: InboxItemView[] } };
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

/** GET/PUT 会话设置的响应体：cwd 为当前生效值，defaultWorkspace 为服务端配置的默认工作区，
 * model 为会话当前模型（resolved；创建会话时已写入服务端默认模型）。 */
interface WorkspaceSettings {
	cwd: string;
	defaultWorkspace: string;
	custom: boolean;
	model: ModelRefPayload | null;
}

/** 模型引用（provider/modelId），与服务端 ModelRef 同形。 */
interface ModelRefPayload {
	provider: string;
	modelId: string;
}

/** GET /api/models 的目录条目；带会话查询时当前会话选中的模型带 selected。 */
interface ModelInfo extends ModelRefPayload {
	providerName: string;
	name: string;
	selected?: boolean;
}

/** GET /api/models 响应：目录 + 默认模型 + （配置的默认模型不可用时的）回落信息。 */
interface ModelCatalog {
	models: ModelInfo[];
	defaultModel: ModelRefPayload;
	defaultModelFallback?: { from: string; to: ModelRefPayload };
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
	/** 当前会话的设置（工作目录 + 当前模型）。 */
	workspace: undefined as WorkspaceSettings | undefined,
	/** 可用模型目录（全局，启动时拉一次）。 */
	modelCatalog: undefined as ModelCatalog | undefined,
	/** 收藏的模型（"provider/modelId"，按收藏先后）；localStorage 持久化，刷新保持。 */
	favorites: [] as string[],
	/** 发送时处于运行中（排队）的消息文本（内存）：用于停止撤回后的提示对账。 */
	queuedSent: [] as string[],
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
const modelSelectEl = document.getElementById("model-select") as HTMLSelectElement;
const favoriteEl = document.getElementById("toggle-favorite") as HTMLButtonElement;
const modelHintEl = document.getElementById("model-hint") as HTMLElement;

// —— 收藏：localStorage 持久化（GLOSSARY「收藏」：浏览器本地偏好，排序在列表最前）——

const FAVORITES_KEY = "stella.model-favorites";

/** 模型引用 → localStorage/option value 用的 "provider/modelId" 键。 */
function modelKey(model: ModelRefPayload): string {
	return `${model.provider}/${model.modelId}`;
}

/** 读取收藏列表：写法不合法时静默回退空表（本地偏好坏了不应阻塞页面）。 */
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

function saveFavorites(favorites: readonly string[]): void {
	localStorage.setItem(FAVORITES_KEY, JSON.stringify(favorites));
}

state.favorites = loadFavorites();

// —— 启动：加载列表，无会话则建一个，然后订阅 ——

void boot();

async function boot(): Promise<void> {
	try {
		// 模型目录是全局资源，与会话加载并行拉取；失败不阻塞聊天（下拉显示加载中/失败）
		void loadModelCatalog().catch(showError);
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
	state.queuedSent = []; // 撤回提示只针对当前会话，切换即弃
	renderList();
	setBusyEnabled();
	renderWorkspace();
	renderModelArea();
	subscribe(id);
	render();
	void loadSettings(id).catch(showError);
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
			renderModelArea();
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

/** 新 requestId：相同 requestId 的重复提交会被 pi-durable 幂等去重（GLOSSARY「提交」），
 * 所以每次发送（含重试）都用新 id；它只在网络层重发时防重复，不用于业务幂等。 */
function newRequestId(): string {
	return crypto.randomUUID();
}

async function submitMessage(content: string): Promise<void> {
	const busy = state.view?.docs["pi.live"]?.run != null; // 发送时在运行：本次提交会排队
	if (busy) state.queuedSent = [...state.queuedSent, content];
	await submitWithRequest(content, newRequestId());
}

/** 重试：以新 requestId 重新提交失败的那条用户消息（同 id 只会找回原失败提交）。 */
async function retrySubmission(content: string): Promise<void> {
	const busy = state.view?.docs["pi.live"]?.run != null;
	if (busy) state.queuedSent = [...state.queuedSent, content];
	await submitWithRequest(content, newRequestId());
}

async function submitWithRequest(content: string, requestId: string): Promise<void> {
	sendEl.disabled = true;
	try {
		const response = await fetch(`/api/conversations/${state.conversationId}/messages`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ content, requestId }),
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

// —— 会话设置：模型切换与收藏 ——

/** 拉取可用模型目录（全局，启动时一次；catalog 含默认模型与回落信息）。 */
async function loadModelCatalog(): Promise<void> {
	state.modelCatalog = (await fetchJson("/api/models")) as ModelCatalog;
	renderModelArea();
}

/** 拉取当前会话的设置（工作目录 + 当前模型）并刷新两个设置块。 */
async function loadSettings(id: number): Promise<void> {
	state.workspace = (await fetchJson(`/api/conversations/${id}/settings`)) as WorkspaceSettings;
	renderWorkspace();
	renderModelArea();
}

/** 模型区整体重绘：下拉、星标按钮、提示行。 */
function renderModelArea(): void {
	renderModelSelect();
	updateFavoriteButton();
	renderModelHint();
}

/** 按目录重绘下拉：收藏项置顶为「★ 收藏」组，其余按 provider 分组（optgroup），当前模型 selected。 */
function renderModelSelect(): void {
	const catalog = state.modelCatalog;
	const none = state.conversationId === undefined;
	modelSelectEl.disabled = none || catalog === undefined;
	favoriteEl.disabled = none || catalog === undefined;
	if (catalog === undefined) {
		modelSelectEl.replaceChildren(el("option", "", none ? "" : "加载中…"));
		return;
	}
	const byKey = new Map(catalog.models.map((model) => [modelKey(model), model]));
	// 收藏过滤到目录里仍存在的（本地偏好可能残留已卸载 provider 的模型）；按收藏先后排序
	const favoriteKeys = state.favorites.filter((key) => byKey.has(key));
	const nodes: HTMLOptGroupElement[] = [];
	if (favoriteKeys.length > 0) {
		const favoritesGroup = document.createElement("optgroup");
		favoritesGroup.label = "★ 收藏";
		for (const key of favoriteKeys) favoritesGroup.append(modelOption(byKey.get(key)!));
		nodes.push(favoritesGroup);
	}
	// 其余按目录顺序分组：provider 连续段一个 optgroup（目录已按装载顺序生成），跳过已收藏项
	let group: HTMLOptGroupElement | undefined;
	let lastProvider: string | undefined;
	for (const model of catalog.models) {
		if (favoriteKeys.includes(modelKey(model))) continue;
		if (group === undefined || lastProvider !== model.provider) {
			lastProvider = model.provider;
			group = document.createElement("optgroup");
			group.label = model.providerName;
			nodes.push(group);
		}
		group.append(modelOption(model));
	}
	modelSelectEl.replaceChildren(...nodes);
	selectCurrentModel();
}

/** 目录条目 → option：value 是 "provider/modelId"，文本是模型显示名。 */
function modelOption(model: ModelInfo): HTMLOptionElement {
	const option = document.createElement("option");
	option.value = modelKey(model);
	option.textContent = model.name;
	return option;
}

/** 选中当前会话的模型（浏览器对 selected 项高亮；收起状态显示的就是它）。 */
function selectCurrentModel(): void {
	const model = state.workspace?.model ?? null;
	const key = model === null ? "" : modelKey(model);
	for (const option of Array.from(modelSelectEl.options)) {
		option.selected = option.value === key;
	}
}

/** 星标按钮反映当前会话模型是否已收藏：空心☆可收藏，实心★可取消。 */
function updateFavoriteButton(): void {
	const model = state.workspace?.model;
	const isFavorite = model != null && state.favorites.includes(modelKey(model));
	favoriteEl.textContent = isFavorite ? "★" : "☆";
	favoriteEl.title = isFavorite ? "取消收藏当前模型" : "收藏当前模型";
	favoriteEl.classList.toggle("fav-on", isFavorite);
}

/** 提示行：默认模型回落提示（若有）+ 当前模型与生效时机。 */
function renderModelHint(): void {
	const lines: string[] = [];
	const fallback = state.modelCatalog?.defaultModelFallback;
	if (fallback !== undefined) {
		lines.push(`配置的默认模型 ${fallback.from} 不可用（provider 未装），已改用 ${displayNameOf(fallback.to)}。`);
	}
	const model = state.workspace?.model;
	if (model != null) lines.push(`当前模型：${displayNameOf(model)}，切换对下一条消息立即生效。`);
	modelHintEl.textContent = lines.join(" ");
}

/** 模型引用 → 展示名：目录里有则用「name（provider 显示名）」，没有则退回原始写法。 */
function displayNameOf(model: ModelRefPayload): string {
	const info = state.modelCatalog?.models.find(
		(item) => item.provider === model.provider && item.modelId === model.modelId,
	);
	return info !== undefined ? `${info.name}（${info.providerName}）` : modelKey(model);
}

/** 下拉选中即切换：PUT model 后服务端 configure({ model }) 写入 pi.agent，对下一条消息生效。 */
async function switchModel(key: string): Promise<void> {
	if (state.conversationId === undefined) return;
	const slash = key.indexOf("/");
	if (slash <= 0) return;
	const provider = key.slice(0, slash);
	const modelId = key.slice(slash + 1);
	try {
		const result = (await fetchJson(`/api/conversations/${state.conversationId}/model`, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ provider, modelId }),
		})) as { model: ModelRefPayload | null };
		if (state.workspace !== undefined) state.workspace.model = result.model;
		if (result.model !== null) {
			showBanner(`模型已切换：${displayNameOf(result.model)}，对下一条消息生效。`);
		}
	} finally {
		renderModelArea(); // 失败时也回滚显示为会话实际模型
	}
}

/** 星标：收藏/取消收藏当前会话模型，localStorage 持久化并重绘下拉（收藏组置顶）。 */
function toggleFavorite(): void {
	const model = state.workspace?.model;
	if (model == null) return;
	const key = modelKey(model);
	const wasFavorite = state.favorites.includes(key);
	state.favorites = wasFavorite ? state.favorites.filter((item) => item !== key) : [...state.favorites, key];
	saveFavorites(state.favorites);
	showBanner(wasFavorite ? `已取消收藏 ${displayNameOf(model)}` : `已收藏 ${displayNameOf(model)}，排在列表最前`);
	renderModelArea();
}

// —— 会话设置：工作目录 ——

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
	const inbox = (state.view?.docs["pi.inbox"]?.items ?? []).filter(isQueuedInput);
	const run = live?.run ?? undefined;
	const busy = run !== undefined;
	const failure = !busy ? live?.runFailure : undefined;
	const partial = live?.generation?.message;
	// partial 去重：本运行已提交回答条目（id ≥ run.first）就不再渲染 partial，避免与最终条目重复
	const runFirst = run?.first;
	const answerCommitted =
		runFirst !== undefined && entries.some((entry) => entry.kind === "pi.assistant" && entry.id >= runFirst);
	const streaming = busy && partial !== undefined && !answerCommitted;

	// 排队消息对账：发出时在运行中的消息，若已不在 pi.inbox 也未出现在 transcript，
	// 说明已随停止撤回（pi-durable abort 撤回排队输入，不留条目），横幅提示。
	reconcileQueuedSent(entries, inbox, busy);

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
	// 错误卡片（非用户停止的失败）：内嵌在失败那次运行的位置——失败运行首条目
	// （runFailure.first）之后的最后一条条目之后（失败 run 会留下一条错误回答条目，
	// 卡片跟在它后面）；窗口内找不到锚点则退回流末尾。重试内容取该运行最后一条
	// 用户消息的文本。
	let errorCard: HTMLElement | undefined;
	let errorAnchorId: number | undefined;
	if (failure !== undefined && failure.reason !== "aborted") {
		const placement = failurePlacement(entries, failure.first);
		if (placement !== undefined) {
			errorAnchorId = placement.anchorId;
			errorCard = renderErrorCard(failure, placement.retryText);
		}
	}
	const renderedCalls = new Set<string>();
	for (const entry of entries) {
		const node = renderEntry(entry, toolResults, liveSlots, renderedCalls);
		if (node !== undefined) nodes.push(node);
		if (entry.id === errorAnchorId && errorCard !== undefined) {
			nodes.push(errorCard); // 内嵌在对应提交位置
			errorCard = undefined;
		}
	}
	if (streaming && partial !== undefined) nodes.push(renderStreaming(partial));
	// 运行中的工具调用：还没落到任何条目的槽位（模型刚发起调用、assistant 条目未提交时）在这显示
	if (busy && live !== undefined) {
		for (const slot of live.tools ?? []) {
			if (slot.callId === undefined || renderedCalls.has(slot.callId)) continue;
			nodes.push(renderToolCard(slotCard(slot, partialToolCall(partial, slot.callId))));
		}
	}
	// 排队中的提交（pi.inbox）：当前运行结束后自动依次执行；真实条目（pi.user）
	// 在放置后才出现，这里只是运行态的预告。
	for (const item of inbox) nodes.push(renderQueuedBubble(item));
	if (busy && !streaming) nodes.push(el("div", "status", "Stella 正在运行…"));
	if (errorCard !== undefined) nodes.push(errorCard); // 锚点不在窗口内时的兜底：流末尾
	if (failure?.reason === "aborted") {
		nodes.push(el("div", "error-line", failureText("aborted")));
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

/** 运行结束（无回答）的提示文案（用户主动停止用：错误卡片只负责非停止的失败）。 */
function failureText(reason?: string): string {
	switch (reason) {
		case "aborted":
			return "已停止本次运行，已生成的部分已保留。";
		default:
			return failureCardText(reason, undefined);
	}
}

/** 错误卡片文案：中文原因包裹底层错误（runFailure.detail，如模型返回的错误文本）。 */
function failureCardText(reason?: string, detail?: string): string {
	let base: string;
	switch (reason) {
		case "model_error":
			base = "本次回答失败：模型请求出错";
			break;
		case "no_model":
			base = "本次回答失败：没有可用的模型";
			break;
		case "faulted":
			base = "本次回答失败：运行内部出错";
			break;
		case "interrupted":
			base = "本次回答失败：服务中断时回答未完成";
			break;
		case "restart_limit":
			base = "本次回答失败：重启后无法继续运行";
			break;
		case "orphaned":
			base = "本次回答失败：所属任务已丢失";
			break;
		case "turn_limit":
			base = "本次回答失败：工具调用轮次达到上限";
			break;
		case "nothing_to_answer":
			base = "本次没有需要回答的内容";
			break;
		default:
			base = `本次回答失败（原因：${reason ?? "未知"}）`;
	}
	const tail = detail !== undefined && detail.trim().length > 0 ? `，底层错误：${detail}` : "。";
	return base + tail;
}

// —— 排队（pi.inbox）与错误卡片 ——

/** 是否为用户输入型排队项（本端只发 input；write 型排队项不识别也不显示）。 */
function isQueuedInput(item: InboxItemView): boolean {
	return item.content !== undefined;
}

/** 排队项的用户消息文本。 */
function inboxText(item: InboxItemView): string {
	return typeof item.content === "string" ? item.content : extractTextOf(item.content ?? []);
}

/** 排队中的提交 → 「等待中」用户气泡（真实 pi.user 条目在放置后才出现，这只是预告）。 */
function renderQueuedBubble(item: InboxItemView): HTMLElement {
	const wrap = el("div", "msg user queued", inboxText(item));
	wrap.append(el("span", "queued-tag", "等待中"));
	return wrap;
}

/**
 * 排队消息对账：发送时运行中的消息记入 state.queuedSent；随 view 对账——仍在 inbox
 * 或已出现为 transcript 条目的移出记录，剩下的视为已随停止撤回，横幅提示一次。
 * pi-durable 语义：abort 撤回排队输入（inbar 清空、不留条目）；正常流程里放置与
 * 出条目同一 commit（同一份全量 view），不会误报。提示基于文本匹配，刷新后记录
 * 即丢失（仅在内存），不遮晚真实状态。
 */
function reconcileQueuedSent(entries: readonly ChatEntry[], inbox: readonly InboxItemView[], busy: boolean): void {
	if (state.queuedSent.length === 0) return;
	const placed = new Set(
		entries.filter((entry) => entry.kind === "pi.user").map((entry) => extractText(entry.model?.[0])),
	);
	const queued = new Set(inbox.map(inboxText));
	const still: string[] = [];
	const withdrawn: string[] = [];
	for (const text of state.queuedSent) {
		if (queued.has(text)) still.push(text);
		else if (!placed.has(text)) withdrawn.push(text);
	}
	state.queuedSent = still;
	if (!busy && withdrawn.length > 0) {
		const preview = withdrawn.map((text) => `「${text.length > 20 ? `${text.slice(0, 20)}…` : text}」`).join("、");
		showBanner(`已停止：排队中的 ${preview} 已撤回，未发送，可重新输入。`);
	}
}

/**
 * 失败运行的落点：runFailure.first 之后的最后一条条目 id（错误卡片锚点，一次运行可含
 * 多条输入与工具轮次，卡片挂在运行末尾）与该运行最后一条用户消息文本（重试内容）。
 * 窗口内没有任何条目时返回 undefined。
 */
function failurePlacement(
	entries: readonly ChatEntry[],
	first: number | undefined,
): { anchorId: number; retryText: string | undefined } | undefined {
	let last: ChatEntry | undefined;
	let lastUser: ChatEntry | undefined;
	for (const entry of entries) {
		if (first !== undefined && entry.id < first) continue;
		last = entry;
		if (entry.kind === "pi.user") lastUser = entry;
	}
	if (last === undefined) return undefined;
	return {
		anchorId: last.id,
		retryText: lastUser === undefined ? undefined : extractText(lastUser.model?.[0]),
	};
}

/** 错误卡片：失败原因中文文案（包裹底层错误）+ 重试按钮（以新 requestId 重发该条用户消息）。 */
function renderErrorCard(failure: NonNullable<LiveDoc["runFailure"]>, content: string | undefined): HTMLElement {
	const card = el("div", "error-card");
	card.append(el("div", "error-card-text", failureCardText(failure.reason, failure.detail)));
	const retry = el("button", "error-card-retry", "重试") as HTMLButtonElement;
	retry.type = "button";
	if (content === undefined || content.length === 0) {
		retry.disabled = true; // 找不到原消息内容（不在窗口内）：无法重试
		retry.title = "找不到原消息内容，无法重试";
	} else {
		retry.addEventListener("click", () => {
			retry.disabled = true;
			void retrySubmission(content).finally(() => {
				retry.disabled = false;
			});
		});
	}
	card.append(retry);
	return card;
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
			// 失败的回答条目（模型请求出错时 pi-durable 保留的 attempt，stopReason "error"）：
			// 以错误样式呈现底层错误，而非当作正常回答渲染部分文本。
			if (message?.stopReason === "error") {
				return el("div", "msg stella failed", message.errorMessage || "（本次回答失败）");
			}
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
	if (message === undefined) return "";
	return extractTextOf(message.content);
}

/** 消息内容（string 或内容块数组）→ 文本（拼接全部 text 块）。 */
function extractTextOf(content: string | ContentBlock[]): string {
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
modelSelectEl.addEventListener("change", () => {
	void switchModel(modelSelectEl.value).catch(showError);
});
favoriteEl.addEventListener("click", toggleFavorite);
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
