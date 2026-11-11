/**
 * 主题逻辑单测（`src/theme.ts`）。
 *
 * 这条链没有任何测试覆盖，但它是**首帧体验**：偏好存 localStorage、解析成实际主题、
 * 写 `html[data-theme]` + `color-scheme` + `meta[theme-color]`（index.html 里的防闪
 * 内联脚本读同一套键，两边必须一致）。测之前先在全局装最小 DOM/存储桩。
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

/** 最小 localStorage 桩。 */
function installStorage(initial: Record<string, string> = {}) {
	const map = new Map(Object.entries(initial));
	(globalThis as unknown as { localStorage: Storage }).localStorage = {
		getItem: (k: string) => map.get(k) ?? null,
		setItem: (k: string, v: string) => void map.set(k, v),
		removeItem: (k: string) => void map.delete(k),
		clear: () => map.clear(),
		key: () => null,
		length: 0,
	} as Storage;
	return map;
}

/** 最小 document 桩：只实现 theme.ts 用到的部分。 */
function installDocument() {
	const meta = { setAttribute: vi.fn() };
	const root = { dataset: {} as Record<string, string>, style: {} as Record<string, string> };
	(globalThis as unknown as { document: unknown }).document = {
		documentElement: root,
		querySelector: (selector: string) => (selector.includes("theme-color") ? meta : null),
	};
	return { root, meta };
}

/** matchMedia 桩：dark 由外部控制。 */
function installMatchMedia(state: { dark: boolean }) {
	const listeners: (() => void)[] = [];
	(globalThis as unknown as { window: unknown }).window = {
		matchMedia: () => ({
			get matches() {
				return state.dark;
			},
			addEventListener: (_: string, cb: () => void) => void listeners.push(cb),
		}),
	};
	return { listeners };
}

describe("主题偏好", () => {
	let store: Map<string, string>;
	let dom: { root: { dataset: Record<string, string>; style: Record<string, string> }; meta: { setAttribute: ReturnType<typeof vi.fn> } };
	const media = { dark: false };

	beforeEach(() => {
		store = installStorage();
		dom = installDocument();
		installMatchMedia(media);
		media.dark = false;
		vi.resetModules();
	});

	it("缺省偏好是 system", async () => {
		const theme = await import("../src/theme");
		expect(theme.loadThemePref()).toBe("system");
	});

	it("循环 light → dark → system → light，并落盘", async () => {
		const theme = await import("../src/theme");
		expect(theme.cycleTheme()).toBe("light");
		expect(store.get("stella-theme")).toBe("light");
		expect(theme.cycleTheme()).toBe("dark");
		expect(theme.cycleTheme()).toBe("system");
		expect(theme.cycleTheme()).toBe("light");
	});

	it("system 跟随系统深浅，显式 light/dark 不跟随", async () => {
		const theme = await import("../src/theme");
		media.dark = true;
		expect(theme.resolveTheme("system")).toBe("dark");
		expect(theme.resolveTheme("light")).toBe("light");
		expect(theme.resolveTheme("dark")).toBe("dark");
		media.dark = false;
		expect(theme.resolveTheme("system")).toBe("light");
	});

	it("applyTheme 写 data-theme / color-scheme / theme-color（与防闪脚本同一落点）", async () => {
		const theme = await import("../src/theme");
		media.dark = true;
		theme.initTheme();
		expect(dom.root.dataset.theme).toBe("dark");
		expect(dom.root.style.colorScheme).toBe("dark");
		expect(dom.meta.setAttribute).toHaveBeenCalledWith("content", "#151517");

		media.dark = false;
		theme.initTheme();
		expect(dom.root.dataset.theme).toBe("light");
		expect(dom.meta.setAttribute).toHaveBeenLastCalledWith("content", "#ffffff");
	});

	it("存量非法值回落 system（不抛错）", async () => {
		installStorage({ "stella-theme": "neon" });
		const theme = await import("../src/theme");
		expect(theme.loadThemePref()).toBe("system");
	});
});
