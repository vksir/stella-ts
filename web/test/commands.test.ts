/**
 * 斜杠指令表单测（`src/store/commands.ts`）。
 *
 * 规则要点：只有整条输入还是"指令名片段"时才弹菜单（出现空白即收起）；提交时只有
 * **已登记**的名字才被拦成本地动作，`/usr/bin/env` 这类正文照常发给模型。
 */

import { describe, expect, it } from "vitest";
import { availableCommands, matchCommands, parseCommand, slashQuery, usageOf } from "../src/store/commands";

describe("slashQuery：何时弹指令菜单", () => {
	it("刚敲下 / 时片段为空（列出全部指令）", () => {
		expect(slashQuery("/")).toBe("");
	});

	it("指令名片段返回 / 之后的部分", () => {
		expect(slashQuery("/comp")).toBe("comp");
	});

	it("出现空白（进入参数区）即收起", () => {
		expect(slashQuery("/compact 保留工具结果")).toBeUndefined();
		expect(slashQuery("/compact\n第二行")).toBeUndefined();
	});

	it("正文里出现 / 不弹菜单", () => {
		expect(slashQuery("看看 /usr/bin")).toBeUndefined();
		expect(slashQuery("")).toBeUndefined();
	});
});

describe("matchCommands：过滤与排序", () => {
	it("空片段返回全部可用指令", () => {
		expect(matchCommands("").map((spec) => spec.name)).toEqual(["compact", "new", "stop", "skill"]);
	});

	it("名字前缀命中排在最前", () => {
		expect(matchCommands("n").map((spec) => spec.name)).toEqual(["new"]);
		expect(matchCommands("co").map((spec) => spec.name)).toEqual(["compact"]);
	});

	it("描述命中也能找到（支持直接敲中文）", () => {
		expect(matchCommands("停止").map((spec) => spec.name)).toEqual(["stop"]);
	});

	it("无命中返回空", () => {
		expect(matchCommands("zzz")).toEqual([]);
	});
});

describe("availableCommands：运行中才有的指令", () => {
	it("空闲时不列 /stop", () => {
		expect(availableCommands({ busy: false }).map((spec) => spec.name)).toEqual(["compact", "new", "skill"]);
	});

	it("运行中列出 /stop", () => {
		expect(availableCommands({ busy: true }).map((spec) => spec.name)).toEqual(["compact", "new", "stop", "skill"]);
	});
});

describe("parseCommand：提交时拦截哪些输入", () => {
	it("无参指令 args 为空", () => {
		const parsed = parseCommand("/new");
		expect(parsed?.spec.name).toBe("new");
		expect(parsed?.args).toBe("");
	});

	it("带参指令保留参数原文（折叠多余空白）", () => {
		expect(parseCommand("/compact   保留工具结果 ")?.args).toBe("保留工具结果");
	});

	it("冒号参数与空格参数等价（/skill:名字 要求）", () => {
		expect(parseCommand("/skill:alpha 让它更简洁")?.args).toBe("alpha 让它更简洁");
		expect(parseCommand("/skill:alpha")?.args).toBe("alpha");
		expect(parseCommand("/skill alpha")?.args).toBe("alpha");
	});

	it("名字大小写不敏感", () => {
		expect(parseCommand("/Compact")?.spec.name).toBe("compact");
	});

	it("未登记的名字与路径不当指令（照常发给模型）", () => {
		expect(parseCommand("/usr/bin/env")).toBeUndefined();
		expect(parseCommand("/foo")).toBeUndefined();
		expect(parseCommand("hello")).toBeUndefined();
	});

	it("用法展示带参数占位", () => {
		expect(usageOf({ name: "compact", args: "[说明]", description: "" })).toBe("/compact [说明]");
		expect(usageOf({ name: "new", description: "" })).toBe("/new");
	});
});
