/**
 * 流式渲染 + 停止冒烟测试（票 02）：
 * 进程内起 app（faux provider + MemoryStorage，零网络零 key），faux 配 tokensPerSecond
 * 让回答逐 token 流出（pi-ai faux 的 delta 用真实定时器推进），据此断言：
 * 1. 流式期间 SSE 收到含 pi.live partial（generation.message）的 view，且逐次增长；
 *    回答落定后 partial 让位于最终 pi.assistant 条目（generation 清空，无重复）。
 * 2. POST /stop 中断运行后，SSE 出现运行结束状态（run 消失、runFailure.reason "aborted"），
 *    已生成的 partial 保留为条目，且会话能继续接受新消息。
 */
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/api.js";
import { loadConfig } from "../src/config.js";
import { createStella, type Stella } from "../src/stella.js";

interface ContentBlock {
	readonly type: string;
	readonly text?: string;
}

interface ModelMessage {
	readonly role: string;
	readonly content: string | readonly ContentBlock[];
}

interface SseEntry {
	readonly id: number;
	readonly kind: string;
	readonly model?: readonly ModelMessage[];
}

interface LiveDoc {
	readonly run?: { readonly first?: number } | null;
	readonly generation?: { readonly message?: ModelMessage } | null;
	readonly runFailure?: { readonly reason?: string } | null;
}

interface SseView {
	readonly conversation: { readonly id: number };
	readonly entries: readonly SseEntry[];
	readonly docs: Record<string, LiveDoc>;
}

interface SseEvent {
	readonly event: string;
	readonly data: string;
}

const STREAM_ANSWER =
	"这是一段用来验证流式渲染的较长回答。Stella 会逐字生成内容，前端应当随 SSE 的 partial 事件" +
	"逐渐增长这段文字，直到回答完成、partial 让位于最终条目。".repeat(6);

const ABORT_ANSWER =
	"这段回答足够长，测试会在它尚未生成完时按下停止。停止后已生成的部分应当保留在消息流中，" +
	"未生成的部分被丢弃，随后会话回到可输入状态。".repeat(14);

