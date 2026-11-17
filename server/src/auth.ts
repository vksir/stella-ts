/**
 * 准入：登录密钥与登录态。
 *
 * Stella 没有用户系统，只有一把锁：谁持有登录密钥（`STELLA_TOKEN`），谁就能用。
 *
 * - **登录密钥**只存在于服务端；浏览器拿不到它，只持有服务端签发的票据。
 * - **票据**无状态（`v1.<签发时间>.<HMAC>`），30 天固定过期，服务端不存会话表；
 *   轮换登录密钥（改 `.env` + 重启）即让全部已签票据失效。
 * - **SSE 也走请求头**：实时通道改用 `fetch` 读流（ADR-0004），
 *   所以不需要把任何凭据放进 URL。
 * - **登录限速**：按来源地址计数，60 秒内 5 次失败后拒绝，避免在线爆破。
 *
 * 术语见 GLOSSARY「准入」：登录密钥 / 登录 / 登录态（与「会话」无关）。
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { accessSync, appendFileSync, constants, existsSync } from "node:fs";
import { resolve } from "node:path";
import type { MiddlewareHandler } from "hono";
import type { Context } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";

import { isLoopbackHost, type StellaConfig } from "./config.js";

/** 票据有效期：固定 30 天，不做滑动续期（见 ADR-0004）。 */
export const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** 登录密钥的最小长度：32 字符（生成器给 43 字符）。 */
export const MIN_LOGIN_KEY_LENGTH = 32;
/** 登录失败限速：窗口内允许的失败次数。 */
export const LOGIN_FAILURE_LIMIT = 5;
/** 登录失败限速窗口（毫秒）。 */
export const LOGIN_FAILURE_WINDOW_MS = 60_000;

/** 生成一枚登录密钥：32 字节随机数的 base64url（43 字符）。 */
export function generateLoginKey(): string {
	return randomBytes(32).toString("base64url");
}

/** 登录密钥太短时抛错：它同时是票据的 HMAC 密钥，弱密钥可被离线猜测。 */
export function assertLoginKeyStrength(key: string): void {
	if (key.length >= MIN_LOGIN_KEY_LENGTH) return;
	throw new Error(
		`STELLA_TOKEN 太短（${key.length} 字符，至少 ${MIN_LOGIN_KEY_LENGTH} 字符）。\n` +
			"登录密钥同时是票据的 HMAC 密钥，弱密钥可被离线猜测。\n" +
			"请执行 `npm run token:gen` 生成一枚（43 字符），写入 .env 后重启。",
	);
}

/**
 * 启动前的部署安全断言：拒绝把“未鉴权”或“明文”入口暴露到非回环地址。
 *
 * - 非回环且没有登录密钥（典型是 faux 模式未配 STELLA_TOKEN）→ 拒绝；
 * - 登录密钥短于 32 字符 → 拒绝；
 * - 非回环且 `STELLA_REQUIRE_HTTPS` 未显式设置 → 拒绝；显式 `0`/`false` 视为知情选择。
 */
export function assertDeploymentSafety(config: StellaConfig): void {
	const loopback = isLoopbackHost(config.host);
	if (config.trustedProxies.some((rule) => rule.trim() === "0.0.0.0/0")) {
		throw new Error(
			"STELLA_TRUSTED_PROXY 不能是 0.0.0.0/0。\n" +
				"这会让任何直连方都能伪造 X-Forwarded-For / X-Forwarded-Proto，" +
				"绕过登录限速和 HTTPS 闸门。请只列反向代理的真实 IP 或最小网段。",
		);
	}
	if (!loopback && config.token === undefined) {
		throw new Error(
			`监听 ${config.host} 但没有启用登录密钥。\n` +
				"拒绝启动：这会让任何能访问该端口的人直接使用文件与命令工具。\n" +
				"请配置 STELLA_TOKEN（npm run token:gen），或把 STELLA_HOST 改回 127.0.0.1。",
		);
	}
	if (config.token !== undefined) assertLoginKeyStrength(config.token);
	if (!loopback && !config.httpsRequired && !config.httpsConfigured) {
		throw new Error(
			`监听 ${config.host} 但没有设置 STELLA_REQUIRE_HTTPS。\n` +
				"拒绝启动：非回环地址上的明文 HTTP 会让登录密钥和 30 天票据以明文传输。\n" +
				"请让反向代理终止 TLS 并设置 STELLA_REQUIRE_HTTPS=1（反代需覆盖 X-Forwarded-Proto: https）。\n" +
				"如果确实要在局域网用明文 HTTP，显式设置 STELLA_REQUIRE_HTTPS=0。",
		);
	}
}

