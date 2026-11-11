/**
 * mdast → React 渲染器：类名与 DOM 结构对齐 legacy/markdown.ts
 * （.md / .code-block / .code-banner / .code-lang / .code-copy / .table-scroll /
 *  .table-fill / .inline-code；软换行→br；图片降级链接；链接仅 http/https）。
 *
 * 每个块组件按 ast 节点引用 memo——冻结块引用不变则子树不重渲。
 */

import { memo, useEffect, useState, type ReactNode } from "react";
import type {
	Blockquote,
	Code,
	Heading,
	InlineCode,
	List,
	ListItem,
	Paragraph,
	PhrasingContent,
	Root,
	Table,
	TableRow,
	Text,
} from "mdast";
import { highlightCode, isSupportedLang } from "./highlight";

// —— 图标 ——

const COPY_ICON = (
	<svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
		<rect x="7" y="7" width="9" height="9" rx="2" />
		<path d="M13 4.5A1.5 1.5 0 0 0 11.5 3h-6A2.5 2.5 0 0 0 3 5.5v6A1.5 1.5 0 0 0 4.5 13" />
	</svg>
);
const CHECK_ICON = (
	<svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
		<path d="M4 10.5l4 4 8-8.5" />
	</svg>
);
const WRAP_ICON = (
	<svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
		<path d="M3 5h14M3 9h7.5a3 3 0 1 1 0 6H8.5m1.5 0-2-2m2 2-2 2M3 15h2" />
	</svg>
);

// —— 安全链接：仅 http/https ——

function safeHref(url: string): string | undefined {
	return /^https?:\/\//i.test(url) ? url : undefined;
}

// —— 行内渲染 ——

function renderInline(nodes: readonly PhrasingContent[] | undefined, keyBase = ""): ReactNode[] {
	if (nodes === undefined) return [];
	return nodes.map((node, index) => {
		const key = `${keyBase}${index}`;
		switch (node.type) {
			case "text": {
				const parts = (node as Text).value.split("\n");
				return parts.map((part, partIndex) => (
					<span key={`${key}-${partIndex}`}>
						{partIndex > 0 && <br />}
						{part}
					</span>
				));
			}
			case "inlineCode":
				return (
					<code key={key} className="inline-code">
						{(node as InlineCode).value}
					</code>
				);
			case "strong":
				return <strong key={key}>{renderInline(node.children, `${key}-`)}</strong>;
			case "emphasis":
				return <em key={key}>{renderInline(node.children, `${key}-`)}</em>;
			case "delete":
				return <del key={key}>{renderInline(node.children, `${key}-`)}</del>;
			case "link": {
				const href = safeHref(node.url);
				if (href === undefined) return <span key={key}>{renderInline(node.children, `${key}-`)}</span>;
				return (
					<a key={key} href={href} target="_blank" rel="noreferrer noopener">
						<svg
							viewBox="0 0 24 24"
							width="12"
							height="12"
							fill="none"
							stroke="currentColor"
							strokeWidth="1.6"
							strokeLinecap="round"
							aria-hidden="true"
						>
							<circle cx="12" cy="12" r="9.5" />
							<path d="M2.5 12h19M12 2.5c2.6 2.6 2.6 16.4 0 19M12 2.5c-2.6 2.6-2.6 16.4 0 19" />
						</svg>
						{renderInline(node.children, `${key}-`)}
					</a>
				);
			}
			case "image": {
				// 图片降级为链接（聊天场景不出图）
				const href = safeHref(node.url);
				if (href === undefined) return <span key={key}>{node.alt ?? node.url}</span>;
				return (
					<a key={key} href={href} target="_blank" rel="noreferrer noopener">
						{node.alt && node.alt.length > 0 ? node.alt : node.url}
					</a>
				);
			}
			case "break":
				return <br key={key} />;
			case "html":
				return <span key={key}>{node.value}</span>;
			default:
				return <span key={key}>{renderInline((node as { children?: PhrasingContent[] }).children, `${key}-`)}</span>;
		}
	});
}

// —— 代码块（banner + 软换行切换 + 复制 + shiki 落定高亮） ——

