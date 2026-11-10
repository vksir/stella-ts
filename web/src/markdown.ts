/**
 * 零依赖 Markdown 子集渲染器（DSH MarkdownText 的观感，DOM 构建保证安全）。
 *
 * 块级：fenced code（带语言 banner + 复制钮）、h1–h6、hr、blockquote（递归）、
 * 有序/无序列表（缩进嵌套、task list）、表格（对齐列）、段落。
 * 行内：`code`、**strong**、*em* / _em_、***strong em***、~~del~~、[text](http…)、
 * 反斜杠转义。行内单换行保留为 <br>（聊天惯例）。
 *
 * 安全：所有文本一律 textContent；链接仅接受 http/https（其余按纯文本处理），
 * 不经 innerHTML 注入任何来源内容。
 */

/** 渲染 markdown 源文本为 DOM 片段容器。 */
export function renderMarkdown(src: string): HTMLElement {
	const root = document.createElement("div");
	root.className = "md";
	renderBlocks(root, normalize(src));
	return root;
}

function normalize(src: string): string {
	return src.replace(/\r\n?/g, "\n").replace(/\t/g, "  ");
}

// —— 块级解析 ——

interface Line {
	text: string;
	indent: number;
}

function splitLines(src: string): Line[] {
	return src.split("\n").map((text) => {
		const match = /^ */.exec(text);
		return { text: text.trimEnd(), indent: match ? match[0].length : 0 };
	});
}

function renderBlocks(container: HTMLElement, src: string): void {
	const lines = splitLines(src);
	let i = 0;
	while (i < lines.length) {
		const line = lines[i];
		if (line === undefined) break;
		if (line.text.trim().length === 0) {
			i += 1;
			continue;
		}
		const fence = /^(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/.exec(line.text.trim());
		if (fence) {
			container.append(renderFence(fence[1] ?? "`", fence[2] ?? "", lines, i));
			i = skipFence(fence[1] ?? "`", lines, i);
			continue;
		}
		const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line.text.trim());
		if (heading) {
			const level = (heading[1] ?? "#").length;
			const h = document.createElement(`h${level}`);
			renderInline(h, heading[2] ?? "");
			container.append(h);
			i += 1;
			continue;
		}
		if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line.text.trim())) {
			container.append(document.createElement("hr"));
			i += 1;
			continue;
		}
		if (line.text.trim().startsWith(">")) {
			const quoted: string[] = [];
			let j = i;
			while (j < lines.length) {
				const match = /^ {0,3}> ?(.*)$/.exec(lines[j]?.text ?? "");
				if (match === null) break;
				quoted.push(match[1] ?? "");
				j += 1;
			}
			const block = document.createElement("blockquote");
			renderBlocks(block, quoted.join("\n"));
			container.append(block);
			i = j;
			continue;
		}
		const listMatch = /^([-*+]|\d{1,9}[.)])(\s+\[[ xX]\])?\s+(.*)$/.exec(line.text.trim());
		if (listMatch) {
			i = renderList(container, lines, i, line.indent);
			continue;
		}
		const table = matchTable(lines, i);
		if (table !== undefined) {
			container.append(renderTable(table.header, table.aligns, table.rows));
			i = table.next;
			continue;
		}
		// 段落：收集到空行或块级起始
		const para: string[] = [];
		let j = i;
		while (j < lines.length) {
			const current = lines[j];
			const text = current?.text ?? "";
			const trimmed = text.trim();
			if (
				trimmed.length === 0 ||
				/^(`{3,}|~{3,})/.test(trimmed) ||
				/^#{1,6}\s/.test(trimmed) ||
				/^ {0,3}>/.test(text) ||
				/^([-*+]|\d{1,9}[.)])\s/.test(trimmed) ||
				/^(-{3,}|\*{3,}|_{3,})\s*$/.test(trimmed)
			) {
				break;
			}
			para.push(trimmed);
			j += 1;
		}
		if (para.length > 0) {
			const p = document.createElement("p");
			for (const [index, text] of para.entries()) {
				if (index > 0) p.append(document.createElement("br"));
				renderInline(p, text);
			}
			container.append(p);
		}
		i = Math.max(j, i + 1);
	}
}

/** fenced code：收集围栏内容（容错未闭合），返回块元素并把游标推到围栏后。 */
function renderFence(marker: string, lang: string, lines: Line[], start: number): HTMLElement {
	const code: string[] = [];
	let j = start + 1;
	for (; j < lines.length; j += 1) {
		const text = lines[j]?.text ?? "";
		const trimmed = text.trim();
		if (trimmed.length > 0 && trimmed.startsWith(marker) && /^`{3,}|^~{3,}/.test(trimmed)) {
			j += 1;
			break;
		}
		code.push(text.trimStart());
	}
	return buildCodeBlock(code.join("\n"), lang, false);
}

