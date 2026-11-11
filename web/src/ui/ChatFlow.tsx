/**
 * 消息流：keys 列表 + 每 key 一个 Seat（只订阅自己的 NodeSource）。
 * 流式期间只有 streaming 节点重渲；历史节点 DOM 纹丝不动。
 * Seat 外层 key 带会话 id 前缀：切换会话强制 remount（内容不同源）。
 */

import { memo, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { failureCardText, store, type FlowNode, type ToolCard } from "../store/app-store";
import { useApp, useFlowKeys, useNode } from "./hooks";
import { IncrementalMarkdown } from "../markdown/incremental";
import { MarkdownBlocks } from "../markdown/view";
import {
	CheckCircleIcon,
	ChevronRightIcon,
	CheckIcon,
	CopyIcon,
	MinusCircleIcon,
	PendingIcon,
	SpinnerIcon,
	StarIcon,
	XCircleIcon,
} from "./icons";

function Seat({ nodeKey, conversationId }: { nodeKey: string; conversationId: number }): ReactNode {
	const node = useNode(nodeKey);
	if (node === null) return null;
	return <NodeView node={node} conversationId={conversationId} />;
}

const SeatMemo = memo(Seat);

export function ChatFlow({ columnRef }: { columnRef: React.RefObject<HTMLDivElement> }): ReactNode {
	const keys = useFlowKeys();
	const conversationId = useApp().conversationId ?? 0;
	return (
		<div className="column" ref={columnRef}>
			{keys.map((key) => (
				<SeatMemo key={`${conversationId}:${key}`} nodeKey={key} conversationId={conversationId} />
			))}
		</div>
	);
}

// —— 轨迹视图（头部「轨迹」Tab）：全部工具调用按时间线展开 ——

export function TraceView(): ReactNode {
	const keys = useFlowKeys();
	const cards = useMemo(() => store.getTraceCards(), [keys]);
	if (cards.length === 0) {
		return (
			<div className="column">
				<div className="flow-item flow-placeholder">（本会话还没有工具调用）</div>
			</div>
		);
	}
	return (
		<div className="column trace">
			{cards.map((item) => (
				<div className="flow-item" key={item.key}>
					<ToolRow card={item.card} />
				</div>
			))}
		</div>
	);
}

// —— 节点视图 ——

function NodeView({ node, conversationId }: { node: FlowNode; conversationId: number }): ReactNode {
	switch (node.type) {
		case "user":
			return <UserNode text={node.text} reveal={node.reveal} />;
		case "assistant":
			return <AssistantNode text={node.text} calls={node.calls} reveal={node.reveal} />;
		case "assistant-error":
			return (
				<div className="flow-item turn-error">
					<span className="error-dot" />
					<div className="turn-error-copy">
						<span className="turn-error-title">{node.type === "assistant-error" ? "本次回答失败" : ""}</span>
						<span className="turn-error-message">{node.message}</span>
					</div>
				</div>
			);
		case "streaming":
			return <StreamingNode text={node.text} />;
		case "tool":
			return (
				<div className="flow-item">
					<ToolRow card={node.card} />
				</div>
			);
		case "running":
			return <RunningRow />;
		case "stopped":
			return <div className="flow-item stopped-line">{node.text}</div>;
		case "error":
			return <ErrorCard reason={node.reason} detail={node.detail} />;
		case "gap":
			return (
				<div className="load-earlier">
					<button type="button" title="断线期间的消息未到达，点击补齐" onClick={() => void store.fillGap(node.after, node.upTo)}>
						加载缺失的消息
					</button>
				</div>
			);
		case "load-earlier":
			return (
				<div className="load-earlier">
					<button type="button" onClick={() => void store.loadEarlier()}>
						加载更早
					</button>
				</div>
			);
		default:
			return null;
	}
}

// —— 用户消息：右对齐浅蓝气泡 + 操作行 ——

function UserNode({ text, reveal }: { text: string; reveal: boolean }): ReactNode {
	return (
		<div className="flow-item msg-user" data-reveal={reveal ? undefined : "hover"}>
			<div className="bubble-stack">
				<div className="bubble">{text}</div>
			</div>
			<CopyActions text={text} />
		</div>
	);
}

// —— 助手消息：无气泡全宽 markdown + 工具折叠行 + 操作行 ——

function AssistantNode({ text, calls, reveal }: { text: string; calls: ToolCard[]; reveal: boolean }): ReactNode {
	const parser = useRef<IncrementalMarkdown | null>(null);
	if (parser.current === null) parser.current = new IncrementalMarkdown();
	const blocks = useMemo(() => parser.current?.settle(text) ?? { blocks: [], frozenEnd: 0 }, [text]);
	return (
		<div className="flow-item msg-stella" data-part="response" data-reveal={reveal ? undefined : "hover"}>
			<div className="turn-status">已完成</div>
			<div className="turn-divider" />
			{text.length > 0 && <MarkdownBlocks blocks={blocks.blocks} />}
			{calls.map((card, index) => (
				<ToolRow key={`${card.name}:${index}`} card={card} />
			))}
			{text.length === 0 && calls.length === 0 && <span className="flow-placeholder">（无文本内容）</span>}
			<CopyActions text={text} />
		</div>
	);
}

// —— 流式节点：增量 append（冻结块缓存 + rAF 上游已合帧） ——

function StreamingNode({ text }: { text: string }): ReactNode {
	const parser = useRef<IncrementalMarkdown | null>(null);
	if (parser.current === null) parser.current = new IncrementalMarkdown();
	const blocks = useMemo(() => parser.current?.append(text) ?? { blocks: [], frozenEnd: 0 }, [text]);
	return (
		<div className="flow-item msg-stella" data-part="response">
			{text.length > 0 && <MarkdownBlocks blocks={blocks.blocks} />}
		</div>
	);
}

// —— 操作行（复制） ——

function CopyActions({ text }: { text: string }): ReactNode | null {
	const [copied, setCopied] = useState(false);
	if (text.length === 0) return null;
	return (
		<div className="msg-actions">
			<button
				type="button"
				className="action"
				title={copied ? "已复制" : "复制"}
				aria-label="复制消息"
				onClick={() => {
					void navigator.clipboard
						.writeText(text)
						.then(() => {
							setCopied(true);
							return new Promise((resolve) => setTimeout(resolve, 1500));
						})
						.then(() => setCopied(false))
						.catch(() => store.showToast("复制失败：浏览器未授权剪贴板访问。"));
				}}
			>
				{copied ? <CheckIcon /> : <CopyIcon />}
			</button>
		</div>
	);
}

// —— 运行状态行（DSH .running：0.5px 分隔线 + 星标 + shimmer 文字） ——

function RunningRow(): ReactNode {
	return (
		<div className="running">
			<span className="running-divider" />
			<span className="running-content">
				<span className="running-icon">
					<StarIcon width={14} height={14} />
				</span>
				<span className="running-text">Stella 正在运行…</span>
			</span>
		</div>
	);
}

// —— 错误卡片 ——

function ErrorCard({ reason, detail }: { reason: string; detail: string | undefined }): ReactNode {
	const [retrying, setRetrying] = useState(false);
	return (
		<div className="flow-item turn-error">
			<span className="error-dot" />
			<div className="turn-error-copy">
				<span className="turn-error-title">{failureCardText(reason, undefined)}</span>
				{detail !== undefined && detail.trim().length > 0 && <span className="turn-error-message">{detail}</span>}
			</div>
			<button
				type="button"
				className="error-retry"
				disabled={retrying}
				title="让模型接着回答停住的上下文，不重复用户消息"
				onClick={() => {
					setRetrying(true);
					void store.retryContinue().finally(() => setRetrying(false));
				}}
			>
				续跑
			</button>
		</div>
	);
}

// —— 工具折叠行（DSH ToolRow：16 图标槽 + 13px 标题 + 点分隔 + 摘要） ——

export function ToolRow({ card }: { card: ToolCard }): ReactNode {
	const summaryClass = `tool-summary${card.isError ? " error" : ""}`;
	const stateSuffix =
		card.status === "running"
			? " · 运行中"
			: card.status === "pending"
				? " · 排队中"
				: card.status === "done" && card.isError
					? " · 失败"
					: "";
	return (
		<details className="tool-row">
			<summary className="tool-head">
				<span className="tool-leading">
					<ToolStatusIcon card={card} />
					<span className="tool-disclosure">
						<ChevronRightIcon />
					</span>
				</span>
				<span className="tool-title">{card.name}</span>
				<span className="tool-sep" />
				<span className={summaryClass} data-streaming={card.status === "running" || card.status === "pending" ? "" : undefined}>
					{card.summary}
					{stateSuffix}
				</span>
			</summary>
			<div className="tool-body-wrap">
				<div className="tool-body">
					<div className="tool-section">参数</div>
					<pre>{card.argsText || "（无）"}</pre>
					{card.output !== undefined && card.output.length > 0 ? (
						<>
							<div className="tool-section">{card.isError ? "错误输出" : "输出"}</div>
							<pre className={card.isError ? "is-error" : undefined}>{card.output}</pre>
						</>
					) : card.status === "running" || card.status === "pending" ? (
						<>
							<div className="tool-section">输出</div>
							<pre>（等待输出…）</pre>
						</>
					) : null}
				</div>
			</div>
		</details>
	);
}

function ToolStatusIcon({ card }: { card: ToolCard }): ReactNode {
	switch (card.status) {
		case "running":
			return (
				<span className="tool-icon-running">
					<SpinnerIcon />
				</span>
			);
		case "pending":
			return (
				<span className="tool-icon-pending">
					<PendingIcon />
				</span>
			);
		case "done":
			return card.isError ? (
				<span className="tool-icon-error">
					<XCircleIcon />
				</span>
			) : (
				<span className="tool-icon-done">
					<CheckCircleIcon />
				</span>
			);
		default:
			return (
				<span className="tool-icon-pending">
					<MinusCircleIcon />
				</span>
			);
	}
}
