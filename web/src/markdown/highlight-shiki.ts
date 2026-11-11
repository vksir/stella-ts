/**
 * shiki 高亮实现（仅由 highlight.ts 动态 import）：
 * JS 正则引擎、无 WASM、双主题 CSS 变量输出。
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
		{ settings: { foreground: "#0F1115", background: "#F9FAFB" } },
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
		{ settings: { foreground: "#E6EDF3", background: "#1B1B1C" } },
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

type LangKey = keyof typeof LANGS;

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

/** 已归一化的语言 id → 双主题 HTML。 */
export async function highlightResolved(code: string, lang: string): Promise<string> {
	if (!(lang in LANGS)) return code;
	const highlighter = await getHighlighter();
	return highlighter.codeToHtml(code, {
		lang: lang as LangKey,
		themes: { light: stellaLight.name, dark: stellaDark.name },
		defaultColor: false,
	});
}

/** 供流式高亮会话复用同一个 highlighter 与主题名。 */
export async function streamingHighlighter(): Promise<{
	highlighter: HighlighterCore;
	themes: { light: string; dark: string };
}> {
	return {
		highlighter: await getHighlighter(),
		themes: { light: stellaLight.name, dark: stellaDark.name },
	};
}
