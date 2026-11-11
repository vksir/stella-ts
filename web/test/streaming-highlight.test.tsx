/**
 * 流式高亮会话单测（`src/markdown/streaming-highlight.tsx`）。
 *
 * 用假 highlighter 驱动，验证四件事（这些是"流式不卡且不闪"的前提）：
 * 1. 只有**整行**进缓存，末行（还在增长）保持纯文本；
 * 2. 跨批 grammar 状态续接（多行字符串这类语法在流式中也正确）；
 * 3. 已缓存批次的元素**引用复用**（React 按引用跳过重渲，不会每 chunk 重算全部）；
 * 4. 两道护栏：超长行不分词、超行数上限整体退回纯文本。
 */

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { StreamingHighlightSession } from "../src/markdown/streaming-highlight";

interface Call {
	code: string;
	hadState: boolean;
}

/** 假 highlighter：按行产出 token，并记录 grammar 状态的传递情况。 */
function fakeHighlighter() {
	const calls: Call[] = [];
	let tokenize = 0;
	const highlighter = {
		codeToTokensWithThemes(code: string, options: { grammarState?: unknown }) {
			calls.push({ code, hadState: options.grammarState !== undefined });
			tokenize += 1;
			return code.split("\n").map((line) => [
				{ content: line, variants: { light: { color: "#111111" }, dark: { color: "#eeeeee" } } },
			]);
		},
		getLastGrammarState(code: string) {
			return { marker: `state:${code.length}` };
		},
	} as never;
	return { highlighter, calls, tokenizeCount: () => tokenize };
}

const THEMES = { light: "stella-light", dark: "stella-dark" };

describe("流式高亮会话", () => {
	it("末行（仍在增长）不进 token 缓存，保持纯文本", () => {
		const { highlighter, calls } = fakeHighlighter();
		const session = new StreamingHighlightSession();
		// 只有一行且没有换行 → 没有"完成的整行"，不应有任何分词调用
		const out = session.render(highlighter, "const a = 1", "ts", THEMES);
		expect(calls.length).toBe(0);
		expect(renderToStaticMarkup(out as never)).toContain("const a = 1");
	});

	it("满一批（BATCH_LINES=8 行）才分词，且下批续接 grammar 状态", () => {
		const { highlighter, calls } = fakeHighlighter();
		const session = new StreamingHighlightSession();
		const lines = Array.from({ length: 9 }, (_, i) => `line${i}`);
		// 9 行 + 末尾空行（split 多一个空串 → 9 个完成行 = 1 满批）
		const code = `${lines.join("\n")}\n`;

		session.render(highlighter, code, "ts", THEMES);
		// 第一批 8 行分词（第 1 次调用），状态为空
		expect(calls.length).toBe(1);
		expect(calls[0]?.code.split("\n").length).toBe(8);
		expect(calls[0]?.hadState).toBe(false);

		// 再长一批：第 2 次调用应带上第一批末尾的 grammar 状态
		const more = Array.from({ length: 9 }, (_, i) => `line${i + 9}`);
		session.render(highlighter, `${code}${more.join("\n")}\n`, "ts", THEMES);
		expect(calls.length).toBe(2);
		expect(calls[1]?.hadState).toBe(true);
	});

	it("已缓存批次不重复分词（同长度追加时命中缓存）", () => {
		const { highlighter, calls } = fakeHighlighter();
		const session = new StreamingHighlightSession();
		const lines = Array.from({ length: 40 }, (_, i) => `l${i}`);
		const code = `${lines.join("\n")}\n`;
		session.render(highlighter, code, "ts", THEMES);
		const after = calls.length;
		// 同一份 code 再渲染一次：全部命中缓存，不再分词
		session.render(highlighter, code, "ts", THEMES);
		expect(calls.length).toBe(after);
	});

	it("末行内容改写时，受影响批次被丢弃并重算（保守但正确）", () => {
		const { highlighter, calls } = fakeHighlighter();
		const session = new StreamingHighlightSession();
		const base = Array.from({ length: 9 }, (_, i) => `l${i}`);
		session.render(highlighter, `${base.join("\n")}\n`, "ts", THEMES);
		const firstRound = calls.length;

		// 第 8 行（0-based 7）被改写 → 该批失效
		const changed = [...base];
		changed[7] = "l7-changed";
		session.render(highlighter, `${changed.join("\n")}\n`, "ts", THEMES);
		expect(calls.length).toBeGreaterThan(firstRound);
	});

	it("超过行数上限时整体放弃流式高亮（返回 null，交给落定路径）", () => {
		const { highlighter, calls } = fakeHighlighter();
		const session = new StreamingHighlightSession();
		const code = `${Array.from({ length: 260 }, (_, i) => `l${i}`).join("\n")}\n`;
		expect(session.render(highlighter, code, "ts", THEMES)).toBe(null);
		expect(calls.length).toBe(0);
	});

	it("超长行不分词（正则引擎最坏情况保护）", () => {
		const { highlighter, calls } = fakeHighlighter();
		const session = new StreamingHighlightSession();
		const long = "x".repeat(1200);
		const code = `${long}\nmore\n`;
		expect(session.render(highlighter, code, "ts", THEMES)).toBe(null);
		expect(calls.length).toBe(0);
	});

	it("换语言或换主题会重置缓存（避免用错 grammar 续接）", () => {
		const { highlighter, calls } = fakeHighlighter();
		const session = new StreamingHighlightSession();
		const code = `${Array.from({ length: 9 }, (_, i) => `l${i}`).join("\n")}\n`;
		session.render(highlighter, code, "ts", THEMES);
		const afterTs = calls.length;
		session.render(highlighter, code, "python", THEMES);
		expect(calls.length).toBe(afterTs + 1);
		expect(calls[calls.length - 1]?.hadState).toBe(false); // 新语言不带旧状态
	});

	it("分词失败时回落纯文本，不抛错（流式中断也要能看）", () => {
		const broken = {
			codeToTokensWithThemes() {
				throw new Error("boom");
			},
			getLastGrammarState() {
				return {};
			},
		} as never;
		const session = new StreamingHighlightSession();
		const code = `${Array.from({ length: 9 }, (_, i) => `l${i}`).join("\n")}\n`;
		const out = session.render(broken, code, "ts", THEMES);
		expect(out).not.toBe(null);
		expect(renderToStaticMarkup(out as never)).toContain("l0");
	});
});
