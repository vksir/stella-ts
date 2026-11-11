/**
 * Composer 席位（DSH InputBar + QueueDock + ContextMeter）：
 * - 28px 圆角胶囊卡：自动长高 textarea（336px 帽）+ 底部工具行。
 * - 工具行：左 workspace chip + 预设 chip；右 收藏 + 模型下拉 + 停止/发送。
 * - 队列条：运行中排队项（插话/编辑/删除）+ busyEnter 切换。
 * - 用量：上下文环 + 累计 token/成本，点开分解面板。
 * 输入框为受控组件，本地 state（不经 store，避免光标跳动）。
 */

import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { store } from "../store/app-store";
import { modelKey } from "../api";
import { ChevronDownIcon, FolderIcon, SendIcon, StarFilledIcon, StarOutlineIcon, StopIcon } from "./icons";
import { useApp } from "./hooks";

const INPUT_MAX_HEIGHT = 336;

// —— Composer 席位 ——

export function ComposerSeat(): ReactNode {
	return (
		<div className="composer-seat">
			<QueueDock />
			<Composer />
			<UsageMeter />
		</div>
	);
}

function Composer(): ReactNode {
	const app = useApp();
	const [value, setValue] = useState("");
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const disabled = app.conversationId === undefined;

	// 自动长高
	const autosize = (): void => {
		const el = textareaRef.current;
		if (el === null) return;
		el.style.height = "auto";
		el.style.height = `${Math.min(el.scrollHeight, INPUT_MAX_HEIGHT)}px`;
	};

	// store 请求聚焦（新建会话 / 引用后）；挂载时先消费一次积压的请求
	useEffect(() => {
		const focusIfPending = (): void => {
			if (store.consumeInputFocus()) textareaRef.current?.focus();
		};
		focusIfPending();
		const off = store.on("focus-input", () => {
			// 等一帧：hero ↔ docked 切换时本组件可能刚移到新父节点
			requestAnimationFrame(() => {
				if (store.consumeInputFocus()) textareaRef.current?.focus();
			});
		});
		return () => {
			off();
		};
	}, []);

	// 引用到输入框：store 写入草稿 → 同步本地 state 并聚焦
	useEffect(() => {
		const off = store.on("draft-set", () => {
			setValue(store.takeDraft());
			requestAnimationFrame(() => {
				autosize();
				textareaRef.current?.focus();
			});
		});
		return () => {
			off();
		};
	}, []);

	const send = (gesture: "primary" | "alternate"): void => {
		const content = value.trim();
		if (content.length === 0 || disabled) return;
		setValue("");
		requestAnimationFrame(autosize);
		store.send(content, gesture);
		textareaRef.current?.focus();
	};

	const busy = app.busy;
	const sendLabel = !busy ? "发送" : app.busyEnter === "steer" ? "插话发送" : "排队发送";

	return (
		<footer id="composer" className="input-bar">
			<div className="input-scroll">
				<div className="grow">
					<textarea
						id="input"
						ref={textareaRef}
						rows={1}
						aria-label="消息输入框"
						disabled={disabled}
						placeholder={disabled ? "先新建一个会话…" : "给 Stella 发消息…"}
						value={value}
						onChange={(e) => {
							setValue(e.target.value);
							autosize();
						}}
						onKeyDown={(e) => {
							if (e.key === "Enter" && !e.shiftKey) {
								e.preventDefault();
								send(e.ctrlKey || e.metaKey ? "alternate" : "primary");
							}
						}}
					/>
				</div>
			</div>
			<div className="row">
				<div className="tools">
					<WorkspaceChip />
					<PresetChip />
				</div>
				<div className="trailing">
					<ModelArea />
					<button
						id="stop"
						className="send-btn stop"
						type="button"
						hidden={!busy}
						aria-label="停止生成"
						onClick={() => void store.stopRun()}
					>
						<StopIcon />
					</button>
					<button
						id="send"
						className="send-btn"
						type="button"
						disabled={disabled || value.trim().length === 0}
						aria-label={sendLabel}
						title={busy ? `${sendLabel}（Ctrl/Cmd+Enter 用另一种）` : sendLabel}
						onClick={() => send("primary")}
					>
						<SendIcon />
					</button>
				</div>
			</div>
		</footer>
	);
}

