/**
 * 流式高亮会话单测（`src/markdown/streaming-highlight.tsx`）。
 *
 * 锁的是**行级锁步**语义：早期按 N 行分批，流式里着色密度只有 11%，落定瞬间整块补色
 * （评审实测 dsh 是 84%）。四条断言：每完成一行就分词、行间 grammar 状态续接、
 * 已缓存行元素引用复用、末行改写只重算末行。
 */

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { StreamingHighlightSession } from "../src/markdown/streaming-highlight";

interface Call {
	code: string;
	hadState: boolean;
}

function fakeHighlighter() {
	const calls: Call[] = [];
	const highlighter = {
		codeToTokensWithThemes(code: string, options: { grammarState?: unknown }) {
			calls.push({ code, hadState: options.grammarState !== undefined });
			return code.split("\n").map((line) => [
				{ content: line || " ", variants: { light: { color: "#111111" }, dark: { color: "#eeeeee" } } },
			]);
		},
		getLastGrammarState(code: string) {
			return { marker: `state:${code.length}` };
		},
	} as never;
	return { highlighter, calls };
}

const THEMES = { light: "stella-light", dark: "stella-dark" };

describe("流式高亮会话（行级锁步）", () => {
	it("每完成一行就分词，且逐行续接 grammar 状态", () => {
		const { highlighter, calls } = fakeHighlighter();
		const session = new StreamingHighlightSession();
		session.render(highlighter, "a\nb\nc\n", "ts", THEMES);

		expect(calls.map((c) => c.code)).toEqual(["a", "b", "c"]);
		expect(calls.map((c) => c.hadState)).toEqual([false, true, true]);
	});

	it("文本增长时只对新增行分词（已缓存行不重算）", () => {
		const { highlighter, calls } = fakeHighlighter();
		const session = new StreamingHighlightSession();
		session.render(highlighter, "l1\nl2\n", "ts", THEMES);
		const after = calls.length;

		session.render(highlighter, "l1\nl2\nl3\nl4\n", "ts", THEMES);
		expect(calls.slice(after).map((c) => c.code)).toEqual(["l3", "l4"]);
	});

	it("末行未变不重算，增长时只重算末行", () => {
		const { highlighter, calls } = fakeHighlighter();
		const session = new StreamingHighlightSession();
		session.render(highlighter, "head\nconst a", "ts", THEMES);
		const afterFirst = calls.length;

		session.render(highlighter, "head\nconst a", "ts", THEMES);
		expect(calls.length).toBe(afterFirst);

		session.render(highlighter, "head\nconst a = 1", "ts", THEMES);
		expect(calls.slice(afterFirst).map((c) => c.code)).toEqual(["const a = 1"]);
	});

	it("末行被改写时回退到该行重算，之前的行保持", () => {
		const { highlighter, calls } = fakeHighlighter();
		const session = new StreamingHighlightSession();
		session.render(highlighter, "l1\nl2\nl3\n", "ts", THEMES);
		const after = calls.length;

		session.render(highlighter, "l1\nl2-changed\nl3\n", "ts", THEMES);
		expect(calls.slice(after).map((c) => c.code)).toEqual(["l2-changed", "l3"]);
	});

	it("渲染结果包含全部行，不漏不重", () => {
		const { highlighter } = fakeHighlighter();
		const session = new StreamingHighlightSession();
		const out = session.render(highlighter, "alpha\nbeta\ngamma", "ts", THEMES);
		const html = renderToStaticMarkup(out as never);
		for (const word of ["alpha", "beta", "gamma"]) expect(html).toContain(word);
		expect((html.match(/alpha/g) ?? []).length).toBe(1);
	});

	it("超过行数上限时整体退回纯文本（返回 null）", () => {
		const { highlighter, calls } = fakeHighlighter();
		const session = new StreamingHighlightSession();
		const many = Array.from({ length: 420 }, (_, i) => `l${i}`).join("\n");
		expect(session.render(highlighter, `${many}\n`, "ts", THEMES)).toBe(null);
		expect(calls.length).toBe(0);
	});

	it("超长行退回纯文本（返回 null）", () => {
		const { highlighter, calls } = fakeHighlighter();
		const session = new StreamingHighlightSession();
		const long = "x".repeat(1200);
		expect(session.render(highlighter, `${long}\nok\n`, "ts", THEMES)).toBe(null);
		expect(calls.length).toBe(0);
	});

	it("换语言会重置缓存（避免用错 grammar 续接）", () => {
		const { highlighter, calls } = fakeHighlighter();
		const session = new StreamingHighlightSession();
		session.render(highlighter, "a\nb\n", "ts", THEMES);
		const afterTs = calls.length;

		session.render(highlighter, "a\nb\n", "python", THEMES);
		expect(calls.length).toBe(afterTs + 2);
		expect(calls[afterTs]?.hadState).toBe(false);
		expect(calls[calls.length - 1]?.hadState).toBe(true);
	});

	it("分词失败时该行按纯文本渲染，不抛错不丢字", () => {
		let failNext = true;
		const highlighter = {
			codeToTokensWithThemes(code: string) {
				if (failNext) {
					failNext = false;
					throw new Error("boom");
				}
				return [[{ content: code, variants: { light: { color: "#111" }, dark: { color: "#eee" } } }]];
			},
			getLastGrammarState: () => ({}),
		} as never;
		const session = new StreamingHighlightSession();
		const out = session.render(highlighter, "alpha\nbeta\n", "ts", THEMES);
		const html = renderToStaticMarkup(out as never);
		expect(html).toContain("alpha");
		expect(html).toContain("beta");
	});
});
