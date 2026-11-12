/**
 * 技能（skill）：一个目录里的 `SKILL.md`，frontmatter 声明名字与触发描述。
 *
 * 与扩展的区别只有一条：扩展的内容每轮都在系统提示里；技能只把名字、描述与
 * 文件路径放进系统提示，正文由模型用 read 按需读取。
 */

/** 扫描到的一个技能。 */
export interface Skill {
	/** 技能名；缺省取 SKILL.md 所在目录名。 */
	readonly name: string;
	/** 一句话说明「做什么、什么时候用」，模型据此决定是否加载正文。 */
	readonly description: string;
	/** SKILL.md 的绝对路径（放进系统提示，模型直接 read 它）。 */
	readonly filePath: string;
	/** 技能目录（SKILL.md 的父目录），附带资源按它解析相对路径。 */
	readonly baseDir: string;
	/** 只允许 `/skill:<name>` 手动触发，不进入系统提示。 */
	readonly disableModelInvocation: boolean;
}

/** 扫描时发现的问题。坏技能被跳过，不阻止启动。 */
export interface SkillDiagnostic {
	readonly severity: "warning";
	readonly message: string;
	readonly path: string;
}

/** 一次扫描的结果。 */
export interface SkillScan {
	readonly skills: readonly Skill[];
	readonly diagnostics: readonly SkillDiagnostic[];
}