// —— 工作目录 chip + 弹层 ——

function WorkspaceChip(): ReactNode {
	const app = useApp();
	const [open, setOpen] = useState(false);
	const [dir, setDir] = useState("");
	const [hint, setHint] = useState("");
	const [saving, setSaving] = useState(false);
	const inputRef = useRef<HTMLInputElement>(null);
	const none = app.conversationId === undefined;
	const settings = app.workspace;

	useEffect(() => {
		if (open) {
			setDir(settings?.cwd ?? "");
			setHint(settings === undefined ? (none ? "" : "加载中…") : settings.custom ? "已自定义（后续工具调用立即生效）" : "默认工作区（服务端 data/workspace）");
			requestAnimationFrame(() => {
				inputRef.current?.focus();
				inputRef.current?.select();
			});
		}
	}, [open, settings, none]);

	useEffect(() => {
		if (!open) return;
		const onPointerDown = (e: PointerEvent): void => {
			if (e.target instanceof Element && e.target.closest(".ws-anchor") === null) setOpen(false);
		};
		const onKey = (e: KeyboardEvent): void => {
			if (e.key === "Escape") {
				setOpen(false);
				// 焦点归还触发按钮（键盘用户不丢位置）
				requestAnimationFrame(() => document.getElementById("workspace-chip")?.focus());
			}
		};
		document.addEventListener("pointerdown", onPointerDown);
		document.addEventListener("keydown", onKey);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown);
			document.removeEventListener("keydown", onKey);
		};
	}, [open]);

	const segments = (settings?.cwd ?? "").split(/[\\/]/).filter((part) => part.length > 0);

	return (
		<div className="ws-anchor">
			<button
				id="workspace-chip"
				className="chip ws-chip"
				type="button"
				aria-expanded={open}
				aria-haspopup="dialog"
				disabled={none || settings === undefined}
				title={settings?.cwd ?? "工作目录"}
				onClick={() => setOpen(!open)}
			>
				<span className="ws-folder">
					<FolderIcon />
				</span>
				<span className="ws-label">{segments[segments.length - 1] ?? settings?.cwd ?? "工作目录"}</span>
				<ChevronDownIcon />
			</button>
			{open && (
				<div id="workspace-pop" className="ws-pop" role="dialog" aria-label="工作目录">
					<div className="ws-pop-title">工作目录</div>
					<input
						ref={inputRef}
						id="workspace-dir"
						className="ws-input"
						type="text"
						spellCheck={false}
						autoComplete="off"
						placeholder="绝对路径，如 D:\projects\demo"
						value={dir}
						onChange={(e) => setDir(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter") {
								e.preventDefault();
								void save();
							}
						}}
					/>
					<div id="workspace-hint" className="ws-hint">{hint}</div>
					<div className="ws-actions">
						<button
							id="reset-workspace"
							className="btn btn-sm btn-ghost"
							type="button"
							disabled={saving}
							onClick={() => {
								setSaving(true);
								void store.resetWorkspace().finally(() => {
									setSaving(false);
									setOpen(false);
								});
							}}
						>
							恢复默认
						</button>
						<button id="save-workspace" className="btn btn-sm btn-primary" type="button" disabled={saving} onClick={() => void save()}>
							保存
						</button>
					</div>
				</div>
			)}
		</div>
	);

	async function save(): Promise<void> {
		setSaving(true);
		const result = await store.saveWorkspace(dir.trim());
		setSaving(false);
		if (result.ok) setOpen(false);
		else setHint(result.error ?? "保存失败");
	}
}

// —— 预设 chip（只读） ——

function PresetChip(): ReactNode {
	const app = useApp();
	if (app.conversationId === undefined || app.preset === null) return null;
	const preset = app.presets.find((item) => item.id === app.preset);
	return (
		<span id="preset-chip" className="chip preset-chip" title={preset?.description ?? `预设：${app.preset}`}>
			{preset?.name ?? app.preset}
		</span>
	);
}

// —— 模型区：收藏 + 下拉 ——

