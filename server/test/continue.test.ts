/**
 * 续跑（continue）：失败后的重试不新增用户消息，直接让模型回答停住的上下文。
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

interface Entry {
	readonly id: number;
	readonly kind: string;
	readonly model?: readonly {
		readonly role: string;
		readonly content: string | ContentBlock[];
		readonly stopReason?: string;
	}[];
}

describe("续跑：失败重试不重复用户消息", () => {
	let stella: Stella;
	let workspaceDir: string;

	/** 每个请求新建 app（无状态）：同一测试内的会话与 harness 不变。 */
	const app = () => createApp(stella);

	beforeEach(async () => {
		workspaceDir = await mkdtemp(join(tmpdir(), "stella-test-"));
		const config = loadConfig({ STELLA_FAUX: "1", STELLA_DATA_DIR: workspaceDir });
		stella = await createStella(config, {});
		stella.faux?.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "模拟的模型故障" }),
			fauxAssistantMessage("续跑后的正常回答。"),
		]);
	});

	afterEach(async () => {
		await stella.close();
		await rm(workspaceDir, { recursive: true, force: true });
	});

	async function entries(id: number): Promise<readonly Entry[]> {
		const response = await app().request(`/api/conversations/${id}/entries?before=999999`);
		return ((await response.json()) as { entries: readonly Entry[] }).entries;
	}

	async function waitFor(id: number, predicate: (entries: readonly Entry[]) => boolean): Promise<readonly Entry[]> {
		const deadline = Date.now() + 10_000;
		for (;;) {
			const page = await entries(id);
			if (predicate(page)) return page;
			if (Date.now() > deadline) throw new Error("等待条目超时");
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
	}

	it("失败后 POST { continue: true } 得到回答，且只有一条 pi.user", async () => {
		const created = await app().request("/api/conversations", { method: "POST" });
		const { id } = (await created.json()) as { id: number };

		const posted = await app().request(`/api/conversations/${id}/messages`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ content: "会失败的问题" }),
		});
		expect(posted.status).toBe(202);

		await waitFor(id, (page) =>
			page.some((entry) => entry.kind === "pi.assistant" && entry.model?.[0]?.stopReason === "error"),
		);

		const resumed = await app().request(`/api/conversations/${id}/messages`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ continue: true }),
		});
		expect(resumed.status).toBe(202);

		const page = await waitFor(id, (list) =>
			list.some((entry) => {
				const message = entry.model?.[0];
				if (entry.kind !== "pi.assistant" || message?.stopReason !== "stop") return false;
				const text = Array.isArray(message.content)
					? message.content.map((block) => block.text ?? "").join("")
					: message.content;
				return text.includes("续跑后的正常回答");
			}),
		);

		expect(page.filter((entry) => entry.kind === "pi.user")).toHaveLength(1);
		const answers = page.filter(
			(entry) => entry.kind === "pi.assistant" && entry.model?.[0]?.stopReason === "stop",
		);
		expect(answers).toHaveLength(1);
	});
});
