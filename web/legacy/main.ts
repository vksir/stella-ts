/**
 * Stella 聊天页（DSH Web UI 结构复刻）：AppFrame 两列外壳 + 会话侧栏 + 消息流 + 胶囊 composer。
 *
 * 与服务端的契约：
 * - 服务端权威：客户端只 POST 当前这条新消息；条目全部来自 SSE 推送的 watch view
 *   （初始 view + 每次 commit 后的新 view）。view 的 entries 只是窗口，客户端由
 *   Transcript 累加成整段转写；断线重连用 ?from=（已持有最新条目 + 1），缺口显式补页。
 * - 流式回答：docs["pi.live"].generation.message 的 partial（约 100ms 一次 commit），
 *   回答条目落定（id ≥ run.first）后 partial 让位。
 * - 工具调用：assistant 条目的 toolCall 块（id）↔ pi.tool-result 条目（toolCallId）
 *   ↔ 运行中的 pi.live.tools 槽位，渲染为 24px 折叠行（展开看参数与输出）。
 * - 排队/插话：运行中发送默认 follow-up，进 composer 上方的队列条（逐项插话/编辑/删除）；
 *   Ctrl/Cmd+Enter 用另一种投递方式；停止会撤回排队输入并 toast。
 * - 失败：runFailure 在失败运行末尾渲染错误行 + 「续跑」（POST {continue:true}），
 *   不重复用户消息。
 * - /compact [说明]：composer 指令，调用手动压缩端点，不作为消息发送。
 * - 预设：新会话选择器（>1 个时）+ composer 只读 chip；能力在创建时写入 pi.agent。
 * - 上下文/花费：composer 下方的小环 + 累计 token/成本，点开看系统/工具/消息分解。
 * - 会话设置：模型切换（PUT /model）与工作目录（PUT /settings）收进 composer 工具行
 *   （模型 chip + 工作目录 chip），与 DSH InputBar 布局一致。
 *
 * UI 行为：主题 light|dark|system（html[data-theme]）、侧栏折叠（280px ↔ 56px rail，
 * <768px 变抽屉 + 遮罩）、空会话 hero（标题 + composer 居中）、markdown 渲染
 * （markdown.ts 子集渲染器）、消息/代码块复制、toast 提示。
 */

import { renderMarkdown } from "./markdown";
import { Transcript } from "./transcript.js";

// —— 服务端数据形状（SSE view / REST 翻页） ——

interface ContentBlock {
	type: string;
	text?: string;
	name?: string;
	/** 工具调用块（pi.assistant 里）：id 关联 pi.tool-result 条目与 pi.live.tools 槽位 */
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
	docs: {
		"pi.live"?: LiveDoc;
		"pi.inbox"?: { items?: InboxItemView[] };
		"pi.usage"?: UsageDoc;
		"pi.agent"?: { model?: ModelRefPayload };
	};
}

interface EntriesPage {
	entries: ChatEntry[];
	hasMore: boolean;
}

/** pi.usage 的一次用量（pi-ai Usage 的 JSON 形状，取展示需要的字段）。 */
interface TokenUsage {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	totalTokens?: number;
	cost?: { total?: number };
}

/** view.docs["pi.usage"]：按 provider/model 与工具名累计。 */
interface UsageDoc {
	models?: Record<string, TokenUsage>;
	tools?: Record<string, TokenUsage>;
}

/** GET /api/presets 的条目。 */
interface PresetSummary {
	id: string;
	name: string;
	description?: string;
	builtin: boolean;
	default: boolean;
	extensions: string[] | null;
	tools: string[] | null;
	missing: string[];
}

interface PresetsResponse {
	presets: PresetSummary[];
	defaultPreset: string;
	defaultMaxTurns: number;
}

/** GET /api/conversations/:id/context：上下文占用。 */
interface ContextOccupancy {
	usedTokens: number;
	windowTokens: number | null;
	percent: number | null;
	breakdown: { system: number; tools: number; messages: number };
	model: ModelRefPayload | null;
	estimated: boolean;
}

interface ConversationSummary {
	id: number;
	title: string | null;
	createdAt?: number;
	preset?: string | null;
}

/** GET/PUT 会话设置的响应体：cwd 为当前生效值，defaultWorkspace 为服务端默认工作区。 */
interface WorkspaceSettings {
	cwd: string;
	defaultWorkspace: string;
	custom: boolean;
	model: ModelRefPayload | null;
	preset: string | null;
}

/** 模型引用（provider/modelId），与服务端 ModelRef 同形。 */
interface ModelRefPayload {
	provider: string;
	modelId: string;
}

/** GET /api/models 的目录条目。 */
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

/** 收集到的单个工具调用的展示状态。 */
interface ToolCard {
	name: string;
	/** 关键参数摘要（一行）。 */
	summary: string;
	/** 参数原文（JSON），展开后可看。 */
	argsText: string;
	/** 结果输出全文；undefined 表示尚未落定。 */
	output: string | undefined;
	isError: boolean;
	/** done 有结果；running/pending 运行态；lost 槽位已清且无结果（历史边缘）。 */
	status: "done" | "running" | "pending" | "lost";
}

// —— 页面状态 ——

const state = {
	conversations: [] as ConversationSummary[],
	conversationId: undefined as number | undefined,
	view: null as SseView | null,
	/** 当前会话的 SSE 连接；切换会话时先 close 旧的再重订。 */
	source: undefined as EventSource | undefined,
	workspace: undefined as WorkspaceSettings | undefined,
	/** 可用预设（启动时拉一次，配置文件热更新后重新拉）。 */
	presets: [] as PresetSummary[],
	defaultPreset: "standard",
	/** 当前会话的预设 id（只用于显示；能力在创建时已写入 pi.agent）。 */
	preset: null as string | null,
	/** 上下文占用（独立端点，按最新条目/模型去抖刷新）。 */
	context: null as ContextOccupancy | null,
	/** 当前上下文缓存键：最新条目 + 模型。 */
	contextKey: "",
	/** busy 时 Enter 的默认投递方式（queue/steer），localStorage 持久化。 */
	busyEnter: loadBusyEnter(),
	modelCatalog: undefined as ModelCatalog | undefined,
	/** 收藏的模型（"provider/modelId"，按收藏先后）；localStorage 持久化。 */
	favorites: [] as string[],
};

// —— DOM ——

const frameEl = document.getElementById("frame") as HTMLElement;
const sidebarEl = document.getElementById("sidebar") as HTMLElement;
const brandEl = document.getElementById("brand") as HTMLButtonElement;
const sidebarCollapseEl = document.getElementById("sidebar-collapse") as HTMLButtonElement;
const sidebarOpenEl = document.getElementById("sidebar-open") as HTMLButtonElement;
const menuToggleEl = document.getElementById("menu-toggle") as HTMLButtonElement;
const drawerMaskEl = document.getElementById("drawer-mask") as HTMLElement;
const newEl = document.getElementById("new-conversation") as HTMLButtonElement;
const presetPickerEl = document.getElementById("preset-picker") as HTMLElement;
const presetChipEl = document.getElementById("preset-chip") as HTMLElement;
const queueDockEl = document.getElementById("queue-dock") as HTMLElement;
const usageMeterEl = document.getElementById("usage-meter") as HTMLElement;
const listEl = document.getElementById("conversation-list") as HTMLElement;
const connEl = document.getElementById("conn") as HTMLElement;
const themeToggleEl = document.getElementById("theme-toggle") as HTMLButtonElement;
const chatHeaderEl = document.getElementById("chat-header") as HTMLElement;
const chatTitleEl = document.getElementById("chat-title") as HTMLElement;
const scrollBodyEl = document.getElementById("scroll-body") as HTMLElement;
const messagesEl = document.getElementById("messages") as HTMLElement;
const heroEl = document.getElementById("hero") as HTMLElement;
const heroStackEl = heroEl.querySelector(".hero-stack") as HTMLElement;
const composerSeatEl = document.getElementById("composer-seat") as HTMLElement;
const composerEl = document.getElementById("composer") as HTMLElement;
const inputEl = document.getElementById("input") as HTMLTextAreaElement;
const sendEl = document.getElementById("send") as HTMLButtonElement;
const stopEl = document.getElementById("stop") as HTMLButtonElement;
const workspaceChipEl = document.getElementById("workspace-chip") as HTMLButtonElement;
const workspaceLabelEl = document.getElementById("workspace-label") as HTMLElement;
const workspacePopEl = document.getElementById("workspace-pop") as HTMLElement;
const workspaceInputEl = document.getElementById("workspace-dir") as HTMLInputElement;
const workspaceHintEl = document.getElementById("workspace-hint") as HTMLElement;
const workspaceSaveEl = document.getElementById("save-workspace") as HTMLButtonElement;
const workspaceResetEl = document.getElementById("reset-workspace") as HTMLButtonElement;
const modelSelectEl = document.getElementById("model-select") as HTMLSelectElement;
const favoriteEl = document.getElementById("toggle-favorite") as HTMLButtonElement;
const confirmEl = document.getElementById("confirm") as HTMLElement;
const confirmTextEl = document.getElementById("confirm-text") as HTMLElement;
const confirmDeleteEl = document.getElementById("confirm-delete") as HTMLButtonElement;
const confirmCancelEl = document.getElementById("confirm-cancel") as HTMLButtonElement;
const bannerEl = document.getElementById("banner") as HTMLElement;