function ModelArea(): ReactNode {
	const app = useApp();
	const catalog = app.modelCatalog;
	const none = app.conversationId === undefined;
	const current = app.workspace?.model ?? null;
	const currentKey = current === null ? "" : modelKey(current);
	const isFavorite = current !== null && app.favorites.includes(currentKey);

	if (catalog === undefined) {
		return (
			<select id="model-select" className="select" aria-label="当前会话使用的模型" disabled value="">
				<option value="">{none ? "" : "加载中…"}</option>
			</select>
		);
	}

	const byKey = new Map(catalog.models.map((model) => [modelKey(model), model]));
	const favoriteKeys = app.favorites.filter((key) => byKey.has(key));
	const groups: { provider: string; label: string; models: typeof catalog.models }[] = [];
	for (const model of catalog.models) {
		if (favoriteKeys.includes(modelKey(model))) continue;
		const last = groups[groups.length - 1];
		if (last === undefined || last.provider !== model.provider) {
			groups.push({ provider: model.provider, label: model.providerName, models: [model] });
		} else {
			last.models.push(model);
		}
	}

	return (
		<>
			<button
				id="toggle-favorite"
				className={`icon-btn fav-btn${isFavorite ? " fav-on" : ""}`}
				type="button"
				title={isFavorite ? "取消收藏当前模型" : "收藏当前模型"}
				aria-label={isFavorite ? "取消收藏当前模型" : "收藏当前模型"}
				disabled={none}
				onClick={() => store.toggleFavorite()}
			>
				{isFavorite ? <StarFilledIcon /> : <StarOutlineIcon />}
			</button>
			<select
				id="model-select"
				className="select"
				aria-label="当前会话使用的模型"
				disabled={none}
				value={currentKey}
				onChange={(e) => void store.switchModel(e.target.value)}
			>
				{favoriteKeys.length > 0 && (
					<optgroup label="★ 收藏">
						{favoriteKeys.map((key) => {
							const model = byKey.get(key)!;
							return (
								<option key={key} value={key}>
									{model.name}
								</option>
							);
						})}
					</optgroup>
				)}
				{groups.map((group) => (
					<optgroup key={group.provider} label={group.label}>
						{group.models.map((model) => (
							<option key={modelKey(model)} value={modelKey(model)}>
								{model.name}
							</option>
						))}
					</optgroup>
				))}
			</select>
		</>
	);
}

// —— 队列条（DSH QueueDock） ——

function QueueDock(): ReactNode {
	// 订阅 view.docs 的版本：排队项的新增/被消费都在同一运行内发生，app 快照不会变
	const docsVersion = useSyncExternalStore(store.subscribeDocs, store.getDocsVersion);
	const app = useApp();
	const inbox = store.getInbox();
	if (!app.busy || inbox.length === 0) return null;
	return (
		<div id="queue-dock" className="queue-dock" data-version={docsVersion}>
			<div className="queue-head">
				<span className="queue-count">{inbox.length} 条排队消息</span>
				<button
					type="button"
					className="queue-setting"
					title="运行中按 Enter 的投递方式；Ctrl/Cmd+Enter 用另一种"
					onClick={() => store.setBusyEnter(app.busyEnter === "queue" ? "steer" : "queue")}
				>
					{app.busyEnter === "queue" ? "Enter：排队" : "Enter：插话"}
				</button>
			</div>
			<div className="queue-rows">
				{inbox.map((item) => (
					<QueueRow key={item.id} item={item} />
				))}
			</div>
		</div>
	);
}

