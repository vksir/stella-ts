/**
 * 扫描技能目录并解析 `SKILL.md`。规则对齐 Agent Skills 规范（pi 的实现）：
 *
 * - 目录里有 `SKILL.md` 就是技能根，不再往里递归；
 * - 否则递归子目录找 `SKILL.md`（跳过 `.` 开头的目录与 `node_modules`）；
 * - `description` 必需，`name` 缺省取目录名；名字只允许小写字母、数字与连字符；
 * - 重名先到先得（目录按名字排序，跨平台结果一致），后来者记一条警告；
 * - 坏文件只记警告，不阻止启动。
 */
import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { Skill, SkillDiagnostic, SkillScan } from "./types.js";

const SKILL_FILE = "SKILL.md";
/** Agent Skills 规范的上限。 */
const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;

/**
 * 读 frontmatter：`---` 包起来的顶层 `key: value`。
 *
 * 支持裸值、单/双引号、行尾注释、`|` 与 `>` 块标量（含 `-`/`+` 修饰）。技能只需要
 * name / description / disable-model-invocation 三个标量，所以不做完整 YAML：
 * 锚点、别名、流式集合（`&`、`*`、`{`、`[` 开头）按普通文本对待。
 * 没有起止分隔线时返回 undefined。
 */
export function parseFrontmatter(text: string): Record<string, string> | undefined {
	const normalized = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
	const lines = normalized.split("\n");
	if ((lines[0] ?? "").trim() !== "---") return undefined;
	const fields: Record<string, string> = {};
	for (let index = 1; index < lines.length; index += 1) {
		const line = lines[index] ?? "";
		if (line.trim() === "---") return fields;
		const match = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
		if (match === null) continue;
		const key = match[1] ?? "";
		if (key.length === 0) continue;
		const raw = stripComment((match[2] ?? "").trim());
		if (raw === "|" || raw === "|-" || raw === "|+" || raw === ">" || raw === ">-" || raw === ">+") {
			const collected: string[] = [];
			let cursor = index + 1;
			while (cursor < lines.length) {
				const next = lines[cursor] ?? "";
				if (next.trim() === "---") break;
				if (next.length > 0 && !/^[ \t]/.test(next)) break;
				collected.push(next.replace(/^[ \t]+/, ""));
				cursor += 1;
			}
			index = cursor - 1;
			fields[key] = raw.startsWith(">")
				? collected.join(" ").replace(/[ \t]+/g, " ").trim()
				: collected.join("\n").replace(/\s+$/, "");
			continue;
		}
		fields[key] = unquote(raw);
	}
	return undefined;
}

/** 去掉引号外的行尾注释：`true # 注释` → `true`，`"a # b"` 原样保留。 */
function stripComment(value: string): string {
	let quote: string | undefined;
	for (let index = 0; index < value.length; index += 1) {
		const character = value[index];
		if (quote !== undefined) {
			if (character === quote) quote = undefined;
			continue;
		}
		if (character === '"' || character === "'") {
			quote = character;
			continue;
		}
		if (character === "#" && (index === 0 || /\s/.test(value[index - 1] ?? ""))) {
			return value.slice(0, index).trimEnd();
		}
	}
	return value;
}

function unquote(value: string): string {
	if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) return value.slice(1, -1);
	if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1);
	return value;
}

/** 名字规则：小写字母、数字、连字符；不以下划线开头/结尾，不出现连续连字符。 */
export function validateName(name: string): readonly string[] {
	const errors: string[] = [];
	if (name.length > MAX_NAME_LENGTH) errors.push(`name 超过 ${MAX_NAME_LENGTH} 字符（${name.length}）`);
	if (!/^[a-z0-9-]+$/.test(name)) errors.push("name 只能包含小写字母、数字与连字符");
	if (name.startsWith("-") || name.endsWith("-")) errors.push("name 不能以连字符开头或结尾");
	if (name.includes("--")) errors.push("name 不能包含连续连字符");
	return errors;
}