/** 当前会话的客户端转写：窗口合并、缺口标记、向前翻页（切换会话时 reset）。 */
const transcript = new Transcript<ChatEntry>({
	before: (oldestId) => fetchEntries({ before: oldestId }),
	between: (afterId, upToId) => fetchEntries({ after: afterId, upTo: upToId }),
});

// —— 图标 ——

const COPY_ICON =
	'<svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="7" y="7" width="9" height="9" rx="2" /><path d="M13 4.5A1.5 1.5 0 0 0 11.5 3h-6A2.5 2.5 0 0 0 3 5.5v6A1.5 1.5 0 0 0 4.5 13" /></svg>';
const CHECK_ICON =
	'<svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 10.5l4 4 8-8.5" /></svg>';
const STAR_ICON =
	'<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" aria-hidden="true"><path d="M12 3.6l2.5 5.1 5.6 0.8-4 4 0.9 5.6-5-2.6-5 2.6 0.9-5.6-4-4 5.6-0.8z" /></svg>';
const STAR_FILLED_ICON =
	'<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" aria-hidden="true"><path d="M12 3.6l2.5 5.1 5.6 0.8-4 4 0.9 5.6-5-2.6-5 2.6 0.9-5.6-4-4 5.6-0.8z" /></svg>';
const SPINNER_ICON =
	'<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 3a9 9 0 1 0 9 9" /></svg>';
const CHECK_CIRCLE_ICON =
	'<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M8.5 12.5l2.5 2.5 4.5-5" /></svg>';
const X_CIRCLE_ICON =
	'<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M9 9l6 6M15 9l-6 6" /></svg>';
const PENDING_ICON =
	'<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>';
const MINUS_CIRCLE_ICON =
	'<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M8.5 12h7" /></svg>';
const RUNNING_STAR_ICON =
	'<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M12 2.6l2.5 6.6 6.9 2.8-6.9 2.8L12 21.4l-2.5-6.6-6.9-2.8 6.9-2.8z" /></svg>';
const TRASH_ICON =
	'<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M10 7V5a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v2M6.5 7l1 13h9l1-13" /></svg>';

// —— 主题：light | dark | system（默认 system），localStorage 持久化 ——

type ThemePref = "light" | "dark" | "system";

const THEME_KEY = "stella-theme";

function systemPrefersDark(): boolean {
	return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function resolveTheme(pref: ThemePref): "light" | "dark" {
	if (pref === "system") return systemPrefersDark() ? "dark" : "light";
	return pref;
}

function applyTheme(pref: ThemePref): void {
	const resolved = resolveTheme(pref);
	document.documentElement.dataset.theme = resolved;
	document.documentElement.style.colorScheme = resolved;
	document
		.querySelector('meta[name="theme-color"]')
		?.setAttribute("content", resolved === "dark" ? "#151517" : "#ffffff");
	themeToggleEl.dataset.pref = pref;
	const label = pref === "light" ? "浅色" : pref === "dark" ? "深色" : "跟随系统";
	themeToggleEl.title = `主题：${label}`;
	themeToggleEl.setAttribute("aria-label", `主题：${label}，点击切换`);
}

function loadThemePref(): ThemePref {
	try {
		const raw = localStorage.getItem(THEME_KEY);
		if (raw === "light" || raw === "dark" || raw === "system") return raw;
	} catch {
		/* localStorage 不可用时跟随系统 */
	}
	return "system";
}

/** 循环切换：浅色 → 深色 → 跟随系统 → 浅色。 */
function cycleTheme(): void {
	const order: ThemePref[] = ["light", "dark", "system"];
	const current = order.indexOf(loadThemePref());
	const next = order[(current + 1) % order.length] ?? "system";
	try {
		localStorage.setItem(THEME_KEY, next);
	} catch {
		/* 存不进就仅本次生效 */
	}
	applyTheme(next);
}

applyTheme(loadThemePref());
themeToggleEl.addEventListener("click", cycleTheme);
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
	applyTheme(loadThemePref());
});

// —— 侧栏状态：桌面 280px ↔ 56px rail（localStorage 记忆）；<768px 折叠 = 抽屉关闭 ——

const SIDEBAR_KEY = "stella-sidebar-collapsed";
const DESKTOP_QUERY = window.matchMedia("(min-width: 768px)");
/** 侧栏折叠动画：切换时短暂标记 frame[data-animating]，让 grid 轨道走 300ms 曲线。 */
let animatingTimer: ReturnType<typeof setTimeout> | undefined;

function isMobileViewport(): boolean {
	return !DESKTOP_QUERY.matches;
}

function sidebarCollapsed(): boolean {
	return frameEl.dataset.sidebarCollapsed === "true";
}

function applySidebarCollapsed(collapsed: boolean, animate: boolean): void {
	if (animate) {
		frameEl.setAttribute("data-animating", "");
		if (animatingTimer !== undefined) clearTimeout(animatingTimer);
		animatingTimer = setTimeout(() => frameEl.removeAttribute("data-animating"), 320);
	}
	frameEl.dataset.sidebarCollapsed = String(collapsed);
	sidebarCollapseEl.setAttribute("aria-label", collapsed ? "展开侧栏" : "收起侧栏");
	menuToggleEl.setAttribute("aria-expanded", String(!collapsed));
	menuToggleEl.setAttribute("aria-label", collapsed ? "打开会话列表" : "关闭会话列表");
	drawerMaskEl.hidden = !(isMobileViewport() && !collapsed);
	// 桌面折叠时 header 左侧出现展开钮
	sidebarOpenEl.hidden = !(collapsed && !isMobileViewport());
}

function loadSidebarCollapsed(): boolean | undefined {
	try {
		const raw = localStorage.getItem(SIDEBAR_KEY);
		if (raw === "1") return true;
		if (raw === "0") return false;
	} catch {
		/* 忽略 */
	}
	return undefined;
}

function storeSidebarCollapsed(collapsed: boolean): void {
	try {
		localStorage.setItem(SIDEBAR_KEY, collapsed ? "1" : "0");
	} catch {
		/* 仅本次生效 */
	}
}

/** 初始状态：有记忆用记忆；否则 <768 关抽屉、<1024 折叠、桌面展开。 */
function initSidebarState(): void {
	const saved = loadSidebarCollapsed();
	const collapsed = saved ?? (isMobileViewport() || window.innerWidth < 1024);
	applySidebarCollapsed(collapsed, false);
}

/** 桌面切换（rail 按钮 / brand / header 展开钮）：持久化。 */
function toggleSidebarCollapsed(): void {
	const next = !sidebarCollapsed();
	storeSidebarCollapsed(next);
	applySidebarCollapsed(next, true);
}

sidebarCollapseEl.addEventListener("click", toggleSidebarCollapsed);
sidebarOpenEl.addEventListener("click", () => {
	storeSidebarCollapsed(false);
	applySidebarCollapsed(false, true);
});
// 移动端抽屉开合不落盘（避免影响桌面记忆态）
menuToggleEl.addEventListener("click", () => {
	applySidebarCollapsed(!sidebarCollapsed(), true);
});
drawerMaskEl.addEventListener("click", () => applySidebarCollapsed(true, true));
DESKTOP_QUERY.addEventListener("change", () => {
	const saved = loadSidebarCollapsed();
	applySidebarCollapsed(saved ?? (isMobileViewport() || window.innerWidth < 1024), false);
});

/** 品牌：展开态点击 = 新会话（DSH web 行为）；rail 态点击 = 展开。 */
brandEl.addEventListener("click", () => {
	if (sidebarCollapsed()) {
		toggleSidebarCollapsed();
		return;
	}
	void createConversation().catch(showError);
});

initSidebarState();

/** 空白态的新建会话按钮（挂在 hero stack 里，进入会话时移除）。 */
let heroNewButton: HTMLButtonElement | null = null;

// —— hero：composer 整体挪动（DSH HeroShell 与 docked InputBar 同一组件） ——