function QueueRow({ item }: { item: { id: number; mode?: string; text: string } }): ReactNode {
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState(item.text);
	const editorRef = useRef<HTMLTextAreaElement>(null);

	useEffect(() => {
		if (editing) {
			editorRef.current?.focus();
			editorRef.current?.select();
		}
	}, [editing]);

	if (editing) {
		return (
			<div className="queue-row" data-id={item.id}>
				<textarea
					ref={editorRef}
					className="queue-editor"
					value={draft}
					rows={2}
					onChange={(e) => setDraft(e.target.value)}
				/>
				<div className="queue-actions">
					<button
						type="button"
						className="queue-action"
						onClick={() => {
							const text = draft.trim();
							if (text.length === 0) return;
							setEditing(false);
							void store.requeueEdited(item, text);
						}}
					>
						保存
					</button>
					<button type="button" className="queue-action" onClick={() => setEditing(false)}>
						取消
					</button>
				</div>
			</div>
		);
	}

	return (
		<div className="queue-row" data-id={item.id}>
			<span className={`queue-tag${item.mode === "steer" ? " is-steer" : ""}`}>{item.mode === "steer" ? "插话" : "排队"}</span>
			<span className="queue-text">{item.text}</span>
			<div className="queue-actions">
				{item.mode !== "steer" && (
					<button type="button" className="queue-action" onClick={() => void store.promoteQueued(item)}>
						插话
					</button>
				)}
				<button type="button" className="queue-action" onClick={() => setEditing(true)}>
					编辑
				</button>
				<button type="button" className="queue-action" onClick={() => void store.withdrawQueued(item)}>
					删除
				</button>
			</div>
		</div>
	);
}

// —— 用量（上下文环 + 累计花费） ——

function summarizeUsage(doc: import("../api").UsageDoc | undefined): { tokens: number; cost: number } {
	let tokens = 0;
	let cost = 0;
	for (const bucket of [doc?.models, doc?.tools]) {
		for (const usage of Object.values(bucket ?? {})) {
			tokens += usage.totalTokens ?? (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0);
			cost += usage.cost?.total ?? 0;
		}
	}
	return { tokens, cost };
}

function formatTokens(value: number): string {
	if (value < 1_000) return String(Math.round(value));
	if (value < 1_000_000) return `${(value / 1_000).toFixed(1)}K`;
	return `${(value / 1_000_000).toFixed(2)}M`;
}

function formatCost(value: number): string {
	if (value <= 0) return "$0";
	if (value < 0.0001) return "<$0.0001";
	if (value < 1) return `$${value.toFixed(4)}`;
	return `$${value.toFixed(2)}`;
}

function ContextRing({ percent }: { percent: number | null }): ReactNode {
	const radius = 5.5;
	const circumference = 2 * Math.PI * radius;
	const dash = percent !== null && percent > 0 ? `${(circumference * Math.min(100, percent)) / 100} ${circumference}` : undefined;
	return (
		<svg viewBox="0 0 14 14" width="14" height="14" aria-hidden="true">
			<circle cx="7" cy="7" r={radius} fill="none" stroke="var(--border-l3)" strokeWidth="2" />
			{dash !== undefined && (
				<circle cx="7" cy="7" r={radius} fill="none" stroke="var(--brand-primary)" strokeWidth="2" strokeLinecap="round" strokeDasharray={dash} transform="rotate(-90 7 7)" />
			)}
		</svg>
	);
}

function UsageMeter(): ReactNode {
	const app = useApp();
	const [open, setOpen] = useState(false);
	const rootRef = useRef<HTMLDivElement>(null);
	const usageDoc = useSyncExternalStore(store.subscribeDocs, () => {
		// 版本变化时返回 docs 引用（同一 view 内引用稳定，跨 view 才换）
		store.getDocsVersion();
		return store.getUsageDoc();
	});
	const stats = useSyncExternalStore(store.subscribeApp, () => store.getRunStats());
	const usage = summarizeUsage(usageDoc);

	useEffect(() => {
		if (!open) return;
		const onPointerDown = (e: PointerEvent): void => {
			if (e.target instanceof Node && rootRef.current?.contains(e.target) !== true) setOpen(false);
		};
		document.addEventListener("pointerdown", onPointerDown);
		return () => document.removeEventListener("pointerdown", onPointerDown);
	}, [open]);

	if (app.conversationId === undefined || app.heroEmpty || app.blank || (usage.tokens <= 0 && app.context === null)) {
		return null;
	}
	const percent = app.context?.percent ?? null;
	const percentText = percent === null ? "—" : `${Math.round(percent)}%`;
	// 缓存命中率：cacheRead / (input + cacheRead)
	const cacheRead = Object.values(usageDoc?.models ?? {}).reduce((sum, u) => sum + (u.cacheRead ?? 0), 0);
	const inputTokens = Object.values(usageDoc?.models ?? {}).reduce((sum, u) => sum + (u.input ?? 0), 0);
	const cacheRate = cacheRead + inputTokens > 0 ? Math.round((cacheRead / (cacheRead + inputTokens)) * 100) : null;

	return (
		<div id="usage-meter" className="usage-meter" ref={rootRef}>
			<div className="usage-chips">
				{stats.steps > 0 && (
					<span className="usage-chip" title="本会话的轮次与回答步数">
						{`${stats.rounds} 轮 ${stats.steps} 步`}
					</span>
				)}
				{usage.tokens > 0 && (
					<span className="usage-chip" title="累计 token 与缓存命中率">
						{`${formatTokens(usage.tokens)} tok`}
						{cacheRate !== null && ` · 缓存命中 ${cacheRate}%`}
					</span>
				)}
				<button
					type="button"
					className="usage-chip usage-trigger"
					aria-expanded={open}
					title={`上下文已用 ${percentText}${app.context?.estimated === true ? "（按字符估算）" : ""}，点开看分解`}
					onClick={() => setOpen(!open)}
				>
					<ContextRing percent={percent} />
					<span className="usage-percent">{percentText}</span>
					{usage.cost > 0 && (
						<>
							<span className="usage-sep">·</span>
							<span className="usage-cost">{formatCost(usage.cost)}</span>
						</>
					)}
				</button>
			</div>
			{open && <UsagePanel context={app.context} usageDoc={usageDoc} />}
		</div>
	);
}

