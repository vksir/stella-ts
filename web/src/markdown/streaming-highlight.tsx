/**
 * 流式语法高亮会话（复刻 dsh `StreamingHighlightSession` 的核心思路）：
 *
 * - 只有「已完成的整行」会被缓存，缓存单元是**一个 React 元素组**（32 行一批）；
 *   流式追加时只对新增的完成行 + 增长中的末行分词，已缓存的行不再重算。
 * - 分词用 shiki 的 `grammarState` 续接：上一批最后一行的语法状态传给下一批，
 *   所以多行字符串、块注释、模板字符串这类跨行语法在流式期间也正确着色。
 * - 三道性能护栏（对齐 dsh 的工程取舍）：
 *   1. 单行超过 `MAX_LINE_LEN` 字符不分词（直接用纯文本，避免正则回溯）；
 *   2. 总行数超过 `MAX_LINES` 时停止流式高亮（退化为纯文本，落定后整块高亮）；
 *   3. 同一批缓存命中直接复用元素引用 → React 按引用跳过重渲。
 * - 与落定路径的输出保持一致（同一套双主题 CSS 变量），视觉上"流式→落定"不闪。
 */

import { Fragment, type ReactNode } from "react";
import type { HighlighterCore } from "shiki/core";

/** 单行字符上限：超过则不分词（正则引擎最坏情况保护）。 */
const MAX_LINE_LEN = 1000;
/** 流式高亮的行数上限：超过就退化为纯文本，等落定整块高亮。 */
const MAX_LINES = 200;
/** 每批缓存的行数（缓存单元的粒度）。 */
const BATCH_LINES = 32;

interface CachedBatch {
	/** 该批第一行的行号。 */
	from: number;
	/** 已渲染的元素组。 */
	rendered: ReactNode;
	/** 该批最后一行的语法状态（供下一批续接）。 */
	state: unknown;
	/** 该批覆盖的原始行文本（判断是否命中）。 */
	lines: string[];
}

export class StreamingHighlightSession {
	private batches: CachedBatch[] = [];
	private state: unknown = undefined;
	private highlighter: HighlighterCore | undefined;
	private lang = "";
	private themeNames: { light: string; dark: string } = { light: "", dark: "" };

	reset(): void {
		this.batches = [];
		this.state = undefined;
		this.lang = "";
	}

	/**
	 * 生成流式视图：返回已缓存批次的元素 + 尾部未缓存完成的纯文本行。
	 *
	 * `code` 是当前（可能未闭合的）代码块内容；`closed` 表示围栏已闭合（此时
	 * 调用方可直接走落定路径，本会话的缓存也应丢弃）。
	 */
	render(
		highlighter: HighlighterCore,
		code: string,
		lang: string,
		themes: { light: string; dark: string },
	): ReactNode | null {
		if (lang !== this.lang || themes.light !== this.themeNames.light) {
			this.reset();
			this.lang = lang;
			this.themeNames = themes;
		}
		this.highlighter = highlighter;

		const all = code.split("\n");
		// 末行可能还在增长：只把「已完成」的行（除最后一行）纳入缓存
		const completed = all.slice(0, -1);
		if (all.length > MAX_LINES) return null; // 太长：交给落定路径
		if (completed.some((line) => line.length > MAX_LINE_LEN)) return null;

		// 丢弃因为末行改写而失效的批次（保守做法：只保留前缀完全匹配的批次）
		while (this.batches.length > 0) {
			const last = this.batches[this.batches.length - 1];
			if (last === undefined) break;
			const end = last.from + last.lines.length;
			const matches = last.lines.every((line, index) => completed[last.from + index] === line);
			if (matches && end <= completed.length) break;
			this.batches.pop();
			this.state = this.batches[this.batches.length - 1]?.state;
		}

		// 追加新的整批
		let cursor = this.batches.reduce((sum, batch) => sum + batch.lines.length, 0);
		while (cursor + BATCH_LINES <= completed.length) {
			const lines = completed.slice(cursor, cursor + BATCH_LINES);
			const tokens = this.tokenize(lines.join("\n"), this.state);
			this.state = tokens.state;
			this.batches.push({
				from: cursor,
				lines,
				state: tokens.state,
				rendered: (
					<Fragment>
						{lines.map((line, index) => (
							<Fragment key={index}>
								{tokens.rows === null ? line : renderTokens(tokens.rows[index] ?? [])}
								{"\n"}
							</Fragment>
						))}
					</Fragment>
				),
			});
			cursor += BATCH_LINES;
		}

		// 尾部：已缓存批次 + 剩余未成批的完整行 + 增长中的末行（纯文本）
		const cached = this.batches.map((batch) => batch.rendered);
		const rest = all.slice(cursor);
		return (
			<>
				{...cached}
				{rest.map((line, index) => (
					<Fragment key={`t${index}`}>
						{line}
						{index < rest.length - 1 && "\n"}
					</Fragment>
				))}
			</>
		);
	}

	/** 分词一批行（用 grammarState 续接）。失败时回落为纯文本。 */
	private tokenize(
		code: string,
		grammarState: unknown,
	): { rows: HighlightToken[][] | null; state: unknown } {
		const highlighter = this.highlighter;
		if (highlighter === undefined) return { rows: null, state: grammarState };
		try {
			const rows = highlighter.codeToTokensWithThemes(code, {
				lang: this.lang as never,
				themes: this.themeNames,
				...(grammarState === undefined ? {} : { grammarState: grammarState as never }),
			}) as unknown as HighlightToken[][];
			return {
				rows,
				state: highlighter.getLastGrammarState(code, {
					lang: this.lang as never,
					theme: this.themeNames.light as never,
				}),
			};
		} catch {
			// 分词失败：返回 null，调用方按纯文本渲染这批行（不丢内容）
			return { rows: null, state: grammarState };
		}
	}
}

interface HighlightToken {
	content: string;
	variants?: Record<string, { color?: string; fontStyle?: number }>;
}

/** 单行 token → React 片段（双主题：两套颜色都写进 CSS 变量，样式表按 html[data-theme] 切换）。 */
function renderTokens(tokens: readonly HighlightToken[]): ReactNode {
	if (tokens.length === 0) return null;
	return (
		<>
			{tokens.map((token, index) => (
				<span
					key={index}
					style={
						{
							"--shiki-light": token.variants?.light?.color,
							"--shiki-dark": token.variants?.dark?.color,
						} as React.CSSProperties
					}
				>
					{token.content}
				</span>
			))}
		</>
	);
}
