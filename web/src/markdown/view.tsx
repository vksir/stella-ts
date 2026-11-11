/**
 * mdast → React 渲染器：类名与 DOM 结构对齐 legacy/markdown.ts
 * （.md / .code-block / .code-banner / .code-lang / .code-copy / .table-scroll /
 *  .table-fill / .inline-code；软换行→br；图片降级链接；链接仅 http/https）。
 *
 * 每个块组件按 ast 节点引用 memo——冻结块引用不变则子树不重渲。
 */

import { memo, type ReactNode, useState } from "react";
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

// —— 图标（与 legacy 相同） ——

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

// —— 代码块（banner + 复制） ——

function CodeBlockView({ node }: { node: Code }): ReactNode {
	const [copied, setCopied] = useState(false);
	const lang = (node.meta ?? "").trim() || node.lang || "";
	return (
		<div className="code-block">
			<div className="code-banner">
				<span className="code-lang">{lang}</span>
				<button
					type="button"
					className="code-copy"
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
			</div>
			<pre>
				<code>{node.value}</code>
			</pre>
		</div>
	);
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
	const narrow = (header?.children.length ?? 0) < 4;
	return (
		<div className={`table-scroll${narrow ? " table-fill" : ""}`}>
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
