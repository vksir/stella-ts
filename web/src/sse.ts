/**
 * SSE 客户端：`fetch` 读流 + 手写帧解析。
 *
 * 为什么不用 `EventSource`：它不接受请求头，而 Bearer 凭据必须走请求头
 * （ADR-0004）。帧语法极简——服务端只发 `event: view|ping` + 单行 JSON，
 * `data` 不会跨行（`JSON.stringify` 会把换行转义）。
 *
 * 解析做成纯函数便于单测；连接管理（重连、静默守护）留在 store 里。
 */
import { authHeaders } from "./auth";

export interface SseFrame {
	readonly event: string;
	readonly data: string;
}

/** 服务端返回了非 2xx（最典型是 401：登录态失效）。 */
export class SseHttpError extends Error {
	constructor(readonly status: number) {
		super(`SSE 连接被拒绝（${status}）`);
		this.name = "SseHttpError";
	}
}

/**
 * 增量解码器：喂文本块，吐出完整的帧。
 * 支持 CRLF、一次到达多帧、一帧跨多个块、注释行（`:` 开头）、多行 `data`。
 */
export function createSseDecoder(): (chunk: string) => SseFrame[] {
	let buffer = "";
	return (chunk: string): SseFrame[] => {
		buffer += chunk;
		const frames: SseFrame[] = [];
		for (;;) {
			const boundary = /\r?\n\r?\n/.exec(buffer);
			if (boundary === null) break;
			const raw = buffer.slice(0, boundary.index);
			buffer = buffer.slice(boundary.index + boundary[0].length);
			const frame = parseFrame(raw);
			if (frame !== undefined) frames.push(frame);
		}
		return frames;
	};
}

function parseFrame(raw: string): SseFrame | undefined {
	let event = "message";
	const data: string[] = [];
	for (const line of raw.split(/\r?\n/)) {
		if (line.length === 0 || line.startsWith(":")) continue;
		const colon = line.indexOf(":");
		const field = colon < 0 ? line : line.slice(0, colon);
		let value = colon < 0 ? "" : line.slice(colon + 1);
		if (value.startsWith(" ")) value = value.slice(1);
		if (field === "event") event = value;
		else if (field === "data") data.push(value);
	}
	// 只有一个空行（心跳帧之间）时没有可派发的字段。
	if (data.length === 0 && event === "message") return undefined;
	return { event, data: data.join("\n") };
}

export interface SseHandlers {
	readonly onFrame: (frame: SseFrame) => void;
}

/**
 * 打开一条 SSE 流并一直读到结束；`signal` 中止时抛 `AbortError`（由调用方识别）。
 * 非 2xx 抛 `SseHttpError`，让调用方能区分「凭据失效」与「网络抖动」。
 */
export async function streamSse(url: string, handlers: SseHandlers, signal: AbortSignal): Promise<void> {
	const headers = authHeaders();
	const response = await fetch(url, { headers, signal });
	if (!response.ok) throw new SseHttpError(response.status);
	if (response.body === null) throw new Error("SSE 响应没有可读的流");

	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	const decode = createSseDecoder();
	for (;;) {
		const { done, value } = await reader.read();
		if (done) return;
		for (const frame of decode(decoder.decode(value, { stream: true }))) handlers.onFrame(frame);
	}
}
