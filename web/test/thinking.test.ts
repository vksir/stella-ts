/**
 * 思考内容（thinking 块）契约单测。
 *
 * 两件事必须钉住：
 * 1. `extractThinking` 的抽取语义——只取非空、非 redacted 的 thinking 块，
 *    多块用空行连接（pi-ai 的 ThinkingContent 形状见 @earendil-works/pi-ai）；
 * 2. `ThinkingBlock` 的 DOM 契约——类名由 style.css 逐条样式化，改名不会报错，
 *    只会静默丢样式（与 markdown-view.test.tsx 同一套路，renderToStaticMarkup 无需 jsdom）。
 */

import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { type ContentBlock, extractThinking, extractThinkingOf } from "../src/api";
import { ThinkingBlock } from "../src/ui/ChatFlow";

describe("extractThinking", () => {
	it("多个 thinking 块用空行连接", () => {
		const content: ContentBlock[] = [
			{ type: "thinking", thinking: "先看目录。" },
			{ type: "text", text: "好的。" },
			{ type: "thinking", thinking: "再改文件。" },
		];
		expect(extractThinkingOf(content)).toBe("先看目录。\n\n再改文件。");
	});

	it("跳过 redacted / 空白 / 非字符串 thinking 块", () => {
		const content: ContentBlock[] = [
			{ type: "thinking", thinking: "读得到。" },
			{ type: "thinking", thinking: "被抹掉。", redacted: true },
			{ type: "thinking", thinking: "   " },
			{ type: "thinking" },
			{ type: "thinking", thinking: "" },
			{ type: "text", text: "正文不算思考。" },
		];
		expect(extractThinkingOf(content)).toBe("读得到。");
	});

	it("纯字符串 content 没有思考", () => {
		expect(extractThinkingOf("一段纯文本")).toBe("");
	});

	it("undefined 与空数组都返回空串", () => {
		expect(extractThinkingOf(undefined)).toBe("");
		expect(extractThinkingOf([])).toBe("");
	});

	it("extractThinking 作用于 model 消息", () => {
		expect(extractThinking(undefined)).toBe("");
		expect(
			extractThinking({ role: "assistant", content: [{ type: "thinking", thinking: "嗯。" }] }),
		).toBe("嗯。");
		expect(extractThinking({ role: "user", content: "用户文本" })).toBe("");
	});

	it("各块两端空白被裁掉", () => {
		const content: ContentBlock[] = [
			{ type: "thinking", thinking: "\n 甲 \n" },
			{ type: "thinking", thinking: " 乙  " },
		];
		expect(extractThinkingOf(content)).toBe("甲\n\n乙");
	});
});

describe("ThinkingBlock 静态标记", () => {
	const html = (thinking: string | undefined, streaming = false): string =>
		renderToStaticMarkup(createElement(ThinkingBlock, { thinking, streaming }));

	it("已完成的回答：details.thinking 且不带 open（默认折叠）", () => {
		const markup = html("想了一会儿。");
		expect(markup.startsWith('<details class="thinking">')).toBe(true);
		expect(markup).not.toContain("open");
	});

	it("流式中：details 带 open（自动展开）且状态是「思考中」", () => {
		const markup = html("还在想。", true);
		expect(markup).toContain('<details class="thinking" open="">');
		expect(markup).toContain('<span class="thinking-status">思考中</span>');
	});

	it("类名齐全：thinking-head / -label / -status / -chev / -body", () => {
		const markup = html("想了 5 个字。");
		expect(markup).toContain('<summary class="thinking-head">');
		expect(markup).toContain('<span class="thinking-label">思考</span>');
		expect(markup).toContain('<span class="thinking-status">8 字</span>');
		expect(markup).toContain('<span class="thinking-chev">');
		expect(markup).toContain('<div class="thinking-body">想了 5 个字。</div>');
	});

	it("空思考返回空字符串", () => {
		expect(html(undefined)).toBe("");
		expect(html("")).toBe("");
		expect(html("", true)).toBe("");
	});
});