let heroMode = false;

function updateHeroMode(on: boolean): void {
	if (heroMode === on) return;
	heroMode = on;
	heroEl.hidden = !on;
	if (on) {
		heroStackEl.appendChild(composerSeatEl);
	} else {
		scrollBodyEl.appendChild(composerSeatEl);
	}
}

// —— 输入框自动长高（上限 = composer 336px 滚动帽） ——

const INPUT_MAX_HEIGHT = 336;

function autosizeInput(): void {
	inputEl.style.height = "auto";
	inputEl.style.height = `${Math.min(inputEl.scrollHeight, INPUT_MAX_HEIGHT)}px`;
}

inputEl.addEventListener("input", autosizeInput);

// —— 收藏：localStorage 持久化（排序在模型下拉最前） ——

const FAVORITES_KEY = "stella.model-favorites";

function modelKey(model: ModelRefPayload): string {
	return `${model.provider}/${model.modelId}`;
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

function saveFavorites(favorites: readonly string[]): void {
	localStorage.setItem(FAVORITES_KEY, JSON.stringify(favorites));
}

state.favorites = loadFavorites();

// —— 工作目录弹层：chip 点击开关，点外/Esc 关闭 ——

function setWorkspacePop(open: boolean): void {
	workspacePopEl.hidden = !open;
	workspaceChipEl.setAttribute("aria-expanded", String(open));
	if (open) {
		workspaceInputEl.focus();
		workspaceInputEl.select();
	}
}

workspaceChipEl.addEventListener("click", () => {
	setWorkspacePop(workspacePopEl.hidden);
});
document.addEventListener("pointerdown", (e) => {
	if (
		!workspacePopEl.hidden &&
		e.target instanceof Node &&
		!workspacePopEl.contains(e.target) &&
		!workspaceChipEl.contains(e.target)
	) {
		setWorkspacePop(false);
	}
});
document.addEventListener("keydown", (e) => {
	if (e.key === "Escape" && !workspacePopEl.hidden) setWorkspacePop(false);
});

// —— 启动：加载列表，无会话则建一个，然后订阅 ——

void boot();

async function boot(): Promise<void> {
	try {
		// 模型目录与预设是全局资源，与会话加载并行拉取；失败不阻塞聊天
		void loadModelCatalog().catch(showError);
		void loadPresets().catch(showError);
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

/** 新建会话：按侧栏选中的预设 POST，刷新列表并切换过去，输入框聚焦、空白消息流。 */
async function createConversation(): Promise<void> {
	// 配置文件热更新后，新会话要拿到最新预设；15s 内不重复拉。
	if (Date.now() - presetsLoadedAt > 15_000) await loadPresets().catch(() => undefined);
	const select = presetPickerEl.querySelector("select");
	const preset = select?.value ?? state.defaultPreset;
	const created = (await fetchJson("/api/conversations", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(preset.length > 0 ? { preset } : {}),
	})) as { id: number };
	await refreshList();
	switchTo(created.id);
	inputEl.focus();
}

/** 拉取预设列表（内置 + 配置文件），填充新会话选择器与只读 chip。 */
async function loadPresets(): Promise<void> {
	const response = (await fetchJson("/api/presets")) as PresetsResponse;
	state.presets = response.presets;
	state.defaultPreset = response.defaultPreset;
	presetsLoadedAt = Date.now();
	renderPresetPicker();
	renderPresetChip();
}

function lastPreset(): string {
	try {
		return localStorage.getItem(PRESET_KEY) ?? state.defaultPreset;
	} catch {
		return state.defaultPreset;
	}
}

/** 新会话预设选择器：只有一个预设时隐藏（标准模式无需选择）。 */
function renderPresetPicker(): void {
	if (state.presets.length <= 1) {
		presetPickerEl.hidden = true;
		presetPickerEl.replaceChildren();
		return;
	}
	presetPickerEl.hidden = false;
	const label = el("label", "preset-label", "预设");
	label.setAttribute("for", "preset-select");
	const select = document.createElement("select");
	select.id = "preset-select";
	select.className = "select preset-select";
	select.setAttribute("aria-label", "新会话预设");
	const preferred = lastPreset();
	for (const preset of state.presets) {
		const option = document.createElement("option");
		option.value = preset.id;
		option.textContent = preset.name;
		if (preset.description !== undefined) option.title = preset.description;
		if (preset.id === preferred) option.selected = true;
		select.append(option);
	}
	select.addEventListener("change", () => {
		try {
			localStorage.setItem(PRESET_KEY, select.value);
		} catch {
			// 仅本次生效
		}
	});
	presetPickerEl.replaceChildren(label, select);
}

/** composer 工具行的只读预设 chip（能力在创建时已写入 pi.agent，运行中不可换）。 */
function renderPresetChip(): void {
	if (state.conversationId === undefined || state.preset === null) {
		presetChipEl.hidden = true;
		return;
	}
	const preset = state.presets.find((item) => item.id === state.preset);
	presetChipEl.hidden = false;
	presetChipEl.textContent = preset?.name ?? state.preset;
	presetChipEl.title = preset?.description ?? `预设：${state.preset}`;
}

/** 切换会话：重置消息状态、关闭旧 EventSource 后重订 SSE，并拉取会话设置。 */
function switchTo(id: number): void {
	if (state.source !== undefined) state.source.close(); // 释放旧连接，避免多 EventSource 并存
	state.source = undefined;
	state.conversationId = id;
	state.view = null;
	transcript.reset();
	state.context = null;
	state.contextKey = "";
	state.preset = null;
	state.workspace = undefined;
	usageOpen = false;
	setWorkspacePop(false);
	renderList();
	setBusyEnabled();
	renderWorkspace();
	renderModelArea();
	subscribe(id);
	render();
	void loadSettings(id).catch(showError);
}

function subscribe(id: number): void {
	connect(id);
}

/**
 * 建立（或断线后重建）SSE 连接。重连时带上 `from`（客户端已持有的最新条目 + 1，即
 * pi-durable `ConversationTranscript.resume`）：服务端只补断线期间的新条目；窗口装不下时
 * 回落到最新窗口，中间的缺口由转写标出并补页。EventSource 的自动重连无法改 URL，
 * 所以这里主动关闭并按需重建。
 */
function connect(id: number): void {
	const newest = transcript.newest;
	const query = newest === undefined ? "" : `?from=${newest + 1}`;
	const source = new EventSource(`/api/conversations/${id}/events${query}`);
	source.addEventListener("view", (e) => {
		const view = JSON.parse((e as MessageEvent<string>).data) as SseView;
		if (view.conversation.id !== state.conversationId) return; // 旧连接的迟到事件，忽略
		state.view = view;
		transcript.merge(view); // 窗口之外的部分由转写保留；窗口不接续时记缺口
		setConn(true);
		render();
		scheduleContextRefresh(id);
	});
	source.addEventListener("ping", () => setConn(true));
	source.onerror = () => {
		setConn(false);
		if (state.source !== source) return;
		source.close();
		state.source = undefined;
		if (state.conversationId !== id) return;
		window.setTimeout(() => {
			if (state.conversationId === id && state.source === undefined) connect(id);
		}, 1000);
	};
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
			transcript.reset();
			state.context = null;
			state.contextKey = "";
			state.preset = null;
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

function send(gesture: "primary" | "alternate" = "primary"): void {
	const content = inputEl.value.trim();
	if (content.length === 0 || state.conversationId === undefined || inputEl.disabled) return;
	void submitMessage(content, gesture);
}

function newRequestId(): string {
	return crypto.randomUUID();
}

/** `/compact [说明]`：手动压缩，不作为用户消息发送。 */
function readCompactCommand(content: string): { instructions?: string } | undefined {
	const match = /^\/compact(?:\s+([\s\S]*))?$/.exec(content);
	if (match === null) return undefined;
	const instructions = match[1]?.trim();
	return instructions === undefined || instructions.length === 0 ? {} : { instructions };
}

async function submitMessage(content: string, gesture: "primary" | "alternate"): Promise<void> {
	const compact = readCompactCommand(content);
	if (compact !== undefined) {
		await runCompact(compact.instructions);
		return;
	}
	const busy = state.view?.docs["pi.live"]?.run != null;
	const whenBusy = busy ? modeForGesture(gesture) : undefined;
	await submitWithRequest(content, newRequestId(), whenBusy);
}

/** 续跑：失败后不新增用户消息，让模型接着回答停住的上下文。 */
async function retryContinue(): Promise<void> {
	sendEl.disabled = true;
	try {
		const response = await fetch(`/api/conversations/${state.conversationId}/messages`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ continue: true }),
		});
		if (!response.ok) {
			const body = (await response.json().catch(() => ({}))) as { error?: string };
			showBanner(body.error ?? `续跑失败（${response.status}）`);
		}
	} catch (error) {
		showError(error);
	} finally {
		sendEl.disabled = state.conversationId === undefined;
	}
}