/** 描述规则：非空，不超过 1024 字符。 */
export function validateDescription(description: string): readonly string[] {
	const errors: string[] = [];
	if (description.trim().length === 0) errors.push("description 不能为空");
	else if (description.length > MAX_DESCRIPTION_LENGTH) {
		errors.push(`description 超过 ${MAX_DESCRIPTION_LENGTH} 字符（${description.length}）`);
	}
	return errors;
}

function loadSkill(filePath: string): { skill: Skill | undefined; diagnostics: readonly SkillDiagnostic[] } {
	const diagnostics: SkillDiagnostic[] = [];
	let text: string;
	try {
		text = readFileSync(filePath, "utf8");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { skill: undefined, diagnostics: [{ severity: "warning", message, path: filePath }] };
	}
	const frontmatter = parseFrontmatter(text);
	if (frontmatter === undefined) {
		return {
			skill: undefined,
			diagnostics: [{ severity: "warning", message: "缺少 --- 包裹的 frontmatter", path: filePath }],
		};
	}
	const description = (frontmatter.description ?? "").trim();
	if (description.length === 0) {
		return { skill: undefined, diagnostics: [{ severity: "warning", message: "缺少 description", path: filePath }] };
	}
	const baseDir = dirname(filePath);
	const name = (frontmatter.name ?? "").trim() || basename(baseDir);
	for (const message of validateName(name)) diagnostics.push({ severity: "warning", message, path: filePath });
	for (const message of validateDescription(description)) diagnostics.push({ severity: "warning", message, path: filePath });
	const hiddenRaw = frontmatter["disable-model-invocation"];
	if (hiddenRaw !== undefined && hiddenRaw !== "true" && hiddenRaw !== "false" && hiddenRaw.length > 0) {
		diagnostics.push({
			severity: "warning",
			message: `disable-model-invocation 应为 true/false，收到的 "${hiddenRaw}" 按 false 处理`,
			path: filePath,
		});
	}
	return {
		skill: {
			name,
			description,
			filePath,
			baseDir,
			// 只有明确的 true 才隐藏；拼错的值不能把技能误关在系统提示之外，也不能误放进去。
			disableModelInvocation: hiddenRaw === "true",
		},
		diagnostics,
	};
}

/** 扫描一个目录。目录不存在时返回空结果（首次启动还没建目录）。 */
export function scanSkills(dir: string): SkillScan {
	const skills: Skill[] = [];
	const diagnostics: SkillDiagnostic[] = [];
	const seen = new Set<string>();

	const walk = (current: string): void => {
		let entries;
		try {
			entries = readdirSync(current, { withFileTypes: true });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			diagnostics.push({ severity: "warning", message: `无法读取目录：${message}`, path: current });
			return;
		}
		// 排序后再遍历：重名「先到先得」的结果不随文件系统返回顺序变化。
		const ordered = [...entries].sort((left, right) => left.name.localeCompare(right.name));
		// 本目录有 SKILL.md：它是技能根，不再往里递归。
		if (ordered.some((entry) => entry.isFile() && entry.name === SKILL_FILE)) {
			const filePath = join(current, SKILL_FILE);
			const loaded = loadSkill(filePath);
			diagnostics.push(...loaded.diagnostics);
			if (loaded.skill !== undefined) {
				if (seen.has(loaded.skill.name)) {
					diagnostics.push({
						severity: "warning",
						message: `技能名 "${loaded.skill.name}" 重复，已忽略这一个`,
						path: filePath,
					});
				} else {
					seen.add(loaded.skill.name);
					skills.push(loaded.skill);
				}
			}
			return;
		}
		for (const entry of ordered) {
			if (!entry.isDirectory()) continue;
			if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
			walk(join(current, entry.name));
		}
	};

	walk(resolve(dir));
	return { skills, diagnostics };
}
