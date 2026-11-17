/** 展示层的时间/路径小工具（App、详情栏、侧栏共用）。 */

import type { ConversationSummary } from "../api";

const DAY_MS = 86_400_000;

export function startOfDay(ts: number): number {
	const date = new Date(ts);
	date.setHours(0, 0, 0, 0);
	return date.getTime();
}

/** 会话的“最近活动”：新数据用 updatedAt，旧数据回落 createdAt。 */
export function timeOf(conversation: ConversationSummary): number {
	return conversation.updatedAt ?? conversation.createdAt ?? 0;
}

export function pad2(value: number): string {
	return String(value).padStart(2, "0");
}

export function relativeTime(ts?: number): string {
	if (ts === undefined || ts <= 0) return "";
	const diff = Date.now() - ts;
	if (diff < 60_000) return "刚刚";
	if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
	const date = new Date(ts);
	const now = new Date();
	if (date.toDateString() === now.toDateString()) return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
	const yesterday = new Date(now);
	yesterday.setDate(now.getDate() - 1);
	if (date.toDateString() === yesterday.toDateString()) return "昨天";
	const days = Math.floor((startOfDay(Date.now()) - startOfDay(ts)) / DAY_MS);
	if (days < 7) return `${days} 天前`;
	return `${date.getMonth() + 1} 月 ${date.getDate()} 日`;
}

export function formatFull(ts?: number): string {
	if (ts === undefined || ts <= 0) return "—";
	const date = new Date(ts);
	return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

/** 取路径末段（Windows 与 POSIX 通用）。 */
export function baseName(path: string): string {
	return path.split(/[\\/]/).filter((part) => part.length > 0).pop() ?? "";
}

export { DAY_MS };
