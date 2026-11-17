/** 预设的展示身份：初始字、身份色、查找。 */

import type { AppSnapshot } from "../store/app-store";

export type Tint = "sage" | "blue" | "clay";

export function presetOf(app: AppSnapshot, id: string | null | undefined) {
	return app.presets.find((preset) => preset.id === id);
}

export function initialOf(name: string | null | undefined): string {
	return Array.from(name?.trim() ?? "")[0] ?? "S";
}

/** 不给预设发明 persona：只按 id/名字挑一个低饱和身份色，纯展示。 */
export function tintFor(idOrName: string | null | undefined): Tint {
	const key = (idOrName ?? "").toLowerCase();
	if (/cod|eng|dev|工程|代码/.test(key)) return "blue";
	if (/writ|文案|写作|草稿/.test(key)) return "clay";
	return "sage";
}
