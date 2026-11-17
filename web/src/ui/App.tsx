/**
 * 应用外壳（Aria 纸感工作台）：侧栏 / 对话 / 详情三栏。
 *
 * - 侧栏：品牌、新建、搜索（`/`）、按最近活动分组、会话删除、工作区与技能/主题。
 * - 中栏：顶栏（标题、状态、详情开关）、消息流、粘底输入卡。
 * - 右栏：预设卡、上下文、工具轨迹、会话信息；<1280px 变成抽屉。
 *
 * 功能语义沿用 Stella：预设创建时锁定、排队/插话、续跑、引用、压缩通知、缺口补齐。
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ConversationSummary } from "../api";
import { store } from "../store/app-store";
import { cycleTheme, loadThemePref } from "../theme";
import {
	FolderIcon,
	LogoutIcon,
	MenuIcon,
	MoonIcon,
	PanelCollapseIcon,
	PanelExpandIcon,
	PanelIcon,
	SearchIcon,
	SkillIcon,
	StarIcon,
	SunIcon,
	SystemIcon,
	TrashIcon,
} from "./icons";
import { ComposerSeat } from "./Composer";
import { ChatFlow } from "./ChatFlow";
import { DetailsRail } from "./DetailsRail";
import { LoginGate } from "./LoginGate";
import { SkillsPanel } from "./SkillsPanel";
import { useApp, useMedia } from "./hooks";
import { DAY_MS, baseName, relativeTime, startOfDay, timeOf } from "./format";
import { initialOf, presetOf, tintFor } from "./preset";

// —— 侧栏状态（App 持有，dataset 同步给 CSS） ——

const SIDEBAR_KEY = "stella-sidebar-collapsed";

function loadSidebarCollapsed(): boolean | undefined {
	try {
		const raw = localStorage.getItem(SIDEBAR_KEY);
		if (raw === "1") return true;
		if (raw === "0") return false;
	} catch {
		/* 忽略 */
	}
	return undefined;
}

function storeSidebarCollapsed(collapsed: boolean): void {
	try {
		localStorage.setItem(SIDEBAR_KEY, collapsed ? "1" : "0");
	} catch {
		/* 仅本次生效 */
	}
}

function isMac(): boolean {
	return /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
}

function initialCollapsed(): boolean {
	// 手机/平板宽度下侧栏是抽屉：首帧必须关闭，不能被桌面的「展开」偏好带开。
	if (window.innerWidth < 900) return true;
	return loadSidebarCollapsed() ?? window.innerWidth < 1024;
}

interface SessionGroup {
	label: string;
	items: ConversationSummary[];
}

function groupSessions(conversations: readonly ConversationSummary[], query: string): SessionGroup[] {
	const needle = query.trim().toLowerCase();
	const filtered = needle.length === 0
		? [...conversations]
		: conversations.filter((conversation) => (conversation.title ?? "新对话").toLowerCase().includes(needle));
	filtered.sort((a, b) => timeOf(b) - timeOf(a));
	if (needle.length > 0) return [{ label: `搜索结果 · ${filtered.length}`, items: filtered }];

	const today = startOfDay(Date.now());
	const buckets = new Map<string, ConversationSummary[]>([
		["今天", []],
		["昨天", []],
		["更早", []],
	]);
	for (const conversation of filtered) {
		const time = timeOf(conversation);
		const diff = time <= 0 ? 99 : Math.round((today - startOfDay(time)) / DAY_MS);
		const label = diff <= 0 ? "今天" : diff === 1 ? "昨天" : "更早";
		buckets.get(label)!.push(conversation);
	}
	return [...buckets.entries()]
		.filter(([, items]) => items.length > 0)
		.map(([label, items]) => ({ label, items }));
}

interface SidebarState {
	collapsed: boolean;
	desktop: boolean;
	toggle(persist: boolean): void;
	set(next: boolean, animate: boolean): void;
}

// —— 侧栏 ——