function CodeBlockView({ node }: { node: Code }): ReactNode {
	const [copied, setCopied] = useState(false);
	const [wrapped, setWrapped] = useState(true);
	const [html, setHtml] = useState<string | null>(null);
	const lang = (node.meta ?? "").trim() || node.lang || "";

	useEffect(() => {
		if (lang.length === 0 || !isSupportedLang(lang)) {
			setHtml(null);
			return;
		}
		let cancelled = false;
		highlightCode(node.value, lang)
			.then((out) => {
				if (!cancelled) setHtml(extractCodeInner(out));
			})
			.catch(() => undefined);
		return () => {
			cancelled = true;
		};
	}, [node.value, lang]);

	return (
		<div className="code-block">
			<div className="code-banner">
				<span className="code-lang">{lang}</span>
				<span className="code-banner-actions">
					<button
						type="button"
						className="code-tool"
						data-on={wrapped ? "" : undefined}
						title={wrapped ? "软换行：开（点击改为横向滚动）" : "软换行：关（点击改为自动换行）"}
						aria-label="切换软换行"
						onClick={() => setWrapped(!wrapped)}
					>
						{WRAP_ICON}
					</button>
					<button
						type="button"
						className="code-tool"
						title={copied ? "已复制" : "复制代码"}
						onClick={() => {
							void navigator.clipboard
								.writeText(node.value)
								.then(() => {
									setCopied(true);
									return new Promise((resolve) => setTimeout(resolve, 1500));
								})
								.then(() => setCopied(false))
								.catch(() => undefined);
						}}
					>
						{copied ? CHECK_ICON : COPY_ICON}
					</button>
				</span>
			</div>
			<pre className={wrapped ? "wrap" : "nowrap"}>
				{html !== null ? <code dangerouslySetInnerHTML={{ __html: html }} /> : <code>{node.value}</code>}
			</pre>
		</div>
	);
}

/** 取 shiki 输出 <code>…</code> 的内层 HTML（外壳 pre/样式用本组件自己的）。 */
function extractCodeInner(out: string): string {
	const match = /<code[^>]*>([\s\S]*)<\/code>/.exec(out);
	return match?.[1] ?? "";
}

// —— 表格 ——

function alignStyle(align: string | null | undefined): React.CSSProperties | undefined {
	if (align === "left") return { textAlign: "left" };
	if (align === "center") return { textAlign: "center" };
	if (align === "right") return { textAlign: "right" };
	return undefined;
}

function TableView({ node }: { node: Table }): ReactNode {
	const header = node.children[0];
	const rows = node.children.slice(1);
	return (
		<div className="table-scroll table-fill">
			<table>
				{header !== undefined && (
					<thead>
						<tr>
							{header.children.map((cell, index) => (
								<th key={index} style={alignStyle(node.align?.[index])}>
									{renderInline(cell.children, `h${index}-`)}
								</th>
							))}
						</tr>
					</thead>
				)}
				<tbody>
					{rows.map((row: TableRow, rowIndex) => (
						<tr key={rowIndex}>
							{row.children.map((cell, index) => (
								<td key={index} style={alignStyle(node.align?.[index])}>
									{renderInline(cell.children, `r${rowIndex}c${index}-`)}
								</td>
							))}
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}

// —— 列表（含 task list） ——

function ListView({ node }: { node: List }): ReactNode {
	const Tag = node.ordered ? "ol" : "ul";
	return (
		<Tag className={node.ordered && node.start !== null && node.start !== 1 ? "md-start" : undefined} start={node.ordered ? (node.start ?? 1) : undefined}>
			{node.children.map((item: ListItem, index) => (
				<li key={index}>
					{item.checked === true || item.checked === false ? (
						<input type="checkbox" checked={item.checked} disabled readOnly aria-label={item.checked ? "已勾选" : "未勾选"} />
					) : undefined}
					{item.children.map((child, childIndex) => (
						<BlockView key={childIndex} node={child} />
					))}
				</li>
			))}
		</Tag>
	);
}

// —— 块渲染 ——

function BlockViewInner({ node }: { node: Root["children"][number] }): ReactNode {
	switch (node.type) {
		case "paragraph":
			return <p>{renderInline((node as Paragraph).children)}</p>;
		case "heading": {
			const heading = node as Heading;
			const depth = Math.min(6, Math.max(1, heading.depth)) as 1 | 2 | 3 | 4 | 5 | 6;
			const Tag = `h${depth}` as "h1";
			return <Tag>{renderInline(heading.children)}</Tag>;
		}
		case "code":
			return <CodeBlockView node={node as Code} />;
		case "blockquote": {
			const quote = node as Blockquote;
			return <blockquote>{quote.children.map((child, index) => <BlockView key={index} node={child} />)}</blockquote>;
		}
		case "list":
			return <ListView node={node as List} />;
		case "table":
			return <TableView node={node as Table} />;
		case "thematicBreak":
			return <hr />;
		case "html":
			return <p>{node.value}</p>;
		default:
			return <p>{renderInline((node as unknown as { children?: PhrasingContent[] }).children)}</p>;
	}
}

const BlockView = memo(BlockViewInner);

// —— 根 ——

/** 渲染一组块（key = 源文本起始偏移，跨冻结边界稳定）。 */
export function MarkdownBlocks({ blocks }: { blocks: readonly { node: Root["children"][number]; start: number }[] }): ReactNode {
	return (
		<div className="md">
			{blocks.map((block) => (
				<BlockView key={block.start} node={block.node} />
			))}
		</div>
	);
}
