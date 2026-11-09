/**
 * 会话管理冒烟测试（票 03）：faux provider + MemoryStorage，零网络零 key。
 * 覆盖：新建（首个 root 会话）、列表（标题=首条用户消息截断、创建时间）、
 * 两个会话各自发消息互不串扰、删除其一后列表只剩另一个。
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

interface ConversationSummary {
	readonly id: number;
	readonly title: string | null;
	readonly createdAt?: number;
}

const ANSWER_A = "这是会话甲的回答。";
const ANSWER_B = "这是会话乙的回答。";
const QUESTION_A = "帮我会话甲写首诗";
const QUESTION_B = "帮我会话乙查个天气";

describe("会话管理：新建 / 列表 / 切换隔离 / 删除", () => {
	let stella: Stella;
	let workspaceDir: string;

	beforeEach(async () => {
		workspaceDir = await mkdtemp(join(tmpdir(), "stella-test-"));
		const config = loadConfig({ STELLA_FAUX: "1", STELLA_DATA_DIR: workspaceDir });
		stella = await createStella(config, {});
	});

	afterEach(async () => {
		await stella.close();
		await rm(workspaceDir, { recursive: true, force: true });
	});

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

	async function newConversation(app: ReturnType<typeof createApp>): Promise<number> {
		const created = await app.request("/api/conversations", { method: "POST" });
		expect(created.status).toBe(201);
		const { id } = (await created.json()) as { id: number };
		return id;
	}

	async function listConversations(app: ReturnType<typeof createApp>): Promise<ConversationSummary[]> {
		const response = await app.request("/api/conversations");
		expect(response.status).toBe(200);
		const body = (await response.json()) as { conversations: ConversationSummary[] };
		return body.conversations;
	}

	async function postMessage(app: ReturnType<typeof createApp>, id: number, content: string): Promise<void> {
		const posted = await app.request(`/api/conversations/${id}/messages`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ content }),
		});
		expect(posted.status).toBe(202);
	}

	/** 等一次运行完整落定：最终回答出现且 run 结束。 */
	async function waitForSettled(
		events: readonly SseEvent[],
		answer: string,
	): Promise<SseView> {
		return waitForView(
			events,
			(view) =>
				view.docs["pi.live"]?.run == null &&
				view.entries.some((entry) => entry.kind === "pi.assistant" && entryText(entry) === answer),
		);
	}

	/** 重新订阅一个会话，返回其初始 view（含完整历史窗口）。 */
	async function initialView(app: ReturnType<typeof createApp>, id: number): Promise<SseView> {
		const events = await readSse(await app.request(`/api/conversations/${id}/events`));
		return waitForView(events, (view) => view.entries.length > 0);
	}

	function entryText(entry: SseEntry): string {
		const content = entry.model?.[0]?.content;
		if (typeof content === "string") return content;
		if (Array.isArray(content)) {
			return content
				.filter((block): block is { type: "text"; text: string } => block.type === "text")
				.map((block) => block.text ?? "")
				.join("");
		}
		return "";
	}

	it("新建：首个是 root 会话，新建后列表含创建时间，标题缺省为空", async () => {
		const app = createApp(stella);
		expect(await listConversations(app)).toEqual([]); // 尚无会话

		const first = await newConversation(app); // 首个：保留的 root 会话
		const second = await newConversation(app);
		expect(first).not.toBe(second);

		const conversations = await listConversations(app);
		expect(conversations.map((conversation) => conversation.id)).toEqual([first, second]);
		expect(conversations[0]!.title).toBeNull(); // 未发消息：标题缺省
		expect(conversations[0]!.createdAt).toBeGreaterThan(0); // 创建时间（元数据文档）
		expect(conversations[1]!.createdAt).toBeGreaterThan(0);
	});

	it("标题：首条消息发出后更新为首条用户消息截断（30 字符）", async () => {
		const app = createApp(stella);
		const id = await newConversation(app);
		const events = await readSse(await app.request(`/api/conversations/${id}/events`));
		await waitForView(events, () => true); // 初始 view

		const longQuestion = "这一段远远超过三十个字的消息用来验证会话标题会按首条用户消息截断生成";
		expect(Array.from(longQuestion).length).toBeGreaterThan(30);
		stella.faux?.setResponses([fauxAssistantMessage("好的。")]);
		await postMessage(app, id, longQuestion);
		await waitForSettled(events, "好的。");

		const conversations = await listConversations(app);
		expect(conversations).toHaveLength(1);
		const chars = Array.from(longQuestion);
		expect(conversations[0]!.title).toBe(`${chars.slice(0, 30).join("")}…`);
	});

	it("互不串扰：两个会话各自发消息，各自历史只含自己的内容；删除其一后列表只剩另一个", async () => {
		const app = createApp(stella);
		const idA = await newConversation(app);
		const idB = await newConversation(app);

		// 会话甲：订阅 → 提问 → 回答落定
		const eventsA = await readSse(await app.request(`/api/conversations/${idA}/events`));
		await waitForView(eventsA, () => true);
		stella.faux?.setResponses([fauxAssistantMessage(ANSWER_A)]);
		await postMessage(app, idA, QUESTION_A);
		await waitForSettled(eventsA, ANSWER_A);

		// 会话乙：订阅 → 提问 → 回答落定（甲的 SSE 不应收到乙的条目）
		const eventsB = await readSse(await app.request(`/api/conversations/${idB}/events`));
		await waitForView(eventsB, () => true);
		stella.faux?.setResponses([fauxAssistantMessage(ANSWER_B)]);
		await postMessage(app, idB, QUESTION_B);
		await waitForSettled(eventsB, ANSWER_B);

		// 甲运行期间与之后，甲的 SSE 不出现乙的问题或回答
		for (const view of eventsA
			.filter((e) => e.event === "view")
			.map((e) => JSON.parse(e.data) as SseView)) {
			expect(view.conversation.id).toBe(idA);
			const texts = view.entries.map(entryText).join("\n");
			expect(texts).not.toContain(QUESTION_B);
			expect(texts).not.toContain(ANSWER_B);
		}

		// 各自重新订阅（切换会话的恢复路径）：历史窗口只含自己的消息
		const viewA = await initialView(app, idA);
		expect(viewA.entries.map(entryText)).toContain(QUESTION_A);
		expect(viewA.entries.map(entryText)).toContain(ANSWER_A);
		expect(viewA.entries.map(entryText).join("\n")).not.toContain(QUESTION_B);
		const viewB = await initialView(app, idB);
		expect(viewB.entries.map(entryText)).toContain(QUESTION_B);
		expect(viewB.entries.map(entryText)).toContain(ANSWER_B);
		expect(viewB.entries.map(entryText).join("\n")).not.toContain(QUESTION_A);

		// 标题各取首条消息
		const before = await listConversations(app);
		expect(before.map((conversation) => conversation.title)).toEqual([QUESTION_A, QUESTION_B]);

		// 删除甲（有确认的 UI 动作；API 直接删除）：列表只剩乙
		const removed = await app.request(`/api/conversations/${idA}`, { method: "DELETE" });
		expect(removed.status).toBe(200);
		expect(((await removed.json()) as { ok: boolean }).ok).toBe(true);
		const after = await listConversations(app);
		expect(after.map((conversation) => conversation.id)).toEqual([idB]);
		expect(after[0]!.title).toBe(QUESTION_B);

		// 删除不存在的会话：404
		const missing = await app.request("/api/conversations/999", { method: "DELETE" });
		expect(missing.status).toBe(404);

		// 乙完好：重新订阅仍能拿到完整历史
		const viewBAfter = await initialView(app, idB);
		expect(viewBAfter.entries.map(entryText)).toContain(QUESTION_B);
	});
});