// —— 密钥来源：显式配置 / faux 豁免 / 首次部署自动生成 ——

export interface LoginKeyResolution {
	/** 生效的登录密钥；undefined 表示本次进程不启用登录（仅 faux 模式）。 */
	readonly key: string | undefined;
	/** 本次自动生成的密钥（需要在日志里提示用户一次）。 */
	readonly generated?: string;
	/** 自动生成时写入的 `.env` 路径。 */
	readonly envPath?: string;
	/** 给启动日志的一句说明。 */
	readonly note?: string;
}

/**
 * 解析登录密钥：
 * 1. `STELLA_TOKEN` 显式配置 → 直接用；
 * 2. faux 模式（`STELLA_FAUX=1`，测试与免 key 体验）→ 不启用登录；
 * 3. 其余情况视为首次部署：生成一枚并追加进"已存在的那个 `.env`"（当前目录优先，
 *    其次仓库根目录——仅当上级目录是 workspace 根时才考虑，避免写到无关的父目录）。
 *    两个位置都没有可写的 `.env` 时报错，要求手动写。
 */
export function resolveLoginKey(
	env: NodeJS.ProcessEnv,
	options: { readonly faux: boolean; readonly cwd?: string },
): LoginKeyResolution {
	const explicit = env.STELLA_TOKEN?.trim();
	if (explicit !== undefined && explicit.length > 0) {
		return {
			key: explicit,
			...(explicit.length < MIN_LOGIN_KEY_LENGTH
				? {
						note:
							`STELLA_TOKEN 偏短（${explicit.length} 字符，至少 ${MIN_LOGIN_KEY_LENGTH} 字符）：` +
							"启动会被拒绝。请用 npm run token:gen 重新生成。",
					}
				: {}),
		};
	}
	if (options.faux) {
		return { key: undefined, note: "STELLA_FAUX=1：未启用登录密钥（任何能访问该端口的人都能使用）。" };
	}

	const base = options.cwd ?? process.cwd();
	// 上级目录只在它是 workspace 根时才考虑：npm workspaces 会把 cwd 切到 server/，
	// 但直接 `node main.js` 时上级可能是毫不相干的另一个项目。
	const candidates = [resolve(base, ".env")];
	if (existsSync(resolve(base, "..", "package.json"))) candidates.push(resolve(base, "..", ".env"));
	const envPath = candidates.find((path) => existsSync(path) && isWritable(path));
	if (envPath === undefined) {
		throw new Error(
			"未配置登录密钥（STELLA_TOKEN），且找不到可写的 .env。\n" +
				"请执行 `npm run token:gen` 生成一枚，然后写入 .env：\n" +
				"  STELLA_TOKEN=<生成的那一串>\n" +
				"（写入后重启服务生效。）",
		);
	}

	const generated = generateLoginKey();
	appendFileSync(
		envPath,
		`\n# 登录密钥：首次启动自动生成。改这一行并重启，即可让所有浏览器重新登录。\nSTELLA_TOKEN=${generated}\n`,
		"utf8",
	);
	return {
		key: generated,
		generated,
		envPath,
		note: `已生成登录密钥并写入 ${envPath}（只打印这一次）。`,
	};
}

function isWritable(path: string): boolean {
	try {
		accessSync(path, constants.W_OK);
		return true;
	} catch {
		return false;
	}
}

// —— 登录密钥比较 ——

/**
 * 登录密钥比较：先各自 sha256 再定长比较，长度差异不参与计时（避免侧信道）。
 */
export function loginKeyMatches(expected: string, candidate: string): boolean {
	const a = createHash("sha256").update(expected).digest();
	const b = createHash("sha256").update(candidate).digest();
	return timingSafeEqual(a, b);
}

// —— 票据：无状态 HMAC ——

function sign(secret: string, payload: string): string {
	return createHmac("sha256", secret).update(payload).digest("base64url").slice(0, 43);
}

function signatureMatches(expected: string, actual: string): boolean {
	const a = Buffer.from(expected);
	const b = Buffer.from(actual);
	return a.length === b.length && timingSafeEqual(a, b);
}

export interface IssuedTicket {
	readonly token: string;
	/** 票据失效的绝对时间（epoch 毫秒）。 */
	readonly expiresAt: number;
}

