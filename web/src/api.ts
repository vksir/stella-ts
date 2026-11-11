/**
 * 服务端契约（SSE view / REST）：类型与 fetch 封装。
 * 从 legacy/main.ts 平移，UI 框架无关。
 */

// —— 服务端数据形状（SSE view / REST 翻页） ——

export interface ContentBlock {
	type: string;
	text?: string;
	name?: string;
	/** 工具调用块（pi.assistant 里）：id 关联 pi.tool-result 条目与 pi.live.tools 槽位 */
	id?: string;
	arguments?: Record<string, unknown>;
	argumentsError?: string;
}

export interface ModelMessage {
	role: string;
	content: string | ContentBlock[];
	/** 该条消息的时间戳（epoch 毫秒）；用户与助手消息都有。 */
	timestamp?: number;
	/** 助手消息的本次用量（token 与成本）。 */
	usage?: TokenUsage;
	/** 助手消息的本次耗时（毫秒，来源侧测得）。 */
	durationMs?: number;
	/** 回答条目的停止原因："error" 表示这次尝试失败（pi-durable 保留的错误 attempt）。 */
	stopReason?: string;
	/** stopReason 为 "error" 时的底层错误文本。 */
	errorMessage?: string;
}

/** pi.tool-result 条目的 model[0]：工具结果，与 assistant 的 toolCall 块按 toolCallId 关联。 */
export interface ToolResultMessage {
	role: "toolResult";
	toolCallId?: string;
	toolName?: string;
	content: ContentBlock[];
	isError?: boolean;
}

/** pi.live.tools 槽位：当前工具轮次一个调用的运行态。 */
export interface LiveToolSlot {
	callId?: string;
	name?: string;
	status?: "pending" | "running" | "done";
	output?: string;
}

export interface ChatEntry {
	id: number;
	kind: string;
	model?: ModelMessage[];
}

export interface LiveRun {
	/** 本次运行的第一个条目：回答条目的 id 必不小于它，用于 partial 去重。 */
	first?: number;
}

export interface LiveDoc {
	run?: LiveRun | null;
	generation?: { message?: ModelMessage } | null;
	tools?: LiveToolSlot[] | null;
	/** 运行结束无回答时的失败原因（含 detail 与失败运行的首条目 id），下一次运行开始时清除。 */
	runFailure?: { reason?: string; detail?: string; first?: number; inputs?: number[] };
}

/** pi.inbox 排队项：等待放置的提交（用户输入，mode 为 steer/followUp）。 */
export interface InboxItemView {
	id: number;
	mode?: string;
	/** 用户消息内容（string 或内容块数组）；write 型排队项无此字段，本端不发送。 */
	content?: string | ContentBlock[];
}

export interface SseView {
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

export interface EntriesPage {
	entries: ChatEntry[];
	hasMore: boolean;
}

/** pi.usage 的一次用量（pi-ai Usage 的 JSON 形状，取展示需要的字段）。 */
export interface TokenUsage {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	totalTokens?: number;
	cost?: { total?: number };
}

/** view.docs["pi.usage"]：按 provider/model 与工具名累计。 */
export interface UsageDoc {
	models?: Record<string, TokenUsage>;
	tools?: Record<string, TokenUsage>;
}

/** GET /api/presets 的条目。 */
export interface PresetSummary {
	id: string;
	name: string;
	description?: string;
	builtin: boolean;
	default: boolean;
	extensions: string[] | null;
	tools: string[] | null;
	missing: string[];
}

export interface PresetsResponse {
	presets: PresetSummary[];
	defaultPreset: string;
	defaultMaxTurns: number;
}

/** GET /api/conversations/:id/context：上下文占用。 */
export interface ContextOccupancy {
	usedTokens: number;
	windowTokens: number | null;
	percent: number | null;
	breakdown: { system: number; tools: number; messages: number };
	model: ModelRefPayload | null;
	estimated: boolean;
}

export interface ConversationSummary {
	id: number;
	title: string | null;
	createdAt?: number;
	preset?: string | null;
}

/** GET/PUT 会话设置的响应体：cwd 为当前生效值，defaultWorkspace 为服务端默认工作区。 */
export interface WorkspaceSettings {
	cwd: string;
	defaultWorkspace: string;
	custom: boolean;
	model: ModelRefPayload | null;
	preset: string | null;
}

/** 模型引用（provider/modelId），与服务端 ModelRef 同形。 */
export interface ModelRefPayload {
	provider: string;
	modelId: string;
}

/** GET /api/models 的目录条目。 */
export interface ModelInfo extends ModelRefPayload {
	providerName: string;
	name: string;
	selected?: boolean;
}

/** GET /api/models 响应：目录 + 默认模型 + （配置的默认模型不可用时的）回落信息。 */
export interface ModelCatalog {
	models: ModelInfo[];
	defaultModel: ModelRefPayload;
	defaultModelFallback?: { from: string; to: ModelRefPayload };
}

export interface ConversationList {
	conversations: ConversationSummary[];
}

// —— fetch ——

export async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
	const response = await fetch(url, init);
	if (!response.ok) {
		const body = (await response.json().catch(() => ({}))) as { error?: string };
		throw new Error(body.error ?? `请求失败（${response.status}）：${url}`);
	}
	return (await response.json()) as T;
}

export function postJson<T>(url: string, body: unknown): Promise<T> {
	return fetchJson<T>(url, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

export function putJson<T>(url: string, body: unknown): Promise<T> {
	return fetchJson<T>(url, {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

/** 非 objec 成功体（204 / {ok:true}）的宽松 POST/PUT/DELETE。 */
export async function postOk(url: string, body?: unknown): Promise<{ ok: true; error?: undefined } | { ok: false; error: string }> {
	const response = await fetch(url, {
		method: "POST",
		headers: body === undefined ? undefined : { "content-type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	if (!response.ok) {
		const payload = (await response.json().catch(() => ({}))) as { error?: string };
		return { ok: false, error: payload.error ?? `请求失败（${response.status}）` };
	}
	return { ok: true };
}

// —— 文本抽取（string 或内容块数组 → 文本） ——

export function extractTextOf(content: string | ContentBlock[] | undefined): string {
	if (content === undefined) return "";
	if (typeof content === "string") return content;
	return content
		.filter((block) => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text ?? "")
		.join("");
}

export function extractText(message: ModelMessage | undefined): string {
	return message === undefined ? "" : extractTextOf(message.content);
}

export function isToolResult(message: ModelMessage | undefined): message is ToolResultMessage {
	return message?.role === "toolResult";
}

/** 流式 partial 里 id 匹配的 toolCall 块（运行中槽位的参数来源）。 */
export function partialToolCall(partial: ModelMessage | undefined, callId: string): ContentBlock | undefined {
	const content = partial?.content;
	if (!Array.isArray(content)) return undefined;
	return content.find((block) => block.type === "toolCall" && block.id === callId);
}

/** 工具结果的输出文本（content 里的 text 块）。 */
export function resultText(result: ToolResultMessage): string {
	return (result.content ?? [])
		.filter((block) => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text ?? "")
		.join("");
}

export function modelKey(model: ModelRefPayload): string {
	return `${model.provider}/${model.modelId}`;
}
