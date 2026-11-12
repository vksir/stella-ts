/**
 * Composer 斜杠指令表（纯数据 + 纯函数，便于在 Node 里单测）。
 *
 * 只有整条输入还是"指令名片段"（`/` 开头且尚未出现空白）时才弹可选项，见 `slashQuery`。
 * 提交时 store 用 `parseCommand` 判定是否走本地动作；**未登记**的 `/xxx` 仍当普通消息
 * 发给模型，避免误伤 `/usr/bin` 这类正文。
 */

export interface CommandSpec {
	/** 不含斜杠。 */
	readonly name: string;
	/** 参数占位（仅展示），如 `[说明]`。 */
	readonly args?: string;
	readonly description: string;
	/** 只在运行中可用（没有运行时不进菜单）。 */
	readonly busyOnly?: boolean;
}

export const COMMANDS: readonly CommandSpec[] = [
	{
		name: "compact",
		args: "[说明]",
		description: "压缩上下文：把较早消息摘要掉，腾出窗口",
	},
	{
		name: "new",
		description: "新建会话（沿用当前预设）",
	},
	{
		name: "stop",
		description: "停止当前运行，已生成内容保留",
		busyOnly: true,
	},
	{
		name: "skill",
		args: ":<名字> [要求]",
		description: "加载一个技能：把它的正文连同要求发给模型",
	},
];

/** 菜单里展示的完整用法：`/compact [说明]`。 */
export function usageOf(spec: CommandSpec): string {
	return spec.args === undefined ? `/${spec.name}` : `/${spec.name} ${spec.args}`;
}

/**
 * 输入框内容处于"指令名片段"状态时，返回 `/` 之后的部分；否则 undefined。
 *
 * 出现空白即视为已进入参数区（或用户只是在写正文），菜单收起。
 */
export function slashQuery(text: string): string | undefined {
	if (!text.startsWith("/")) return undefined;
	const rest = text.slice(1);
	return /\s/.test(rest) ? undefined : rest;
}

/** 当前可用指令（`busyOnly` 的只在运行中出现）。 */
export function availableCommands(options: { busy: boolean }): readonly CommandSpec[] {
	return COMMANDS.filter((spec) => spec.busyOnly !== true || options.busy);
}

/**
 * 按片段过滤：名字前缀命中排前，名字包含或描述命中排后。
 * 空片段返回全部（刚敲下 `/` 时列出所有可选项）。
 */
export function matchCommands(query: string, list: readonly CommandSpec[] = COMMANDS): readonly CommandSpec[] {
	const needle = query.toLowerCase();
	if (needle.length === 0) return list;
	const prefix: CommandSpec[] = [];
	const other: CommandSpec[] = [];
	for (const spec of list) {
		const name = spec.name.toLowerCase();
		if (name.startsWith(needle)) prefix.push(spec);
		else if (name.includes(needle) || spec.description.includes(query)) other.push(spec);
	}
	return [...prefix, ...other];
}

/**
 * 解析一条已提交的输入。`/compact 保留工具结果` → `{ spec: compact, args: "保留工具结果" }`。
 * 未登记的名字返回 undefined（当普通消息处理）。
 */
export function parseCommand(
	text: string,
	list: readonly CommandSpec[] = COMMANDS,
): { spec: CommandSpec; args: string } | undefined {
	// 支持两种写法：`/compact 说明` 与 `/skill:名字 要求`（冒号参数与空格参数等价）。
	const matched = /^\/([A-Za-z][\w-]*)(?::([^\s]+))?(?:\s+([\s\S]*))?$/.exec(text.trim());
	if (matched === null) return undefined;
	const name = matched[1]!.toLowerCase();
	const spec = list.find((item) => item.name === name);
	if (spec === undefined) return undefined;
	const inline = matched[2];
	const rest = (matched[3] ?? "").trim();
	const args = inline === undefined ? rest : rest.length > 0 ? `${inline} ${rest}` : inline;
	return { spec, args };
}
