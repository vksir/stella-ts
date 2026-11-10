/**
 * 运行配置：解析、合并、失败回退。热更新的 fs.watch 只做接线，实际重读逻辑直接测 reload()。
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	DEFAULT_MAX_TURNS,
	DEFAULT_RUNTIME_CONFIG,
	StellaSettingsStore,
	resolveRuntimeConfig,
} from "../src/settings.js";

describe("运行配置解析", () => {
	it("空/非法配置回落到内置默认值", () => {
		expect(resolveRuntimeConfig(undefined)).toEqual(DEFAULT_RUNTIME_CONFIG);
		expect(resolveRuntimeConfig(null)).toEqual(DEFAULT_RUNTIME_CONFIG);
		expect(resolveRuntimeConfig("nope")).toEqual(DEFAULT_RUNTIME_CONFIG);
	});

	it("settings 与 defaultMaxTurns 覆盖默认值，stream 逐字段合并", () => {
		const config = resolveRuntimeConfig({
			defaultMaxTurns: 7,
			settings: { stream: { timeoutMs: 5 }, retry: { maxRetries: 1 } },
		});
		expect(config.defaultMaxTurns).toBe(7);
		expect(config.settings.stream?.timeoutMs).toBe(5);
		expect(config.settings.retry).toEqual({ maxRetries: 1 });
	});

	it("内置 standard 始终存在；文件同名预设整体覆盖，非法预设与未知默认值回落", () => {
		const config = resolveRuntimeConfig({
			defaultPreset: "nope",
			presets: [
				{ id: "readonly", name: "只读", tools: ["read"], maxTurns: 5 },
				{ id: "Bad Id", tools: ["read"] },
				{ id: "standard", name: "自定义标准" },
			],
		});
		expect(config.defaultPreset).toBe("standard");
		const ids = config.presets.map((preset) => preset.id);
		expect(ids).toContain("standard");
		expect(ids).toContain("readonly");
		expect(ids).not.toContain("Bad Id");
		expect(config.presets.find((preset) => preset.id === "standard")?.name).toBe("自定义标准");
		expect(config.presets.find((preset) => preset.id === "readonly")?.maxTurns).toBe(5);
	});

	it("defaultMaxTurns 非法时回落 128", () => {
		for (const value of [0, -1, 1.5, "8", null]) {
			expect(resolveRuntimeConfig({ defaultMaxTurns: value }).defaultMaxTurns).toBe(DEFAULT_MAX_TURNS);
		}
	});
});

describe("配置存储：读取与失败回退", () => {
	let dir: string;
	let path: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "stella-config-"));
		path = join(dir, "stella.config.json");
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("文件不存在时保持默认值", () => {
		const store = new StellaSettingsStore(path);
		store.load();
		expect(store.runtime).toEqual(DEFAULT_RUNTIME_CONFIG);
		store.stop();
	});

	it("读到新值后生效；解析失败保留上一份", async () => {
		await writeFile(path, JSON.stringify({ defaultMaxTurns: 9 }), "utf8");
		const store = new StellaSettingsStore(path);
		store.load();
		expect(store.runtime.defaultMaxTurns).toBe(9);

		await writeFile(path, "{ not json", "utf8");
		expect(store.reload()).toBe(false);
		expect(store.runtime.defaultMaxTurns).toBe(9);

		await writeFile(path, JSON.stringify({ defaultMaxTurns: 11 }), "utf8");
		expect(store.reload()).toBe(true);
		expect(store.runtime.defaultMaxTurns).toBe(11);
		store.stop();
	});
});
