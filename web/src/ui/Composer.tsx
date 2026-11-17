/**
 * Composer 席位（Aria 输入卡 + Stella 的队列/用量）：
 * - 纸白圆角卡：自动长高 textarea + 底部工具行。
 * - 左：工作目录 chip + 预设 chip（只读）；右：上下文环 + 模型选择（每行带收藏星）+ 发送。
 * - 队列条：运行中排队项（插话/编辑/删除）+ busyEnter 切换。
 * - 用量：上下文环 + 累计花费，点开分解面板（详情栏也显示上下文）。
 * - 指令菜单：整条输入还是 `/片段` 时在卡片上方弹出可选项（↑↓/Enter/Tab/Esc）。
 */

import { useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { store } from "../store/app-store";
import { type CommandSpec, availableCommands, matchCommands, slashQuery, usageOf } from "../store/commands";
import { modelKey, type ModelInfo } from "../api";
import { isComposingEvent } from "./composer-keys";
import { ChevronDownIcon, FolderIcon, SendIcon, StarFilledIcon, StarOutlineIcon, StopIcon } from "./icons";
import { useApp } from "./hooks";
import { initialOf, presetOf, tintFor } from "./preset";

const INPUT_MAX_HEIGHT = 260;
/** 菜单最多列出的指令条数（再多也没人往下翻）。 */
const MENU_LIMIT = 8;

// —— Composer 席位 ——

export function ComposerSeat(): ReactNode {
	return (
		<div className="composer-seat">
			<QueueDock />
			<Composer />
		</div>
	);
}

function Composer(): ReactNode {
	const app = useApp();
	const [value, setValue] = useState("");
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const disabled = app.conversationId === undefined;
	const preset = presetOf(app, app.preset);
	const targetName = preset?.name ?? "Stella";

	// —— 指令菜单 ——
	const [active, setActive] = useState(0);
	const [dismissed, setDismissed] = useState(false);
	const query = disabled ? undefined : slashQuery(value);
	const options = query === undefined ? [] : matchCommands(query, availableCommands({ busy: app.busy })).slice(0, MENU_LIMIT);
	const menuOpen = query !== undefined && !dismissed && options.length > 0;
	const activeIndex = Math.min(active, Math.max(0, options.length - 1));
	const itemRefs = useRef(new Map<string, HTMLDivElement>());

	useEffect(() => {
		setActive(0);
	}, [query]);

	useEffect(() => {
		if (!menuOpen) return;
		const name = options[activeIndex]?.name;
		if (name !== undefined) itemRefs.current.get(name)?.scrollIntoView({ block: "nearest" });
	}, [menuOpen, activeIndex, query]);

	const autosize = (): void => {
		const el = textareaRef.current;
		if (el === null) return;
		el.style.height = "auto";
		el.style.height = `${Math.min(el.scrollHeight, INPUT_MAX_HEIGHT)}px`;
	};

	useEffect(() => {
		const focusIfPending = (): void => {
			if (store.consumeInputFocus()) textareaRef.current?.focus();
		};
		focusIfPending();
		const off = store.on("focus-input", () => {
			requestAnimationFrame(() => {
				if (store.consumeInputFocus()) textareaRef.current?.focus();
			});
		});
		return () => {
			off();
		};
	}, []);

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

	const accept = (spec: CommandSpec): void => {
		const next = `/${spec.name} `;
		setValue(next);
		setDismissed(true);
		requestAnimationFrame(() => {
			autosize();
			const el = textareaRef.current;
			el?.focus();
			el?.setSelectionRange(next.length, next.length);
		});
	};

	const onKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>): void => {
		if (isComposingEvent(e)) return;
		if (menuOpen) {
			const count = options.length;
			if (e.key === "ArrowDown") {
				e.preventDefault();
				setActive((activeIndex + 1) % count);
				return;
			}
			if (e.key === "ArrowUp") {
				e.preventDefault();
				setActive((activeIndex - 1 + count) % count);
				return;
			}
			if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") {
				e.preventDefault();
				accept(options[activeIndex]!);
				return;
			}
			if (e.key === "Escape") {
				e.preventDefault();
				setDismissed(true);
				return;
			}
		}
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			send(e.ctrlKey || e.metaKey ? "alternate" : "primary");
		}
	};

	return (
		<footer id="composer" className="composer-shell">
			{menuOpen && (
				<div id="cmd-menu" className="cmd-pop" role="listbox" aria-label="可选指令">
					<div className="cmd-head">指令</div>
					<div className="cmd-list">
						{options.map((spec, index) => (
							<div
								key={spec.name}
								ref={(el) => {
									if (el === null) itemRefs.current.delete(spec.name);
									else itemRefs.current.set(spec.name, el);
								}}
								id={`cmd-option-${spec.name}`}
								className={`cmd-item${index === activeIndex ? " is-active" : ""}`}
								role="option"
								aria-selected={index === activeIndex}
								onMouseDown={(e) => e.preventDefault()}
								onMouseEnter={() => setActive(index)}
								onClick={() => accept(spec)}
							>
								<span className="cmd-name">{usageOf(spec)}</span>
								<span className="cmd-desc">{spec.description}</span>
							</div>
						))}
					</div>
					<div className="cmd-foot">↑↓ 选择 · Enter 补全 · Esc 关闭</div>
				</div>
			)}
			<div className="composer">
				<textarea
					id="input"
					ref={textareaRef}
					className="composer-input"
					rows={1}
					aria-label="消息输入框"
					aria-expanded={menuOpen}
					aria-controls={menuOpen ? "cmd-menu" : undefined}
					aria-activedescendant={menuOpen ? `cmd-option-${options[activeIndex]?.name ?? ""}` : undefined}
					disabled={disabled}
					placeholder={
						disabled
							? "先新建一个会话…"
							: busy
								? "正在运行，可以先写下一条想法…"
								: `给「${targetName}」发送消息…`
					}
					value={value}
					onChange={(e) => {
						setValue(e.target.value);
						setDismissed(false);
						autosize();
					}}
					onBlur={() => setDismissed(true)}
					onKeyDown={onKeyDown}
				/>
				<div className="composer-bar">
					<div className="composer-left">
						<WorkspaceChip />
						<PresetChip />
					</div>
					<div className="composer-right">
						<UsageMeter compact />
						<ModelArea />
						<button
							id="stop"
							className="send-btn stop"
							type="button"
							hidden={!busy}
							aria-label="停止生成"
							title="停止生成"
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
				<ChevronDownIcon width={10} height={10} />
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
							if (isComposingEvent(e)) return;
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

// —— 预设 chip（只读；预设创建时锁定，不在会话内切换） ——

function PresetChip(): ReactNode {
	const app = useApp();
	if (app.conversationId === undefined || app.preset === null) return null;
	const preset = presetOf(app, app.preset);
	const name = preset?.name ?? app.preset;
	return (
		<span id="preset-chip" className="chip preset-chip" title={preset?.description ?? `预设：${app.preset}`}>
			<span className={`chip-avatar tint-${tintFor(preset?.id)}`}>{initialOf(name)}</span>
			<span className="chip-label">{name}</span>
		</span>
	);
}

// —— 模型区：触发按钮 + 自绘下拉（每行右侧的星即收藏） ——

function ModelArea(): ReactNode {
	const app = useApp();
	const catalog = app.modelCatalog;
	const none = app.conversationId === undefined;
	const current = app.workspace?.model ?? null;
	const currentKey = current === null ? "" : modelKey(current);
	const [open, setOpen] = useState(false);
	const wrapRef = useRef<HTMLSpanElement>(null);
	const triggerRef = useRef<HTMLButtonElement>(null);
	const menuRef = useRef<HTMLDivElement>(null);

	const close = (restoreFocus: boolean): void => {
		setOpen(false);
		if (restoreFocus) requestAnimationFrame(() => triggerRef.current?.focus());
	};

	// 点到模型区之外就收起
	useEffect(() => {
		if (!open) return;
		const onPointerDown = (event: PointerEvent): void => {
			if (event.target instanceof Node && wrapRef.current?.contains(event.target) === true) return;
			setOpen(false);
		};
		document.addEventListener("pointerdown", onPointerDown);
		return () => document.removeEventListener("pointerdown", onPointerDown);
	}, [open]);

	// 打开时把焦点放到当前模型那一行（找不到就第一行）
	useEffect(() => {
		if (!open) return;
		const menu = menuRef.current;
		const target =
			menu?.querySelector<HTMLElement>(".model-item.is-current .model-item-name") ??
			menu?.querySelector<HTMLElement>(".model-item-name");
		target?.focus();
	}, [open]);

	const currentInfo = catalog?.models.find((model) => modelKey(model) === currentKey);
	const triggerLabel =
		current === null
			? none
				? "—"
				: "加载中…"
			: (currentInfo?.name ?? `${current.provider}/${current.modelId}`);

	// 上下键在「模型名 / 收藏星」按钮之间移动（与原生下拉的键盘手感对齐）。
	const moveFocus = (step: number): void => {
		const menu = menuRef.current;
		if (menu === null) return;
		const buttons = [...menu.querySelectorAll<HTMLButtonElement>("button")];
		if (buttons.length === 0) return;
		const from = buttons.indexOf(document.activeElement as HTMLButtonElement);
		const next = buttons[(from + step + buttons.length) % buttons.length];
		next?.focus();
	};

	const trigger = (
		<button
			id="model-select"
			ref={triggerRef}
			className="model-select"
			type="button"
			aria-label="当前会话使用的模型"
			aria-haspopup="menu"
			aria-expanded={open}
			disabled={none || catalog === undefined}
			title={triggerLabel}
			onClick={() => setOpen(!open)}
			onKeyDown={(event) => {
				if (event.key === "ArrowDown") {
					event.preventDefault();
					setOpen(true);
				}
			}}
		>
			<span className="model-label">{triggerLabel}</span>
		</button>
	);

	if (catalog === undefined) {
		return (
			<span className="model-wrap" ref={wrapRef}>
				{trigger}
				<span className="model-caret">
					<ChevronDownIcon width={10} height={10} />
				</span>
			</span>
		);
	}

	const byKey = new Map(catalog.models.map((model) => [modelKey(model), model]));
	const currentMissing = current !== null && !byKey.has(currentKey);
	const favoriteKeys = app.favorites.filter((key) => byKey.has(key));
	const groups: { provider: string; label: string; models: ModelInfo[] }[] = [];
	for (const model of catalog.models) {
		if (favoriteKeys.includes(modelKey(model))) continue;
		const last = groups[groups.length - 1];
		if (last === undefined || last.provider !== model.provider) {
			groups.push({ provider: model.provider, label: model.providerName, models: [model] });
		} else {
			last.models.push(model);
		}
	}

	const renderRow = (model: ModelInfo): ReactNode => {
		const key = modelKey(model);
		const selected = key === currentKey;
		const favorite = app.favorites.includes(key);
		return (
			<div className={`model-item${selected ? " is-current" : ""}`} key={key} role="none">
				<button
					type="button"
					role="menuitem"
					className="model-item-name"
					aria-current={selected ? "true" : undefined}
					title={model.name}
					onClick={() => {
						void store.switchModel(key);
						close(true);
					}}
				>
					{model.name}
				</button>
				<button
					type="button"
					role="menuitem"
					className={`model-fav${favorite ? " is-on" : ""}`}
					title={favorite ? `取消收藏 ${model.name}` : `收藏 ${model.name}`}
					aria-label={favorite ? `取消收藏 ${model.name}` : `收藏 ${model.name}`}
					aria-pressed={favorite}
					onClick={() => store.toggleFavoriteOf(key)}
				>
					{favorite ? <StarFilledIcon width={12} height={12} /> : <StarOutlineIcon width={12} height={12} />}
				</button>
			</div>
		);
	};

	return (
		<span className="model-wrap" ref={wrapRef}>
			{trigger}
			<span className="model-caret">
				<ChevronDownIcon width={10} height={10} />
			</span>
			{open && (
				<div
					id="model-menu"
					ref={menuRef}
					className="model-menu"
					role="menu"
					aria-label="选择模型"
					onKeyDown={(event) => {
						if (event.key === "ArrowDown" || event.key === "ArrowUp") {
							event.preventDefault();
							moveFocus(event.key === "ArrowDown" ? 1 : -1);
						} else if (event.key === "Escape") {
							event.preventDefault();
							close(true);
						}
					}}
				>
					{currentMissing && current !== null && (
						<>
							<div className="model-group-label">当前</div>
							<div className="model-item is-current" role="none">
								<button type="button" role="menuitem" className="model-item-name" onClick={() => close(true)}>
									{`${current.provider}/${current.modelId}（当前）`}
								</button>
							</div>
						</>
					)}
					{favoriteKeys.length > 0 && (
						<>
							<div className="model-group-label">★ 收藏</div>
							{favoriteKeys.map((key) => renderRow(byKey.get(key)!))}
						</>
					)}
					{groups.map((group) => (
						<div key={group.provider} role="group" aria-label={group.label}>
							<div className="model-group-label">{group.label}</div>
							{group.models.map((model) => renderRow(model))}
						</div>
					))}
				</div>
			)}
		</span>
	);
}

// —— 队列条 ——

function QueueDock(): ReactNode {
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
			<circle cx="7" cy="7" r={radius} fill="none" stroke="var(--line-strong)" strokeWidth="2" />
			{dash !== undefined && (
				<circle cx="7" cy="7" r={radius} fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeDasharray={dash} transform="rotate(-90 7 7)" />
			)}
		</svg>
	);
}