const Sidebar = memo(function Sidebar({
	state,
	onOpenSkills,
}: {
	state: SidebarState;
	onOpenSkills: () => void;
}): ReactNode {
	const app = useApp();
	const [themePref, setThemePref] = useState(loadThemePref);
	const [query, setQuery] = useState("");
	const [newPreset, setNewPreset] = useState(() => store.lastPreset());
	const searchRef = useRef<HTMLInputElement>(null);
	const wantSearchFocus = useRef(false);
	const collapsed = state.collapsed;

	const groups = useMemo(() => groupSessions(app.conversations, query), [app.conversations, query]);
	const needle = query.trim();

	// 切换会话 / 打开抽屉后把当前行滚进可视区（列表很长时否则看不到高亮）
	useEffect(() => {
		const frame = requestAnimationFrame(() => {
			const active = document.querySelector<HTMLElement>(".session-item.active");
			active?.scrollIntoView({ block: "nearest" });
		});
		return () => cancelAnimationFrame(frame);
	}, [app.conversationId, app.conversations.length, collapsed]);

	// `/` 聚焦搜索（输入框/文本域里不抢）
	useEffect(() => {
		const onKey = (event: KeyboardEvent): void => {
			if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
			if (document.querySelector(".modal-root") !== null) return;
			const target = event.target;
			if (target instanceof Element && target.closest("input, textarea, select, [contenteditable='true']") !== null) return;
			event.preventDefault();
			if (state.collapsed) {
				wantSearchFocus.current = true;
				state.set(false, true);
			} else {
				searchRef.current?.focus();
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [collapsed, state.set]);

	// 从 rail 展开后，把焦点交给搜索框
	useEffect(() => {
		if (collapsed || !wantSearchFocus.current) return;
		wantSearchFocus.current = false;
		requestAnimationFrame(() => searchRef.current?.focus());
	}, [collapsed]);

	const cwd = app.workspace?.cwd ?? "";
	const cwdName = baseName(cwd);
	const connText = app.connected ? "已连接" : app.conversationId === undefined ? "未连接" : "重连中…";

	/** 新建会话；抽屉宽度下建完就收起，直接看到新会话。 */
	const createSession = (): void => {
		setQuery("");
		void store.createConversation().catch((error) => store.showError(error));
		if (!state.desktop) state.set(true, true);
	};

	return (
		<>
			<aside id="sidebar" className="sidebar-col" aria-label="会话侧栏">
				<div className="sidebar-root">
					<div className="logo-row">
						<button
							id="brand"
							className="brand"
							type="button"
							title="Stella"
							onClick={() => {
								if (collapsed) {
									state.toggle(true);
									return;
								}
								createSession();
							}}
						>
							<span className="brand-mark" aria-hidden="true">
								<StarIcon width={9} height={9} />
							</span>
							<span className="brand-word">Stella</span>
							<span className="brand-sub">DAILY AGENT</span>
							<span className="rail-expand" aria-hidden="true">
								<PanelExpandIcon />
							</span>
						</button>
						<button
							id="sidebar-collapse"
							className="icon-btn sidebar-collapse"
							type="button"
							aria-label={collapsed ? "展开侧栏" : "收起侧栏"}
							title={collapsed ? "展开侧栏" : "收起侧栏"}
							onClick={() => state.toggle(true)}
						>
							<PanelCollapseIcon />
						</button>
					</div>

					<button
						id="new-conversation"
						className="new-session"
						type="button"
						onClick={createSession}
					>
						<span className="ns-plus" aria-hidden="true" />
						<span className="new-session-label">新建会话</span>
						{!collapsed && <kbd>{isMac() ? "⌘⌥N" : "Ctrl Alt N"}</kbd>}
					</button>

					{app.presets.length > 1 && (
						<div className="preset-row">
							<label className="preset-label" htmlFor="preset-select">
								新会话预设
							</label>
							<select
								id="preset-select"
								className="preset-select"
								aria-label="新会话预设"
								value={newPreset}
								onChange={(event) => {
									setNewPreset(event.target.value);
									store.rememberPreset(event.target.value);
								}}
							>
								{app.presets.map((preset) => (
									<option key={preset.id} value={preset.id} title={preset.description}>
										{preset.name}
									</option>
								))}
							</select>
						</div>
					)}

					{collapsed ? (
						<button
							type="button"
							className="rail-search"
							title="搜索会话"
							aria-label="搜索会话"
							onClick={() => {
								wantSearchFocus.current = true;
								state.set(false, true);
							}}
						>
							<SearchIcon />
						</button>
					) : (
						<label className="search">
							<span className="search-icon" aria-hidden="true">
								<SearchIcon />
							</span>
							<input
								ref={searchRef}
								type="search"
								value={query}
								placeholder="搜索会话"
								aria-label="搜索会话"
								autoComplete="off"
								spellCheck={false}
								onChange={(event) => setQuery(event.target.value)}
								onKeyDown={(event) => {
									if (event.key === "Escape") {
										setQuery("");
										searchRef.current?.blur();
									}
								}}
							/>
							<kbd className="search-kbd">/</kbd>
						</label>
					)}

					{!collapsed && (
						<div className="list-head">
							<span>会话</span>
							<span className="list-head-meta">
								{app.busy ? (
									<>
										<span className="si-live" />1 个进行中
									</>
								) : null}
							</span>
						</div>
					)}

					<div id="conversation-list" className="session-scroll">
						{groups.length === 0 && (
							<div className="empty-list">
								{needle.length > 0 ? `没有找到与「${needle}」相关的会话` : "还没有会话，点击上方「新建会话」开始。"}
							</div>
						)}
						{groups.map((group) => (
							<div key={group.label} className="session-group">
								{!collapsed && <div className="group-label">{group.label}</div>}
								<ul className="session-list">
									{group.items.map((conversation) => {
										const preset = presetOf(app, conversation.preset ?? app.preset);
										const name = preset?.name ?? "默认预设";
										const tint = tintFor(conversation.preset ?? preset?.id);
										const active = conversation.id === app.conversationId;
										const live = active && app.busy;
										return (
											<li key={conversation.id} className={`session-item${active ? " active" : ""}`}>
												<button
													type="button"
													className="session-main"
													title={conversation.title ?? "新对话"}
													onClick={() => {
														if (!active) store.switchTo(conversation.id);
														if (!state.desktop) state.set(true, true);
													}}
												>
													<span className="si-rail-char" aria-hidden="true">
														{initialOf(conversation.title)}
													</span>
													<span className="si-title-row">
														<span className="si-title">{conversation.title ?? "新对话"}</span>
														{live && <span className="si-live" title="运行中" />}
													</span>
													<span className="si-meta">
														<span className={`si-agent tint-${tint}`}>{initialOf(name)}</span>
														<span className="si-meta-text">
															{live ? "正在运行" : `${name} · ${relativeTime(timeOf(conversation))}`}
														</span>
													</span>
												</button>
												<button
													type="button"
													className="session-delete"
													title="删除会话"
													aria-label={`删除会话：${conversation.title ?? "新对话"}`}
													onClick={() => store.openConfirm(conversation)}
												>
													<TrashIcon />
												</button>
											</li>
										);
									})}
								</ul>
							</div>
						))}
					</div>

					<div className="sidebar-foot">
						<div className="workspace">
							<span className="workspace-avatar" title={cwd}>
								{cwdName.length > 0 ? initialOf(cwdName) : <FolderIcon />}
							</span>
							<span className="workspace-meta">
								<strong>{cwdName.length > 0 ? cwdName : "本地工作区"}</strong>
								<small>
									<span className={`conn-dot${app.connected ? " on" : ""}`} />
									{connText}
								</small>
							</span>
							<div className="foot-actions">
								<button id="skills-open" className="icon-btn subtle" type="button" title="技能" aria-label="管理技能" onClick={onOpenSkills}>
									<SkillIcon />
								</button>
								<button
									id="theme-toggle"
									className="icon-btn subtle"
									type="button"
									data-pref={themePref}
									title={`主题：${themePref === "light" ? "浅色" : themePref === "dark" ? "深色" : "跟随系统"}`}
									aria-label={`主题：${themePref === "light" ? "浅色" : themePref === "dark" ? "深色" : "跟随系统"}，点击切换`}
									onClick={() => setThemePref(cycleTheme())}
								>
									<span className={themePref === "light" ? "icon-light" : themePref === "dark" ? "icon-dark" : "icon-system"}>
										{themePref === "light" ? <SunIcon /> : themePref === "dark" ? <MoonIcon /> : <SystemIcon />}
									</span>
								</button>
								{app.authRequired && (
									<button id="logout" className="icon-btn subtle" type="button" title="退出登录" aria-label="退出登录" onClick={() => store.logout()}>
										<LogoutIcon />
									</button>
								)}
							</div>
						</div>
					</div>
				</div>
			</aside>
		</>
	);
});

// —— 欢迎页 ——

function Welcome({ blank, onNew }: { blank: boolean; onNew: () => void }): ReactNode {
	const app = useApp();
	const preset = presetOf(app, app.preset);
	const name = preset?.name ?? "Stella";
	const tint = tintFor(preset?.id);
	return (
		<div className="welcome">
			<div className={`welcome-mark tint-${tint}`}>{initialOf(name)}</div>
			<div className="welcome-eyebrow">{blank ? "Stella · Ready" : `${name} · Ready`}</div>
			{blank ? (
				<button type="button" className="btn btn-md btn-primary hero-new" onClick={onNew}>
					新建会话
				</button>
			) : (
				<ComposerSeat />
			)}
		</div>
	);
}

// —— 中央列 ——

interface DetailsState {
	open: boolean;
	toggle(): void;
	close(): void;
}

function ConversationView({ sidebar, details }: { sidebar: SidebarState; details: DetailsState }): ReactNode {
	const app = useApp();
	const scrollerRef = useRef<HTMLDivElement>(null);
	const columnRef = useRef<HTMLDivElement>(null);
	const followingRef = useRef(true);

	// scroll follow：意图（nearBottom 阈值）与内容增长分离
	useEffect(() => {
		const scroller = scrollerRef.current;
		const column = columnRef.current;
		if (scroller === null || column === null) return;
		const onScroll = (): void => {
			followingRef.current = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80;
		};
		scroller.addEventListener("scroll", onScroll, { passive: true });
		const observer = new ResizeObserver(() => {
			if (followingRef.current) scroller.scrollTop = scroller.scrollHeight;
		});
		observer.observe(column);
		return () => {
			scroller.removeEventListener("scroll", onScroll);
			observer.disconnect();
		};
	}, [app.conversationId, app.heroEmpty, app.blank]);

	// 自己发送 / 切换会话：立即贴底
	useEffect(() => {
		const offInstant = store.on("scroll-instant", () => {
			const scroller = scrollerRef.current;
			if (scroller !== null) {
				followingRef.current = true;
				scroller.scrollTop = scroller.scrollHeight;
			}
		});
		return () => {
			offInstant();
		};
	}, [app.conversationId]);

	// 运行结束的那一帧再补一次贴底（最后一个 chunk 与完成事件同帧到达的竞态）。
	const busyRef = useRef(app.busy);
	useEffect(() => {
		const wasBusy = busyRef.current;
		busyRef.current = app.busy;
		if (!wasBusy || app.busy) return;
		if (!followingRef.current) return;
		requestAnimationFrame(() => {
			const scroller = scrollerRef.current;
			if (scroller !== null && followingRef.current) scroller.scrollTop = scroller.scrollHeight;
		});
	}, [app.busy]);

	const heroMode = app.heroEmpty || app.blank;
	const current = app.conversations.find((conversation) => conversation.id === app.conversationId);
	const preset = presetOf(app, app.preset);
	const model = app.workspace?.model;
	const title = app.blank ? "Stella" : current?.title ?? "新对话";
	const subtitle = app.blank
		? "万用日常型助手"
		: [
				presetOf(app, current?.preset ?? app.preset)?.name ?? "默认预设",
				model === null || model === undefined ? "" : store.displayNameOf(model),
				relativeTime(current === undefined ? undefined : timeOf(current)),
			]
				.filter((part): part is string => part !== undefined && part.length > 0)
				.join(" · ");

	const newConversation = (): void => {
		void store.createConversation().catch((error) => store.showError(error));
	};

	return (
		<section id="center" className="center-col">
			<header id="chat-header" className="topbar">
				<button
					id="menu-toggle"
					className="icon-btn mobile-menu"
					type="button"
					aria-label={sidebar.collapsed ? "打开会话列表" : "关闭会话列表"}
					aria-expanded={!sidebar.collapsed}
					aria-controls="sidebar"
					onClick={() => sidebar.set(!sidebar.collapsed, true)}
				>
					<MenuIcon />
				</button>
				<div className="topbar-title">
					<div className="session-title-row">
						<h1 id="chat-title" className="session-title" title={title}>
							{title}
						</h1>
						<span className={`status-pill${app.busy ? " live" : ""}`}>
							<span className="dot" />
							{app.blank ? "本地" : app.busy ? "运行中" : "空闲"}
						</span>
					</div>
					<div className="session-sub" title={subtitle}>
						{subtitle}
					</div>
				</div>
				<div className="topbar-actions">
					{app.conversationId !== undefined && (
						<button
							id="details-toggle"
							className="icon-btn"
							type="button"
							aria-label={details.open ? "关闭会话详情" : "打开会话详情"}
							aria-expanded={details.open}
							title="会话详情"
							onClick={details.toggle}
						>
							<PanelIcon />
						</button>
					)}
					{current !== undefined && (
						<button
							id="conversation-delete"
							className="icon-btn"
							type="button"
							aria-label="删除会话"
							title="删除会话"
							onClick={() => store.openConfirm(current)}
						>
							<TrashIcon />
						</button>
					)}
				</div>
			</header>

			<div id="scroll-body" className="chat-scroll" ref={scrollerRef}>
				{heroMode ? (
					<div id="hero" className="hero">
						<Welcome blank={app.blank} onNew={newConversation} />
					</div>
				) : (
					<>
						<main id="messages" className="messages" tabIndex={-1} aria-live="polite">
							<ChatFlow columnRef={columnRef} />
						</main>
						<ComposerSeat />
					</>
				)}
			</div>
		</section>
	);
}

// —— 根 ——

/**
 * 准入分支：未通过登录门禁时只渲染登录页。
 * 外壳拆成独立组件（`Shell`），所以这里的 hooks 不受分支影响：App 永远只调一次 `useApp`。
 */
export function App(): ReactNode {
	const app = useApp();
	if (app.auth === "checking") return <div className="auth-gate" aria-busy="true" />;
	if (app.auth !== "ready") return <LoginGate />;
	return <Shell />;
}

function Shell(): ReactNode {
	const app = useApp();
	const desktop = useMedia("(min-width: 900px)");
	const wide = useMedia("(min-width: 1280px)");
	const [collapsed, setCollapsed] = useState(initialCollapsed);
	const [animating, setAnimating] = useState(false);
	const [skillsOpen, setSkillsOpen] = useState(false);
	const [detailsOpen, setDetailsOpen] = useState(false);
	const animatingTimer = useRef<number | undefined>(undefined);

	const set = useCallback((next: boolean, animate: boolean) => {
		if (animate) {
			setAnimating(true);
			window.clearTimeout(animatingTimer.current);
			animatingTimer.current = window.setTimeout(() => setAnimating(false), 320);
		}
		setCollapsed(next);
	}, []);

	// state 提升后的 ref 镜像（toggle 闭包读最新值）
	const collapsedRef = useRef(collapsed);
	collapsedRef.current = collapsed;

	const toggle = useCallback((persist: boolean) => {
		const next = !collapsedRef.current;
		if (persist) storeSidebarCollapsed(next);
		set(next, true);
	}, [set]);

	// 视口跨越断点：进入抽屉宽度时强制关闭；回到桌面时恢复用户的收起偏好。
	useEffect(() => {
		if (!desktop) {
			setCollapsed(true);
			return;
		}
		setCollapsed(loadSidebarCollapsed() ?? window.innerWidth < 1024);
	}, [desktop]);

	// 新会话快捷键：Ctrl/Cmd + Alt + N（与侧栏键帽一致）
	useEffect(() => {
		const onKey = (event: KeyboardEvent): void => {
			if ((event.ctrlKey || event.metaKey) && event.altKey && event.key.toLowerCase() === "n") {
				event.preventDefault();
				void store.createConversation().catch((error) => store.showError(error));
				if (!desktop) set(true, true);
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [desktop, set]);

	// dataset 同步给 CSS（grid 轨道 / rail 显隐 / 抽屉）
	useEffect(() => {
		const frame = document.getElementById("frame");
		if (frame === null) return;
		frame.dataset.sidebarCollapsed = String(collapsed);
		frame.toggleAttribute("data-sidebar-drawer", !desktop);
		frame.dataset.details = detailsOpen && app.conversationId !== undefined ? "open" : "closed";
		frame.toggleAttribute("data-details-drawer", !wide);
		frame.toggleAttribute("data-animating", animating);
	}, [collapsed, animating, desktop, detailsOpen, wide, app.conversationId]);

	// Esc 关闭抽屉 / 详情
	useEffect(() => {
		const onKey = (event: KeyboardEvent): void => {
			if (event.key !== "Escape") return;
			if (document.querySelector(".modal-root") !== null) return;
			if (!desktop && !collapsed) set(true, true);
			else if (!wide && detailsOpen) setDetailsOpen(false);
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [desktop, collapsed, wide, detailsOpen, set]);

	const sidebar: SidebarState = { collapsed, desktop, toggle, set };
	const details: DetailsState = {
		open: detailsOpen && app.conversationId !== undefined,
		toggle: () => setDetailsOpen(!detailsOpen),
		close: () => setDetailsOpen(false),
	};
	const scrimVisible = (!desktop && !collapsed) || (!wide && detailsOpen && app.conversationId !== undefined);

	return (
		<div
			id="frame"
			className="frame"
			data-sidebar-collapsed={String(collapsed)}
			data-sidebar-drawer={desktop ? undefined : ""}
			data-details={details.open ? "open" : "closed"}
			data-details-drawer={wide ? undefined : ""}
		>
			<div className="grain" aria-hidden="true" />
			<Sidebar state={sidebar} onOpenSkills={() => setSkillsOpen(true)} />
			<ConversationView sidebar={sidebar} details={details} />
			{details.open && <DetailsRail onClose={details.close} />}
			<button
				type="button"
				className="scrim"
				hidden={!scrimVisible}
				aria-label="关闭浮层"
				onClick={() => {
					if (!desktop) set(true, true);
					if (!wide) setDetailsOpen(false);
				}}
			/>
			{skillsOpen && (
				<SkillsPanel
					presets={app.presets}
					initialPreset={app.preset ?? store.lastPreset()}
					onClose={() => setSkillsOpen(false)}
				/>
			)}
			<ConfirmDialog />
			<Toast message={app.toast} />
		</div>
	);
}

function ConfirmDialog(): ReactNode {
	const app = useApp();
	const target = app.confirmTarget;
	const cancelRef = useRef<HTMLButtonElement>(null);
	const restoreRef = useRef<HTMLElement | null>(null);

	useEffect(() => {
		if (target !== null) {
			restoreRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
			cancelRef.current?.focus();
			return;
		}
		const back = restoreRef.current;
		restoreRef.current = null;
		back?.focus();
	}, [target]);

	useEffect(() => {
		if (target === null) return;
		const onKey = (event: KeyboardEvent): void => {
			if (event.key === "Escape") {
				event.preventDefault();
				store.closeConfirm();
			}
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [target]);

	if (target === null) return null;
	return (
		<div id="confirm" className="modal-root">
			<div className="modal-mask" onClick={() => store.closeConfirm()} />
			<div id="confirm-card" className="modal-dialog confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="confirm-title">
				<div className="modal-header">
					<h3 id="confirm-title" className="modal-title">
						删除会话
					</h3>
				</div>
				<p id="confirm-text" className="modal-desc">
					{`删除会话「${target.title ?? "新对话"}」？该会话的消息将不再显示。`}
				</p>
				<div className="modal-footer">
					<button ref={cancelRef} id="confirm-cancel" className="btn btn-md btn-ghost" type="button" onClick={() => store.closeConfirm()}>
						取消
					</button>
					<button
						id="confirm-delete"
						className="btn btn-md btn-danger"
						type="button"
						onClick={() => {
							const id = target.id;
							store.closeConfirm();
							void store.deleteConversation(id).catch((error) => store.showError(error));
						}}
					>
						删除
					</button>
				</div>
			</div>
		</div>
	);
}

function Toast({ message }: { message: string | null }): ReactNode {
	if (message === null) return null;
	return (
		<div id="banner" className="toast" role="status">
			{message}
		</div>
	);
}
