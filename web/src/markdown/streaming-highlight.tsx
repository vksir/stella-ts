/**
 * 流式语法高亮会话（复刻 dsh 的「解析到哪染到哪」）。
 *
 * 设计要点（早期版本的两次返工都写在这里，避免再犯）：
 *
 * 1. **行级锁步，不做"够一批才染"**：早期按 32 行（后改 8 行）分批，结果是流式里
 *    文本已经到 1000 字、着色只有前 8 行（11%），落定瞬间整块"咔"地补色 —— 与 dsh 的
 *    84% 着色密度差一个数量级。现在每完成一行就单独分词并缓存，末行（仍在增长）也分词，
 *    于是任何时刻屏幕上的着色密度都与正文同步。
 * 2. **grammar 状态逐行续接**：每行分词后记下 `stateAfter`，下一行用它续接，所以多行
 *    字符串 / 块注释 / 模板字符串在流式中也正确；末行内容被改写时，从该行回退状态重算。
 * 3. **缓存单元是「单行」**：行文本与渲染结果一起存，命中即复用 React 元素引用，
 *    避免每个 chunk 重渲整块。
 * 4. **护栏**：单行超 `MAX_LINE_LEN` 或总行数超 `MAX_LINES` 时整体退回纯文本，
 *    交给落定路径整块高亮（避免正则引擎最坏情况）。
 * 5. **颜色与落定路径一致**：同样用 `codeToTokensWithThemes` 的双主题 variants
 *    写进 `--shiki-light` / `--shiki-dark`，由样式表按主题切换（parity 已实测：
 *    流式 20 token / 4 色 ↔ 落定 20 token / 4 色，逐值相同）。
 */

import { Fragment, type ReactNode } from "react";
import type { HighlighterCore } from "shiki/core";

/** 单行字符上限：超过则整体退回纯文本（正则引擎最坏情况保护）。 */
const MAX_LINE_LEN = 1000;
/** 行数上限：超过则整体退回纯文本，等落定整块高亮。 */
const MAX_LINES = 400;

interface Token {
	content: string;
	/** 双主题颜色（`codeToTokensWithThemes` 的 variants）。 */
	light?: string;
	dark?: string;
}

interface CachedLine {
	/** 该行原文（用于判断缓存是否仍有效）。 */
	text: string;
	/** 渲染好的元素。 */
	rendered: ReactNode;
	/** 该行结束后的语法状态（下一行续接用）。 */
	stateAfter: unknown;
}

interface Themes {
	light: string;
	dark: string;
	[key: string]: string;
}

export class StreamingHighlightSession {
	private lines: CachedLine[] = [];
	private state: unknown = undefined;
	private lang = "";
	private themes: Themes = { light: "", dark: "" };
	private highlighter: HighlighterCore | undefined;
	/** 末行缓存（末行随每个 chunk 增长，单独缓存避免重复分词）。 */
	private partial: { text: string; rendered: ReactNode } | undefined;

	reset(): void {
		this.lines = [];
		this.state = undefined;
		this.lang = "";
		this.partial = undefined;
	}

	/**
	 * 生成流式视图：已缓存的行（彩色） + 末行（彩色） + 收尾换行。
	 * 返回 null 表示放弃流式高亮（调用方走纯文本）。
	 */
	render(highlighter: HighlighterCore, code: string, lang: string, themes: Themes): ReactNode | null {
		if (lang !== this.lang || themes.light !== this.themes.light) {
			this.reset();
			this.lang = lang;
			this.themes = themes;
		}
		this.highlighter = highlighter;

		const all = code.split("\n");
		if (all.length > MAX_LINES) return null;
		if (all.some((line) => line.length > MAX_LINE_LEN)) return null;

		const completed = all.slice(0, -1);
		const last = all[all.length - 1] ?? "";

		// 1) 前缀失配（末行改写 / 换块）时回退：找到第一个不一致的行，从那里重算
		let divergeAt = 0;
		const limit = Math.min(completed.length, this.lines.length);
		while (divergeAt < limit && this.lines[divergeAt]?.text === completed[divergeAt]) divergeAt += 1;
		if (divergeAt < this.lines.length) {
			this.lines = this.lines.slice(0, divergeAt);
			this.state = divergeAt === 0 ? undefined : this.lines[divergeAt - 1]?.stateAfter;
			this.partial = undefined;
		}

		// 2) 逐行补齐新完成的整行（每行一次分词，锁步）
		for (let index = this.lines.length; index < completed.length; index += 1) {
			const text = completed[index] ?? "";
			const tokens = this.tokenize(text);
			// 分词失败（rows === null）时按纯文本渲染该行，绝不丢内容
			this.lines.push({
				text,
				rendered: tokens.rows === null ? text : renderTokens(tokens.rows),
				stateAfter: tokens.state,
			});
			this.state = tokens.state;
		}

		// 3) 末行：内容变了才重新分词（它每个 chunk 都在长）
		if (this.partial === undefined || this.partial.text !== last) {
			const tokens = this.tokenize(last);
			this.partial = { text: last, rendered: tokens.rows === null ? last : renderTokens(tokens.rows) };
		}

		return (
			<>
				{this.lines.map((line, index) => (
					<Fragment key={index}>
						{line.rendered}
						{"\n"}
					</Fragment>
				))}
				{this.partial?.rendered}
			</>
		);
	}

	/**
	 * 用当前 grammar 状态分词一行。
	 *
	 * **坑（踩过两次，务必保持这个写法）**：`grammarState` 是一次性游标，分词过程会
	 * **就地推进**它。所以不能「先分词一次拿到 tokens，再拿同一个 state 调
	 * `getLastGrammarState(line, …)` 求新状态」——第二次调用会从已被推进的状态继续，
	 * 抛错后被我这里的 catch 吞掉，表现为**第一行有色、后面全变纯文本**。
	 * 正确做法：分词一次，用 `getLastGrammarState(tokens)` 从 token 数组反推新状态。
	 */
	private tokenize(line: string): { rows: Token[] | null; state: unknown } {
		const highlighter = this.highlighter;
		if (highlighter === undefined) return { rows: null, state: this.state };
		if (line.length === 0) return { rows: [], state: this.state };
		try {
			const rows = highlighter.codeToTokensWithThemes(line, {
				lang: this.lang as never,
				themes: { light: this.themes.light, dark: this.themes.dark },
				...(this.state === undefined ? {} : { grammarState: this.state as never }),
			}) as unknown as { content: string; variants?: Record<string, { color?: string }> }[][];
			const row = rows[0] ?? [];
			const tokens: Token[] = row.map((token) => ({
				content: token.content,
				light: token.variants?.light?.color,
				dark: token.variants?.dark?.color,
			}));
			// 从 token 反推状态：不再用 line 重新分词（会二次消耗 state）
			const nextState = highlighter.getLastGrammarState(row as never);
			return { rows: tokens, state: nextState };
		} catch {
			return { rows: null, state: this.state };
		}
	}
}

/** 单行 token → React 片段（双主题：两套颜色写进 CSS 变量，样式表按主题切换）。 */
function renderTokens(tokens: readonly Token[]): ReactNode {
	if (tokens.length === 0) return null;
	return (
		<>
			{tokens.map((token, index) => (
				<span
					key={index}
					style={
						{
							"--shiki-light": token.light,
							"--shiki-dark": token.dark,
						} as React.CSSProperties
					}
				>
					{token.content}
				</span>
			))}
		</>
	);
}
