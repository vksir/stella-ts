/**
 * 最小安全兜底：只拦“毁灭性”命令，不做审批流。
 *
 * 预设负责能力边界（例如只读预设不给 bash），但日常/标准预设仍开着 shell；
 * 这里的 `beforeTool` 是最后一道保险，拦 `rm -rf /`、格式化磁盘、关机这类
 * 不可逆操作。命中时给模型一个 blocked 结果，让它改用安全做法。
 */
import { defineExtension, hook, ToolTask } from "@earendil-works/pi-durable";

const SHELL_TOOLS = new Set(["bash", "powershell"]);

const DANGEROUS: readonly { readonly pattern: RegExp; readonly reason: string }[] = [
	{
		pattern: /\brm\s+-[a-z]*[rf][a-z]*\b[^\n]*\s(\/|\/\*|~|\$HOME)(\s|$)/i,
		reason: "recursive delete of / or the home directory",
	},
	{ pattern: /\bmkfs(\.[a-z0-9]+)?\b/i, reason: "filesystem format" },
	{ pattern: /\bdd\b[^\n]*\bof=\/dev\//i, reason: "raw device write" },
	{ pattern: /:\(\)\s*\{\s*:\|:&\s*\};:/, reason: "fork bomb" },
	{ pattern: /(^|[;&|]\s*)(sudo\s+)?(shutdown|reboot|halt|poweroff)\b/i, reason: "host shutdown" },
	{ pattern: /\bformat\s+[a-z]:/i, reason: "disk format" },
	{ pattern: /\bdiskpart\b/i, reason: "disk partitioning" },
	{ pattern: /\bdel\s+(\/[a-z]+\s+)*[a-z]:\\/i, reason: "recursive delete of a drive root" },
	{ pattern: /\brd\s+(\/[a-z]+\s+)*[a-z]:\\/i, reason: "recursive delete of a drive root" },
	{ pattern: /\bRemove-Item\b[^\n]*-Recurse[^\n]*\b[a-z]:\\\s*$/i, reason: "recursive delete of a drive root" },
	{ pattern: />\s*\/dev\/(sd|disk|nvme)/i, reason: "raw device write" },
	{ pattern: /\bchmod\s+-R\s+777\s+\/(\s|$)/i, reason: "world-writable root" },
];

/** 命中危险命令时返回拦截原因；否则 undefined。 */
export function dangerousCommand(tool: string, args: unknown): string | undefined {
	if (!SHELL_TOOLS.has(tool) || typeof args !== "object" || args === null) return undefined;
	const command = (args as { command?: unknown }).command;
	if (typeof command !== "string" || command.length === 0) return undefined;
	for (const { pattern, reason } of DANGEROUS) {
		if (pattern.test(command)) return reason;
	}
	return undefined;
}

export const StellaGuard = defineExtension({
	name: "stella-guard",
	hooks: [
		hook(ToolTask, {
			beforeTool: (call) => {
				const reason = dangerousCommand(call.name, call.arguments);
				return reason === undefined
					? undefined
					: { block: `Blocked by Stella's safety guard: ${reason}. Ask the user before doing this.` };
			},
		}),
	],
});