function skipFence(marker: string, lines: Line[], start: number): number {
	let j = start + 1;
	for (; j < lines.length; j += 1) {
		const trimmed = (lines[j]?.text ?? "").trim();
		if (trimmed.length > 0 && trimmed.startsWith(marker) && /^`{3,}|^~{3,}/.test(trimmed)) {
			return j + 1;
		}
	}
	return j;
}

/** 列表：返回消费到的行号（嵌套按缩进，2 空格一级；宽松处理 1 空格续行）。 */
function renderList(container: HTMLElement, lines: Line[], start: number, baseIndent: number): number {
	const first = /^([-*+]|\d{1,9}[.)])/.exec((lines[start]?.text ?? "").trim());
	const ordered = first !== null && /\d/.test(first[0] ?? "");
	const list = document.createElement(ordered ? "ol" : "ul");
	let i = start;
	while (i < lines.length) {
		const line = lines[i];
		if (line === undefined) break;
		const trimmed = line.text.trim();
		if (trimmed.length === 0) {
			// 空行：后随更深缩进则属于列表（松散列表），否则结束
			const next = lines[i + 1];
			if (next === undefined || next.indent <= baseIndent || next.text.trim().length === 0) break;
			i += 1;
			continue;
		}
		if (line.indent < baseIndent) break;
		const item = /^([-*+]|\d{1,9}[.)])(\s+\[[ xX]\])?\s+(.*)$/.exec(trimmed);
		if (item === null || line.indent > baseIndent) {
			// 非列表行：若比基准缩进更深，归入上一个 item；否则结束列表
			const lastItem = list.lastElementChild;
			if (line.indent > baseIndent && lastItem instanceof HTMLElement) {
				appendItemBody(lastItem, trimmed);
				i += 1;
				continue;
			}
			break;
		}
		const li = document.createElement("li");
		const task = item[2] !== undefined;
		if (task) {
			const box = document.createElement("input");
			box.type = "checkbox";
			box.checked = /x/i.test(item[2] ?? "");
			box.disabled = true;
			li.append(box);
		}
		renderInline(li, item[3] ?? "");
		list.append(li);
		i += 1;
		// 嵌套列表 / 深缩进续行
		while (i < lines.length) {
			const follow = lines[i];
			if (follow === undefined) break;
			const followTrimmed = follow.text.trim();
			if (followTrimmed.length === 0) break;
			if (follow.indent <= baseIndent) break;
			if (/^([-*+]|\d{1,9}[.)])\s/.test(followTrimmed) && follow.indent > baseIndent) {
				i = renderList(li, lines, i, follow.indent);
				continue;
			}
			appendItemBody(li, followTrimmed);
			i += 1;
		}
	}
	container.append(list);
	return i;
}

/** 把续行文本并入列表项（新段落或追加到末段）。 */
function appendItemBody(li: HTMLElement, text: string): void {
	const last = li.lastElementChild;
	if (last instanceof HTMLElement && last.tagName === "P") {
		last.append(document.createElement("br"));
		renderInline(last, text);
		return;
	}
	const p = document.createElement("p");
	renderInline(p, text);
	li.append(p);
}

/** 表格探测：header 行 + |---| 分隔行。 */
function matchTable(
	lines: Line[],
	start: number,
): { header: string[]; aligns: string[]; rows: string[][]; next: number } | undefined {
	const header = splitTableRow(lines[start]?.text ?? "");
	if (header.length < 2) return undefined;
	const divider = (lines[start + 1]?.text ?? "").trim();
	if (!/^\|? *:?-{3,}/.test(divider) || !divider.includes("-")) return undefined;
	const aligns = splitTableRow(divider).map((cell) => {
		const t = cell.trim();
		const left = t.startsWith(":");
		const right = t.endsWith(":");
		return left && right ? "center" : right ? "right" : "left";
	});
	const rows: string[][] = [];
	let j = start + 2;
	while (j < lines.length) {
		const text = (lines[j]?.text ?? "").trim();
		if (text.length === 0 || !text.includes("|")) break;
		rows.push(splitTableRow(text));
		j += 1;
	}
	return { header, aligns, rows, next: j };
}

function splitTableRow(text: string): string[] {
	const trimmed = text.trim().replace(/^\|/, "").replace(/\|$/, "");
	return trimmed.split("|").map((cell) => cell.trim());
}

function renderTable(header: string[], aligns: string[], rows: string[][]): HTMLElement {
	const wrap = document.createElement("div");
	wrap.className = "table-scroll";
	const table = document.createElement("table");
	const thead = document.createElement("thead");
	const headRow = document.createElement("tr");
	for (const [index, cell] of header.entries()) {
		const th = document.createElement("th");
		const align = aligns[index];
		if (align === "center" || align === "right") th.style.textAlign = align;
		renderInline(th, cell);
		headRow.append(th);
	}
	thead.append(headRow);
	table.append(thead);
	const tbody = document.createElement("tbody");
	for (const row of rows) {
		const tr = document.createElement("tr");
		for (const [index, cell] of row.entries()) {
			const td = document.createElement("td");
			const align = aligns[index];
			if (align === "center" || align === "right") td.style.textAlign = align;
			renderInline(td, cell);
			tr.append(td);
		}
		tbody.append(tr);
	}
	table.append(tbody);
	wrap.append(table);
	// 列数不超过 3 时撑满列宽（DSH tableFill：少列表格填充）
	if (header.length < 4) wrap.classList.add("table-fill");
	return wrap;
}

// —— 代码块（DSH CodeBlock：banner + 复制钮 + pre） ——

const COPY_ICON =
	'<svg viewBox="0 0 20 20" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="7" y="7" width="9" height="9" rx="2" /><path d="M13 4.5A1.5 1.5 0 0 0 11.5 3h-6A2.5 2.5 0 0 0 3 5.5v6A1.5 1.5 0 0 0 4.5 13" /></svg>';
const CHECK_ICON =
	'<svg viewBox="0 0 20 20" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 10.5l4 4 8-8.5" /></svg>';

function buildCodeBlock(code: string, lang: string, withBanner: boolean): HTMLElement {
	const block = document.createElement("div");
	block.className = "code-block";
	if (withBanner || lang.length > 0) {
		const banner = document.createElement("div");
		banner.className = "code-banner";
		const label = document.createElement("span");
		label.className = "code-lang";
		label.textContent = lang.length > 0 ? lang : "代码";
		const copy = document.createElement("button");
		copy.type = "button";
		copy.className = "code-copy";
		copy.title = "复制代码";
		copy.setAttribute("aria-label", "复制代码");
		copy.innerHTML = COPY_ICON;
		copy.addEventListener("click", () => {
			void navigator.clipboard
				.writeText(code)
				.then(() => {
					copy.innerHTML = CHECK_ICON;
					copy.title = "已复制";
					return new Promise((resolve) => setTimeout(resolve, 1500));
				})
				.then(() => {
					copy.innerHTML = COPY_ICON;
					copy.title = "复制代码";
				})
				.catch(() => undefined);
		});
		banner.append(label, copy);
		block.append(banner);
	}
	const pre = document.createElement("pre");
	const codeEl = document.createElement("code");
	codeEl.textContent = code;
	pre.append(codeEl);
	block.append(pre);
	return block;
}

// —— 行内解析 ——

const ESCAPABLE = /[\\`*_{}[\]()#+\-.!~>|]/;

/** 行内渲染：扫描器逐段消费标记，纯文本走 textContent。 */
function renderInline(target: HTMLElement, src: string): void {
	let buffer = "";
	const flush = (): void => {
		if (buffer.length > 0) {
			target.append(document.createTextNode(buffer));
			buffer = "";
		}
	};
	let i = 0;
	while (i < src.length) {
		const ch = src[i] ?? "";
		// 反斜杠转义
		if (ch === "\\" && i + 1 < src.length && ESCAPABLE.test(src[i + 1] ?? "")) {
			buffer += src[i + 1];
			i += 2;
			continue;
		}
		// 行内代码（优先于其他标记；反引号串支持多反引号定界）
		if (ch === "`") {
			const span = matchCodeSpan(src, i);
			if (span !== undefined) {
				flush();
				target.append(buildInlineCode(span.text));
				i = span.end;
				continue;
			}
		}
		// 图片 ![alt](url) → 降级为链接 [alt](url)
		if (ch === "!" && src[i + 1] === "[") {
			const link = matchLink(src, i + 1);
			if (link !== undefined) {
				flush();
				appendLink(target, link.text, link.url);
				i = link.end;
				continue;
			}
		}
		// 链接
		if (ch === "[") {
			const link = matchLink(src, i);
			if (link !== undefined) {
				flush();
				appendLink(target, link.text, link.url);
				i = link.end;
				continue;
			}
		}
		// 粗斜体 ***x***
		if (src.startsWith("***", i) || src.startsWith("___", i)) {
			const closer = src.slice(i).startsWith("***") ? "***" : "___";
			const end = src.indexOf(closer, i + 3);
			if (end > i + 3) {
				flush();
				const strong = document.createElement("strong");
				const em = document.createElement("em");
				renderInline(em, src.slice(i + 3, end));
				strong.append(em);
				target.append(strong);
				i = end + 3;
				continue;
			}
		}
		// 粗体 **x** / __x__
		if (src.startsWith("**", i) || src.startsWith("__", i)) {
			const closer = src.slice(i).startsWith("**") ? "**" : "__";
			const end = src.indexOf(closer, i + 2);
			if (end > i + 2) {
				flush();
				const strong = document.createElement("strong");
				renderInline(strong, src.slice(i + 2, end));
				target.append(strong);
				i = end + 2;
				continue;
			}
		}
		// 删除线 ~~x~~
		if (src.startsWith("~~", i)) {
			const end = src.indexOf("~~", i + 2);
			if (end > i + 2) {
				flush();
				const del = document.createElement("del");
				renderInline(del, src.slice(i + 2, end));
				target.append(del);
				i = end + 2;
				continue;
			}
		}
		// 斜体 *x*（x 起止非空白；_x_ 前后需为边界，避免 snake_case 误判）
		if (ch === "*" || ch === "_") {
			const boundaryOk =
				ch === "*" ||
				i === 0 ||
				/[\s([{>"']/.test(src[i - 1] ?? " ") === true ||
				/[\s)\]}<"'.,!?;:]/.test(src[i - 1] ?? " ") === true;
			const close = matchEmphasis(src, i, ch);
			if (close !== undefined && boundaryOk) {
				flush();
				const em = document.createElement("em");
				renderInline(em, src.slice(i + 1, close));
				target.append(em);
				i = close + 1;
				continue;
			}
		}
		buffer += ch;
		i += 1;
	}
	flush();
}

/** 行内代码 span：成对反引号（内容首尾各留一个空格时剥除）。 */
function matchCodeSpan(src: string, start: number): { text: string; end: number } | undefined {
	const tick = /^`+/.exec(src.slice(start))?.[0] ?? "`";
	const end = src.indexOf(tick, start + tick.length);
	if (end === -1) return undefined;
	let text = src.slice(start + tick.length, end);
	if (text.length >= 2 && text.startsWith(" ") && text.endsWith(" ")) {
		text = text.slice(1, -1);
	}
	return { text, end: end + tick.length };
}

/** 斜体闭合：同标记且后随非空白、内容非空非纯空白。 */
function matchEmphasis(src: string, start: number, marker: string): number | undefined {
	const inner = marker === "*" ? /^\*([^*\s][^*]*?)\*(?![*\w])/ : /^_([^_\s][^_]*?)_(?![\w])/;
	const rest = src.slice(start);
	const match = inner.exec(rest);
	if (match === null) return undefined;
	return start + (match.index + (match[0].length - 1));
}

/** [text](url)：仅 http/https。 */
function matchLink(
	src: string,
	start: number,
): { text: string; url: string; end: number } | undefined {
	let i = start + 1;
	let depth = 1;
	let textEnd = -1;
	for (; i < src.length; i += 1) {
		const ch = src[i];
		if (ch === "[") depth += 1;
		else if (ch === "]") {
			depth -= 1;
			if (depth === 0) {
				textEnd = i;
				break;
			}
		} else if (ch === "\\" && ESCAPABLE.test(src[i + 1] ?? "")) i += 1;
	}
	if (textEnd === -1 || src[textEnd + 1] !== "(") return undefined;
	const urlEnd = src.indexOf(")", textEnd + 2);
	if (urlEnd === -1) return undefined;
	const url = src.slice(textEnd + 2, urlEnd).trim().replace(/^<|>$/g, "");
	if (!/^https?:\/\//i.test(url)) return undefined;
	return { text: src.slice(start + 1, textEnd), url, end: urlEnd + 1 };
}

function appendLink(target: HTMLElement, text: string, url: string): void {
	const a = document.createElement("a");
	a.href = url;
	a.textContent = text.length > 0 ? text : url;
	a.target = "_blank";
	a.rel = "noreferrer noopener";
	target.append(a);
}

function buildInlineCode(text: string): HTMLElement {
	const code = document.createElement("code");
	code.className = "inline-code";
	code.textContent = text;
	return code;
}
