/**
 * 应用外壳（DSH AppFrame 复刻）：grid 两列 + 侧栏三态（280px ↔ 56px rail、<768px 抽屉）。
 * DOM 结构与类名对齐 legacy index.html，style.css 继续生效。
 */

import { memo, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { store } from "../store/app-store";
import { cycleTheme, loadThemePref } from "../theme";
import {
	MenuIcon,
	MoonIcon,
	PanelCollapseIcon,
	PanelExpandIcon,
	PlusIcon,
	SunIcon,
	SystemIcon,
	TrashIcon,
	StarIcon,
} from "./icons";
import { ComposerSeat } from "./Composer";
import { ChatFlow, TraceView } from "./ChatFlow";
import { ChevronDownIcon } from "./icons";
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

const Sidebar = memo(function Sidebar({ state }: { state: SidebarState }): ReactNode {
	const app = useApp();
	const [themePref, setThemePref] = useState(loadThemePref);
	const collapsed = state.collapsed;
	const drawer = !state.desktop && !collapsed;

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
						<ul id="conversation-list" className="session-list">
							{app.conversations.map((conversation) => (
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
					<div className="tabs" role="tablist" aria-label="会话视图">
						<button type="button" className="tab" role="tab" aria-selected={view === "chat"} onClick={() => setView("chat")}>
							对话
						</button>
						<button type="button" className="tab" role="tab" aria-selected={view === "trace"} onClick={() => setView("trace")}>
							轨迹
						</button>
					</div>
				)}
			</header>
			<div id="scroll-body" className="scroll-body" ref={scrollerRef}>
				<main id="messages" className="messages" aria-live="polite">
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

export function App(): ReactNode {
	const app = useApp();
	const desktop = useMedia("(min-width: 768px)");
	const [collapsed, setCollapsed] = useState(initialCollapsed);
	const [animating, setAnimating] = useState(false);
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
			<Sidebar state={sidebar} />
			<ConversationView sidebar={sidebar} />
			<ConfirmDialog />
			<Toast message={app.toast} />
		</div>
	);
}

function ConfirmDialog(): ReactNode {
	const app = useApp();
	const target = app.confirmTarget;
	const cancelRef = useRef<HTMLButtonElement>(null);
	useEffect(() => {
		if (target !== null) cancelRef.current?.focus();
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
