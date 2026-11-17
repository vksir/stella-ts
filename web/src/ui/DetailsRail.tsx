/**
 * 会话详情栏（Aria 的 Session Details）：
 * 预设卡 / 上下文用量 / 工具轨迹 / 会话信息。全部用真实数据，不摆假指标。
 *
 * <1280px 时由 CSS 变成右侧抽屉；完整轨迹通过弹层查看。
 */

import { useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import type { PresetSummary } from "../api";
import { store } from "../store/app-store";
import { TraceView } from "./ChatFlow";
import { CloseIcon } from "./icons";
import { useApp, useFlowKeys } from "./hooks";
import { baseName, formatFull, relativeTime, timeOf } from "./format";
import { initialOf, presetOf, tintFor } from "./preset";

function formatTokens(value: number): string {
	if (value < 1_000) return String(Math.round(value));
	if (value < 1_000_000) return `${(value / 1_000).toFixed(1)}K`;
	return `${(value / 1_000_000).toFixed(2)}M`;
}

function capabilityChips(preset: PresetSummary | undefined): string[] {
	if (preset === undefined) return [];
	const chips: string[] = [];
	for (const extension of preset.extensions ?? []) chips.push(`扩展 · ${extension}`);
	if (preset.skills === null) chips.push("全部技能");
	else for (const skill of preset.skills ?? []) chips.push(`技能 · ${skill}`);
	if (preset.tools === null) chips.push("全部工具");
	else for (const tool of preset.tools ?? []) chips.push(`工具 · ${tool}`);
	return chips.slice(0, 4);
}

function statusLabel(status: "running" | "pending" | "done" | "lost", isError: boolean): string {
	if (status === "running") return "正在执行";
	if (status === "pending") return "等待执行";
	if (status === "lost") return "未完成";
	return isError ? "失败" : "已完成";
}

export function DetailsRail({ onClose }: { onClose: () => void }): ReactNode {
	const app = useApp();
	const keys = useFlowKeys();
	const docsVersion = useSyncExternalStore(store.subscribeDocs, store.getDocsVersion);
	const [traceOpen, setTraceOpen] = useState(false);

	const cards = useMemo(() => store.getTraceCards(), [keys, docsVersion]);
	const stats = useMemo(() => store.getRunStats(), [keys]);
	const current = app.conversations.find((item) => item.id === app.conversationId);
	const preset = presetOf(app, current?.preset ?? app.preset);
	const presetName = preset?.name ?? "默认预设";
	const tint = tintFor(preset?.id);
	const model = app.workspace?.model ?? app.context?.model ?? null;

	const used = app.context?.usedTokens ?? 0;
	const windowTokens = app.context?.windowTokens ?? null;
	const percent = app.context?.percent ?? (windowTokens === null || windowTokens <= 0 ? null : (used / windowTokens) * 100);
	const meterWidth = percent === null ? 0 : Math.max(2, Math.min(100, percent));
	const remaining = windowTokens === null ? null : Math.max(0, windowTokens - used);
	const recent = cards.slice(-6);
	const chips = capabilityChips(preset);

	useEffect(() => {
		if (!traceOpen) return;
		const onKey = (event: KeyboardEvent): void => {
			if (event.key === "Escape") {
				event.preventDefault();
				setTraceOpen(false);
			}
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [traceOpen]);

	return (
		<aside id="details" className="details-col" aria-label="会话详情">
			<div className="details-head">
				<span className="details-label">SESSION DETAILS</span>
				<button className="icon-btn subtle" type="button" aria-label="关闭会话详情" title="关闭" onClick={onClose}>
					<CloseIcon width={15} height={15} />
				</button>
			</div>

			<div className="details-body">
				<div className="agent-card">
					<div className="dc-row">
						<div className={`avatar tint-${tint}`}>{initialOf(presetName)}</div>
						<div className="dc-id">
							<div className="dc-name">Stella</div>
							<div className="dc-title">{presetName}</div>
						</div>
						<span className={`dc-state${app.busy ? " live" : ""}`}>
							<span className="dot" />
							{app.busy ? "运行中" : "空闲"}
						</span>
					</div>
					<p className="dc-desc">
						{preset?.description ?? "该会话创建于预设元数据之前；能力已锁定在会话里。"}
					</p>
					{chips.length > 0 && (
						<div className="dc-chips">
							{chips.map((chip) => (
								<span key={chip} className="dc-chip">
									{chip}
								</span>
							))}
						</div>
					)}
				</div>

				<div className="section">
					<div className="section-head">
						<span>上下文用量</span>
						<span className="tag">{model === null ? "—" : store.displayNameOf(model)}</span>
					</div>
					{app.context === null ? (
						<div className="empty-note">首轮回答后显示。</div>
					) : (
						<>
							<div className="ctx-nums">
								<strong>{formatTokens(used)}</strong>
								<span>{windowTokens === null ? "tokens" : `/ ${formatTokens(windowTokens)} tokens`}</span>
							</div>
							<div className="meter">
								<i style={{ width: `${meterWidth}%` }} />
							</div>
							<div className="ctx-foot">
								<span>
									{percent === null
										? "窗口未知"
										: percent > 0 && percent < 0.1
											? "已使用 <0.1%"
											: `已使用 ${percent.toFixed(1)}%`}
								</span>
								<span>{remaining === null ? "" : `剩余 ${formatTokens(remaining)}`}</span>
							</div>
						</>
					)}
				</div>

				<div className="section">
					<div className="section-head">
						<span>工具轨迹</span>
						<span className="tag">{cards.length} 次调用</span>
					</div>
					{recent.length === 0 ? (
						<div className="empty-note">暂无工具调用。发一条需要读写文件或执行命令的消息试试。</div>
					) : (
						<div className="timeline">
							{recent.map(({ key, card }) => (
								<div key={key} className={`tl-item ${card.status}${card.isError ? " error" : ""}`}>
									<span className="tl-dot" />
									<div className="tl-copy">
										<div className="tl-label" title={`${card.name} · ${card.summary}`}>
											{card.name} · {card.summary}
										</div>
										<div className="tl-meta">{statusLabel(card.status, card.isError)}</div>
									</div>
								</div>
							))}
						</div>
					)}
					{cards.length > recent.length && (
						<button type="button" className="trace-more" onClick={() => setTraceOpen(true)}>
							查看全部 {cards.length} 次调用
						</button>
					)}
				</div>

				<div className="section">
					<div className="section-head">
						<span>会话信息</span>
					</div>
					<div className="info-row">
						<span>创建时间</span>
						<span>{formatFull(current?.createdAt)}</span>
					</div>
					<div className="info-row">
						<span>最近活动</span>
						<span>{relativeTime(current === undefined ? undefined : timeOf(current))}</span>
					</div>
					<div className="info-row">
						<span>对话轮次</span>
						<span>{`${stats.rounds} 轮 · ${stats.steps} 步`}</span>
					</div>
					<div className="info-row">
						<span>模型</span>
						<span>{model === null ? "—" : store.displayNameOf(model)}</span>
					</div>
					<div className="info-row">
						<span>预设</span>
						<span>{presetName}</span>
					</div>
					<div className="info-row">
						<span>工作目录</span>
						<span title={app.workspace?.cwd}>{baseName(app.workspace?.cwd ?? "") || "—"}</span>
					</div>
					<div className="info-row">
						<span>会话标识</span>
						<span>#{app.conversationId}</span>
					</div>
				</div>

				<div className="details-note">Stella · 本地部署。工具调用会真实读写工作目录、执行命令。</div>
			</div>

			{traceOpen && (
				<div className="modal-root">
					<div className="modal-mask" onClick={() => setTraceOpen(false)} />
					<div className="modal-dialog trace-dialog" role="dialog" aria-modal="true" aria-labelledby="trace-title">
						<div className="modal-header">
							<div>
								<div className="modal-eyebrow">TOOL TRACE</div>
								<h3 id="trace-title" className="modal-title">
									工具轨迹
								</h3>
							</div>
							<button className="icon-btn subtle" type="button" aria-label="关闭" title="关闭" onClick={() => setTraceOpen(false)}>
								<CloseIcon width={16} height={16} />
							</button>
						</div>
						<div className="trace-scroll">
							<TraceView />
						</div>
					</div>
				</div>
			)}
		</aside>
	);
}