describe("流式渲染 + 停止", () => {
	let stella: Stella;
	let workspaceDir: string;

	beforeEach(async () => {
		workspaceDir = await mkdtemp(join(tmpdir(), "stella-test-"));
		const config = loadConfig({ STELLA_FAUX: "1", STELLA_DATA_DIR: workspaceDir });
		stella = await createStella(config, {}, { fauxTokensPerSecond: 100 });
	});

	afterEach(async () => {
		await stella.close();
		await rm(workspaceDir, { recursive: true, force: true });
	});

	async function newConversation(app: ReturnType<typeof createApp>): Promise<number> {
		const created = await app.request("/api/conversations", { method: "POST" });
		expect(created.status).toBe(201);
		const { id } = (await created.json()) as { id: number };
		return id;
	}

	async function readSse(response: Response): Promise<SseEvent[]> {
		const events: SseEvent[] = [];
		const reader = response.body!.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		const parseChunk = (chunk: string): void => {
			buffer += chunk;
			for (;;) {
				const boundary = buffer.indexOf("\n\n");
				if (boundary < 0) break;
				const raw = buffer.slice(0, boundary);
				buffer = buffer.slice(boundary + 2);
				const event = /^event: (.*)$/m.exec(raw)?.[1] ?? "message";
				const data = /^data: (.*)$/m.exec(raw)?.[1] ?? "";
				events.push({ event, data });
			}
		};
		void (async () => {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) return;
				parseChunk(decoder.decode(value, { stream: true }));
			}
		})();
		return events;
	}

	async function waitForView(
		events: readonly SseEvent[],
		predicate: (view: SseView) => boolean,
	): Promise<SseView> {
		const deadline = Date.now() + 15_000;
		for (;;) {
			const hit = events
				.filter((e) => e.event === "view")
				.map((e) => JSON.parse(e.data) as SseView)
				.find(predicate);
			if (hit !== undefined) return hit;
			if (Date.now() > deadline) throw new Error("等待 SSE view 超时");
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
	}

	/** 视图中的 partial（运行中生成的节流快照）文本。 */
	function partialText(view: SseView): string {
		return messageText(view.docs["pi.live"]?.generation?.message);
	}

	function messageText(message: ModelMessage | undefined): string {
		const content = message?.content;
		if (typeof content === "string") return content;
		if (Array.isArray(content)) {
			return content
				.filter((block): block is { type: "text"; text: string } => block.type === "text")
				.map((block) => block.text ?? "")
				.join("");
		}
		return "";
	}

	function findEntry(view: SseView, kind: string): SseEntry | undefined {
		// 取最后一个：停止场景中消息流会有多个同类条目（中止的 partial + 新回答）
		let hit: SseEntry | undefined;
		for (const entry of view.entries) if (entry.kind === kind) hit = entry;
		return hit;
	}

	it("流式期间 SSE 收到逐次增长的 partial，回答落定后 partial 让位于最终条目", async () => {
		const app = createApp(stella);
		stella.faux?.setResponses([fauxAssistantMessage(STREAM_ANSWER)]);
		const id = await newConversation(app);

		const events = await readSse(await app.request(`/api/conversations/${id}/events`));
		await waitForView(events, () => true); // 初始 view

		const posted = await app.request(`/api/conversations/${id}/messages`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ content: "讲讲流式渲染" }),
		});
		expect(posted.status).toBe(202);

		// 流式期间：partial 出现且 run 在场
		const withPartial = await waitForView(
			events,
			(view) => view.docs["pi.live"]?.run != null && partialText(view).length > 0,
		);
		expect(withPartial.docs["pi.live"]?.generation?.message).toBeDefined();

		// partial 逐次增长：收集到达顺序上的不同长度，后一次应更长
		const deadline = Date.now() + 15_000;
		const lengths: number[] = [];
		const viewsList = (): SseView[] =>
			events
				.filter((e) => e.event === "view")
				.map((e) => JSON.parse(e.data) as SseView);
		while (Date.now() < deadline) {
			for (const view of viewsList()) {
				const text = partialText(view);
				const length = text.length;
				if (length > 0 && (lengths.length === 0 || length > lengths[lengths.length - 1]!)) {
					lengths.push(length);
				}
			}
			if (lengths.length >= 2) break;
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		expect(lengths.length).toBeGreaterThanOrEqual(2);
		expect(lengths[lengths.length - 1]!).toBeGreaterThan(lengths[0]!);

		// 回答落定：最终条目含完整回答，partial 让位（generation.message 清空），run 结束
		const settled = await waitForView(
			events,
			(view) =>
				messageText(findEntry(view, "pi.assistant")?.model?.[0]) === STREAM_ANSWER &&
				view.docs["pi.live"]?.run == null &&
				view.docs["pi.live"]?.generation?.message === undefined,
		);
		expect(findEntry(settled, "pi.user")).toBeDefined();
	});

	it("停止：中断后 SSE 出现运行结束状态，已生成内容保留，会话可继续输入", async () => {
		const app = createApp(stella);
		stella.faux?.setResponses([fauxAssistantMessage(ABORT_ANSWER)]);
		const id = await newConversation(app);

		const events = await readSse(await app.request(`/api/conversations/${id}/events`));
		await waitForView(events, () => true);

		const posted = await app.request(`/api/conversations/${id}/messages`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ content: "写一段长文" }),
		});
		expect(posted.status).toBe(202);

		// 等 partial 出现（确认确有内容在生成），再停止
		await waitForView(events, (view) => view.docs["pi.live"]?.run != null && partialText(view).length > 0);
		const stopped = await app.request(`/api/conversations/${id}/stop`, { method: "POST" });
		expect(stopped.status).toBe(200);
		expect(((await stopped.json()) as { ok: boolean }).ok).toBe(true);

		// 运行结束状态：run 消失，runFailure.reason 为 "aborted"
		const ended = await waitForView(
			events,
			(view) =>
				view.docs["pi.live"]?.run == null && view.docs["pi.live"]?.runFailure?.reason === "aborted",
		);
		expect(ended.docs["pi.live"]?.runFailure?.reason).toBe("aborted");

		// 已生成内容保留：pi.assistant 条目在场，文本是脚本回答的前缀（非空、未生成完的部分）
		const assistant = findEntry(ended, "pi.assistant");
		expect(assistant).toBeDefined();
		const kept = messageText(assistant?.model?.[0]);
		expect(kept.length).toBeGreaterThan(0);
		expect(ABORT_ANSWER.startsWith(kept)).toBe(true);

		// 会话回到可输入状态：再发一条消息能正常获得回答
		stella.faux?.setResponses([fauxAssistantMessage("好的，我在。")]);
		const again = await app.request(`/api/conversations/${id}/messages`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ content: "继续" }),
		});
		expect(again.status).toBe(202);
		const resumed = await waitForView(
			events,
			(view) =>
				messageText(findEntry(view, "pi.assistant")?.model?.[0]) === "好的，我在。" &&
				view.docs["pi.live"]?.run == null,
		);
		expect(resumed.docs["pi.live"]?.runFailure?.reason).toBeUndefined();
	});

	it("空闲时停止是无害的空操作", async () => {
		const app = createApp(stella);
		const id = await newConversation(app);
		const stopped = await app.request(`/api/conversations/${id}/stop`, { method: "POST" });
		expect(stopped.status).toBe(200);
		const missing = await app.request("/api/conversations/999/stop", { method: "POST" });
		expect(missing.status).toBe(404);
	});
});
