/**
 * 上下文占用端点：优先 provider usage（faux 报 0 时退回估算），窗口来自模型目录，
 * 分解三段之和与 usedTokens 对齐。
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

describe("上下文占用", () => {
	let stella: Stella;
	let workspaceDir: string;

	/** 每个请求新建 app（无状态）：同一测试内的会话与 harness 不变。 */
	const app = () => createApp(stella);

	beforeEach(async () => {
		workspaceDir = await mkdtemp(join(tmpdir(), "stella-test-"));
		const config = loadConfig({ STELLA_FAUX: "1", STELLA_DATA_DIR: workspaceDir });
		stella = await createStella(config, {});
		stella.faux?.setResponses([fauxAssistantMessage("第一答。"), fauxAssistantMessage("第二答。")]);
	});

	afterEach(async () => {
		await stella.close();
		await rm(workspaceDir, { recursive: true, force: true });
	});

	async function answer(id: number, content: string): Promise<void> {
		const posted = await app().request(`/api/conversations/${id}/messages`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ content }),
		});
		expect(posted.status).toBe(202);
		const deadline = Date.now() + 10_000;
		for (;;) {
			const response = await app().request(`/api/conversations/${id}/entries?before=999999`);
			const page = (await response.json()) as { entries: readonly Entry[] };
			if (page.entries.at(-1)?.kind === "pi.assistant") return;
			if (Date.now() > deadline) throw new Error("等待回答超时");
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
	}

	async function context(id: number) {
		const response = await app().request(`/api/conversations/${id}/context`);
		expect(response.status).toBe(200);
		return (await response.json()) as {
			usedTokens: number;
			windowTokens: number | null;
			percent: number | null;
			breakdown: { system: number; tools: number; messages: number };
			model: { provider: string; modelId: string } | null;
			estimated: boolean;
		};
	}

	it("返回已用 token、窗口、百分比与三段分解，并随对话增长", async () => {
		const created = await app().request("/api/conversations", { method: "POST" });
		const { id } = (await created.json()) as { id: number };

		await answer(id, "第一问");
		const first = await context(id);
		expect(first.usedTokens).toBeGreaterThan(0);
		expect(first.windowTokens).toBe(128_000);
		expect(first.percent).not.toBeNull();
		expect(first.percent!).toBeGreaterThan(0);
		expect(first.percent!).toBeLessThanOrEqual(100);
		expect(first.model).toEqual({ provider: "faux", modelId: "faux-1" });
		const sum = first.breakdown.system + first.breakdown.tools + first.breakdown.messages;
		expect(Math.abs(sum - first.usedTokens)).toBeLessThanOrEqual(3);
		// faux 不报 usage.input，走估算
		expect(first.estimated).toBe(true);

		await answer(id, "第二问");
		const second = await context(id);
		expect(second.usedTokens).toBeGreaterThanOrEqual(first.usedTokens);
	});
});
