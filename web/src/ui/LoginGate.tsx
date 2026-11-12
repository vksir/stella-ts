/**
 * 登录门禁：唯一入口是「输入登录密钥」。
 *
 * 前端没有路由库，所以它不是一条路由，而是 App 顶部的一个状态分支（ADR-0004）。
 * 输入框是密码类型：密钥会被粘贴进来，不该在屏幕上留痕；回车即可提交。
 */
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { store } from "../store/app-store";
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
			<div className="auth-card">
				<div className="auth-brand" aria-hidden="true">
					Stella
				</div>
				<h1 className="auth-title">输入登录密钥</h1>
				<p className="auth-hint">
					Stella 没有用户系统，只有一把锁。登录密钥由部署者保管，写在服务端 <code>.env</code> 的{" "}
					<code>STELLA_TOKEN</code>。
				</p>
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
					{busy ? "校验中…" : "登录"}
				</button>
				{message !== null && (
					<p className="auth-message" role="alert">
						{message}
					</p>
				)}
			</div>
		</form>
	);
}
