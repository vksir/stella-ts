/**
 * 文案与摘要单测（`src/store/labels.ts`）。
 *
 * 这些函数决定"失败时用户看到什么"和"工具行摘要显示什么"，属于产品文案契约。
 * 它们被 store 与组件共用，一旦被改动（少一种 reason、少一个工具名分支）不容易在
 * 人工点测中发现，所以用测试钉住。
 */

import { describe, expect, it } from "vitest";
import { failureCardText, stoppedText, summarizeToolCall } from "../src/store/labels";

describe("失败卡片文案", () => {
	it("每种已知失败原因都有独立中文说明", () => {
		const reasons = [
			"model_error",
			"no_model",
			"faulted",
			"interrupted",
			"restart_limit",
			"orphaned",
			"turn_limit",
			"nothing_to_answer",
		];
		const texts = reasons.map((reason) => failureCardText(reason, undefined));
		// 每条都以「本次」开头并是可读中文，不落进兜底分支
		for (const [index, text] of texts.entries()) {
			expect(text, reasons[index]).toMatch(/^本次/);
			expect(text, reasons[index]).not.toContain("原因：");
			expect(text, reasons[index]).toMatch(/。$/);
		}
		// 互不相同（没有两个原因共用同一句文案）
		expect(new Set(texts).size).toBe(reasons.length);
	});

	it("未知原因走兜底并带上原因名", () => {
		const text = failureCardText("some_new_reason", undefined);
		expect(text).toContain("本次回答失败");
		expect(text).toContain("some_new_reason");
	});

	it("缺省原因不报错（显示未知）", () => {
		expect(failureCardText(undefined, undefined)).toContain("未知");
	});

	it("有底层错误时追加 detail，空白 detail 视为没有", () => {
		expect(failureCardText("model_error", "HTTP 429")).toContain("底层错误：HTTP 429");
		expect(failureCardText("model_error", "   ")).toBe("本次回答失败：模型请求出错。");
		expect(failureCardText("model_error", "")).toBe("本次回答失败：模型请求出错。");
	});

	it("停止文案说明已生成部分保留", () => {
		expect(stoppedText()).toContain("已停止");
		expect(stoppedText()).toContain("已保留");
	});
});

describe("工具调用摘要", () => {
	it("bash 取 command 首行", () => {
		expect(summarizeToolCall("bash", { command: "ls -la" })).toBe("ls -la");
		expect(summarizeToolCall("bash", { command: "pwd\nwhoami" })).toBe("pwd");
	});

	it("read 取 path", () => {
		expect(summarizeToolCall("read", { path: "src/main.ts" })).toBe("src/main.ts");
	});

	it("write 带写入字数", () => {
		expect(summarizeToolCall("write", { path: "a.txt", content: "12345" })).toBe("a.txt（写入 5 字）");
	});

	it("edit 带替换前后字数", () => {
		expect(summarizeToolCall("edit", { path: "a.txt", oldText: "ab", newText: "cde" })).toBe(
			"a.txt（替换 2 字 → 3 字）",
		);
	});

	it("未知工具无字符串参数时回落 JSON 一行", () => {
		expect(summarizeToolCall("custom_tool", { a: 1 })).toBe('{"a":1}');
	});

	it("codemode 取脚本首个非空行", () => {
		expect(summarizeToolCall("codemode", { code: "\nconst x = await tools.read({path:'a'})" })).toBe(
			"const x = await tools.read({path:'a'})",
		);
		// 全是空白 → 退化为字数提示，不显示空白行
		expect(summarizeToolCall("codemode", { code: "   \n\n  " })).toBe("（脚本 7 字）");
	});

	it("subagent 取 task 首行", () => {
		expect(summarizeToolCall("subagent", { task: "调研 X 方案的可行性\n并给出结论" })).toBe(
			"调研 X 方案的可行性",
		);
	});

	it("未知工具优先挑像主语的字符串参数，而不是整段 JSON", () => {
		expect(summarizeToolCall("some_tool", { query: "关键词", other: 1 })).toBe("关键词");
		expect(summarizeToolCall("some_tool", { url: "https://example.com" })).toBe("https://example.com");
		// 没有可读字符串时才回落 JSON
		expect(summarizeToolCall("some_tool", { n: 3, flag: true })).toBe('{"n":3,"flag":true}');
	});

	it("超过 80 字截断加省略号", () => {
		const long = "x".repeat(120);
		const summary = summarizeToolCall("bash", { command: long });
		expect(summary.length).toBe(81);
		expect(summary.endsWith("…")).toBe(true);
	});

	it("参数缺失或类型不符不抛错", () => {
		expect(summarizeToolCall("bash", {})).toBe("");
		expect(summarizeToolCall("read", { path: 42 })).toBe("");
		expect(summarizeToolCall("write", { path: "p", content: null })).toBe("p（写入 0 字）");
	});
});
