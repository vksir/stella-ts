/**
 * 前台子代理：模型调用 `subagent` → 创建子会话 → 子会话回答 → 文本回到父会话；
 * 子会话带 owner，不进入会话列表。
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/api.js";
import { loadConfig } from "../src/config.js";
import { createStella, type Stella } from "../src/stella.js";

interface Entry {
	readonly kind: string;
	readonly model?: readonly {
		readonly content?: readonly { readonly type?: string; readonly text?: string }[];
		readonly details?: { readonly conversationId?: number };
		readonly isError?: boolean;
	}[];
}

describe("前台子代理", () => {
	let stella: Stella;
	let workspaceDir: string;

	beforeEach(async () => {
		workspaceDir = await mkdtemp(join(tmpdir(), "stella-test-"));
		stella = await createStella(loadConfig({ STELLA_FAUX: "1", STELLA_DATA_DIR: workspaceDir }), {});
		stella.faux?.setResponses([
			fauxAssistantMessage([fauxToolCall("subagent", { task: "说一句话" }, { id: "s1" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("子代理回答"),
			fauxAssistantMessage("父代理完成"),
		]);
	});

	afterEach(async () => {
		await stella.close();
		await rm(workspaceDir, { recursive: true, force: true });
	});

	it("子会话回答回到父会话，且子会话不进列表", async () => {
		const app = createApp(stella);
		const created = await app.request("/api/conversations", { method: "POST" });
		const { id } = (await created.json()) as { id: number };
		const posted = await app.request(`/api/conversations/${id}/messages`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ content: "派个子代理" }),
		});
		expect(posted.status).toBe(202);

		const deadline = Date.now() + 30_000;
		let resultEntry: Entry | undefined;
		for (;;) {
			const response = await app.request(`/api/conversations/${id}/entries?before=999999`);
			const page = (await response.json()) as { entries: readonly Entry[] };
			resultEntry = page.entries.find((entry) => entry.kind === "pi.tool-result");
			if (resultEntry !== undefined) break;
			if (Date.now() > deadline) throw new Error("等待子代理结果超时");
			await new Promise((resolve) => setTimeout(resolve, 50));
		}

		const message = resultEntry?.model?.[0];
		expect(message?.isError).toBe(false);
		const text = (message?.content ?? []).map((block) => block.text ?? "").join("");
		expect(text).toContain("子代理回答");

		const childId = message?.details?.conversationId;
		expect(Number.isInteger(childId)).toBe(true);
		const child = await stella.harness.conversation(childId! as ConversationId, BACKGROUND_CONTEXT);
		expect(child).toBeDefined();

		const list = await app.request("/api/conversations");
		const listBody = (await list.json()) as { conversations: { id: number }[] };
		expect(listBody.conversations.map((item) => item.id)).toEqual([id]);

		const all = await stella.harness.commit(
			async (tx) => (await tx.scanConversations({}, 100)).items.map((record) => record.id),
			BACKGROUND_CONTEXT,
		);
		expect(all).toHaveLength(2); // 父会话 + 子会话
	});
});