export type TicketCheck =
	| { readonly ok: true; readonly expiresAt: number }
	| { readonly ok: false; readonly reason: "missing" | "malformed" | "expired" | "signature" };

/** 签发登录票据（不需要保存任何状态）。 */
export function issueToken(secret: string, now: number = Date.now()): IssuedTicket {
	const payload = `v1.${now}`;
	return { token: `${payload}.${sign(secret, payload)}`, expiresAt: now + TOKEN_TTL_MS };
}

/** 校验登录票据：格式、签名、过期三件事。 */
export function verifyToken(secret: string, token: string | undefined, now: number = Date.now()): TicketCheck {
	if (token === undefined || token.length === 0) return { ok: false, reason: "missing" };
	const parts = token.split(".");
	if (parts.length !== 3 || parts[0] !== "v1") return { ok: false, reason: "malformed" };
	const issuedAt = Number.parseInt(parts[1] ?? "", 10);
	if (!Number.isInteger(issuedAt) || issuedAt <= 0) return { ok: false, reason: "malformed" };
	if (!signatureMatches(sign(secret, `v1.${issuedAt}`), parts[2] ?? "")) {
		return { ok: false, reason: "signature" };
	}
	const expiresAt = issuedAt + TOKEN_TTL_MS;
	if (now >= expiresAt) return { ok: false, reason: "expired" };
	return { ok: true, expiresAt };
}

// —— 登录失败限速 ——

/** 按来源地址的滑动窗口计数（内存，进程重启清零）。 */
export class LoginThrottle {
	private readonly entries = new Map<string, { count: number; resetAt: number }>();
	/** 条目上限：超过就直接清空（防伪造来源把内存拉爆；清空只会短暂放松限速）。 */
	private static readonly MAX_ENTRIES = 4096;

	/** 距离可以重试还有多少毫秒；0 表示现在就能试。 */
	retryAfterMs(source: string, now: number = Date.now()): number {
		this.sweep(now);
		const entry = this.entries.get(source);
		if (entry === undefined) return 0;
		return entry.count >= LOGIN_FAILURE_LIMIT ? entry.resetAt - now : 0;
	}

	recordFailure(source: string, now: number = Date.now()): number {
		if (this.entries.size >= LoginThrottle.MAX_ENTRIES) this.entries.clear();
		const entry = this.entries.get(source);
		if (entry === undefined) {
			this.entries.set(source, { count: 1, resetAt: now + LOGIN_FAILURE_WINDOW_MS });
			return 1;
		}
		entry.count += 1;
		return entry.count;
	}

	reset(source: string): void {
		this.entries.delete(source);
	}

	/** 清掉已过窗口的条目（否者 Map 只在同一个来源再次尝试时才回收）。 */
	private sweep(now: number): void {
		for (const [source, entry] of this.entries) {
			if (now >= entry.resetAt) this.entries.delete(source);
		}
	}
}

// —— 来源与协议：信任模型 ——
//
// `X-Forwarded-For` / `X-Forwarded-Proto` 只有直连方是**可信反向代理**时才看：
// 不可信来源随手伪造就能绕过登录限速、伪装 HTTPS。可信名单由 `STELLA_TRUSTED_PROXY`
// 给出（默认只有回环）。

/** 去掉 IPv6 的 zone id，并把 IPv4-mapped 地址归一成 IPv4。 */
function normalizeAddress(address: string): string {
	const lowered = address.trim().toLowerCase();
	const zone = lowered.indexOf("%");
	const bare = zone >= 0 ? lowered.slice(0, zone) : lowered;
	if (bare.startsWith("::ffff:")) {
		const mapped = bare.slice("::ffff:".length);
		if (mapped.includes(".")) return mapped;
	}
	return bare;
}

function ipv4ToInt(ip: string): number | undefined {
	const parts = ip.split(".");
	if (parts.length !== 4) return undefined;
	let value = 0;
	for (const part of parts) {
		if (!/^\d{1,3}$/.test(part)) return undefined;
		const octet = Number(part);
		if (octet > 255) return undefined;
		value = value * 256 + octet;
	}
	return value >>> 0;
}

