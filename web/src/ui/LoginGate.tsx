/**
 * 登录门禁：唯一入口是「登录密钥」。
 *
 * 前端没有路由库，所以它不是一条路由，而是 App 顶部的一个状态分支（ADR-0004）。
 * 输入框是密码类型：密钥会被粘贴进来，不该在屏幕上留痕；回车即可提交。
 * 文案面向使用者：先说清「这是什么、怎么进」（hint），部署细节退到更淡的脚注
 * （footnote，写给自部署的人），不把 `.env` / 环境变量摆到第一屏。
 */
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { store } from "../store/app-store";
import { StarIcon } from "./icons";
import { useApp } from "./hooks";

export function LoginGate(): ReactNode {
	const app = useApp();
	const [key, setKey] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const inputRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		inputRef.current?.focus();
	}, []);

	const submit = (event: FormEvent<HTMLFormElement>): void => {
		event.preventDefault();
		if (busy || key.trim().length === 0) return;
		setBusy(true);
		setError(null);
		void store
			.submitLogin(key)
			.catch((failure: unknown) => {
				setError(failure instanceof Error ? failure.message : String(failure));
			})
			.finally(() => setBusy(false));
	};

	// 启动时连不上服务端之类的问题由 store 的 toast 承载，这里一并显示。
	const message = error ?? app.toast;

	return (
		<form className="auth-gate" onSubmit={submit}>
			<div className="grain" aria-hidden="true" />
			<div className="auth-card">
				<div className="auth-brand" aria-hidden="true">
					<span className="brand-mark">
						<StarIcon width={10} height={10} />
					</span>
					<span>Stella</span>
				</div>
				<div className="auth-eyebrow">私人空间</div>
				<h1 className="auth-title">欢迎回来</h1>
				<p className="auth-hint">Stella 是你的私人助手，输入登录密钥就能进入。</p>
				<input
					ref={inputRef}
					className="auth-input"
					type="password"
					value={key}
					onChange={(e) => setKey(e.target.value)}
					placeholder="登录密钥"
					aria-label="登录密钥"
					autoComplete="current-password"
					spellCheck={false}
					disabled={busy}
					aria-invalid={error !== null}
				/>
				<button className="auth-submit" type="submit" disabled={busy || key.trim().length === 0}>
					{busy ? "正在验证…" : "进入"}
				</button>
				{message !== null && (
					<p className="auth-message" role="alert">
						{message}
					</p>
				)}
				<p className="auth-footnote">
					不知道密钥？问一下部署 Stella 的人。自己部署的话，它在服务端 <code>.env</code> 的{" "}
					<code>STELLA_TOKEN</code>。
				</p>
			</div>
		</form>
	);
}