function UsagePanel({ context, usageDoc }: { context: import("../api").ContextOccupancy | null; usageDoc: import("../api").UsageDoc | undefined }): ReactNode {
	const rows: ReactNode[] = [];
	if (context !== null) {
		const total = context.breakdown.system + context.breakdown.tools + context.breakdown.messages;
		rows.push(
			<div className="usage-panel-head" key="head">
				<span className="usage-panel-title">上下文</span>
				<span className="usage-panel-value">
					{context.windowTokens === null ? `${formatTokens(context.usedTokens)} tokens` : `${formatTokens(context.usedTokens)} / ${formatTokens(context.windowTokens)}`}
				</span>
			</div>,
		);
		for (const [label, value] of [
			["系统提示", context.breakdown.system],
			["工具定义", context.breakdown.tools],
			["消息", context.breakdown.messages],
		] as const) {
			rows.push(
				<div className="usage-row" key={label}>
					<span className="usage-row-label">{label}</span>
					<span className="usage-bar">
						<span className="usage-bar-fill" style={{ width: total <= 0 ? "0%" : `${Math.max(2, (value / total) * 100)}%` }} />
					</span>
					<span className="usage-row-value">{formatTokens(value)}</span>
				</div>,
			);
		}
		if (context.model !== null) {
			rows.push(
				<div className="usage-panel-note" key="note">
					{`${context.model.provider}/${context.model.modelId}${context.estimated ? " · 估算值" : ""}`}
				</div>,
			);
		}
	}
	const models = Object.entries(usageDoc?.models ?? {});
	const tools = Object.entries(usageDoc?.tools ?? {});
	if (models.length > 0 || tools.length > 0) {
		rows.push(
			<div className="usage-panel-title" key="cost-title">
				累计花费
			</div>,
		);
		for (const [key, usage] of models) {
			rows.push(
				<div className="usage-row usage-row-cost" key={`m:${key}`}>
					<span className="usage-row-label">{key}</span>
					<span className="usage-row-value">{`${formatTokens(usage.totalTokens ?? (usage.input ?? 0) + (usage.output ?? 0))} · ${formatCost(usage.cost?.total ?? 0)}`}</span>
				</div>,
			);
		}
		for (const [key, usage] of tools) {
			rows.push(
				<div className="usage-row usage-row-cost" key={`t:${key}`}>
					<span className="usage-row-label">{`工具 ${key}`}</span>
					<span className="usage-row-value">{`${formatTokens(usage.totalTokens ?? (usage.input ?? 0) + (usage.output ?? 0))} · ${formatCost(usage.cost?.total ?? 0)}`}</span>
				</div>,
			);
		}
	}
	return (
		<div className="usage-panel" role="dialog" aria-label="上下文与花费">
			{rows}
		</div>
	);
}
