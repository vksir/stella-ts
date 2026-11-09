/**
 * 排队 + 错误重试冒烟测试（票 06）：
 * 进程内起 app（faux provider + MemoryStorage，零网络零 key），faux 配 tokensPerSecond
 * 控速制造运行窗口，据此断言：
 * 1. 运行中 POST 新消息不报错（202），以 follow-up 排队进 view.docs["pi.inbox"]；
 *    前一条回答结束后排队项按入队顺序自动依次执行，各得回答（transcript 顺序对应）。
 * 2. 停止（abort）撤回排队输入（pi-durable 语义）：排队项从 inbox 消失、不产生条目，
 *    运行以 runFailure.reason "aborted" 结束——按其语义如实呈现，而非继续执行。
 * 3. 注入模型错误（fauxAssistantMessage stopReason "error"）：运行无回答结束，SSE view
 *    出现失败态（run 消失、runFailure.reason "model_error"、detail 为底层错误文本），
 *    用户消息条目在场且无回答条目；以新 requestId 重发同内容后重试成功，错误清除，
 *    transcript 如实出现第二条相同内容的 pi.user 条目。
 * 4. 相同 requestId 的重复提交被 pi-durable 幂等去重：返回原提交 id，不新建运行——
 *    所以重试必须用新 requestId。
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
	readonly stopReason?: string;
	readonly errorMessage?: string;
}

interface SseEntry {
	readonly id: number;
	readonly kind: string;
	readonly model?: readonly ModelMessage[];
}

interface InboxItem {
	readonly id: number;
	readonly mode?: string;
	readonly content?: string | readonly ContentBlock[];
}

interface LiveDoc {
	readonly run?: { readonly first?: number } | null;
	readonly generation?: { readonly message?: ModelMessage } | null;
	readonly runFailure?: { readonly reason?: string; readonly detail?: string; readonly first?: number } | null;
}

interface SseView {
	readonly conversation: { readonly id: number };
	readonly entries: readonly SseEntry[];
	readonly docs: { readonly "pi.live"?: LiveDoc; readonly "pi.inbox"?: { readonly items?: readonly InboxItem[] } };
}

interface SseEvent {
	readonly event: string;
	readonly data: string;
}

/** 第一条回答足够长：在它流式生成期间发出后续两条消息，制造排队窗口。 */
const LONG_ANSWER_1 =
	"这是第一条回答，篇幅足够长，测试会在它尚未生成完时把后续消息排进队列。" +
	"队列里的消息应当在本条回答结束后按入队顺序自动依次执行。".repeat(12);
const ANSWER_2 = "第二条回答（排队后自动执行）。";
const ANSWER_3 = "第三条回答（排队后自动执行）。";
/** 停止场景的长回答：排队消息发出后按下停止。 */
const STOP_ANSWER =
	"这段回答足够长，测试会在它尚未生成完时验证停止与排队的协同。" +
	"按 pi-durable 语义，停止会撤回排队中的输入，它们不应再被执行。".repeat(14);
const FAILED_QUESTION = "这个问题会触发一次被注入的模型故障";
const RETRIED_ANSWER = "重试后的正常回答。";