/** IPv4 地址是否落在 CIDR 内（`base/bits`）。非 IPv4 或写法非法时 false。 */
function ipv4InCidr(address: string, rule: string): boolean {
	const slash = rule.indexOf("/");
	if (slash <= 0) return false;
	const base = rule.slice(0, slash);
	const bits = Number.parseInt(rule.slice(slash + 1), 10);
	if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;
	const candidate = ipv4ToInt(address);
	const network = ipv4ToInt(base);
	if (candidate === undefined || network === undefined) return false;
	if (bits === 0) return true;
	const mask = (0xffffffff << (32 - bits)) >>> 0;
	return (candidate & mask) === (network & mask);
}

/**
 * 直连地址是否可信代理。支持精确 IP（IPv4/IPv6）与 IPv4 CIDR；
 * IPv6 只支持精确匹配（含 `/128`），不做 IPv6 CIDR 计算。
 */
export function isTrustedProxy(address: string | undefined, trusted: readonly string[]): boolean {
	if (address === undefined) return false;
	const candidate = normalizeAddress(address);
	for (const raw of trusted) {
		const rule = normalizeAddress(raw);
		if (rule.length === 0) continue;
		const slash = rule.indexOf("/");
		if (slash < 0) {
			if (rule === candidate) return true;
			continue;
		}
		// IPv6 的 `/128` 等价于精确匹配（其余 IPv6 前缀不支持，文档已标明）。
		if (rule.endsWith("/128") && normalizeAddress(rule.slice(0, -4)) === candidate) return true;
		if (ipv4InCidr(candidate, rule)) return true;
	}
	return false;
}

/**
 * 从直连地址与请求头解析客户端来源。
 *
 * 直连方不可信时只返回直连地址（头部一律忽略）；可信时取 `X-Forwarded-For` 的**最右一项**
 * ——它是最近一层代理追加的，单层反代下就是真实客户端地址。多层代理需自行保证层数与顺序。
 */
export function sourceFrom(
	peer: string | undefined,
	forwardedFor: string | undefined,
	trusted: readonly string[],
): string {
	const direct = peer ?? "local";
	if (!isTrustedProxy(peer, trusted)) return direct;
	const last = forwardedFor
		?.split(",")
		.map((part) => part.trim())
		.filter((part) => part.length > 0)
		.at(-1);
	return last ?? direct;
}

/**
 * 请求实际使用的协议（只有可信代理的 `X-Forwarded-Proto` 才算数）。
 * 多层代理取最左一项（原始客户端协议）。无法判断时 undefined。
 */
export function requestProto(
	peer: string | undefined,
	forwardedProto: string | undefined,
	trusted: readonly string[],
): "http" | "https" | undefined {
	if (!isTrustedProxy(peer, trusted)) return undefined;
	const value = forwardedProto?.split(",")[0]?.trim().toLowerCase();
	return value === "https" || value === "http" ? value : undefined;
}

/** 连接的直连地址（进程内调用没有 socket，返回 undefined）。 */
export function peerAddress(c: Context): string | undefined {
	try {
		return getConnInfo(c).remote.address;
	} catch {
		return undefined;
	}
}

/** 请求来源地址（限速与日志用）。 */
export function clientSource(c: Context, trusted: readonly string[]): string {
	return sourceFrom(peerAddress(c), c.req.header("x-forwarded-for"), trusted);
}

/** 请求实际协议：可信代理的 `X-Forwarded-Proto`；直连时 undefined。 */
export function connectionProto(c: Context, trusted: readonly string[]): "http" | "https" | undefined {
	return requestProto(peerAddress(c), c.req.header("x-forwarded-proto"), trusted);
}

// —— Hono 中间件 ——

export interface AuthGate {
	/** 登录密钥本身（只在服务端）；比较用 loginKeyMatches。 */
	readonly key: string;
	readonly middleware: MiddlewareHandler;
	readonly throttle: LoginThrottle;
}

export function bearerToken(c: Context): string | undefined {
	const header = c.req.header("authorization") ?? c.req.header("Authorization");
	if (header === undefined) return undefined;
	const match = /^bearer\s+(\S+)$/i.exec(header.trim());
	return match?.[1];
}

export function createAuthGate(key: string): AuthGate {
	const throttle = new LoginThrottle();

	const middleware: MiddlewareHandler = async (c, next) => {
		// 探针端点免鉴权。SSE 也走 Bearer（fetch 读流），不在这里开口子。
		if (c.req.path === "/api/health") return next();

		const checked = verifyToken(key, bearerToken(c));
		if (!checked.ok) {
			return c.json({ error: "需要登录：缺少或无效的登录凭证" }, 401);
		}
		return next();
	};

	return { key, middleware, throttle };
}
