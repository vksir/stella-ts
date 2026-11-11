/**
 * 流式高亮 × 真实 shiki 集成测试。
 *
 * 用真的 highlighter（与页面同一套主题与语言包）跑一次流式渲染，断言：
 * 1. token 带双主题颜色（variants 里 key 是 themes 映射里的 light/dark）；
 * 2. 已着色字符占比接近 100%（含关键字、字符串、注释）；
 * 3. 与落定路径（codeToHtml）色板一致。
 *
 * 这层测试是必要的：假 highlighter 只能验证缓存/续接逻辑，验证不了
 * "variants 键名写错导致 span 没有 style"这类真实集成问题。
 */

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { StreamingHighlightSession } from "../src/markdown/streaming-highlight";
import { highlightResolved, streamingHighlighter } from "../src/markdown/highlight-shiki";

const CODE = [
  '// 注释一行',
  'const text = "字符串";',
  "function add(a, b) {",
  "  return a + b;",
  "}",
].join(String.fromCharCode(10)) + String.fromCharCode(10);

describe("流式高亮 × 真实 shiki", () => {
	it("流式渲染的 span 带双主题颜色（variants 键名正确）", async () => {
		const { highlighter, themes } = await streamingHighlighter();
		const session = new StreamingHighlightSession();
		const node = session.render(highlighter, CODE, "typescript", themes);
		expect(node).not.toBe(null);
		const html = renderToStaticMarkup(node as never);
		expect(html).toContain("--shiki-light");
		expect(html).toContain("--shiki-dark");
		// 关键字 const 必须被染色
		expect(html).toMatch(/<span style="[^"]*--shiki-light/);
	});

	it("非空字符全部落在着色 span 里（行级锁步，不留黑尾巴）", async () => {
		const { highlighter, themes } = await streamingHighlighter();
		const session = new StreamingHighlightSession();
		const html = renderToStaticMarkup(session.render(highlighter, CODE, "typescript", themes) as never);
		// 行间换行是本组件自己插的文本节点，不计入覆盖率
		const visible = (text) => text.replace(/\s+/g, "").length;
		const plain = html.replace(/<[^>]+>/g, "");
		const styledText = [...html.matchAll(/<span style="[^"]*">([^<]*)<\/span>/g)].map((m) => m[1]).join("");
		expect(visible(styledText)).toBe(visible(plain));
		expect(visible(plain)).toBeGreaterThan(20); // 断言不是空跑
	});

	it("与落定路径色板一致（parity）", async () => {
		const { highlighter, themes } = await streamingHighlighter();
		const session = new StreamingHighlightSession();
		const streamHtml = renderToStaticMarkup(session.render(highlighter, CODE, "typescript", themes) as never);
		const settledHtml = await highlightResolved(CODE, "typescript");
		const palette = (html) => [...new Set([...html.matchAll(/--shiki-light:s*(#[0-9A-Fa-f]{6})/g)].map((m) => m[1].toUpperCase()))].sort();
		expect(palette(streamHtml)).toEqual(palette(settledHtml));
	});
});
