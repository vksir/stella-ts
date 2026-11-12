/**
 * 前台子代理（pi-durable 示例 21 的产品化）：
 *
 * - 模型调用 `subagent` 工具，工具在自己的任务下创建一个**子会话**（所有权归本工具调用），
 *   在子会话里跑一次任务，把最终回答文本带回父会话。
 * - `replay: "safe"`：崩溃重跑时通过所有权索引找到同一个子会话与同一条提交，
 *   不会重复创建、重复提问。
 * - 子会话继承父会话的 agent（模型、扩展、工具、cwd、maxTurns），只移除 `subagent`
 *   自身，避免无限套娃；`callers: ["model"]` 让 code mode 脚本不能调用它。
 * - 中止工具调用会中止子会话；结果 `details.conversationId` 供 UI 挂载子会话。
 */
import type { Context } from "@earendil-works/chord/context";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { obj, str } from "@earendil-works/pi-schema";
import {
	AssistantEntry,
	configure,
	defineExtension,
	defineTool,
	type EntryId,
	type Extension,
	type ToolExecutionApi,
} from "@earendil-works/pi-durable";

async function answerText(api: ToolExecutionApi, answer: EntryId, context: Context): Promise<string> {
	const entry = await api.commit((tx) => tx.entry(AssistantEntry, answer), context);
	const message = entry?.model?.[0] as AssistantMessage | undefined;
	if (message === undefined) return "";
	return message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
}

export const StellaSubagent: Extension = defineExtension({
	name: "subagent",
	tools: [
		defineTool({
			name: "subagent",
			description:
				"Delegate a self-contained task to a fresh subagent with its own context and get its final answer back. " +
				"Use it for a focused piece of work that would otherwise flood this conversation with intermediate steps.",
			parameters: obj({ task: str({ description: "What the subagent should do, in full" }) }),
			callers: ["model"],
			replay: "safe",
			execute: async (args, api, context) => {
				const child = await api.commit(async (tx) => {
					// 所有权索引记住这个子会话：崩溃重跑时复用，而不是再建一个。
					const existing = (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0];
					if (existing !== undefined) return existing.id;
					const created = await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
					await configure(tx, created.id, { extensions: { remove: [StellaSubagent] } });
					return created.id;
				}, context);
				await api.details({ conversationId: child }, context);

				const handle = await api.conversation(child, context);
				if (handle === undefined) throw new Error("Subagent conversation is unavailable");
				const request = { type: "input", content: args.task, requestId: `subagent:${api.taskId}` } as const;
				const settled = await (await handle.submit(request, context)).wait(context);
				if (settled.status !== "done" || settled.type !== "input") {
					const reason = settled.status === "unanswered" ? settled.reason : settled.status;
					throw new Error(`Subagent did not answer: ${reason}`);
				}
				const text = await answerText(api, settled.answer, context);
				return {
					output: [{ type: "text", text: text.length > 0 ? text : "(subagent returned no text)" }],
					details: { conversationId: child },
				};
			},
		}),
	],
});
