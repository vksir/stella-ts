/**
 * 预设：配置文件里的预设解析进 pi.agent（工具集 / maxTurns），创建会话时选择，列表与设置端点回报。
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId } from "@earendil-works/pi-durable";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/api.js";
import { loadConfig } from "../src/config.js";
import { createStella, type Stella } from "../src/stella.js";

describe("预设：配置解析与创建会话", () => {
	let stella: Stella;
	let workspaceDir: string;

	beforeEach(async () => {
		workspaceDir = await mkdtemp(join(tmpdir(), "stella-test-"));
		const config = loadConfig({ STELLA_FAUX: "1", STELLA_DATA_DIR: workspaceDir });
		await writeFile(
			config.configPath,
			JSON.stringify({
				defaultPreset: "readonly",
				presets: [{ id: "readonly", name: "只读", tools: ["read"], maxTurns: 5 }],
			}),
			"utf8",
		);
		stella = await createStella(config, {});
	});

	afterEach(async () => {
		await stella.close();
		await rm(workspaceDir, { recursive: true, force: true });
	});

	it("GET /api/presets 返回内置 + 文件预设与默认值", async () => {
		const app = createApp(stella);
		const response = await app.request("/api/presets");
		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			presets: { id: string; name: string; default: boolean; builtin: boolean; missing: string[] }[];
			defaultPreset: string;
			defaultMaxTurns: number;
		};
		expect(body.defaultPreset).toBe("readonly");
		expect(body.defaultMaxTurns).toBe(128);
		const ids = body.presets.map((preset) => preset.id);
		expect(ids).toEqual(["standard", "readonly"]);
		expect(body.presets.find((preset) => preset.id === "readonly")?.default).toBe(true);
		expect(body.presets.every((preset) => preset.missing.length === 0)).toBe(true);
	});

	it("创建会话时解析预设：工具集与 maxTurns 写入 pi.agent", async () => {
		const app = createApp(stella);

		const created = await app.request("/api/conversations", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({}),
		});
		expect(created.status).toBe(201);
		const { id, preset } = (await created.json()) as { id: number; preset: string };
		expect(preset).toBe("readonly");

		const conversation = await stella.harness.conversation(id as ConversationId, BACKGROUND_CONTEXT);
		const agent = await conversation!.agent(BACKGROUND_CONTEXT);
		expect(agent.tools.map((tool) => tool.name)).toEqual(["read"]);
		expect(agent.maxTurns).toBe(5);

		const settings = await app.request(`/api/conversations/${id}/settings`);
		const settingsBody = (await settings.json()) as { preset: string | null };
		expect(settingsBody.preset).toBe("readonly");

		const list = await app.request("/api/conversations");
		const listBody = (await list.json()) as { conversations: { id: number; preset: string | null }[] };
		expect(listBody.conversations.find((item) => item.id === id)?.preset).toBe("readonly");
	});

	it("标准预设启用全部已安装工具", async () => {
		const app = createApp(stella);
		const created = await app.request("/api/conversations", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ preset: "standard" }),
		});
		const { id } = (await created.json()) as { id: number };
		const conversation = await stella.harness.conversation(id as ConversationId, BACKGROUND_CONTEXT);
		const agent = await conversation!.agent(BACKGROUND_CONTEXT);
		const names = agent.tools.map((tool) => tool.name);
		expect(names).toEqual(expect.arrayContaining(["read", "write", "edit", "bash", "codemode", "subagent"]));
		expect(agent.maxTurns).toBe(128);
	});

	it("未知预设返回 400", async () => {
		const app = createApp(stella);
		const response = await app.request("/api/conversations", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ preset: "nope" }),
		});
		expect(response.status).toBe(400);
		const body = (await response.json()) as { error: string };
		expect(body.error).toContain("nope");
	});
});