async function runCompact(instructions: string | undefined): Promise<void> {
	sendEl.disabled = true;
	try {
		const response = await fetch(`/api/conversations/${state.conversationId}/compact`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(instructions === undefined ? {} : { instructions }),
		});
		if (!response.ok) {
			const body = (await response.json().catch(() => ({}))) as { error?: string };
			showBanner(body.error ?? `压缩失败（${response.status}）`);
			return;
		}
		inputEl.value = "";
		autosizeInput();
		showBanner("已提交压缩，摘要将在下一个轮次边界落位");
	} catch (error) {
		showError(error);
	} finally {
		sendEl.disabled = state.conversationId === undefined;
	}
}

async function submitWithRequest(
	content: string,
	requestId: string,
	whenBusy?: "steer" | "followUp",
	options?: { readonly clearInput?: boolean },
): Promise<boolean> {
	sendEl.disabled = true;
	try {
		const response = await fetch(`/api/conversations/${state.conversationId}/messages`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ content, requestId, ...(whenBusy === undefined ? {} : { whenBusy }) }),
		});
		if (!response.ok) {
			const body = (await response.json().catch(() => ({}))) as { error?: string };
			showBanner(body.error ?? `发送失败（${response.status}）`);
			return false;
		}
		if (options?.clearInput !== false) {
			inputEl.value = "";
			autosizeInput();
		}
		void refreshList().catch(() => undefined); // 首条消息更新了会话标题，刷新侧栏
		return true;
	} catch (error) {
		showBanner(error instanceof Error ? error.message : String(error));
		return false;
	} finally {
		sendEl.disabled = state.conversationId === undefined;
		inputEl.focus();
	}
}

// —— 会话设置：模型切换与收藏 ——

async function loadModelCatalog(): Promise<void> {
	const catalog = (await fetchJson("/api/models")) as ModelCatalog;
	state.modelCatalog = catalog;
	if (catalog.defaultModelFallback !== undefined) {
		const fallback = catalog.defaultModelFallback;
		showBanner(
			`配置的默认模型 ${fallback.from} 不可用（provider 未装），已改用 ${displayNameOf(fallback.to)}。`,
		);
	}
	renderModelArea();
}

async function loadSettings(id: number): Promise<void> {
	const settings = (await fetchJson(`/api/conversations/${id}/settings`)) as WorkspaceSettings;
	if (state.conversationId !== id) return; // 切换会话后的迟到响应
	state.workspace = settings;
	state.preset = settings.preset ?? null;
	renderPresetChip();
	renderWorkspace();
	renderModelArea();
}

function renderModelArea(): void {
	renderModelSelect();
	updateFavoriteButton();
}

/** 按目录重绘下拉：收藏置顶「★ 收藏」组，其余按 provider 分组，当前模型 selected。 */
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
	const favoriteKeys = state.favorites.filter((key) => byKey.has(key));
	const nodes: HTMLOptGroupElement[] = [];
	if (favoriteKeys.length > 0) {
		const favoritesGroup = document.createElement("optgroup");
		favoritesGroup.label = "★ 收藏";
		for (const key of favoriteKeys) favoritesGroup.append(modelOption(byKey.get(key)!));
		nodes.push(favoritesGroup);
	}
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

function modelOption(model: ModelInfo): HTMLOptionElement {
	const option = document.createElement("option");
	option.value = modelKey(model);
	option.textContent = model.name;
	return option;
}

function selectCurrentModel(): void {
	const model = state.workspace?.model ?? null;
	const key = model === null ? "" : modelKey(model);
	for (const option of Array.from(modelSelectEl.options)) {
		option.selected = option.value === key;
	}
}

/** 星标按钮反映当前会话模型是否已收藏。 */
function updateFavoriteButton(): void {
	const model = state.workspace?.model;
	const isFavorite = model != null && state.favorites.includes(modelKey(model));
	favoriteEl.innerHTML = isFavorite ? STAR_FILLED_ICON : STAR_ICON;
	favoriteEl.title = isFavorite ? "取消收藏当前模型" : "收藏当前模型";
	favoriteEl.setAttribute(
		"aria-label",
		isFavorite ? "取消收藏当前模型" : "收藏当前模型",
	);
	favoriteEl.classList.toggle("fav-on", isFavorite);
}

function displayNameOf(model: ModelRefPayload): string {
	const info = state.modelCatalog?.models.find(
		(item) => item.provider === model.provider && item.modelId === model.modelId,
	);
	return info !== undefined ? `${info.name}（${info.providerName}）` : modelKey(model);
}

/** 下拉选中即切换：PUT model 后服务端写入 pi.agent，对下一条消息生效。 */
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

function toggleFavorite(): void {
	const model = state.workspace?.model;
	if (model == null) return;
	const key = modelKey(model);
	const wasFavorite = state.favorites.includes(key);
	state.favorites = wasFavorite
		? state.favorites.filter((item) => item !== key)
		: [...state.favorites, key];
	saveFavorites(state.favorites);
	showBanner(wasFavorite ? `已取消收藏 ${displayNameOf(model)}` : `已收藏 ${displayNameOf(model)}，排在列表最前`);
	renderModelArea();
}

// —— 会话设置：工作目录 ——

/** 工作目录 chip：显示 cwd 的末段路径；未设置时占位。 */
function renderWorkspace(): void {
	const settings = state.workspace;
	const none = state.conversationId === undefined;
	workspaceChipEl.disabled = none || settings === undefined;
	workspaceSaveEl.disabled = none || settings === undefined;
	workspaceResetEl.disabled = none || settings === undefined;
	if (settings === undefined) {
		workspaceLabelEl.textContent = "工作目录";
		workspaceInputEl.value = "";
		workspaceHintEl.textContent = none ? "" : "加载中…";
		return;
	}
	if (workspaceInputEl.value !== settings.cwd) workspaceInputEl.value = settings.cwd;
	const segments = settings.cwd.split(/[\\/]/).filter((part) => part.length > 0);
	workspaceLabelEl.textContent = segments[segments.length - 1] ?? settings.cwd;
	workspaceChipEl.title = settings.cwd;
	workspaceHintEl.textContent = settings.custom
		? "已自定义（后续工具调用立即生效）"
		: "默认工作区（服务端 data/workspace）";
}

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
		setWorkspacePop(false);
	} catch (error) {
		// 校验失败（服务端中文提示）留在弹层内展示
		workspaceHintEl.textContent = error instanceof Error ? error.message : String(error);
	} finally {
		renderWorkspace();
	}
}

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
		setWorkspacePop(false);
	} finally {
		renderWorkspace();
	}
}

// —— 渲染 ——

