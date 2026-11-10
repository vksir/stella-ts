/**
 * 队列操作：当运行中发送时 whenBusy 的三种投递方式（steer / followUp / reject），
 * 以及 DELETE /submissions/:id 撤回排队提交（队列条的删除/编辑/插话前置）。
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { InboxDoc, LiveDoc, type ConversationId } from "@earendil-works/pi-durable";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/api.js";
import { loadConfig } from "../src/config.js";
import { createStella, type Stella } from "../src/stella.js";

describe("队列：steer / followUp / reject 与撤回", () => {
	let stella: Stella;
	let workspaceDir: string;

	/** 每个请求新建 app（无状态）：同一测试内的会话与 harness 不变。 */
	const app = () => createApp(stella);

	beforeEach(async () => {
		workspaceDir = await mkdtemp(join(tmpdir(), "stella-test-"));
		const config = loadConfig({ STELLA_FAUX: "1", STELLA_DATA_DIR: workspaceDir });
		stella = await createStella(config, {});
	});

	afterEach(async () => {
		await stella.close();
		await rm(workspaceDir, { recursive: true, force: true });
	});

	it("busy 时 steer 入队为 steer、默认入队为 followUp、reject 返回 409；撤回后不再执行", async () => {
		let release!: () => void;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		stella.faux?.setResponses([
			async () => {
				await held;
				return fauxAssistantMessage("第一条回答。");
			},
		]);

		const created = await app().request("/api/conversations", { method: "POST" });
		const { id } = (await created.json()) as { id: number };

		const first = await app().request(`/api/conversations/${id}/messages`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ content: "第一问" }),
		});
		expect(first.status).toBe(202);

		// 等运行真正开始（faux 回答被 hold 住）
		const deadline = Date.now() + 10_000;
		for (;;) {
			const live = await stella.harness.snapshot(LiveDoc, id as ConversationId, BACKGROUND_CONTEXT);
			if (live?.run !== undefined) break;
			if (Date.now() > deadline) throw new Error("等待运行开始超时");
			await new Promise((resolve) => setTimeout(resolve, 20));
		}

		async function queue(content: string, whenBusy?: "steer" | "followUp" | "reject") {
			return app().request(`/api/conversations/${id}/messages`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ content, ...(whenBusy === undefined ? {} : { whenBusy }) }),
			});
		}

		const followUp = await queue("排队消息");
		expect(followUp.status).toBe(202);
		const followUpId = ((await followUp.json()) as { submissionId: number }).submissionId;

		const steer = await queue("插话消息", "steer");
		expect(steer.status).toBe(202);
		const steerId = ((await steer.json()) as { submissionId: number }).submissionId;

		const rejected = await queue("不要了", "reject");
		expect(rejected.status).toBe(409);

		const inbox = await stella.harness.snapshot(InboxDoc, id as ConversationId, BACKGROUND_CONTEXT);
		const modes = new Map((inbox?.items ?? []).map((item) => [String(item.id), item.mode]));
		expect(modes.get(String(followUpId))).toBe("followUp");
		expect(modes.get(String(steerId))).toBe("steer");

		const removedFollowUp = await app().request(`/api/conversations/${id}/submissions/${followUpId}`, {
			method: "DELETE",
		});
		expect(removedFollowUp.status).toBe(200);
		expect(((await removedFollowUp.json()) as { result: string }).result).toBe("aborted");

		const removedSteer = await app().request(`/api/conversations/${id}/submissions/${steerId}`, {
			method: "DELETE",
		});
		expect(((await removedSteer.json()) as { result: string }).result).toBe("aborted");

		const after = await stella.harness.snapshot(InboxDoc, id as ConversationId, BACKGROUND_CONTEXT);
		expect(after?.items ?? []).toHaveLength(0);

		release();
		await stella.harness.waitForIdle(BACKGROUND_CONTEXT);

		const page = await app().request(`/api/conversations/${id}/entries?before=999999`);
		const body = (await page.json()) as { entries: { kind: string }[] };
		expect(body.entries.filter((entry) => entry.kind === "pi.user")).toHaveLength(1);
	});
});