function UsageMeter({ compact = false }: { compact?: boolean }): ReactNode {
	const app = useApp();
	const [open, setOpen] = useState(false);
	const rootRef = useRef<HTMLDivElement>(null);
	const usageDoc = useSyncExternalStore(store.subscribeDocs, () => {
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
	const percentText =
		percent === null
			? "—"
			: percent > 0 && percent < 0.1
				? "<0.1%"
				: percent > 0 && percent < 1
					? `${percent.toFixed(1)}%`
					: `${Math.round(percent)}%`;
	const cacheRead = Object.values(usageDoc?.models ?? {}).reduce((sum, u) => sum + (u.cacheRead ?? 0), 0);
	const inputTokens = Object.values(usageDoc?.models ?? {}).reduce((sum, u) => sum + (u.input ?? 0), 0);
	const cacheRate = cacheRead + inputTokens > 0 ? Math.round((cacheRead / (cacheRead + inputTokens)) * 100) : null;

	return (
		<div id="usage-meter" className={`usage-meter${compact ? " compact" : ""}`} ref={rootRef}>
			<div className="usage-chips">
				{!compact && stats.steps > 0 && (
					<span className="usage-chip" title="本会话的轮次与回答步数">
						{`${stats.rounds} 轮 ${stats.steps} 步`}
					</span>
				)}
				{!compact && usage.tokens > 0 && (
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
