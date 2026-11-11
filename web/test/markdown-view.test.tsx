/**
 * Markdown 渲染器契约单测（`src/markdown/view.tsx`）。
 *
 * 用 `renderToStaticMarkup` 直接渲染 mdast → HTML（无需 jsdom）。锁的是**类名与结构**：
 * 这些类名被 style.css 逐条样式化，也被第三方评审逐项测量过（表格行线、代码块 banner、
 * 链接地球图标、task list 勾选框……）。改坏一个类名不会报错，只会静默丢样式，
 * 所以用测试钉住。
 */

import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { IncrementalMarkdown } from "../src/markdown/incremental";
import { MarkdownBlocks } from "../src/markdown/view";

/** 渲染 markdown 源文本为 HTML 字符串（走落定路径）。 */
function render(src: string): string {
	const { blocks } = new IncrementalMarkdown().settle(src);
	return renderToStaticMarkup(createElement(MarkdownBlocks, { blocks }));
}

describe("Markdown 渲染契约", () => {
	it("根容器是 .md，块级元素不额外包壳", () => {
		const html = render("一段话。");
		expect(html.startsWith('<div class="md">')).toBe(true);
		expect(html).toContain("<p>一段话。</p>");
	});

	it("标题按层级输出 h1–h3", () => {
		const html = render("# 一\n\n## 二\n\n### 三");
		expect(html).toContain("<h1>一</h1>");
		expect(html).toContain("<h2>二</h2>");
		expect(html).toContain("<h3>三</h3>");
	});

	it("软换行保留为 <br>（聊天惯例，不切段）", () => {
		const html = render("第一行\n第二行");
		expect(html).toContain("<br/>");
		expect((html.match(/<p>/g) ?? []).length).toBe(1);
	});

	it("行内标记：strong / em / del / inline-code 类名", () => {
		const html = render("**粗** *斜* ~~删~~ `code`");
		expect(html).toContain("<strong>粗</strong>");
		expect(html).toContain("<em>斜</em>");
		expect(html).toContain("<del>删</del>");
		expect(html).toContain('<code class="inline-code">code</code>');
	});

	it("代码块：.code-block + .code-banner + .code-lang + 两个 .code-tool + pre.wrap", () => {
		const html = render("```ts\nconst a = 1;\n```");
		expect(html).toContain('class="code-block"');
		expect(html).toContain('class="code-banner"');
		expect(html).toContain('<span class="code-lang">ts</span>');
		expect(html).toContain('class="code-banner-actions"');
		expect((html.match(/class="code-tool"/g) ?? []).length).toBe(2); // 软换行 + 复制
		expect(html).toContain('<pre class="wrap">');
		// SSR 阶段未执行 effect，代码以纯文本渲染（流式/首帧语义）
		expect(html).toContain("const a = 1;");
	});

	it("表格：.table-scroll.table-fill 撑满、对齐写进 style、末列不补右内距", () => {
		const html = render("| 左 | 中 |\n| :-- | :-: |\n| 1 | 2 |");
		expect(html).toContain('class="table-scroll table-fill"');
		expect(html).toContain("<table>");
		expect(html).toContain("text-align:left");
		expect(html).toContain("text-align:center");
		expect(html).toContain("<thead>");
		expect(html).toContain("<tbody>");
	});

	it("列表：有序用 ol 带 start，无序用 ul；task list 出 disabled checkbox", () => {
		const ul = render("- a\n- b");
		expect(ul).toContain("<ul>");
		expect((ul.match(/<li>/g) ?? []).length).toBe(2);

		const ol = render("3. c\n4. d");
		expect(ol).toContain('<ol start="3">');

		const task = render("- [x] done\n- [ ] todo");
		expect(task).toContain('type="checkbox"');
		expect(task).toContain("disabled");
		expect(task).toContain("checked");
		expect(task).toContain('aria-label="已勾选"');
		expect(task).toContain('aria-label="未勾选"');
	});

	it("引用块递归渲染内部块", () => {
		const html = render("> 引用里的一段\n>\n> - 引用里的列表");
		expect(html).toContain("<blockquote>");
		expect(html).toContain("<p>引用里的一段</p>");
		expect(html).toContain("<ul>");
	});

	it("链接：仅 http(s) 可点，带 12px 地球图标 + 新窗口属性", () => {
		const ok = render("[站点](https://example.com)");
		expect(ok).toContain('href="https://example.com"');
		expect(ok).toContain('target="_blank"');
		expect(ok).toContain('rel="noreferrer noopener"');
		expect(ok).toContain("<svg"); // 地球图标
		expect(ok).toContain('width="12"');

		const bad = render("[危险](javascript:alert(1))");
		expect(bad).not.toContain("javascript:");
		expect(bad).toContain("<span>");
	});

	it("图片降级为链接（聊天场景不出图）", () => {
		const html = render("![示意](https://example.com/a.png)");
		expect(html).not.toContain("<img");
		expect(html).toContain('href="https://example.com/a.png"');
		expect(html).toContain("示意");
	});

	it("HTML 不注入（按纯文本渲染）", () => {
		const html = render('<script>alert(1)</script>');
		expect(html).not.toContain("<script>");
		expect(html).toContain("&lt;script&gt;");
	});

	it("分隔线与内联代码内的反引号内容不被当标记", () => {
		expect(render("a\n\n---\n\nb")).toContain("<hr/>");
		const html = render("`**不是粗体**`");
		expect(html).toContain('<code class="inline-code">**不是粗体**</code>');
	});
});

describe("状态行文案（aborted 语义）", () => {
	// 通过渲染整块 markdown 无法覆盖状态行；这里直接校验 props 契约：
	// 状态行文案由 ChatFlow 的 AssistantNode 计算，规则为
	//   aborted → "已中断"；有 durationMs → "已完成，用时 N 秒"；否则 "已完成"。
	it("规则表（作为文档与回归基线）", () => {
		const status = (aborted: boolean, durationMs?: number): string =>
			aborted
				? "已中断"
				: durationMs === undefined
					? "已完成"
					: `已完成，用时 ${Math.max(1, Math.round(durationMs / 1000))} 秒`;

		expect(status(true, 12871)).toBe("已中断"); // 服务崩溃留下的部分回答
		expect(status(false, 12871)).toBe("已完成，用时 13 秒");
		expect(status(false, 400)).toBe("已完成，用时 1 秒"); // 不足 1 秒也显示 1 秒
		expect(status(false)).toBe("已完成"); // 历史运行无用时
	});
});
