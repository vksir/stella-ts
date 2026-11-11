/**
 * React-free、无副作用的文案与摘要（从 app-store 抽出，便于单测）。
 *
 * 抽出的动因：这些函数被 store 与组件共用，但原先放在 app-store.ts 里——该模块在
 * import 时就 `new AppStore()`（读 localStorage），在 Node 测试环境不可加载。
 */

/** 工具调用的关键参数摘要（一行，过长截断）。 */
/** 工具调用的关键参数摘要（一行，过长截断）。 */
export function summarizeToolCall(name: string, args: Readonly<Record<string, unknown>>): string {
	const str = (key: string): string => (typeof args[key] === "string" ? (args[key] as string) : "");
	let summary: string;
	switch (name) {
		case "bash":
			summary = str("command");
			break;
		case "read":
			summary = str("path");
			break;
		case "write": {
			const content = str("content");
			summary = `${str("path")}（写入 ${content.length} 字）`;
			break;
		}
		case "edit": {
			summary = `${str("path")}（替换 ${str("oldText").length} 字 → ${str("newText").length} 字）`;
			break;
		}
		// Stella / pi-durable 自有工具：code 模式脚本、子代理任务
		case "codemode": {
			const code = str("code");
			const firstLine = code.split("\n").find((line) => line.trim().length > 0) ?? "";
			summary = firstLine.length > 0 ? firstLine.trim() : `（脚本 ${code.length} 字）`;
			break;
		}
		case "subagent":
			summary = str("task").split("\n")[0] ?? "";
			break;
		default: {
			// 未知工具：优先挑一个像"主语"的字符串参数，避免把整个 JSON 甩在行上
			const preferred = ["command", "path", "query", "url", "name", "task", "code", "pattern", "prompt"];
			const picked = preferred.map((key) => str(key)).find((value) => value.length > 0);
			summary = picked ?? (JSON.stringify(args) ?? "");
		}
	}
	const oneLine = summary.split("\n")[0] ?? "";
	return oneLine.length > 80 ? `${oneLine.slice(0, 80)}…` : oneLine;
}

/** 失败卡片文案：中文原因 + 可选底层错误。 */
export function failureCardText(reason: string | undefined, detail: string | undefined): string {
	let base: string;
	switch (reason) {
		case "model_error":
			base = "本次回答失败：模型请求出错";
			break;
		case "no_model":
			base = "本次回答失败：没有可用的模型";
			break;
		case "faulted":
			base = "本次回答失败：运行内部出错";
			break;
		case "interrupted":
			base = "本次回答失败：服务中断时回答未完成";
			break;
		case "restart_limit":
			base = "本次回答失败：重启后无法继续运行";
			break;
		case "orphaned":
			base = "本次回答失败：所属任务已丢失";
			break;
		case "turn_limit":
			base = "本次回答失败：工具调用轮次达到上限";
			break;
		case "nothing_to_answer":
			base = "本次没有需要回答的内容";
			break;
		default:
			base = `本次回答失败（原因：${reason ?? "未知"}）`;
	}
	const tail = detail !== undefined && detail.trim().length > 0 ? `，底层错误：${detail}` : "。";
	return base + tail;
}

/** 用户主动停止后的说明行文案。 */
export function stoppedText(): string {
	return "已停止本次运行，已生成的部分已保留。";
}
