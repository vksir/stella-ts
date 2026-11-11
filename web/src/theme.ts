/** 主题：light | dark | system（默认 system），localStorage 持久化；防闪脚本在 index.html。 */

export type ThemePref = "light" | "dark" | "system";

const THEME_KEY = "stella-theme";

function systemPrefersDark(): boolean {
	return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

export function resolveTheme(pref: ThemePref): "light" | "dark" {
	if (pref === "system") return systemPrefersDark() ? "dark" : "light";
	return pref;
}

export function loadThemePref(): ThemePref {
	try {
		const raw = localStorage.getItem(THEME_KEY);
		if (raw === "light" || raw === "dark" || raw === "system") return raw;
	} catch {
		/* localStorage 不可用时跟随系统 */
	}
	return "system";
}

function applyTheme(pref: ThemePref): void {
	const resolved = resolveTheme(pref);
	document.documentElement.dataset.theme = resolved;
	document.documentElement.style.colorScheme = resolved;
	document
		.querySelector('meta[name="theme-color"]')
		?.setAttribute("content", resolved === "dark" ? "#151517" : "#ffffff");
}

/** 循环切换：浅色 → 深色 → 跟随系统 → 浅色；持久化并立即生效。 */
export function cycleTheme(): ThemePref {
	const order: ThemePref[] = ["light", "dark", "system"];
	const current = order.indexOf(loadThemePref());
	const next = order[(current + 1) % order.length] ?? "system";
	try {
		localStorage.setItem(THEME_KEY, next);
	} catch {
		/* 存不进就仅本次生效 */
	}
	applyTheme(next);
	return next;
}

/** 启动时应用一次，并跟随系统偏好变化（system 态）。 */
export function initTheme(): void {
	applyTheme(loadThemePref());
	window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
		applyTheme(loadThemePref());
	});
}
