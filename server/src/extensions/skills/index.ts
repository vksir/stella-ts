/**
 * 技能扩展：把 `data/skills/` 里的 `SKILL.md` 索引接入系统提示。
 *
 * 只有一件事：系统提示里放一段 `<available_skills>`，正文由模型用 read 按需读取。
 * 技能集合在**创建会话时**定格进 `SkillSnapshot`（见 snapshot.ts），所以这里只读
 * 快照，不扫目录——目录变化不会动到已有会话的提示词缓存。
 */
import { watch, type FSWatcher } from "node:fs";
import { mkdir } from "node:fs/promises";
import { defineExtension, section, type Extension } from "@earendil-works/pi-durable";
import { renderSkillsCatalog } from "./catalog.js";
import { scanSkills } from "./scan.js";
import { SkillSnapshot } from "./snapshot.js";
import type { Skill, SkillDiagnostic } from "./types.js";

/** 扩展名：预设按名字引用它。 */
export const SKILLS_EXTENSION_NAME = "stella-skills";

/**
 * 技能清单扩展。
 *
 * 读的是会话文档里的快照，不是磁盘。创建会话时没写快照（旧会话）时返回 undefined，
 * 系统提示里就不出现这一段，行为与没有技能功能时一致。
 */
export const StellaSkills: Extension = defineExtension({
	name: SKILLS_EXTENSION_NAME,
	sections: [
		section(
			SKILLS_EXTENSION_NAME,
			async (input, context) => {
				const snapshot = await input.read.snapshot(SkillSnapshot, input.conversationId, context);
				const catalog = snapshot?.catalog ?? "";
				return catalog.length > 0 ? catalog : undefined;
			},
			{ tag: false },
		),
	],
});

/** 目录变化后的防抖。 */
const RELOAD_DEBOUNCE_MS = 150;

/**
 * 技能目录的所有者：负责建目录、扫描、监听变化。
 *
 * 扫描结果只给**新建会话**用；已有会话读自己的 `SkillSnapshot`。所以监听变化不会
 * 让任何正在进行的对话换技能。
 */
export class SkillsStore {
	readonly #dir: string;
	#skills: readonly Skill[] = [];
	#diagnostics: readonly SkillDiagnostic[] = [];
	#watcher: FSWatcher | undefined;
	#timer: NodeJS.Timeout | undefined;

	constructor(dir: string) {
		this.#dir = dir;
	}

	get dir(): string {
		return this.#dir;
	}

	/** 当前扫描到的技能（新会话按预设白名单从这里取）。 */
	get skills(): readonly Skill[] {
		return this.#skills;
	}

	get diagnostics(): readonly SkillDiagnostic[] {
		return this.#diagnostics;
	}

	/** 建目录、扫描一次、开始监听。 */
	async start(): Promise<void> {
		await mkdir(this.#dir, { recursive: true });
		this.reload();
		this.#startWatching();
	}

	/** 立即重扫一次。 */
	reload(): void {
		const scan = scanSkills(this.#dir);
		this.#skills = scan.skills;
		this.#diagnostics = scan.diagnostics;
	}

	stop(): void {
		if (this.#timer !== undefined) {
			clearTimeout(this.#timer);
			this.#timer = undefined;
		}
		this.#watcher?.close();
		this.#watcher = undefined;
	}

	#startWatching(): void {
		if (this.#watcher !== undefined) return;
		try {
			this.#watcher = watch(this.#dir, { recursive: true, persistent: false }, () => this.#scheduleReload());
			this.#watcher.on("error", (error) => {
				console.error(`[stella] 技能目录监听失败：${this.#dir}`, error);
			});
		} catch (error) {
			console.warn(`[stella] 技能目录不可监听，新增技能需重启后生效：${this.#dir}`, error);
		}
	}

	#scheduleReload(): void {
		if (this.#timer !== undefined) clearTimeout(this.#timer);
		this.#timer = setTimeout(() => {
			this.#timer = undefined;
			this.reload();
		}, RELOAD_DEBOUNCE_MS);
		this.#timer.unref?.();
	}
}

export { renderSkillsCatalog } from "./catalog.js";
export { parseFrontmatter, scanSkills, validateDescription, validateName } from "./scan.js";
export { SkillSnapshot } from "./snapshot.js";
export type { Skill, SkillDiagnostic, SkillScan } from "./types.js";
