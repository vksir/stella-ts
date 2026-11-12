/**
 * 会话创建时定格的技能清单。
 *
 * 为什么定格：系统提示是模型请求的前缀，服务商按前缀做缓存。规则、工具或这段技能
 * 介绍只要在会话中途变一次，缓存就从头失效、费用跳一档。所以目录扫描只在**创建
 * 会话**时发生；之后这个会话永远返回同一串文字。目录的增删改只影响新会话。
 *
 * 顺带保住另一件事：会话过程中删掉某个技能，已有会话不会因为读不到文件而报错。
 */
import { defineDoc } from "@earendil-works/pi-durable";

/** 一张会话文档：拼接好的技能介绍 + 名字到文件的对照表。 */
export interface SkillSnapshot {
	/** 渲染好的 `<available_skills>` 文字；空串表示这个会话没有可用技能。 */
	catalog: string;
	/** JSON 序列化的 `Skill[]`，供 `/skill:<name>` 找文件（含不进入提示的技能）。 */
	entries: string;
	[key: string]: string;
}

export const SkillSnapshot = defineDoc<SkillSnapshot>({
	kind: "stella.skills",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ catalog: "", entries: "[]" }),
	checkpointWhen: () => true,
});