describe("排队 + 错误重试", () => {
	let stella: Stella;
	let workspaceDir: string;

	beforeEach(async () => {
		workspaceDir = await mkdtemp(join(tmpdir(), "stella-test-"));
		const config = loadConfig({ STELLA_FAUX: "1", STELLA_DATA_DIR: workspaceDir });
		stella = await createStella(config, {}, { fauxTokensPerSecond: 200 });
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

	async function postMessage(
		app: ReturnType<typeof createApp>,
		id: number,
		content: string,
		requestId?: string,
	): Promise<{ status: number; submissionId: number }> {
		const response = await app.request(`/api/conversations/${id}/messages`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ content, ...(requestId !== undefined ? { requestId } : {}) }),
		});
		const body = (await response.json()) as { submissionId?: number };
		return { status: response.status, submissionId: body.submissionId ?? -1 };
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

	function entriesOfKind(view: SseView, kind: string): SseEntry[] {
		return view.entries.filter((entry) => entry.kind === kind);
	}

	function textsOf(view: SseView, kind: string): string[] {
		return entriesOfKind(view, kind).map((entry) => messageText(entry.model?.[0]));
	}

	function inboxOf(view: SseView): readonly InboxItem[] {
		return view.docs["pi.inbox"]?.items ?? [];
	}

	it("运行中发送两条消息：不报错入队 pi.inbox，运行结束后按序自动执行、各得回答", async () => {
		const app = createApp(stella);
		stella.faux?.setResponses([
			fauxAssistantMessage(LONG_ANSWER_1),
			fauxAssistantMessage(ANSWER_2),
			fauxAssistantMessage(ANSWER_3),
		]);
		const id = await newConversation(app);

		const events = await readSse(await app.request(`/api/conversations/${id}/events`));
		await waitForView(events, () => true); // 初始 view

		const first = await postMessage(app, id, "第一个问题");
		expect(first.status).toBe(202);
		// 第一条还在流式生成时连发两条：不报错（仍 202），排队而非拒绝
		const second = await postMessage(app, id, "第二个问题");
		expect(second.status).toBe(202);
		const third = await postMessage(app, id, "第三个问题");
		expect(third.status).toBe(202);

		// 两条后续消息都在排队：pi.inbox 按入队顺序各有一项
		const queued = await waitForView(events, (view) => inboxOf(view).length === 2);
		expect(inboxOf(queued).map((item) => item.content)).toEqual(["第二个问题", "第三个问题"]);

		// 运行结束后排队项自动依次执行：三条提问按序各得脚本对应的回答
		const settled = await waitForView(
			events,
			(view) =>
				view.docs["pi.live"]?.run == null &&
				inboxOf(view).length === 0 &&
				JSON.stringify(textsOf(view, "pi.user")) ===
					JSON.stringify(["第一个问题", "第二个问题", "第三个问题"]) &&
				JSON.stringify(textsOf(view, "pi.assistant")) ===
					JSON.stringify([LONG_ANSWER_1, ANSWER_2, ANSWER_3]),
		);
		expect(settled.docs["pi.live"]?.runFailure).toBeUndefined();
	});

	it("停止与排队协同：按 pi-durable 语义撤回排队输入（不执行、无条目），已生成部分保留", async () => {
		const app = createApp(stella);
		stella.faux?.setResponses([fauxAssistantMessage(STOP_ANSWER)]);
		const id = await newConversation(app);

		const events = await readSse(await app.request(`/api/conversations/${id}/events`));
		await waitForView(events, () => true);

		const first = await postMessage(app, id, "写一段长文");
		expect(first.status).toBe(202);
		const second = await postMessage(app, id, "排队中的消息");
		expect(second.status).toBe(202);
		await waitForView(events, (view) => inboxOf(view).length === 1);
		// 等到确有内容在生成（partial 非空）再停止，保证「已生成部分保留」可断言
		await waitForView(
			events,
			(view) =>
				inboxOf(view).length === 1 &&
				messageText(view.docs["pi.live"]?.generation?.message).length > 0,
		);

		const stopped = await app.request(`/api/conversations/${id}/stop`, { method: "POST" });
		expect(stopped.status).toBe(200);

		// 停止后：run 结束（aborted），排队输入被撤回——inbox 清空且 transcript 中无该消息
		// （谓词锚定 aborted：初始 view 也满足 run 空 + inbox 空，不能提前命中）
		const ended = await waitForView(
			events,
			(view) =>
				view.docs["pi.live"]?.run == null &&
				inboxOf(view).length === 0 &&
				view.docs["pi.live"]?.runFailure?.reason === "aborted",
		);
		expect(ended.docs["pi.live"]?.runFailure?.reason).toBe("aborted");
		expect(textsOf(ended, "pi.user")).toEqual(["写一段长文"]); // 排队消息未放置
		// 已生成的部分保留：中止的 partial 转为 assistant 条目（票 02 语义）
		expect(entriesOfKind(ended, "pi.assistant").length).toBe(1);

		// 撤回不产生回答：失败态（aborted）只对应第一条
		expect(textsOf(ended, "pi.assistant").some((text) => text.includes("排队中的消息"))).toBe(false);
	});

	it("注入模型失败：SSE 出现失败态（runFailure.model_error + 底层错误），重试成功后错误被回答取代", async () => {
		const app = createApp(stella);
		stella.faux?.setResponses([
			fauxAssistantMessage("（不应出现的回答）", { stopReason: "error", errorMessage: "模拟的模型故障" }),
		]);
		const id = await newConversation(app);

		const events = await readSse(await app.request(`/api/conversations/${id}/events`));
		await waitForView(events, () => true);

		const posted = await postMessage(app, id, FAILED_QUESTION);
		expect(posted.status).toBe(202);

		// 失败态：run 结束、runFailure.reason "model_error"、detail 是底层错误文本
		const failed = await waitForView(
			events,
			(view) => view.docs["pi.live"]?.run == null && view.docs["pi.live"]?.runFailure != null,
		);
		expect(failed.docs["pi.live"]?.runFailure?.reason).toBe("model_error");
		expect(failed.docs["pi.live"]?.runFailure?.detail).toContain("模拟的模型故障");
		// 失败的提交已放置为 pi.user 条目；失败 attempt 被 pi-durable 保留为错误回答条目
		// （stopReason "error" + 底层错误文本），而非正常回答——前端如实渲染为错误气泡。
		expect(textsOf(failed, "pi.user")).toEqual([FAILED_QUESTION]);
		const failedEntries = entriesOfKind(failed, "pi.assistant");
		expect(failedEntries.length).toBe(1);
		const failedMessage = failedEntries[0]!.model?.[0];
		expect(failedMessage?.stopReason).toBe("error");
		expect(failedMessage?.errorMessage).toContain("模拟的模型故障");

		// 重试：相同内容 + 新 requestId，正常回答
		stella.faux?.setResponses([fauxAssistantMessage(RETRIED_ANSWER)]);
		const retried = await postMessage(app, id, FAILED_QUESTION, "retry-new-request-id");
		expect(retried.status).toBe(202);
		expect(retried.submissionId).not.toBe(posted.submissionId); // 新 requestId → 新提交

		const recovered = await waitForView(
			events,
			(view) =>
				textsOf(view, "pi.assistant").includes(RETRIED_ANSWER) && view.docs["pi.live"]?.run == null,
		);
		// 错误清除：runFailure 被新运行的开始移除（错误卡片随之消失）
		expect(recovered.docs["pi.live"]?.runFailure).toBeUndefined();
		// 重试的提交按 pi-durable 语义再次放置：transcript 如实出现第二条相同内容的用户消息
		expect(JSON.stringify(textsOf(recovered, "pi.user"))).toBe(
			JSON.stringify([FAILED_QUESTION, FAILED_QUESTION]),
		);
		// 历史如实保留：旧的错误回答条目仍在（stopReason "error"），正常回答另起一条
		const assistantEntries = entriesOfKind(recovered, "pi.assistant");
		expect(assistantEntries.length).toBe(2);
		expect(assistantEntries[0]!.model?.[0]?.stopReason).toBe("error");
		expect(messageText(assistantEntries[1]!.model?.[0])).toBe(RETRIED_ANSWER);
	});

	it("相同 requestId 的重复提交被幂等去重：返回原失败提交、不新建运行（所以重试必须用新 requestId）", async () => {
		const app = createApp(stella);
		stella.faux?.setResponses([]); // 队列为空：faux 返回错误响应（"No more faux responses queued"）
		const id = await newConversation(app);

		const events = await readSse(await app.request(`/api/conversations/${id}/events`));
		await waitForView(events, () => true);

		const first = await postMessage(app, id, "只发一次的问题", "same-request-id");
		expect(first.status).toBe(202);
		const failedView = await waitForView(
			events,
			(view) =>
				view.docs["pi.live"]?.run == null &&
				view.docs["pi.live"]?.runFailure?.reason === "model_error",
		);
		expect(textsOf(failedView, "pi.user")).toEqual(["只发一次的问题"]);

		// 相同 requestId 重发：pi-durable 幂等去重，返回原提交 id，不产生新条目、不新建运行
		const duplicate = await postMessage(app, id, "只发一次的问题", "same-request-id");
		expect(duplicate.status).toBe(202);
		expect(duplicate.submissionId).toBe(first.submissionId);

		// 去重后无任何新条目：仍只有一条用户消息、一条错误回答、无新运行
		const after = await waitForView(
			events,
			(view) =>
				view.docs["pi.live"]?.run == null &&
				view.docs["pi.live"]?.runFailure?.reason === "model_error" &&
				textsOf(view, "pi.user").length === 1,
		);
		expect(textsOf(after, "pi.user")).toEqual(["只发一次的问题"]); // 没有第二条
		expect(entriesOfKind(after, "pi.assistant").length).toBe(1); // 只有原失败 attempt，无新回答
	});
});
