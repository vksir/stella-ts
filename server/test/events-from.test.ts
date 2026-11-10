/**
 * SSE 断线续订（`?from=`）：对应 pi-durable `ConversationWindow.from` 与
 * `ConversationTranscript.resume`——客户端给出已持有的最新条目 + 1，服务端的窗口
 * 从那里开始，只补断线期间的新条目；缺失超过窗口上限时回落到最新窗口，
 * 中间的缺口由客户端的转写显式标出。
 */
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/api.js";
import { loadConfig } from "../src/config.js";
import { createStella, type Stella } from "../src/stella.js";

interface Entry {
	readonly id: number;
	readonly kind: string;
}

interface View {
	readonly conversation: { readonly id: number };
	readonly entries: readonly Entry[];
	readonly before?: number;
}

interface SseEvent {
	readonly event: string;
	readonly data: string;
}

describe("SSE 断线续订（?from=）", () => {
	let stella: Stella;
	let workspaceDir: string;

	/** 每个请求新建 app（无状态）：同一次测试内的会话与 harness 不变。 */
	const app = () => createApp(stella);

	beforeEach(async () => {
		workspaceDir = await mkdtemp(join(tmpdir(), "stella-test-"));
		const config = loadConfig({ STELLA_FAUX: "1", STELLA_DATA_DIR: workspaceDir });
		stella = await createStella(config, {});
		stella.faux?.setResponses([fauxAssistantMessage("第一条回答。"), fauxAssistantMessage("第二条回答。")]);
	});

	afterEach(async () => {
		await stella.close();
		await rm(workspaceDir, { recursive: true, force: true });
	});

	/** 后台读 SSE，事件按到达顺序累积。 */
	async function readSse(response: Response): Promise<SseEvent[]> {
		const events: SseEvent[] = [];
		const reader = response.body!.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		const parse = (chunk: string): void => {
			buffer += chunk;
			for (;;) {
				const boundary = buffer.indexOf("\n\n");
				if (boundary < 0) return;
				const raw = buffer.slice(0, boundary);
				buffer = buffer.slice(boundary + 2);
				events.push({
					event: /^event: (.*)$/m.exec(raw)?.[1] ?? "message",
					data: /^data: (.*)$/m.exec(raw)?.[1] ?? "",
				});
			}
		};
		void (async () => {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) return;
				parse(decoder.decode(value, { stream: true }));
			}
		})();
		return events;
	}

	async function waitForView(events: readonly SseEvent[], predicate: (view: View) => boolean): Promise<View> {
		const deadline = Date.now() + 15_000;
		for (;;) {
			const hit = events
				.filter((event) => event.event === "view")
				.map((event) => JSON.parse(event.data) as View)
				.find(predicate);
			if (hit !== undefined) return hit;
			if (Date.now() > deadline) throw new Error("等待 SSE view 超时");
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
	}

	async function post(id: number, content: string): Promise<void> {
		const response = await app().request(`/api/conversations/${id}/messages`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ content }),
		});
		expect(response.status).toBe(202);
	}

	async function allEntries(id: number): Promise<readonly Entry[]> {
		const deadline = Date.now() + 10_000;
		for (;;) {
			const response = await app().request(`/api/conversations/${id}/entries?before=999999`);
			const page = (await response.json()) as { entries: readonly Entry[] };
			if (page.entries.at(-1)?.kind === "pi.assistant") return page.entries;
			if (Date.now() > deadline) throw new Error("等待回答条目超时");
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
	}

	it("from 从已持有的最新条目之后开始，只补断线期间的新条目", async () => {
		const created = await app().request("/api/conversations", { method: "POST" });
		const { id } = (await created.json()) as { id: number };
		await post(id, "第一问");
		const held = await allEntries(id);
		const newest = held.at(-1)!;

		// 断线重连：from = 已持有的最新条目 + 1（ConversationTranscript.resume）
		const events = await readSse(await app().request(`/api/conversations/${id}/events?from=${newest.id + 1}`));
		const initial = await waitForView(events, () => true);
		expect(initial.entries).toEqual([]);
		expect(initial.before).toBe(newest.id);

		// 断线期间产生的新条目只包含新条目，窗口前一条正是客户端已持有的最新条目
		await post(id, "第二问");
		const resumed = await waitForView(events, (view) => view.entries.some((entry) => entry.id > newest.id));
		expect(resumed.before).toBe(newest.id);
		expect(resumed.entries.every((entry) => entry.id > newest.id)).toBe(true);

		// 等第二轮回答落定，避免测试结束时后台 settleSubmission 撞上 close（日志噪声）
		await allEntries(id);
	});
});
