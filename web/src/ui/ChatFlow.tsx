/**
 * 消息流：keys 列表 + 每 key 一个 Seat（只订阅自己的 NodeSource）。
 * 流式期间只有 streaming 节点重渲；历史节点 DOM 纹丝不动。
 * Seat 外层 key 带会话 id 前缀：切换会话强制 remount（内容不同源）。
 *
 * 外观采用 Aria 的消息语言：助手带头像与衬线名字，用户是暖沙气泡；
 * 「状态行」的折叠语义保留（GLOSSARY），只是换成了消息头上的状态与箭头。
 */

import { memo, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { failureCardText, store, type FlowNode, type ToolCard } from "../store/app-store";
import { useApp, useFlowKeys, useNode } from "./hooks";
import { IncrementalMarkdown } from "../markdown/incremental";
import { MarkdownBlocks } from "../markdown/view";
import {
	CheckCircleIcon,
	ChevronDownIcon,
	ChevronRightIcon,
	CheckIcon,
	CopyIcon,
	InfoIcon,
	MinusCircleIcon,
	PendingIcon,
	QuoteIcon,
	SpinnerIcon,
	XCircleIcon,
} from "./icons";
import { initialOf, presetOf, tintFor } from "./preset";

function Seat({ nodeKey }: { nodeKey: string }): ReactNode {
	const node = useNode(nodeKey);
	if (node === null) return null;
	return <NodeView node={node} />;
}

const SeatMemo = memo(Seat);

export function ChatFlow({ columnRef }: { columnRef: React.RefObject<HTMLDivElement> }): ReactNode {
	const keys = useFlowKeys();
	const conversationId = useApp().conversationId ?? 0;
	// 有流式节点时不再画单独的「正在思考」行：流式消息头自己带计时，
	// 否则会出现「正在回答」和「正在思考」两条并行状态。
	const hasStreaming = keys.includes("streaming");
	return (
		<div className="column" ref={columnRef}>
			{keys.map((key) =>
				hasStreaming && key === "running" ? null : <SeatMemo key={`${conversationId}:${key}`} nodeKey={key} />,
			)}
		</div>
	);
}

// —— 轨迹视图（详情栏「查看全部」弹层）：全部工具调用按时间线展开 ——

export function TraceView(): ReactNode {
	const keys = useFlowKeys();
	const docsVersion = useSyncExternalStore(store.subscribeDocs, store.getDocsVersion);
	const cards = useMemo(() => store.getTraceCards(), [keys, docsVersion]);
	if (cards.length === 0) {
		return (
			<div className="column">
				<div className="flow-placeholder">（本会话还没有工具调用）</div>
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

function NodeView({ node }: { node: FlowNode }): ReactNode {
	switch (node.type) {
		case "user":
			return <UserNode text={node.text} reveal={node.reveal} timestamp={node.timestamp} />;
		case "assistant":
			return (
				<AssistantNode
					text={node.text}
					thinking={node.thinking}
					calls={node.calls}
					reveal={node.reveal}
					durationMs={node.durationMs}
					timestamp={node.timestamp}
					tokens={node.tokens}
					aborted={node.aborted}
				/>
			);
		case "assistant-error":
			return (
				<div className="flow-item turn-error">
					<span className="error-dot" />
					<div className="turn-error-copy">
						<span className="turn-error-title">本次回答失败</span>
						<span className="turn-error-message">{node.message}</span>
					</div>
				</div>
			);
		case "streaming":
			return <StreamingNode text={node.text} thinking={node.thinking} />;
		case "tool":
			return (
				<div className="flow-item tool-only">
					<ToolRow card={node.card} />
				</div>
			);
		case "running":
			return <RunningRow />;
		case "stopped":
			return <div className="flow-item stopped-line">{node.text}</div>;
		case "notice":
			return <NoticeRow label={node.label} detail={node.detail} />;
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

/** 消息时间：HH:mm（同一天）或 M/D HH:mm。 */
function formatStamp(ts?: number): string {
	if (ts === undefined || ts <= 0) return "";
	const d = new Date(ts);
	const now = new Date();
	const sameDay = d.toDateString() === now.toDateString();
	const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
	return sameDay ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

/** token 用量：1.2K / 11.8K / 1.2M。 */
function formatTokenCount(value: number): string {
	if (value < 1000) return String(Math.round(value));
	if (value < 1_000_000) return `${(value / 1000).toFixed(1)}K`;
	return `${(value / 1_000_000).toFixed(2)}M`;
}

function useAgentIdentity(): { name: string; tint: ReturnType<typeof tintFor> } {
	const app = useApp();
	const current = app.conversations.find((conversation) => conversation.id === app.conversationId);
	const preset = presetOf(app, current?.preset ?? app.preset);
	return { name: preset?.name ?? "Stella", tint: tintFor(preset?.id) };
}

// —— 用户消息：右对齐暖沙气泡 + 操作行 ——

function UserNode({ text, reveal, timestamp }: { text: string; reveal: boolean; timestamp?: number }): ReactNode {
	return (
		<div className="flow-item msg user" data-reveal={reveal ? undefined : "hover"}>
			<div className="bubble">{text}</div>
			<MessageActions text={text} timestamp={timestamp} />
		</div>
	);
}

// —— 思考块：折叠的模型思考内容（流式中自动展开） ——

/**
 * 思考区（details/summary）。类名是 style.css 的契约，不能改名。
 * 已完成的回答默认折叠；流式中展开并显示「思考中」。
 */
export function ThinkingBlock({ thinking, streaming = false }: { thinking: string | undefined; streaming?: boolean }): ReactNode {
	const bodyRef = useRef<HTMLDivElement>(null);
	// 流式思考持续变长：跟到底部，别让新内容落在折叠区外（body 有 max-height 滚动）。
	useEffect(() => {
		if (!streaming) return;
		const body = bodyRef.current;
		if (body !== null) body.scrollTop = body.scrollHeight;
	}, [thinking, streaming]);
	if (thinking === undefined || thinking.length === 0) return null;
	return (
		<details className="thinking" open={streaming ? true : undefined}>
			<summary className="thinking-head">
				<span className="thinking-label">思考</span>
				<span className="thinking-status">{streaming ? "思考中" : `${thinking.length} 字`}</span>
				<span className="thinking-chev">
					<ChevronRightIcon width={12} height={12} />
				</span>
			</summary>
			<div className="thinking-body" ref={bodyRef}>
				{thinking}
			</div>
		</details>
	);
}

// —— 助手消息：头像 + 衬线名字 + 折叠状态 + 思考/markdown/工具 + 操作行 ——

function AssistantNode({
	text,
	thinking,
	calls,
	reveal,
	durationMs,
	timestamp,
	tokens,
	aborted,
}: {
	text: string;
	thinking?: string;
	calls: ToolCard[];
	reveal: boolean;
	durationMs?: number;
	timestamp?: number;
	tokens?: number;
	aborted?: boolean;
}): ReactNode {
	const parser = useRef<IncrementalMarkdown | null>(null);
	if (parser.current === null) parser.current = new IncrementalMarkdown();
	const blocks = useMemo(() => parser.current?.settle(text) ?? { blocks: [], frozenEnd: 0 }, [text]);
	const [collapsed, setCollapsed] = useState(false);
	const { name, tint } = useAgentIdentity();
	const statusText = aborted
		? "已中断"
		: durationMs === undefined
			? "已完成"
			: `已完成 · ${Math.max(1, Math.round(durationMs / 1000))} 秒`;

	// 只有工具调用、没有正文的 assistant 条目：不重复一条「回答」头，直接贴工具卡。
	// 工具卡自己有状态与折叠；下一条正文回答再出状态行。
	if (text.length === 0 && calls.length > 0) {
		return (
			<div className="flow-item tool-only" data-part="response">
				<ThinkingBlock thinking={thinking} />
				<div className="tool-stack">
					{calls.map((card, index) => (
						<ToolRow key={`${card.name}:${index}`} card={card} />
					))}
				</div>
			</div>
		);
	}

	return (
		<div className="flow-item msg agent" data-part="response" data-reveal={reveal ? undefined : "hover"}>
			<div className={`avatar tint-${tint}`} aria-hidden="true">
				{initialOf(name)}
			</div>
			<div className="msg-main">
				<div className="msg-head">
					<button
						type="button"
						className="msg-id"
						aria-expanded={!collapsed}
						title={collapsed ? "展开回答" : "收起回答"}
						onClick={() => setCollapsed(!collapsed)}
					>
						<span className="msg-name">{name}</span>
						<span className="msg-role">回答</span>
						<span className={`msg-status${aborted ? " is-aborted" : ""}`}>{statusText}</span>
						<span className="msg-chev">
							<ChevronDownIcon width={12} height={12} />
						</span>
					</button>
					<span className="msg-time">{formatStamp(timestamp)}</span>
				</div>
				{!collapsed && (
					<div className="msg-body">
						<ThinkingBlock thinking={thinking} />
						{text.length > 0 && <MarkdownBlocks blocks={blocks.blocks} />}
						{calls.length > 0 && (
							<div className="tool-stack">
								{calls.map((card, index) => (
									<ToolRow key={`${card.name}:${index}`} card={card} />
								))}
							</div>
						)}
						{text.length === 0 && calls.length === 0 && <span className="flow-placeholder">（无文本内容）</span>}
					</div>
				)}
				<MessageActions text={text} tokens={tokens} />
			</div>
		</div>
	);
}

// —— 流式节点：增量 append（冻结块缓存 + rAF 上游已合帧） ——

function StreamingNode({ text, thinking }: { text: string; thinking?: string }): ReactNode {
	const parser = useRef<IncrementalMarkdown | null>(null);
	if (parser.current === null) parser.current = new IncrementalMarkdown();
	const blocks = useMemo(() => parser.current?.append(text) ?? { blocks: [], frozenEnd: 0 }, [text]);
	const { name, tint } = useAgentIdentity();
	const elapsed = useElapsedSeconds();
	// 只有思考、还没出正文时，状态行说「正在思考」而不是「正在回答」。
	const statusBase = text.length > 0 ? "正在回答" : "正在思考";
	return (
		<div className="flow-item msg agent" data-part="response">
			<div className={`avatar tint-${tint}`} aria-hidden="true">
				{initialOf(name)}
			</div>
			<div className="msg-main">
				<div className="msg-head">
					<span className="msg-id static">
						<span className="msg-name">{name}</span>
						<span className="msg-role">回答</span>
						<span className="msg-status live">
							{elapsed === undefined ? statusBase : `${statusBase} · ${elapsed} 秒`}
						</span>
					</span>
				</div>
				<div className="msg-body">
					<ThinkingBlock thinking={thinking} streaming />
					{text.length > 0 ? <MarkdownBlocks blocks={blocks.blocks} streaming /> : <span className="flow-placeholder">正在组织语言…</span>}
				</div>
			</div>
		</div>
	);
}

// —— 操作行（引用 / 复制） ——

function MessageActions({
	text,
	timestamp,
	tokens,
}: {
	text: string;
	timestamp?: number;
	tokens?: number;
}): ReactNode | null {
	const [copied, setCopied] = useState(false);
	const stamp = formatStamp(timestamp);
	if (text.length === 0 && stamp.length === 0) return null;
	return (
		<div className="msg-actions">
			{stamp.length > 0 && <span className="msg-stamp">{stamp}</span>}
			{tokens !== undefined && tokens > 0 && (
				<span className="msg-tokens" title="本条回答的 token 用量">
					{`${formatTokenCount(tokens)} tok`}
				</span>
			)}
			<button
				type="button"
				className="action"
				title="引用到输入框"
				aria-label="引用到输入框"
				onClick={() => store.quoteToInput(text)}
			>
				<QuoteIcon />
				<span>引用</span>
			</button>
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
				<span>{copied ? "已复制" : "复制"}</span>
			</button>
		</div>
	);
}

// —— 运行状态行：带实时耗时 ——

function useElapsedSeconds(): number | undefined {
	const startedAt = store.getRunStartedAt();
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (startedAt === undefined) return;
		const timer = window.setInterval(() => setNow(Date.now()), 1000);
		return () => window.clearInterval(timer);
	}, [startedAt]);
	return startedAt === undefined ? undefined : Math.max(1, Math.round((now - startedAt) / 1000));
}

function RunningRow(): ReactNode {
	const elapsed = useElapsedSeconds();
	const { name, tint } = useAgentIdentity();
	return (
		<div className="running">
			<div className={`avatar tint-${tint}`} aria-hidden="true">
				{initialOf(name)}
			</div>
			<span className="running-content">
				<span className="running-text">
					{name} 正在思考
					{elapsed === undefined ? "…" : `，用时 ${elapsed} 秒…`}
				</span>
				<span className="running-bar" aria-hidden="true" />
			</span>
		</div>
	);
}

// —— 非对话条目的通知行（压缩 / 重置 / 自定义类型）——

function NoticeRow({ label, detail }: { label: string; detail?: string }): ReactNode {
	if (detail === undefined) {
		return (
			<div className="flow-item turn-notice">
				<InfoIcon width={14} height={14} />
				<span>{label}</span>
			</div>
		);
	}
	return (
		<details className="flow-item turn-notice">
			<summary>
				<InfoIcon width={14} height={14} />
				<span>{label}</span>
				<span className="turn-notice-hint">查看摘要</span>
			</summary>
			<div className="turn-notice-body">{detail}</div>
		</details>
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

// —— 工具卡（Aria .tool：圆形状态图标 + 名字 + 摘要 + 展开详情） ——

export function ToolRow({ card }: { card: ToolCard }): ReactNode {
	const statusText =
		card.status === "running"
			? "运行中"
			: card.status === "pending"
				? "排队中"
				: card.status === "done" && card.isError
					? "失败"
					: card.status === "lost"
						? "未完成"
						: "";
	return (
		<details className="tool">
			<summary className="tool-head">
				<span className="tool-ico">
					<ToolStatusIcon card={card} />
				</span>
				<span className="tool-label">{card.name}</span>
				<span className="tool-detail" data-streaming={card.status === "running" || card.status === "pending" ? "" : undefined}>
					{card.summary}
				</span>
				{statusText.length > 0 && <span className={`tool-status${card.isError ? " is-error" : ""}`}>{statusText}</span>}
				<span className="tool-disclosure">
					<ChevronRightIcon width={12} height={12} />
				</span>
			</summary>
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
