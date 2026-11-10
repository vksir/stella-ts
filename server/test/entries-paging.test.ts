/**
 * 条目翻页端点（票：断线重连补缺口）：
 * - `before`：取更早的一页（升序返回，`hasMore` 说明还有没有）。
 * - `after` + `upTo`：取缺口内的一页（严格开区间），供客户端补上窗口跳跃造成的缺失段。
 * 条目 ID 有空洞，端点只接受开区间边界，不按 ID 推算条目数——与 pi-durable
 * `ConversationTranscript` 的 `loadEarlier` / `fillGap` 对齐。
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

interface EntriesPage {
	readonly entries: readonly Entry[];
	readonly hasMore: boolean;
}

/** 取一段：`before` 或 `after` + `upTo`。 */
async function fetchEntries(
	app: ReturnType<typeof createApp>,
	id: number,
	query: { before?: number; after?: number; upTo?: number },
): Promise<{ status: number; page?: EntriesPage; error?: string }> {
	const params = new URLSearchParams();
	if (query.before !== undefined) params.set("before", String(query.before));
	if (query.after !== undefined) params.set("after", String(query.after));
	if (query.upTo !== undefined) params.set("upTo", String(query.upTo));
	const response = await app.request(`/api/conversations/${id}/entries?${params.toString()}`);
	const body = (await response.json()) as EntriesPage & { error?: string };
	return response.ok ? { status: response.status, page: body } : { status: response.status, error: body.error };
}

/** 全部条目（`before` 传一个大 ID，等价于"从头取"）；未回答完时轮询。 */
async function allEntries(app: ReturnType<typeof createApp>, id: number): Promise<Entry[]> {
	const deadline = Date.now() + 10_000;
	for (;;) {
		const { page } = await fetchEntries(app, id, { before: 999_999 });
		if (page !== undefined && page.entries.at(-1)?.kind === "pi.assistant") return [...page.entries];
		if (Date.now() > deadline) throw new Error("等待回答条目超时");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

describe("条目翻页：before / after+upTo", () => {
	let stella: Stella;
	let workspaceDir: string;

	beforeEach(async () => {
		workspaceDir = await mkdtemp(join(tmpdir(), "stella-test-"));
		const config = loadConfig({ STELLA_FAUX: "1", STELLA_DATA_DIR: workspaceDir });
		stella = await createStella(config, {});
		stella.faux?.setResponses([
			fauxAssistantMessage("第一条回答。"),
			fauxAssistantMessage("第二条回答。"),
			fauxAssistantMessage("第三条回答。"),
		]);
	});

	afterEach(async () => {
		await stella.close();
		await rm(workspaceDir, { recursive: true, force: true });
	});

	it("before 排除该条目本身，返回升序与 hasMore", async () => {
		const app = createApp(stella);
		const created = await app.request("/api/conversations", { method: "POST" });
		const { id } = (await created.json()) as { id: number };
		for (const text of ["第一问", "第二问", "第三问"]) {
			const posted = await app.request(`/api/conversations/${id}/messages`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ content: text }),
			});
			expect(posted.status).toBe(202);
			await allEntries(app, id); // 等这一轮回答落定
		}
		const all = await allEntries(app, id);
		expect(all.length).toBeGreaterThanOrEqual(6);

		const newest = all.at(-1)!;
		const { status, page } = await fetchEntries(app, id, { before: newest.id });
		expect(status).toBe(200);
		expect(page?.entries.map((entry) => entry.id)).toEqual(all.slice(0, -1).map((entry) => entry.id));
		expect(page?.hasMore).toBe(false);
	});

	it("after + upTo 只返回开区间内的条目（升序）", async () => {
		const app = createApp(stella);
		const created = await app.request("/api/conversations", { method: "POST" });
		const { id } = (await created.json()) as { id: number };
		const posted = await app.request(`/api/conversations/${id}/messages`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ content: "唯一一问" }),
		});
		expect(posted.status).toBe(202);
		const all = await allEntries(app, id);
		const first = all[0]!;
		const last = all.at(-1)!;

		const { status, page } = await fetchEntries(app, id, { after: first.id, upTo: last.id });
		expect(status).toBe(200);
		expect(page?.entries.map((entry) => entry.id)).toEqual(all.slice(1, -1).map((entry) => entry.id));
		expect(page?.hasMore).toBe(false);
	});

	it("非法查询返回 400", async () => {
		const app = createApp(stella);
		const created = await app.request("/api/conversations", { method: "POST" });
		const { id } = (await created.json()) as { id: number };

		expect((await fetchEntries(app, id, {})).status).toBe(400);
		expect((await fetchEntries(app, id, { before: 0 })).status).toBe(400);
		expect((await fetchEntries(app, id, { after: 5 })).status).toBe(400); // 缺 upTo
		expect((await fetchEntries(app, id, { after: 5, upTo: 5 })).status).toBe(400); // upTo 必须大于 after
	});
});
