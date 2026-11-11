/**
 * 代码高亮的门面（轻量）：只做语言归一与按需加载。
 * 真正的 shiki 与语言包在首次遇到代码块时动态 import（独立 chunk，不占首屏）。
 */

/** 语言别名归一（md → markdown、sh/zsh → shellscript、py → python…）。 */
const ALIASES: Record<string, string> = {
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

export function isSupportedLang(lang: string): boolean {
	return ALIASES[lang.toLowerCase()] !== undefined;
}

type ShikiModule = typeof import("./highlight-shiki");

let modulePromise: Promise<ShikiModule> | undefined;

function loadShiki(): Promise<ShikiModule> {
	if (modulePromise === undefined) modulePromise = import("./highlight-shiki");
	return modulePromise;
}

/** 高亮为双主题 HTML（span 带 --shiki-light/--shiki-dark 变量）；不支持的语言原样返回。 */
export async function highlightCode(code: string, lang: string): Promise<string> {
	const resolved = ALIASES[lang.toLowerCase()];
	if (resolved === undefined) return code;
	const shiki = await loadShiki();
	return shiki.highlightResolved(code, resolved);
}