function render(): void {
	// 渲染数据源是客户端转写（窗口 + 已翻页 + 缺口标记），不是单个 view 的窗口
	const items = transcript.items;
	const entries = items.flatMap((item) => (item.kind === "entry" ? [item.entry] : []));
	const live = state.view?.docs["pi.live"];
	const inbox = (state.view?.docs["pi.inbox"]?.items ?? []).filter(isQueuedInput);
	const run = live?.run ?? undefined;
	const busy = run !== undefined;
	const failure = !busy ? live?.runFailure : undefined;
	const partial = live?.generation?.message;
	// partial 去重：本运行已提交回答条目（id ≥ run.first）就不再渲染 partial
	const runFirst = run?.first;
	const answerCommitted =
		runFirst !== undefined &&
		entries.some((entry) => entry.kind === "pi.assistant" && entry.id >= runFirst);
	const streaming = busy && partial !== undefined && !answerCommitted;

	const column = document.createElement("div");
	column.className = "column";

	if (state.conversationId === undefined) {
		// 空白态：没有会话（全部被删除）—— 复用 hero 容器（标题 + 新建按钮 + composer 居中）
		if (heroNewButton === null) {
			heroNewButton = el("button", "btn btn-md btn-primary", "新建会话") as HTMLButtonElement;
			heroNewButton.type = "button";
			heroNewButton.classList.add("hero-new");
			heroNewButton.addEventListener("click", () => void createConversation().catch(showError));
		}
		heroStackEl.insertBefore(heroNewButton, composerSeatEl);
		updateHeroMode(true);
		renderChatTitle();
		stopEl.hidden = true;
		return;
	}
	// 有会话：移除空白态的新建按钮
	heroNewButton?.remove();

	// 工具调用数据源：结果条目与运行态槽位按 callId 关联
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

	// 错误卡片（非用户停止的失败）：内嵌在失败运行末尾（runFailure.first 之后的最后一条之后）
	let errorCard: HTMLElement | undefined;
	let errorAnchorId: number | undefined;
	if (failure !== undefined && failure.reason !== "aborted") {
		const anchorId = failurePlacement(entries, failure.first);
		if (anchorId !== undefined) {
			errorAnchorId = anchorId;
			errorCard = renderErrorCard(failure);
		}
	}

	const renderedCalls = new Set<string>();
	const flowNodes: HTMLElement[] = [];
	for (const item of items) {
		if (item.kind === "gap") {
			flowNodes.push(renderGap(item.after, item.upTo)); // 断线或窗口跳跃造成的缺失段
			continue;
		}
		const entry = item.entry;
		const node = renderEntry(entry, toolResults, liveSlots, renderedCalls);
		if (node !== undefined) {
			flowNodes.push(node);
			if (entry.id === errorAnchorId && errorCard !== undefined) {
				flowNodes.push(errorCard); // 内嵌在对应提交位置
				errorCard = undefined;
			}
		}
	}
	if (streaming && partial !== undefined) flowNodes.push(renderStreaming(partial));
	// 运行中的工具调用：还没落到任何条目的槽位在这显示
	if (busy && live !== undefined) {
		for (const slot of live.tools ?? []) {
			if (slot.callId === undefined || renderedCalls.has(slot.callId)) continue;
			flowNodes.push(wrapFlow(renderToolRow(slotCard(slot, partialToolCall(partial, slot.callId)))));
		}
	}
	if (busy) flowNodes.push(renderRunning());
	if (errorCard !== undefined) flowNodes.push(errorCard); // 锚点不在窗口内时的兜底：流末尾
	if (failure?.reason === "aborted") flowNodes.push(renderStoppedLine());

	// 操作行 hover 显现：最新一条用户消息与最新一条回答常显
	markReveal(flowNodes);
	column.append(...flowNodes);

	if (canLoadEarlier()) {
		const wrap = document.createElement("div");
		wrap.className = "load-earlier";
		const button = el("button", "", "加载更早") as HTMLButtonElement;
		button.type = "button";
		button.addEventListener("click", () => void loadEarlier());
		wrap.append(button);
		column.prepend(wrap);
	}

	renderQueueDock(inbox);
	renderSendLabel(busy);
	renderUsageMeter();

	stopEl.hidden = !busy;

	// 空会话 hero：有会话但无任何内容时，标题 + composer 居中
	updateHeroMode(
		state.conversationId !== undefined &&
			!busy &&
			entries.length === 0 &&
			inbox.length === 0 &&
			failure === undefined,
	);
	renderChatTitle();
	renderPresetChip();

	const scroller = scrollBodyEl;
	const nearBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 120;
	messagesEl.replaceChildren(column);
	if (nearBottom) scroller.scrollTop = scroller.scrollHeight;
}

/** 最新一条用户行与最新一条回答行的操作行常显，其余 hover 显现（DSH actions reveal）。 */
function markReveal(nodes: readonly HTMLElement[]): void {
	let lastUser = -1;
	let lastResponse = -1;
	for (const [index, node] of nodes.entries()) {
		if (node.classList.contains("msg-user")) lastUser = index;
		if (node.classList.contains("msg-stella")) lastResponse = index;
	}
	for (const [index, node] of nodes.entries()) {
		const hasActions = node.querySelector(".msg-actions") !== null;
		if (hasActions && index !== lastUser && index !== lastResponse) {
			node.dataset.reveal = "hover";
		}
	}
}

/** 侧栏：会话列表（标题 + 时间 + hover 删除钮），当前会话高亮。 */
function renderList(): void {
	const nodes: Node[] = [];
	for (const conversation of state.conversations) {
		const item = document.createElement("li");
		item.className = `session-row${conversation.id === state.conversationId ? " selected" : ""}`;
		const main = document.createElement("button");
		main.type = "button";
		main.className = "session-main";
		const title = el("span", "session-title", conversation.title ?? "新对话");
		const time = el("span", "session-time", formatTime(conversation.createdAt));
		main.append(title, time);
		main.addEventListener("click", () => {
			if (conversation.id !== state.conversationId) switchTo(conversation.id);
			if (isMobileViewport()) applySidebarCollapsed(true, true); // 抽屉中选中后收回
		});
		const remove = document.createElement("button");
		remove.type = "button";
		remove.className = "session-delete";
		remove.title = "删除会话";
		remove.setAttribute("aria-label", `删除会话：${conversation.title ?? "新对话"}`);
		remove.innerHTML = TRASH_ICON;
		remove.addEventListener("click", () => confirmDelete(conversation));
		item.append(main, remove);
		nodes.push(item);
	}
	listEl.replaceChildren(...nodes);
	renderChatTitle(); // 首条消息更新了会话标题，头部标题随之刷新
}

/** 聊天区头部：当前会话标题（DSH crumb-current）；空白态隐藏整条 header。 */
function renderChatTitle(): void {
	const conv = state.conversations.find((c) => c.id === state.conversationId);
	chatTitleEl.textContent = conv?.title ?? "新对话";
	chatHeaderEl.hidden = state.conversationId === undefined;
}

/** 无会话时禁用输入与发送（空白态不接收消息）。 */
function setBusyEnabled(): void {
	const none = state.conversationId === undefined;
	inputEl.disabled = none;
	sendEl.disabled = none;
	if (none) {
		inputEl.value = "";
		autosizeInput();
		inputEl.placeholder = "先新建一个会话…";
	} else {
		inputEl.placeholder = "给 Stella 发消息…（Enter 发送，Shift+Enter 换行）";
	}
}

/** 删除确认弹层。 */
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

/** 运行结束（用户主动停止）的一行说明。 */
function failureText(reason?: string): string {
	if (reason === "aborted") return "已停止本次运行，已生成的部分已保留。";
	return failureCardText(reason, undefined);
}

/** 错误文案：中文原因包裹底层错误（runFailure.detail）。 */
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

// —— 排队（pi.inbox） ——

/** 是否为用户输入型排队项（write 型排队项不识别也不显示）。 */
function isQueuedInput(item: InboxItemView): boolean {
	return item.content !== undefined;
}

function inboxText(item: InboxItemView): string {
	return typeof item.content === "string" ? item.content : extractTextOf(item.content ?? []);
}

const BUSY_ENTER_KEY = "stella-busy-enter";
const PRESET_KEY = "stella-preset";
let presetsLoadedAt = 0;

/** busy 时 Enter 的默认投递方式；Ctrl/Cmd+Enter 用另一种。 */
function loadBusyEnter(): "queue" | "steer" {
	try {
		return localStorage.getItem(BUSY_ENTER_KEY) === "steer" ? "steer" : "queue";
	} catch {
		return "queue";
	}
}

function setBusyEnter(value: "queue" | "steer"): void {
	state.busyEnter = value;
	try {
		localStorage.setItem(BUSY_ENTER_KEY, value);
	} catch {
		// 仅本次生效
	}
}

/** 主手势（Enter / 发送按钮）与替代手势（Ctrl/Cmd+Enter）在 busy 时的投递方式。 */
function modeForGesture(gesture: "primary" | "alternate"): "steer" | "followUp" {
	const preferred = state.busyEnter === "steer";
	const steer = gesture === "primary" ? preferred : !preferred;
	return steer ? "steer" : "followUp";
}

/** 发送按钮的可读标签：busy 时跟随默认投递方式。 */
function renderSendLabel(busy: boolean): void {
	const label = !busy ? "发送" : state.busyEnter === "steer" ? "插话发送" : "排队发送";
	sendEl.title = busy ? `${label}（Ctrl/Cmd+Enter 用另一种）` : label;
	sendEl.setAttribute("aria-label", label);
}

/** 队列条（DSH QueueDock）：运行中排队的提交，逐项 插话/编辑/删除。 */
function renderQueueDock(inbox: readonly InboxItemView[]): void {
	if (inbox.length === 0) {
		queueDockEl.hidden = true;
		queueDockEl.replaceChildren();
		return;
	}
	queueDockEl.hidden = false;
	const head = document.createElement("div");
	head.className = "queue-head";
	head.append(el("span", "queue-count", `${inbox.length} 条排队消息`));
	const toggle = el(
		"button",
		"queue-setting",
		state.busyEnter === "queue" ? "Enter：排队" : "Enter：插话",
	) as HTMLButtonElement;
	toggle.type = "button";
	toggle.title = "运行中按 Enter 的投递方式；Ctrl/Cmd+Enter 用另一种";
	toggle.addEventListener("click", () => {
		setBusyEnter(state.busyEnter === "queue" ? "steer" : "queue");
		render();
	});
	head.append(toggle);

	const rows = document.createElement("div");
	rows.className = "queue-rows";
	for (const item of inbox) rows.append(renderQueueRow(item));
	queueDockEl.replaceChildren(head, rows);
}

