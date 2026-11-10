/**
 * 会话元数据：标题与创建时间。
 *
 * pi-durable 的 `ConversationRecord` 只有 id 与归属关系，不含标题、创建时间，也没有删除会话的
 * API（Harness/Conversation/Tx/Storage 各层都没有）。因此元数据按 README「Your Own State」
 * 用会话级文档自持，与条目同一事务落盘（SQLite 下随会话一起持久化，重启后完好）。
 *
 * 删除的真实语义：pi-durable 1.5.0 无法移除已创建的会话记录，本票的删除是宿主层的
 * 归档（隐藏）：删除前 `conversation.abort()` 停掉运行并撤回排队输入，再把 `deleted`
 * 置真；列表过滤后用户看不到该会话，但数据仍在存储中。
 */
import { defineDoc } from "@earendil-works/pi-durable";

/** 会话标题的最大长度（GLOSSARY「会话标题」：首条用户消息截断约 30 字符）。 */
const TITLE_MAX_LENGTH = 30;

/** 会话元数据（满足 pi-durable `JsonObject` 约束，带索引签名）。 */
export interface ConversationMeta {
	/** 创建时间（epoch 毫秒）。旧数据（票 01 时代）缺失时为 0，列表按缺失处理。 */
	createdAt: number;
	/** 会话标题；首条用户消息发出前为 null，前端显示占位名。 */
	title: string | null;
	/** 归档（删除）标记：置真后从列表隐藏。数据不物理删除。 */
	deleted: boolean;
	/** 创建时选择的预设 id（只用于显示；能力已解析进 `pi.agent`，首轮后锁定）。 */
	preset: string | null;
	[key: string]: number | string | null | boolean;
}

/** 会话级元数据文档：每次变更都存完整基（元数据极小，重放无意义）。 */
export const ConversationMeta = defineDoc<ConversationMeta>({
	kind: "stella.meta",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ createdAt: 0, title: null, deleted: false, preset: null }),
	checkpointWhen: () => true,
});

/** 新会话元数据的初值（创建会话的同一 commit 写入）。 */
export function initialConversationMeta(): ConversationMeta {
	return { createdAt: Date.now(), title: null, deleted: false, preset: null };
}

/** 首条用户消息截断为会话标题：按码点取前 30 字符，截断时补省略号。 */
export function truncateTitle(content: string): string {
	const trimmed = content.trim();
	const chars = Array.from(trimmed);
	if (chars.length <= TITLE_MAX_LENGTH) return trimmed;
	return `${chars.slice(0, TITLE_MAX_LENGTH).join("")}…`;
}
