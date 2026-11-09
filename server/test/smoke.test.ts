/**
 * 骨架 + 首问首答闭环冒烟测试（票 01 的 happy path）：
 * 进程内起 app（faux provider + MemoryStorage，零网络零 key），
 * POST 消息后从 SSE 依次收到含用户条目与回答条目的 view。
 */
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/api.js";
import { loadConfig } from "../src/config.js";
import { createStella, type Stella } from "../src/stella.js";

interface SseEntry {
	readonly id: number;
	readonly kind: string;
	readonly model?: readonly unknown[];
}

interface SseView {
	readonly conversation: { readonly id: number };
	readonly entries: readonly SseEntry[];
	readonly before?: number;
	readonly docs: Record<string, unknown>;
}

interface SseEvent {
	readonly event: string;
	readonly data: string;
}

const FAUX_ANSWER = "你好，我是 Stella，这是测试用的固定回答。";

describe("骨架冒烟：首问首答闭环", () => {
	let stella: Stella;
	let workspaceDir: string;

	beforeEach(async () => {
		workspaceDir = await mkdtemp(join(tmpdir(), "stella-test-"));
		const config = loadConfig({ STELLA_FAUX: "1", STELLA_DATA_DIR: workspaceDir });
		expect(config.faux).toBe(true);
		stella = await createStella(config, {});
		stella.faux?.setResponses([fauxAssistantMessage(FAUX_ANSWER)]);
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

	it("POST 消息后从 SSE 收到用户条目与回答条目", async () => {
		const app = createApp(stella);

		// 新建会话（首个是 root 会话）
		const created = await app.request("/api/conversations", { method: "POST" });
		expect(created.status).toBe(201);
		const { id } = (await created.json()) as { id: number };
		expect(id).toBeGreaterThan(0);

		// 先订阅 SSE（不丢初始 view 与后续 commit），再提交消息
		const ssePromise = app.request(`/api/conversations/${id}/events`);
		const events = await readSse(await ssePromise);
		const initial = await waitForView(events, () => true);
		expect(initial.conversation.id).toBe(id);
		expect(Array.isArray(initial.entries)).toBe(true);

		// 提交当前消息（客户端只发新消息，不带历史）
		const posted = await app.request(`/api/conversations/${id}/messages`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ content: "你好" }),
		});
		expect(posted.status).toBe(202);
		const { submissionId } = (await posted.json()) as { submissionId: number };
		expect(Number.isInteger(submissionId)).toBe(true);

		// 用户条目（pi.user）
		const withUser = await waitForView(events, (view) =>
			view.entries.some((entry) => entry.kind === "pi.user"),
		);
		const userEntry = withUser.entries.find((entry) => entry.kind === "pi.user");
		expect(firstText(userEntry)).toBe("你好");

		// 回答条目（pi.assistant，由 generation 提交）
		const withAnswer = await waitForView(events, (view) =>
			view.entries.some((entry) => entry.kind === "pi.assistant"),
		);
		const answerEntry = withAnswer.entries.find((entry) => entry.kind === "pi.assistant");
		expect(firstText(answerEntry)).toBe(FAUX_ANSWER);

		// 历史还在：重新订阅 SSE 的初始 view 应包含两条条目（窗口下限 ≥ 2）
		const resubscribed = readSse(await app.request(`/api/conversations/${id}/events`));
		const resumed = await waitForView(await resubscribed, (view) => view.entries.length >= 2);
		const kinds = resumed.entries.map((entry) => entry.kind);
		expect(kinds).toContain("pi.user");
		expect(kinds).toContain("pi.assistant");
	});

	it("faux 模式外零 key 启动报错（中文提示）", async () => {
		const config = loadConfig({ STELLA_DATA_DIR: workspaceDir });
		await expect(createStella(config, {})).rejects.toThrow(/API key/);
		await expect(createStella(config, {})).rejects.toThrow(/STELLA_FAUX/);
	});
});

/** 条目 model[0].content 中的文本（faux 回答与用户消息都是纯文本）。 */
function firstText(entry: SseEntry | undefined): string | undefined {
	const message = entry?.model?.[0] as { content?: unknown } | undefined;
	const content = message?.content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter((block): block is { type: "text"; text: string } => (block as { type?: string }).type === "text")
			.map((block) => block.text)
			.join("");
	}
	return undefined;
}