function renderQueueRow(item: InboxItemView): HTMLElement {
	const row = document.createElement("div");
	row.className = "queue-row";
	row.dataset.id = String(item.id);
	const tag = el("span", `queue-tag${item.mode === "steer" ? " is-steer" : ""}`, item.mode === "steer" ? "插话" : "排队");
	const text = el("span", "queue-text", inboxText(item));
	const actions = document.createElement("div");
	actions.className = "queue-actions";
	if (item.mode !== "steer") actions.append(queueAction("插话", () => void promoteQueued(item)));
	actions.append(queueAction("编辑", () => editQueued(row, item)));
	actions.append(queueAction("删除", () => void withdrawQueued(item)));
	row.append(tag, text, actions);
	return row;
}

function queueAction(label: string, onClick: () => void): HTMLButtonElement {
	const button = el("button", "queue-action", label) as HTMLButtonElement;
	button.type = "button";
	button.addEventListener("click", onClick);
	return button;
}

/** 撤回一条排队提交；返回服务端结果（aborted / already_placed / settled）。 */
async function deleteSubmission(id: number): Promise<string> {
	if (state.conversationId === undefined) return "failed";
	const response = await fetch(`/api/conversations/${state.conversationId}/submissions/${id}`, {
		method: "DELETE",
	});
	if (!response.ok) {
		const body = (await response.json().catch(() => ({}))) as { error?: string };
		showBanner(body.error ?? `撤回失败（${response.status}）`);
		return "failed";
	}
	return ((await response.json()) as { result: string }).result;
}

function explainWithdrawFailure(result: string): void {
	if (result === "already_placed") showBanner("这条消息已经开始执行，无法撤回");
	else if (result === "settled") showBanner("这条消息已经结束，无法撤回");
}

async function withdrawQueued(item: InboxItemView): Promise<void> {
	const result = await deleteSubmission(item.id);
	if (result === "aborted") {
		showBanner("已撤回排队消息");
		render();
	} else {
		explainWithdrawFailure(result);
	}
}

/** 把已排队的 followUp 提升为插话：pi-durable 没有原地改 mode 的 API，只能撤回后以 steer 重发。 */
async function promoteQueued(item: InboxItemView): Promise<void> {
	const result = await deleteSubmission(item.id);
	if (result !== "aborted") {
		explainWithdrawFailure(result);
		return;
	}
	const ok = await submitWithRequest(inboxText(item), newRequestId(), "steer", { clearInput: false });
	if (ok) showBanner("已改为插话发送");
}

/** 编辑排队消息：撤回后以原投递方式重发；同样受“已放置则放弃”约束。 */
function editQueued(row: HTMLElement, item: InboxItemView): void {
	const editor = document.createElement("textarea");
	editor.className = "queue-editor";
	editor.value = inboxText(item);
	editor.rows = 2;
	const actions = document.createElement("div");
	actions.className = "queue-actions";
	const save = queueAction("保存", () => {
		const text = editor.value.trim();
		if (text.length === 0) return;
		void (async () => {
			const result = await deleteSubmission(item.id);
			if (result !== "aborted") {
				explainWithdrawFailure(result);
				render();
				return;
			}
			await submitWithRequest(text, newRequestId(), item.mode === "steer" ? "steer" : undefined, {
				clearInput: false,
			});
		})();
	});
	const cancel = queueAction("取消", () => render());
	actions.append(save, cancel);
	row.replaceChildren(editor, actions);
	editor.focus();
	editor.select();
}

/**
 * 失败运行的落点：runFailure.first 之后的最后一条条目 id（错误卡片锚点）。
 * 窗口内没有任何条目时返回 undefined。
 */
function failurePlacement(entries: readonly ChatEntry[], first: number | undefined): number | undefined {
	let last: ChatEntry | undefined;
	for (const entry of entries) {
		if (first !== undefined && entry.id < first) continue;
		last = entry;
	}
	return last?.id;
}

/** 错误卡片（DSH turnErrorRow：点列 + 600 标题 + 说明 + 重试 pill）。 */
function renderErrorCard(failure: NonNullable<LiveDoc["runFailure"]>): HTMLElement {
	const card = document.createElement("div");
	card.className = "flow-item turn-error";
	card.append(el("span", "error-dot"));
	const copy = document.createElement("div");
	copy.className = "turn-error-copy";
	const title = el("span", "turn-error-title", failureCardText(failure.reason, undefined));
	copy.append(title);
	if (failure.detail !== undefined && failure.detail.trim().length > 0) {
		copy.append(el("span", "turn-error-message", failure.detail));
	}
	const retry = el("button", "error-retry", "续跑") as HTMLButtonElement;
	retry.type = "button";
	retry.title = "让模型接着回答停住的上下文，不重复用户消息";
	retry.addEventListener("click", () => {
		retry.disabled = true;
		void retryContinue().finally(() => {
			retry.disabled = false;
		});
	});
	card.append(copy, retry);
	return card;
}

/** 用户主动停止后的说明行（DSH .stopped：quiet inline tag）。 */
function renderStoppedLine(): HTMLElement {
	const line = el("div", "flow-item stopped-line", failureText("aborted"));
	return line;
}

/** 进行中的回答：流式 partial 以 markdown 呈现（运行状态行由 render() 统一追加）。 */
function renderStreaming(message: ModelMessage): HTMLElement {
	const itemEl = document.createElement("div");
	itemEl.className = "flow-item msg-stella";
	const text = extractText(message);
	if (text.length > 0) itemEl.append(renderMarkdown(text));
	return itemEl;
}

/** 运行状态行（DSH .running：0.5px 分隔线 + 星标 + shimmer 文字）。 */
function renderRunning(): HTMLElement {
	const row = document.createElement("div");
	row.className = "running";
	const divider = document.createElement("span");
	divider.className = "running-divider";
	const content = document.createElement("span");
	content.className = "running-content";
	const icon = document.createElement("span");
	icon.className = "running-icon";
	icon.innerHTML = RUNNING_STAR_ICON;
	const text = el("span", "running-text", "Stella 正在运行…");
	content.append(icon, text);
	row.append(divider, content);
	return row;
}

/** 条目按类型渲染：用户消息、assistant 回答（markdown + 工具折叠行）；tool-result 并入。 */
function renderEntry(
	entry: ChatEntry,
	toolResults: ReadonlyMap<string, ToolResultMessage>,
	liveSlots: ReadonlyMap<string, LiveToolSlot>,
	renderedCalls: Set<string>,
): HTMLElement | undefined {
	switch (entry.kind) {
		case "pi.user": {
			const text = extractText(entry.model?.[0]);
			const itemEl = document.createElement("div");
			itemEl.className = "flow-item msg-user";
			const stack = document.createElement("div");
			stack.className = "bubble-stack";
			stack.append(el("div", "bubble", text));
			itemEl.append(stack);
			const actions = copyActions(text);
			if (actions !== undefined) itemEl.append(actions);
			return itemEl;
		}
		case "pi.assistant": {
			const message = entry.model?.[0];
			// 失败的回答条目（pi-durable 保留的错误 attempt）：错误行呈现底层错误
			if (message?.stopReason === "error") {
				const itemEl = document.createElement("div");
				itemEl.className = "flow-item turn-error";
				itemEl.append(el("span", "error-dot"));
				const copy = document.createElement("div");
				copy.className = "turn-error-copy";
				copy.append(el("span", "turn-error-title", "本次回答失败"));
				copy.append(
					el("span", "turn-error-message", message.errorMessage || "（模型请求出错）"),
				);
				itemEl.append(copy);
				return itemEl;
			}
			const itemEl = document.createElement("div");
			itemEl.className = "flow-item msg-stella";
			itemEl.dataset.part = "response";
			const text = extractText(message);
			if (text.length > 0) itemEl.append(renderMarkdown(text));
			const blocks = Array.isArray(message?.content) ? message.content : [];
			let hasToolCall = false;
			for (const block of blocks) {
				if (block.type !== "toolCall" || block.id === undefined) continue;
				hasToolCall = true;
				renderedCalls.add(block.id);
				itemEl.append(renderToolRow(callCard(block, toolResults.get(block.id), liveSlots.get(block.id))));
			}
			if (text.length === 0 && !hasToolCall) {
				itemEl.append(el("span", "flow-placeholder", "（无文本内容）"));
			}
			const actions = copyActions(text);
			if (actions !== undefined) itemEl.append(actions);
			return itemEl;
		}
		default: {
			// pi.system 是提示词/工具变化的位置记录：静默跳过；
			// pi.tool-result 已并入工具折叠行：跳过；
			// 其余（pi.reset / pi.compaction / 自定义类型）→ 占位行
			if (entry.kind === "pi.system" || entry.kind === "pi.tool-result") return undefined;
			const itemEl = el("div", "flow-item flow-placeholder", `（${entry.kind}）`);
			return itemEl;
		}
	}
}

