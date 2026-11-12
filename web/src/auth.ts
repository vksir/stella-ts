/**
 * 准入的客户端一侧：票据存取 + 登录请求。
 *
 * 浏览器持有的是服务端签发的票据（`v1.<签发时间>.<HMAC>`），不是登录密钥本身——
 * 登录密钥只在登录那一次 POST 里出现，之后不再可读（ADR-0004）。
 * 票据固定 30 天过期；服务端不存会话表，退出只是删掉本地这份。
 */

const STORAGE_KEY = "stella-auth";

export interface AuthCredential {
	readonly token: string;
	/** 失效的绝对时间（epoch 毫秒），由服务端下发。 */
	readonly expiresAt: number;
}

export interface AuthStatus {
	/** 服务端是否启用登录（faux 模式下为 false）。 */
	readonly authRequired: boolean;
	/** 本地凭据是否被服务端接受。 */
	readonly ok: boolean;
}

/** 读取本地票据；已过期则顺手清掉（不必等一次 401）。 */
export function readCredential(): AuthCredential | undefined {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (raw === null) return undefined;
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== "object" || parsed === null) return undefined;
		const { token, expiresAt } = parsed as { token?: unknown; expiresAt?: unknown };
		if (typeof token !== "string" || token.length === 0) return undefined;
		if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
			clearCredential();
			return undefined;
		}
		return { token, expiresAt };
	} catch {
		return undefined;
	}
}

export function writeCredential(credential: AuthCredential): void {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(credential));
	} catch {
		/* 隐私模式/配额满：本次会话内仍可用（store 里不缓存，见下） */
	}
}

export function clearCredential(): void {
	try {
		localStorage.removeItem(STORAGE_KEY);
	} catch {
		/* 忽略 */
	}
}

/** 请求头：有有效票据时返回 `{ authorization }`。 */
export function authHeaders(): Record<string, string> | undefined {
	const credential = readCredential();
	return credential === undefined ? undefined : { authorization: `Bearer ${credential.token}` };
}

// —— 401 回调：fetchJson 与 SSE 共用 ——

let unauthorizedHandler: (() => void) | undefined;

export function setUnauthorizedHandler(handler: (() => void) | undefined): void {
	unauthorizedHandler = handler;
}

/** 由网络层调用：任何请求收到 401 都意味着「登录态没了」。 */
export function notifyUnauthorized(): void {
	unauthorizedHandler?.();
}

// —— 接口调用（不走 fetchJson：登录请求不该带旧票据、也不该触发 401 回调） ——

export async function fetchAuthStatus(): Promise<AuthStatus> {
	const response = await fetch("/api/auth/status", { headers: authHeaders() });
	if (!response.ok) throw new Error(`无法读取登录状态（${response.status}）`);
	const body = (await response.json()) as { authRequired?: unknown; ok?: unknown };
	return { authRequired: body.authRequired === true, ok: body.ok === true };
}

/** 用登录密钥换票据；失败时抛带中文文案的 Error。 */
export async function loginRequest(key: string): Promise<AuthCredential> {
	const response = await fetch("/api/auth/login", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ key }),
	});
	const body = (await response.json().catch(() => ({}))) as { error?: unknown; token?: unknown; expiresAt?: unknown };
	if (!response.ok) {
		const message = typeof body.error === "string" ? body.error : `登录失败（${response.status}）`;
		throw new Error(message);
	}
	if (typeof body.token !== "string" || typeof body.expiresAt !== "number") {
		// 服务端未启用登录（faux 模式）：返回空凭据，调用方据此直接进入。
		return { token: "", expiresAt: Number.MAX_SAFE_INTEGER };
	}
	return { token: body.token, expiresAt: body.expiresAt };
}
