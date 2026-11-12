/**
 * 应用外壳（DSH AppFrame 复刻）：grid 两列 + 侧栏三态（280px ↔ 56px rail、<768px 抽屉）。
 * DOM 结构与类名对齐 legacy index.html，style.css 继续生效。
 */

import { memo, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { store } from "../store/app-store";
import { cycleTheme, loadThemePref } from "../theme";
import {
	FolderIcon,
	LogoutIcon,
	MenuIcon,
	MoonIcon,
	PanelCollapseIcon,
	PanelExpandIcon,
	PlusIcon,
	SearchIcon,
	SkillIcon,
	SunIcon,
	SystemIcon,
	TrashIcon,
	StarIcon,
} from "./icons";
import { ComposerSeat } from "./Composer";
import { ChatFlow, TraceView } from "./ChatFlow";
import { ChevronDownIcon } from "./icons";
import { LoginGate } from "./LoginGate";
import { SkillsPanel } from "./SkillsPanel";
import { useApp, useMedia } from "./hooks";

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
	return loadSidebarCollapsed() ?? window.innerWidth < 1024;
}

function formatRelative(createdAt?: number): string {
	if (createdAt === undefined || createdAt <= 0) return "";
	const now = Date.now();
	const diff = now - createdAt;
	if (diff < 60_000) return "刚刚";
	if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}分钟`;
	const date = new Date(createdAt);
	const today = new Date(now);
	const pad = (n: number): string => String(n).padStart(2, "0");
	if (date.toDateString() === today.toDateString()) return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
	if (date.getFullYear() === today.getFullYear()) return `${date.getMonth() + 1}/${date.getDate()}`;
	return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
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
	const [searching, setSearching] = useState(false);
	const [query, setQuery] = useState("");
	const searchRef = useRef<HTMLInputElement>(null);
	const collapsed = state.collapsed;
	const drawer = !state.desktop && !collapsed;

	useEffect(() => {
		if (searching) searchRef.current?.focus();
	}, [searching]);

	const needle = query.trim().toLowerCase();
	const visible = needle.length === 0
		? app.conversations
		: app.conversations.filter((c) => (c.title ?? "新对话").toLowerCase().includes(needle));

	// 当前会话的工作目录（真实数据：会话设置 cwd 的末段）
	const cwd = app.workspace?.cwd ?? "";
	// 取路径末段：先把反斜杠归一为斜杠，再按 "/" 切（Windows 与 POSIX 通用，无需正则转义）。
	const cwdName = cwd.split(String.fromCharCode(92)).join("/").split("/").filter((part) => part.length > 0).pop() ?? "";

	const onThemeToggle = (): void => setThemePref(cycleTheme());

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
								void store.createConversation().catch((error) => store.showError(error));
							}}
						>
							<span className="brand-identity">
								<span className="brand-mark">
									<StarIcon />
								</span>
								<span className="brand-name">Stella</span>
							</span>
							<span className="rail-expand">
								<PanelExpandIcon />
							</span>
						</button>
						<button
							id="sidebar-collapse"
							className="icon-btn"
							type="button"
							aria-label={collapsed ? "展开侧栏" : "收起侧栏"}
							onClick={() => state.toggle(true)}
						>
							<PanelCollapseIcon />
						</button>
					</div>
					<button
						id="new-conversation"
						className="new-session"
						type="button"
						onClick={() => {
							void store.createConversation().catch((error) => store.showError(error));
						}}
					>
						<span className="new-session-content">
							<PlusIcon />
							<span className="new-session-label">新会话</span>
							{!collapsed && <span className="new-session-key">{isMac() ? "⌘⌥N" : "Ctrl+Alt+N"}</span>}
						</span>
					</button>
					{app.presets.length > 1 && (
						<div className="preset-row">
							<label className="preset-label" htmlFor="preset-select">
								预设
							</label>
							<select
								id="preset-select"
								className="select preset-select"
								aria-label="新会话预设"
								value={store.lastPreset()}
								onChange={(e) => store.rememberPreset(e.target.value)}
							>
								{app.presets.map((preset) => (
									<option key={preset.id} value={preset.id} title={preset.description}>
										{preset.name}
									</option>
								))}
							</select>
						</div>
					)}
					<div className="scroll-region">
						<div className="group-head">
							<span className="group-title">
								会话
								{app.conversations.length > 0 && <span className="group-count">{app.conversations.length}</span>}
							</span>
							<span className="group-actions">
								<button
									type="button"
									className="icon-btn"
									title={searching ? "关闭搜索" : "搜索会话"}
									aria-label={searching ? "关闭搜索" : "搜索会话"}
									aria-pressed={searching}
									onClick={() => {
										setSearching(!searching);
										if (searching) setQuery("");
									}}
								>
									<SearchIcon />
								</button>
								<button
									type="button"
									className="icon-btn"
									title="新会话"
									aria-label="新会话"
									onClick={() => void store.createConversation().catch((error) => store.showError(error))}
								>
									<PlusIcon />
								</button>
							</span>
						</div>
						{searching && (
							<div className="session-search">
								<input
									ref={searchRef}
									type="search"
									value={query}
									placeholder="搜索会话标题"
									aria-label="搜索会话标题"
									onChange={(e) => setQuery(e.target.value)}
									onKeyDown={(e) => {
										if (e.key === "Escape") {
											setQuery("");
											setSearching(false);
										}
									}}
								/>
							</div>
						)}
						{cwdName.length > 0 && (
							<div className="workspace-row" title={cwd}>
								<FolderIcon />
								<span className="workspace-row-name">{cwdName}</span>
							</div>
						)}
						<ul id="conversation-list" className="session-list">
							{visible.length === 0 && needle.length > 0 && (
								<li className="session-empty">{`没有匹配「${query.trim()}」的会话`}</li>
							)}
							{visible.map((conversation) => (
								<li
									key={conversation.id}
									className={`session-row${conversation.id === app.conversationId ? " selected" : ""}`}
								>
									<button
										type="button"
										className="session-main"
										onClick={() => {
											if (conversation.id !== app.conversationId) store.switchTo(conversation.id);
										}}
									>
										<span className="session-slot" aria-hidden="true">
											{conversation.id === app.conversationId && app.busy && <span className="session-dot" />}
										</span>
										<span className="session-title">{conversation.title ?? "新对话"}</span>
										<span className="session-time">{formatRelative(conversation.createdAt)}</span>
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
							))}
						</ul>
					</div>
					<div className="foot-area">
						<span
							id="conn"
							className={`conn ${app.connected ? "conn-online" : "conn-offline"}`}
							title={app.connected ? "已连接" : app.conversationId === undefined ? "未连接" : "重连中…"}
						>
							<span className="conn-dot" />
							<span className="conn-text">
								{app.connected ? "已连接" : app.conversationId === undefined ? "未连接" : "重连中…"}
							</span>
						</span>
						<button
							id="skills-open"
							className="icon-btn"
							type="button"
							title="技能"
							aria-label="管理技能"
							onClick={onOpenSkills}
						>
							<SkillIcon />
						</button>
						{app.authRequired && (
							<button
								id="logout"
								className="icon-btn"
								type="button"
								title="退出登录"
								aria-label="退出登录"
								onClick={() => store.logout()}
							>
								<LogoutIcon />
							</button>
						)}
						<button
							id="theme-toggle"
							className="icon-btn"
							type="button"
							data-pref={themePref}
							title={`主题：${themePref === "light" ? "浅色" : themePref === "dark" ? "深色" : "跟随系统"}`}
							aria-label={`主题：${themePref === "light" ? "浅色" : themePref === "dark" ? "深色" : "跟随系统"}，点击切换`}
							onClick={onThemeToggle}
						>
							<span className={themePref === "light" ? "icon-light" : themePref === "dark" ? "icon-dark" : "icon-system"}>
								{themePref === "light" ? <SunIcon /> : themePref === "dark" ? <MoonIcon /> : <SystemIcon />}
							</span>
						</button>
					</div>
				</div>
			</aside>
			<div id="drawer-mask" className="drawer-mask" hidden={!drawer} onClick={() => state.set(true, true)} />
		</>
	);
});

// —— 中央列 ——

function ConversationView({ sidebar }: { sidebar: SidebarState }): ReactNode {
	const app = useApp();
	const scrollerRef = useRef<HTMLDivElement>(null);
	const columnRef = useRef<HTMLDivElement>(null);
	const followingRef = useRef(true);
	const [view, setView] = useState<"chat" | "trace">("chat");

	// Tab 行键盘操作：←/→ 在家（roving tabindex），Home/End 跳首尾（WAI-ARIA tabs 模式）
	const onTabsKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
		const order: ("chat" | "trace")[] = ["chat", "trace"];
		const index = order.indexOf(view);
		let next: "chat" | "trace" | undefined;
		if (e.key === "ArrowRight") next = order[(index + 1) % order.length];
		else if (e.key === "ArrowLeft") next = order[(index - 1 + order.length) % order.length];
		else if (e.key === "Home") next = order[0];
		else if (e.key === "End") next = order[order.length - 1];
		if (next === undefined) return;
		e.preventDefault();
		setView(next);
		requestAnimationFrame(() => document.getElementById(`tab-${next}`)?.focus());
	};

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
	}, [app.conversationId]);

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

	// 运行结束的那一帧再补一次贴底。
	// 偶发竞态：最后一个 chunk 与完成事件同帧到达时，ResizeObserver 回调读到的还是
	// 布局前的 scrollHeight，于是停在距底 100+px 处不再跟随（评审在 4 次运行里见到 1 次）。
	// 这里只在"用户本来就在跟随"时补，不抢回主动向上翻阅的人。
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
	const compact = heroMode;
	const title = app.conversations.find((c) => c.id === app.conversationId)?.title ?? "新对话";
	const composer = <ComposerSeat />;
	const preset = app.presets.find((item) => item.id === app.preset);

	return (
		<section id="center" className="center-col">
			<header id="chat-header" className="conv-header" data-compact={compact ? "" : undefined} hidden={app.conversationId === undefined}>
				<div className="title-row">
					<button
						id="menu-toggle"
						className="icon-btn mobile-only"
						type="button"
						aria-label={sidebar.collapsed ? "打开会话列表" : "关闭会话列表"}
						aria-expanded={!sidebar.collapsed}
						aria-controls="sidebar"
						onClick={() => sidebar.set(!sidebar.collapsed, true)}
					>
						<MenuIcon />
					</button>
					<button id="sidebar-open" className="icon-btn desktop-only" type="button" aria-label="展开侧栏" hidden>
						<PanelExpandIcon />
					</button>
					{!compact && (
						<div className="crumbs">
							<span className="crumb-seg">
								<span id="chat-title" className="crumb crumb-current">
									{title}
								</span>
								{preset !== undefined && (
									<span className="status-chip" title={preset.description ?? `预设：${preset.id}`}>
										{preset.name}
										<ChevronDownIcon />
									</span>
								)}
							</span>
						</div>
					)}
				</div>
				{!compact && (
					<div className="tabs" role="tablist" aria-label="会话视图" onKeyDown={onTabsKeyDown}>
						<button
							type="button"
							role="tab"
							id="tab-chat"
							className="tab"
							aria-selected={view === "chat"}
							aria-controls="messages"
							tabIndex={view === "chat" ? 0 : -1}
							onClick={() => setView("chat")}
						>
							对话
						</button>
						<button
							type="button"
							role="tab"
							id="tab-trace"
							className="tab"
							aria-selected={view === "trace"}
							aria-controls="messages"
							tabIndex={view === "trace" ? 0 : -1}
							onClick={() => setView("trace")}
						>
							轨迹
						</button>
					</div>
				)}
			</header>
			<div id="scroll-body" className="scroll-body" ref={scrollerRef}>
				<main
					id="messages"
					className="messages"
					role="tabpanel"
					aria-labelledby={`tab-${view}`}
					tabIndex={-1}
					aria-live="polite"
				>
					{view === "chat" ? <ChatFlow columnRef={columnRef} /> : <TraceView />}
				</main>
				{heroMode ? (
					<div id="hero" className="hero">
						<div className="hero-stack">
							{app.blank && (
								<button
									type="button"
									className="btn btn-md btn-primary hero-new"
									onClick={() => void store.createConversation().catch((error) => store.showError(error))}
								>
									新建会话
								</button>
							)}
							<div className="hero-headline">
								<span className="hero-mark">
									<StarIcon width={26} height={26} />
								</span>
								<span className="hero-title">Stella</span>
							</div>
							<div className="hero-sub">万用日常型助手，直接开始提问。</div>
							{app.workspace?.model != null && (
								<span className="hero-badge">{store.displayNameOf(app.workspace.model)}</span>
							)}
							{composer}
						</div>
					</div>
				) : (
					composer
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
	const desktop = useMedia("(min-width: 768px)");
	const [collapsed, setCollapsed] = useState(initialCollapsed);
	const [animating, setAnimating] = useState(false);
	const [skillsOpen, setSkillsOpen] = useState(false);
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

	// 视口跨越断点：无记忆时按宽度决定
	useEffect(() => {
		if (loadSidebarCollapsed() === undefined) setCollapsed(!desktop || window.innerWidth < 1024);
	}, [desktop]);

	// 新会话快捷键：Ctrl/Cmd + Alt + N（与侧栏键帽一致）
	useEffect(() => {
		const onKey = (e: KeyboardEvent): void => {
			if ((e.ctrlKey || e.metaKey) && e.altKey && e.key.toLowerCase() === "n") {
				e.preventDefault();
				void store.createConversation().catch((error) => store.showError(error));
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);

	// dataset 同步给 CSS（grid 轨道 / rail 显隐 / 抽屉）
	useEffect(() => {
		const frame = document.getElementById("frame");
		if (frame === null) return;
		frame.dataset.sidebarCollapsed = String(collapsed);
		frame.toggleAttribute("data-sidebar-drawer", !desktop);
		if (animating) frame.setAttribute("data-animating", "");
		else frame.removeAttribute("data-animating");
		const open = document.getElementById("sidebar-open");
		if (open !== null) open.hidden = !(collapsed && desktop);
	}, [collapsed, animating, desktop]);

	const sidebar: SidebarState = { collapsed, desktop, toggle, set };

	return (
		<div id="frame" className="frame" data-sidebar-collapsed={String(collapsed)} data-sidebar-drawer={desktop ? undefined : ""}>
			<Sidebar state={sidebar} onOpenSkills={() => setSkillsOpen(true)} />
			<ConversationView sidebar={sidebar} />
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
	/** 打开弹层前的焦点元素：关闭后归还，键盘用户不会丢失位置。 */
	const restoreRef = useRef<HTMLElement | null>(null);

	useEffect(() => {
		if (target !== null) {
			restoreRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
			cancelRef.current?.focus();
			return;
		}
		// 关闭（确认 / 取消 / Esc / 点遮罩）：焦点回到打开它的按钮
		const back = restoreRef.current;
		restoreRef.current = null;
		back?.focus();
	}, [target]);

	// Esc 关闭（WAI-ARIA dialog 模式）
	useEffect(() => {
		if (target === null) return;
		const onKey = (e: KeyboardEvent): void => {
			if (e.key === "Escape") {
				e.preventDefault();
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
			<div id="confirm-card" className="modal-dialog" role="dialog" aria-modal="true" aria-labelledby="confirm-title">
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
