/**
 * 代码高亮（dsh 观感：JS 正则引擎、无 WASM；落定后高亮，流式中 plain）。
 *
 * - 双主题（light/dark）经 shiki 的 CSS 变量输出（--shiki-light/--shiki-dark），
 *   由 style.css 按 html[data-theme] 切换，主题切换零重算。
 * - highlighter 惰性单例：首个代码块出现才动态加载（不占首屏包）。
 * - 常用语言静态打包（dsh 启动只装 TS/Shell/JSON、其余懒加载的同款取舍，
 *   这里收敛为一个 chunk）。
 */

import { createHighlighterCore, type HighlighterCore, type ThemeRegistrationRaw } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import bash from "shiki/langs/bash.mjs";
import css from "shiki/langs/css.mjs";
import diff from "shiki/langs/diff.mjs";
import go from "shiki/langs/go.mjs";
import html from "shiki/langs/html.mjs";
import java from "shiki/langs/java.mjs";
import javascript from "shiki/langs/javascript.mjs";
import json from "shiki/langs/json.mjs";
import jsx from "shiki/langs/jsx.mjs";
import markdown from "shiki/langs/markdown.mjs";
import powershell from "shiki/langs/powershell.mjs";
import python from "shiki/langs/python.mjs";
import rust from "shiki/langs/rust.mjs";
import shellscript from "shiki/langs/shellscript.mjs";
import sql from "shiki/langs/sql.mjs";
import tsx from "shiki/langs/tsx.mjs";
import typescript from "shiki/langs/typescript.mjs";
import yaml from "shiki/langs/yaml.mjs";

/** dsh 亮色锚点：关键字 #D6336C、字符串 #2B8A3E、注释 #868E96、正文 #0F1115。 */
const stellaLight = {
	name: "stella-light",
	type: "light",
	colors: {},
	settings: [
		{ scope: ["comment", "punctuation.definition.comment"], settings: { foreground: "#868E96" } },
		{ scope: ["string", "string.regexp", "string.interpolated", "entity.name.tag"], settings: { foreground: "#2B8A3E" } },
		{ scope: ["keyword", "keyword.control", "keyword.operator.expression", "storage.type", "storage.modifier", "entity.name.type", "support.type", "support.class"], settings: { foreground: "#D6336C" } },
		{ scope: ["constant", "constant.numeric", "constant.language", "attribute.name", "variable.language"], settings: { foreground: "#1C7ED6" } },
		{ scope: ["entity.name.function", "support.function", "meta.function-call", "entity.name.class"], settings: { foreground: "#6741D9" } },
		{ scope: ["variable", "variable.other", "meta.variable", "punctuation", "meta.brace", "text"], settings: { foreground: "#0F1115" } },
	],
} satisfies ThemeRegistrationRaw;

/** 暗色锚点：GitHub Dark 系（与亮色同语义位）。 */
const stellaDark = {
	name: "stella-dark",
	type: "dark",
	colors: {},
	settings: [
		{ scope: ["comment", "punctuation.definition.comment"], settings: { foreground: "#8B949E" } },
		{ scope: ["string", "string.regexp", "string.interpolated", "entity.name.tag"], settings: { foreground: "#7EE787" } },
		{ scope: ["keyword", "keyword.control", "keyword.operator.expression", "storage.type", "storage.modifier", "entity.name.type", "support.type", "support.class"], settings: { foreground: "#FF7B72" } },
		{ scope: ["constant", "constant.numeric", "constant.language", "attribute.name", "variable.language"], settings: { foreground: "#79C0FF" } },
		{ scope: ["entity.name.function", "support.function", "meta.function-call", "entity.name.class"], settings: { foreground: "#D2A8FF" } },
		{ scope: ["variable", "variable.other", "meta.variable", "punctuation", "meta.brace", "text"], settings: { foreground: "#E6EDF3" } },
	],
} satisfies ThemeRegistrationRaw;

const LANGS = {
	bash,
	css,
	diff,
	go,
	html,
	java,
	javascript,
	json,
	jsx,
	markdown,
	powershell,
	python,
	rust,
	shellscript,
	sql,
	tsx,
	typescript,
	yaml,
} as const;

export type BundledLang = keyof typeof LANGS;

/** 语言别名归一（md → markdown、sh/zsh → shellscript、py → python…）。 */
const ALIASES: Record<string, BundledLang> = {
	js: "javascript",
	mjs: "javascript",
	cjs: "javascript",
	javascript: "javascript",
	jsx: "jsx",
	ts: "typescript",
	tsx: "tsx",
	typescript: "typescript",
	json: "json",
	jsonc: "json",
	sh: "shellscript",
	zsh: "shellscript",
	shell: "shellscript",
	bash: "bash",
	console: "shellscript",
	py: "python",
	python: "python",
	css: "css",
	html: "html",
	xml: "html",
	md: "markdown",
	markdown: "markdown",
	yml: "yaml",
	yaml: "yaml",
	sql: "sql",
	diff: "diff",
	patch: "diff",
	go: "go",
	rs: "rust",
	rust: "rust",
	java: "java",
	ps1: "powershell",
	powershell: "powershell",
	pwsh: "powershell",
};

let highlighterPromise: Promise<HighlighterCore> | undefined;

function getHighlighter(): Promise<HighlighterCore> {
	if (highlighterPromise === undefined) {
		highlighterPromise = createHighlighterCore({
			themes: [stellaLight, stellaDark],
			langs: Object.values(LANGS),
			engine: createJavaScriptRegexEngine(),
		});
	}
	return highlighterPromise;
}

/** 语言 id → 是否可高亮。 */
export function isSupportedLang(lang: string): boolean {
	return ALIASES[lang.toLowerCase()] !== undefined;
}

/** 高亮为双主题 HTML（span 带 --shiki-light/--shiki-dark 变量）。 */
export async function highlightCode(code: string, lang: string): Promise<string> {
	const resolved = ALIASES[lang.toLowerCase()];
	if (resolved === undefined) return code;
	const highlighter = await getHighlighter();
	return highlighter.codeToHtml(code, {
		lang: resolved,
		themes: { light: stellaLight.name, dark: stellaDark.name },
		defaultColor: false,
	});
}