/** 消息操作行（DSH MessageIconActions）：复制钮，空文本不包装。 */
function copyActions(text: string): HTMLElement | undefined {
	if (text.length === 0) return undefined;
	const row = document.createElement("div");
	row.className = "msg-actions";
	const copy = document.createElement("button");
	copy.type = "button";
	copy.className = "action";
	copy.title = "复制";
	copy.setAttribute("aria-label", "复制消息");
	copy.innerHTML = COPY_ICON;
	copy.addEventListener("click", () => {
		void navigator.clipboard
			.writeText(text)
			.then(() => {
				copy.innerHTML = CHECK_ICON;
				copy.title = "已复制";
				return new Promise((resolve) => setTimeout(resolve, 1500));
			})
			.then(() => {
				copy.innerHTML = COPY_ICON;
				copy.title = "复制";
			})
			.catch(() => showBanner("复制失败：浏览器未授权剪贴板访问。"));
	});
	row.append(copy);
	return row;
}

// —— 工具调用折叠行 ——

/** assistant 条目里的一个工具调用块 → 卡片状态。 */
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

/** 工具折叠行（DSH DisclosureRow/ToolRow 节奏：16 图标槽 + 13px 标题 + 点分隔 + 摘要）。 */
function renderToolRow(card: ToolCard): HTMLElement {
	const details = document.createElement("details");
	details.className = "tool-row";
	const summary = document.createElement("summary");
	summary.className = "tool-head";
	const leading = document.createElement("span");
	leading.className = "tool-leading";
	leading.innerHTML =
		toolIcon(card) +
		`<span class="tool-disclosure"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6" /></svg></span>`;
	const title = el("span", "tool-title", card.name);
	const sep = document.createElement("span");
	sep.className = "tool-sep";
	const summaryText = el("span", `tool-summary${card.isError ? " error" : ""}`, toolSummary(card));
	summary.append(leading, title, sep, summaryText);
	const bodyWrap = document.createElement("div");
	bodyWrap.className = "tool-body-wrap";
	const body = document.createElement("div");
	body.className = "tool-body";
	const section = el("div", "tool-section", "参数");
	const argsPre = document.createElement("pre");
	argsPre.textContent = card.argsText || "（无）";
	body.append(section, argsPre);
	if (card.output !== undefined && card.output.length > 0) {
		const outSection = el("div", "tool-section", card.isError ? "错误输出" : "输出");
		const outPre = document.createElement("pre");
		if (card.isError) outPre.className = "is-error";
		outPre.textContent = card.output;
		body.append(outSection, outPre);
	} else if (card.status === "running" || card.status === "pending") {
		const outSection = el("div", "tool-section", "输出");
		const outPre = document.createElement("pre");
		outPre.textContent = "（等待输出…）";
		body.append(outSection, outPre);
	}
	bodyWrap.append(body);
	details.append(summary, bodyWrap);
	return details;
}

/** 状态图标（spinner/勾/叉/时钟/减号）与颜色类。 */
function toolIcon(card: ToolCard): string {
	switch (card.status) {
		case "running":
			return wrapIconClass(SPINNER_ICON, "tool-icon-running");
		case "pending":
			return wrapIconClass(PENDING_ICON, "tool-icon-pending");
		case "done":
			return card.isError
				? wrapIconClass(X_CIRCLE_ICON, "tool-icon-error")
				: wrapIconClass(CHECK_CIRCLE_ICON, "tool-icon-done");
		default:
			return wrapIconClass(MINUS_CIRCLE_ICON, "tool-icon-pending");
	}
}

function wrapIconClass(icon: string, className: string): string {
	return `<span class="${className}">${icon}</span>`;
}

/** 收起态摘要：完成显示参数摘要；运行态附加状态词。 */
function toolSummary(card: ToolCard): string {
	const stateSuffix =
		card.status === "running"
			? " · 运行中"
		: card.status === "pending"
			? " · 排队中"
			: card.status === "done" && card.isError
				? " · 失败"
				: "";
	return `${card.summary}${stateSuffix}`;
}

/** 工具调用的关键参数摘要（一行，过长截断）。 */
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

