/**
 * 把技能列表渲染成系统提示里的一段文字。
 *
 * 只放名字、描述与 SKILL.md 路径，不放正文——这正是「技能」与「扩展」的分界。
 * 格式照 Agent Skills 规范（pi 的 `<available_skills>`），模型按 location 用 read 读取。
 */
import type { Skill } from "./types.js";

const HEADER = [
	"The following skills provide specialized instructions for specific tasks.",
	"Use the read tool to load a skill's file when the task matches its description.",
	"Resolve relative paths against the skill's directory (parent of SKILL.md). Use absolute paths in tool calls.",
];

function escapeXml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

/**
 * 渲染成一段可直接放进系统提示的文字；没有可展示的技能时返回空串。
 *
 * `disableModelInvocation` 的技能不进提示（只能 `/skill:<name>` 手动加载）。
 */
export function renderSkillsCatalog(skills: readonly Skill[]): string {
	const visible = skills.filter((skill) => !skill.disableModelInvocation);
	if (visible.length === 0) return "";
	const lines = [...HEADER, "", "<available_skills>"];
	for (const skill of visible) {
		lines.push("  <skill>");
		lines.push(`    <name>${escapeXml(skill.name)}</name>`);
		lines.push(`    <description>${escapeXml(skill.description)}</description>`);
		lines.push(`    <location>${escapeXml(skill.filePath)}</location>`);
		lines.push("  </skill>");
	}
	lines.push("</available_skills>");
	return lines.join("\n");
}
