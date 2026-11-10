/**
 * code mode 冒烟：标准预设启用 `codemode`，脚本在 QuickJS worker 里执行并把输出作为工具结果。
 */
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/api.js";
import { loadConfig } from "../src/config.js";
import { createStella, type Stella } from "../src/stella.js";

interface ToolResultEntry {
	readonly kind: string;
	readonly model?: readonly { readonly content?: readonly { readonly text?: string }[]; readonly isError?: boolean }[];
}

describe("code mode", () => {
	let stella: Stella;
	let workspaceDir: string;

	beforeEach(async () => {
		workspaceDir = await mkdtemp(join(tmpdir(), "stella-test-"));
		stella = await createStella(loadConfig({ STELLA_FAUX: "1", STELLA_DATA_DIR: workspaceDir }), {});
		stella.faux?.setResponses([
			fauxAssistantMessage([fauxToolCall("codemode", { code: "return 1 + 1;" }, { id: "c1" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("完成"),
		]);
	});

	afterEach(async () => {
		await stella.close();
		await rm(workspaceDir, { recursive: true, force: true });
	});

	it("执行脚本并把结果作为工具结果返回", async () => {
		const app = createApp(stella);
		const created = await app.request("/api/conversations", { method: "POST" });
		const { id } = (await created.json()) as { id: number };
		const posted = await app.request(`/api/conversations/${id}/messages`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ content: "算一下 1+1" }),
		});
		expect(posted.status).toBe(202);

		const deadline = Date.now() + 30_000;
		for (;;) {
			const response = await app.request(`/api/conversations/${id}/entries?before=999999`);
			const page = (await response.json()) as { entries: readonly ToolResultEntry[] };
			const result = page.entries.find((entry) => entry.kind === "pi.tool-result");
			if (result !== undefined) {
				const message = result.model?.[0];
				expect(message?.isError).toBe(false);
				const text = (message?.content ?? []).map((block) => block.text ?? "").join("");
				expect(text).toContain("2");
				return;
			}
			if (Date.now() > deadline) throw new Error("等待 code mode 结果超时");
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
	}, 40_000);
});