function wrapFlow(node: HTMLElement): HTMLElement {
	const itemEl = document.createElement("div");
	itemEl.className = "flow-item";
	itemEl.append(node);
	return itemEl;
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

/** 是否还有更早的历史：由转写按翻页返回的 hasMore 维护，不按条目 ID 推算（ID 有空洞）。 */
function canLoadEarlier(): boolean {
	return transcript.hasEarlier;
}

/** 向前翻页：取最早一条之前的一页，插入转写头部。 */
async function loadEarlier(): Promise<void> {
	if (state.conversationId === undefined) return;
	try {
		if (await transcript.loadEarlier()) render();
	} catch (error) {
		showError(error);
	}
}

/** 补一段缺口（断线重连后窗口不再接续已见条目）：从 after 向 upTo 取一页。 */
function renderGap(after: number, upTo: number): HTMLElement {
	const wrap = document.createElement("div");
	wrap.className = "load-earlier";
	const button = el("button", "", "加载缺失的消息") as HTMLButtonElement;
	button.type = "button";
	button.title = "断线期间的消息未到达，点击补齐";
	button.addEventListener("click", async () => {
		button.disabled = true;
		try {
			await transcript.fillGap(after, upTo);
			render();
		} catch (error) {
			showError(error);
			button.disabled = false;
		}
	});
	wrap.append(button);
	return wrap;
}

/** 条目翻页：`before` 取更早，`after` + `upTo` 取缺口内的一页（服务端返回升序 + hasMore）。 */
async function fetchEntries(query: { before?: number; after?: number; upTo?: number }): Promise<EntriesPage> {
	const params = new URLSearchParams();
	if (query.before !== undefined) params.set("before", String(query.before));
	if (query.after !== undefined) params.set("after", String(query.after));
	if (query.upTo !== undefined) params.set("upTo", String(query.upTo));
	return (await fetchJson(`/api/conversations/${state.conversationId}/entries?${params.toString()}`)) as EntriesPage;
}

// —— 上下文占用 + 累计花费（DSH ContextMeter） ——

let contextTimer: number | undefined;
let usageOpen = false;

/** 会话条目/模型变化后去抖刷新上下文占用；流式 partial 不触发。 */
function scheduleContextRefresh(id: number): void {
	if (contextTimer !== undefined) window.clearTimeout(contextTimer);
	contextTimer = window.setTimeout(() => {
		contextTimer = undefined;
		if (state.conversationId !== id) return;
		const newest = transcript.newest ?? 0;
		const model = state.view?.docs["pi.agent"]?.model;
		const key = `${newest}:${model?.provider ?? ""}/${model?.modelId ?? ""}`;
		if (key === state.contextKey) return;
		state.contextKey = key;
		fetchJson(`/api/conversations/${id}/context`)
			.then((value) => {
				if (state.conversationId !== id) return;
				state.context = value as ContextOccupancy;
				renderUsageMeter();
			})
			.catch(() => {
				// 上下文占用失败不打扰聊天（旧值继续显示）
			});
	}, 250);
}

function summarizeUsage(doc: UsageDoc | undefined): { tokens: number; cost: number } {
	let tokens = 0;
	let cost = 0;
	for (const bucket of [doc?.models, doc?.tools]) {
		for (const usage of Object.values(bucket ?? {})) {
			tokens += usage.totalTokens ?? (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0);
			cost += usage.cost?.total ?? 0;
		}
	}
	return { tokens, cost };
}

function formatTokens(value: number): string {
	if (value < 1_000) return String(Math.round(value));
	if (value < 1_000_000) return `${(value / 1_000).toFixed(1)}K`;
	return `${(value / 1_000_000).toFixed(2)}M`;
}

function formatCost(value: number): string {
	if (value <= 0) return "$0";
	if (value < 0.0001) return "<$0.0001";
	if (value < 1) return `$${value.toFixed(4)}`;
	return `$${value.toFixed(2)}`;
}

function contextRing(percent: number | null): SVGSVGElement {
	const ns = "http://www.w3.org/2000/svg";
	const svg = document.createElementNS(ns, "svg");
	svg.setAttribute("viewBox", "0 0 14 14");
	svg.setAttribute("width", "14");
	svg.setAttribute("height", "14");
	svg.setAttribute("aria-hidden", "true");
	const radius = 5.5;
	const circumference = 2 * Math.PI * radius;
	const track = document.createElementNS(ns, "circle");
	track.setAttribute("cx", "7");
	track.setAttribute("cy", "7");
	track.setAttribute("r", String(radius));
	track.setAttribute("fill", "none");
	track.setAttribute("stroke", "var(--border-l3)");
	track.setAttribute("stroke-width", "2");
	svg.append(track);
	if (percent !== null && percent > 0) {
		const fill = document.createElementNS(ns, "circle");
		fill.setAttribute("cx", "7");
		fill.setAttribute("cy", "7");
		fill.setAttribute("r", String(radius));
		fill.setAttribute("fill", "none");
		fill.setAttribute("stroke", "var(--brand-primary)");
		fill.setAttribute("stroke-width", "2");
		fill.setAttribute("stroke-linecap", "round");
		fill.setAttribute("stroke-dasharray", `${(circumference * Math.min(100, percent)) / 100} ${circumference}`);
		fill.setAttribute("transform", "rotate(-90 7 7)");
		svg.append(fill);
	}
	return svg;
}

/** composer 下方的一行：上下文环 + 百分比 + 累计 token/成本；点开看分解。 */
function renderUsageMeter(): void {
	if (state.conversationId === undefined) {
		usageMeterEl.hidden = true;
		usageMeterEl.replaceChildren();
		return;
	}
	const usageDoc = state.view?.docs["pi.usage"];
	const usage = summarizeUsage(usageDoc);
	const context = state.context;
	if (usage.tokens <= 0 && context === null) {
		usageMeterEl.hidden = true;
		usageMeterEl.replaceChildren();
		return;
	}
	usageMeterEl.hidden = false;

	const trigger = document.createElement("button");
	trigger.type = "button";
	trigger.className = "usage-trigger";
	trigger.setAttribute("aria-expanded", String(usageOpen));
	const percent = context?.percent ?? null;
	const percentText = percent === null ? "—" : `${Math.round(percent)}%`;
	trigger.title = `上下文已用 ${percentText}${context?.estimated === true ? "（按字符估算）" : ""}`;
	trigger.append(contextRing(percent), el("span", "usage-percent", percentText));
	if (usage.tokens > 0) {
		trigger.append(el("span", "usage-sep", "·"), el("span", "usage-tokens", formatTokens(usage.tokens)));
	}
	if (usage.cost > 0) trigger.append(el("span", "usage-sep", "·"), el("span", "usage-cost", formatCost(usage.cost)));
	trigger.addEventListener("click", () => {
		usageOpen = !usageOpen;
		renderUsageMeter();
	});

	const nodes: Node[] = [trigger];
	if (usageOpen) nodes.push(renderUsagePanel(context, usageDoc));
	usageMeterEl.replaceChildren(...nodes);
}

function renderUsagePanel(context: ContextOccupancy | null, usageDoc: UsageDoc | undefined): HTMLElement {
	const panel = document.createElement("div");
	panel.className = "usage-panel";
	panel.setAttribute("role", "dialog");
	panel.setAttribute("aria-label", "上下文与花费");

	if (context !== null) {
		const head = document.createElement("div");
		head.className = "usage-panel-head";
		head.append(el("span", "usage-panel-title", "上下文"));
		head.append(
			el(
				"span",
				"usage-panel-value",
				context.windowTokens === null
					? `${formatTokens(context.usedTokens)} tokens`
					: `${formatTokens(context.usedTokens)} / ${formatTokens(context.windowTokens)}`,
			),
		);
		panel.append(head);

		const total =
			context.breakdown.system + context.breakdown.tools + context.breakdown.messages;
		const rows: [string, number][] = [
			["系统提示", context.breakdown.system],
			["工具定义", context.breakdown.tools],
			["消息", context.breakdown.messages],
		];
		for (const [label, value] of rows) {
			const row = document.createElement("div");
			row.className = "usage-row";
			row.append(el("span", "usage-row-label", label));
			const bar = document.createElement("span");
			bar.className = "usage-bar";
			const fill = document.createElement("span");
			fill.className = "usage-bar-fill";
			fill.style.width = total <= 0 ? "0%" : `${Math.max(2, (value / total) * 100)}%`;
			bar.append(fill);
			row.append(bar, el("span", "usage-row-value", formatTokens(value)));
			panel.append(row);
		}
		if (context.model !== null) {
			panel.append(
				el(
					"div",
					"usage-panel-note",
					`${context.model.provider}/${context.model.modelId}${context.estimated ? " · 估算值" : ""}`,
				),
			);
		}
	}

	const models = Object.entries(usageDoc?.models ?? {});
	const tools = Object.entries(usageDoc?.tools ?? {});
	if (models.length > 0 || tools.length > 0) {
		panel.append(el("div", "usage-panel-title", "累计花费"));
		const line = (key: string, usage: TokenUsage): HTMLElement => {
			const row = document.createElement("div");
			row.className = "usage-row usage-row-cost";
			row.append(el("span", "usage-row-label", key));
			const tokens = usage.totalTokens ?? (usage.input ?? 0) + (usage.output ?? 0);
			row.append(
				el("span", "usage-row-value", `${formatTokens(tokens)} · ${formatCost(usage.cost?.total ?? 0)}`),
			);
			return row;
		};
		for (const [key, usage] of models) panel.append(line(key, usage));
		for (const [key, usage] of tools) panel.append(line(`工具 ${key}`, usage));
	}

	return panel;
}

document.addEventListener("pointerdown", (e) => {
	if (!usageOpen) return;
	if (e.target instanceof Node && usageMeterEl.contains(e.target)) return;
	usageOpen = false;
	renderUsageMeter();
});

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

function setConn(online: boolean): void {
	// 空白态（无会话）没有可重连的目标：如实显示「未连接」
	const text = online ? "已连接" : state.conversationId === undefined ? "未连接" : "重连中…";
	connEl.classList.toggle("conn-online", online);
	connEl.classList.toggle("conn-offline", !online);
	connEl.title = text;
	const label = connEl.querySelector(".conn-text");
	if (label !== null) label.textContent = text;
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

sendEl.addEventListener("click", () => send("primary"));
stopEl.addEventListener("click", () => void stopRun());
newEl.addEventListener("click", () => {
	void createConversation().catch(showError);
	if (isMobileViewport()) applySidebarCollapsed(true, true);
});
workspaceSaveEl.addEventListener("click", () => void saveWorkspace());
workspaceResetEl.addEventListener("click", () => void resetWorkspace());
modelSelectEl.addEventListener("change", () => {
	void switchModel(modelSelectEl.value).catch(showError);
});
favoriteEl.addEventListener("click", toggleFavorite);
workspaceInputEl.addEventListener("keydown", (e) => {
	if (e.key === "Enter") {
		e.preventDefault();
		void saveWorkspace();
	}
});
confirmCancelEl.addEventListener("click", closeConfirm);
confirmDeleteEl.addEventListener("click", () => void performDelete());
confirmEl.addEventListener("click", (e) => {
	if (e.target === confirmEl || (e.target instanceof Element && e.target.classList.contains("modal-mask"))) {
		closeConfirm(); // 点遮罩关闭
	}
});
inputEl.addEventListener("keydown", (e) => {
	if (e.key === "Enter" && !e.shiftKey) {
		e.preventDefault();
		send(e.ctrlKey || e.metaKey ? "alternate" : "primary");
	}
});

function showError(error: unknown): void {
	showBanner(error instanceof Error ? error.message : String(error));
}

/** 停止当前运行：服务端 abort 后，已生成的部分保留。 */
async function stopRun(): Promise<void> {
	if (state.conversationId === undefined) return;
	const queued = (state.view?.docs["pi.inbox"]?.items ?? []).filter(isQueuedInput).length;
	stopEl.disabled = true;
	try {
		const response = await fetch(`/api/conversations/${state.conversationId}/stop`, { method: "POST" });
		if (!response.ok) {
			const body = (await response.json().catch(() => ({}))) as { error?: string };
			showBanner(body.error ?? `停止失败（${response.status}）`);
		} else if (queued > 0) {
			showBanner(`已停止：${queued} 条排队消息已撤回`);
		}
	} catch (error) {
		showBanner(error instanceof Error ? error.message : String(error));
	} finally {
		stopEl.disabled = false;
	}
}
