/**
 * 准入测试：登录密钥、票据、限速、SSE 鉴权。
 *
 * 用 faux provider + MemoryStorage 起进程内 app（零网络零 key），
 * 与 smoke.test.ts 相同的装法，只是配置里多一枚 STELLA_TOKEN。
 */
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";
import { createApp } from "../src/api.js";
import { loadConfig, isLoopbackHost, type StellaConfig } from "../src/config.js";
import { createStella, type Stella } from "../src/stella.js";
import {
	LOGIN_FAILURE_LIMIT,
	MIN_LOGIN_KEY_LENGTH,
	TOKEN_TTL_MS,
	assertDeploymentSafety,
	assertLoginKeyStrength,
	issueToken,
	loginKeyMatches,
	resolveLoginKey,
	verifyToken,
} from "../src/auth.js";

const KEY = "test-login-key-0123456789abcdefghijklmnopqrstuvwxyz";
const ANSWER = "这是登录之后才看得到的回答。";

describe("准入：登录密钥与票据", () => {
	let stella: Stella;
	let dir: string;
	let app: Hono;
	let token: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "stella-auth-"));
		const base = loadConfig({ STELLA_FAUX: "1", STELLA_DATA_DIR: dir });
		stella = await createStella({ ...base, token: KEY }, {});
		stella.faux?.setResponses([fauxAssistantMessage(ANSWER)]);
		app = createApp(stella);

		const login = await app.request("/api/auth/login", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ key: KEY }),
		});
		expect(login.status).toBe(200);
		token = ((await login.json()) as { token: string }).token;
	});

	afterEach(async () => {
		await stella.close();
		await rm(dir, { recursive: true, force: true });
	});

	const bearer = (): Record<string, string> => ({ authorization: `Bearer ${token}` });

	it("未登录访问 API 一律 401", async () => {
		const response = await app.request("/api/conversations");
		expect(response.status).toBe(401);
		expect(((await response.json()) as { error: string }).error).toMatch(/需要登录/);
	});

	it("/api/health 与 /api/auth/status 免鉴权", async () => {
		expect((await app.request("/api/health")).status).toBe(200);

		const anonymous = await app.request("/api/auth/status");
		expect(anonymous.status).toBe(200);
		expect(await anonymous.json()).toEqual({ authRequired: true, ok: false });

		const signed = await app.request("/api/auth/status", { headers: bearer() });
		const status = (await signed.json()) as { authRequired: boolean; ok: boolean; expiresAt: number };
		expect(status.authRequired).toBe(true);
		expect(status.ok).toBe(true);
		expect(status.expiresAt).toBeGreaterThan(Date.now());
	});

	it("错误密钥 401 且文案不泄露细节；正确密钥签发票据", async () => {
		const wrong = await app.request("/api/auth/login", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ key: "nope" }),
		});
		expect(wrong.status).toBe(401);
		expect(((await wrong.json()) as { error: string }).error).toBe("登录密钥不正确");

		const empty = await app.request("/api/auth/login", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ key: "   " }),
		});
		expect(empty.status).toBe(400);

		expect(token).toMatch(/^v1\.\d+\.[A-Za-z0-9_-]+$/);
	});

	it("带票据可用；篡改签名被拒", async () => {
		const ok = await app.request("/api/conversations", { headers: bearer() });
		expect(ok.status).toBe(200);

		const lastChar = token.at(-1) === "A" ? "B" : "A";
		const tampered = `${token.slice(0, -1)}${lastChar}`;
		const denied = await app.request("/api/conversations", { headers: { authorization: `Bearer ${tampered}` } });
		expect(denied.status).toBe(401);

		const garbage = await app.request("/api/conversations", { headers: { authorization: "Bearer v9.1.abc" } });
		expect(garbage.status).toBe(401);
	});

	it("票据 30 天固定过期，轮换登录密钥即全员失效", () => {
		const issued = issueToken(KEY);
		expect(issued.expiresAt - Date.now()).toBeLessThanOrEqual(TOKEN_TTL_MS);

		expect(verifyToken(KEY, issued.token).ok).toBe(true);
		expect(verifyToken(KEY, issued.token, issued.expiresAt)).toEqual({ ok: false, reason: "expired" });
		expect(verifyToken("rotated-key", issued.token)).toEqual({ ok: false, reason: "signature" });
		expect(verifyToken(KEY, undefined)).toEqual({ ok: false, reason: "missing" });
		expect(verifyToken(KEY, "v1.abc")).toEqual({ ok: false, reason: "malformed" });
	});

	it(`同一来源连错 ${LOGIN_FAILURE_LIMIT} 次后限速 429`, async () => {
		// beforeEach 里的一次成功登录会把计数清零；这里连续失败。
		const attempt = async (): Promise<Response> =>
			app.request("/api/auth/login", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ key: "wrong" }),
			});

		for (let i = 0; i < LOGIN_FAILURE_LIMIT; i += 1) {
			expect((await attempt()).status).toBe(401);
		}
		const limited = await attempt();
		expect(limited.status).toBe(429);
		expect(limited.headers.get("retry-after")).toMatch(/^\d+$/);
	});

	it("SSE 无凭据 401，带 Bearer 可订阅", async () => {		const denied = await app.request("/api/conversations/1/events");
		expect(denied.status).toBe(401);

		const created = await app.request("/api/conversations", { method: "POST", headers: bearer() });
		const { id } = (await created.json()) as { id: number };

		const response = await app.request(`/api/conversations/${id}/events`, { headers: bearer() });
		expect(response.status).toBe(200);
		// 反向代理（nginx）默认缓冲；应用必须显式告诉它别缓。
		expect(response.headers.get("x-accel-buffering")).toBe("no");
		const frames = await readFrames(response);
		expect(frames[0]?.event).toBe("view");
		expect((JSON.parse(frames[0]!.data) as { conversation: { id: number } }).conversation.id).toBe(id);
	});

	it("URL 里的凭据不被接受（SSE 也只看 Bearer）", async () => {
		const created = await app.request("/api/conversations", { method: "POST", headers: bearer() });
		const { id } = (await created.json()) as { id: number };

		const viaQuery = await app.request(`/api/conversations/${id}/events?token=${token}`);
		expect(viaQuery.status).toBe(401);
		expect((await app.request(`/api/conversations/${id}/events?ticket=bogus`)).status).toBe(401);
	});

	it("faux 模式未配密钥：不启用登录，接口直接可用", async () => {
		const anonymous = await createApp(
			await createStella(loadConfig({ STELLA_FAUX: "1", STELLA_DATA_DIR: dir }), {}),
		);
		const status = (await (await anonymous.request("/api/auth/status")).json()) as { authRequired: boolean };
		expect(status.authRequired).toBe(false);
		expect((await anonymous.request("/api/conversations")).status).toBe(200);
		// 登录接口在免登录模式下也不发凭据
		const login = await anonymous.request("/api/auth/login", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ key: "anything" }),
		});
		expect(login.status).toBe(200);
		expect(((await login.json()) as { authRequired: boolean }).authRequired).toBe(false);
	});
});

describe("登录密钥来源", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "stella-token-"));
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("显式配置直接用；faux 模式不启用", () => {
		expect(resolveLoginKey({ STELLA_TOKEN: KEY }, { faux: false }).key).toBe(KEY);
		expect(resolveLoginKey({}, { faux: true }).key).toBeUndefined();
	});

	it("首次部署生成并写入已存在的 .env", async () => {
		const nested = join(dir, "repo");
		await mkdir(nested);
		const envPath = join(nested, ".env");
		await writeFile(envPath, "STELLA_PORT=7090\n", "utf8");

		const resolved = resolveLoginKey({}, { faux: false, cwd: nested });
		expect(resolved.key).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(resolved.generated).toBe(resolved.key);
		expect(resolved.envPath).toBe(envPath);

		const text = await readFile(envPath, "utf8");
		expect(text).toContain("STELLA_PORT=7090");
		expect(text).toContain(`STELLA_TOKEN=${resolved.key}`);
	});

	it("找不到可写的 .env 时给出可行动的中文报错", () => {
		expect(() => resolveLoginKey({}, { faux: false, cwd: dir })).toThrow(/token:gen/);
	});

	it("只向 workspace 根的 .env 回退（普通父目录不碰）", async () => {
		const repo = join(dir, "repo");
		const nested = join(repo, "server");
		await mkdir(nested, { recursive: true });
		await writeFile(join(repo, "package.json"), '{"name":"repo"}\n', "utf8");
		await writeFile(join(repo, ".env"), "STELLA_PORT=7090\n", "utf8");

		// cwd 没有 .env，但上级是 workspace 根 → 写仓库根那个
		const resolved = resolveLoginKey({}, { faux: false, cwd: nested });
		expect(resolved.envPath).toBe(join(repo, ".env"));
		expect(await readFile(join(repo, ".env"), "utf8")).toContain(`STELLA_TOKEN=${resolved.key}`);

		// 上级没有 package.json → 不把它当仓库根
		const orphan = join(dir, "orphan");
		await mkdir(orphan, { recursive: true });
		await writeFile(join(dir, ".env"), "\n", "utf8");
		expect(() => resolveLoginKey({}, { faux: false, cwd: orphan })).toThrow(/token:gen/);
	});

	it("密钥比较不看长度（定长哈希后比）", () => {
		expect(loginKeyMatches(KEY, KEY)).toBe(true);
		expect(loginKeyMatches(KEY, `${KEY}x`)).toBe(false);
		expect(loginKeyMatches(KEY, KEY.slice(0, -1))).toBe(false);
	});
});

describe("部署安全断言", () => {
	// 不访问磁盘：loadConfig 只做路径解析；这里只测纯函数。
	const base = loadConfig({ STELLA_FAUX: "1", STELLA_DATA_DIR: "stella-config-test" });
	const config = (patch: Partial<StellaConfig>): StellaConfig => ({ ...base, ...patch });

	it("回环地址判定", () => {
		for (const host of ["127.0.0.1", "127.0.0.2", "localhost", "::1", "[::1]", "::ffff:127.0.0.1"]) {
			expect(isLoopbackHost(host), host).toBe(true);
		}
		for (const host of ["0.0.0.0", "::", "192.168.1.10", "stella.example.com"]) {
			expect(isLoopbackHost(host), host).toBe(false);
		}
	});

	it("弱密钥直接拒绝", () => {
		expect(() => assertLoginKeyStrength("short")).toThrow(/至少 32/);
		expect(() => assertLoginKeyStrength(KEY)).not.toThrow();
		expect(KEY.length).toBeGreaterThanOrEqual(MIN_LOGIN_KEY_LENGTH);
	});

	it("faux + 非回环 + 无密钥拒绝启动", () => {
		expect(() => assertDeploymentSafety(config({ host: "0.0.0.0" }))).toThrow(/没有启用登录密钥/);
		// 回环上的 faux（测试/本地体验）仍然允许
		expect(() => assertDeploymentSafety(config({ host: "127.0.0.1" }))).not.toThrow();
	});

	it("非回环 + 未显式配置 HTTPS 拒绝启动", () => {
		expect(() => assertDeploymentSafety(config({ host: "0.0.0.0", token: KEY }))).toThrow(
			/STELLA_REQUIRE_HTTPS/,
		);
	});

	it("可信代理不能是 0.0.0.0/0（否则 XFF/XFP 可伪造）", () => {
		expect(() =>
			assertDeploymentSafety(
				config({ host: "127.0.0.1", token: KEY, trustedProxies: ["0.0.0.0/0"] }),
			),
		).toThrow(/0\.0\.0\.0\/0/);
	});

	it("显式关闭 HTTPS（局域网自担风险）时放行", () => {
		expect(() =>
			assertDeploymentSafety(
				config({ host: "0.0.0.0", token: KEY, httpsConfigured: true, httpsRequired: false }),
			),
		).not.toThrow();
	});

	it("非回环 + HTTPS + 强密钥放行", () => {
		expect(() =>
			assertDeploymentSafety(
				config({ host: "0.0.0.0", token: KEY, httpsConfigured: true, httpsRequired: true }),
			),
		).not.toThrow();
	});

	it("只有显式 1/0/true/false 才算配置过 HTTPS", () => {
		expect(loadConfig({}).httpsConfigured).toBe(false);
		expect(loadConfig({ STELLA_REQUIRE_HTTPS: "0" })).toMatchObject({
			httpsRequired: false,
			httpsConfigured: true,
		});
		expect(loadConfig({ STELLA_REQUIRE_HTTPS: "true" })).toMatchObject({
			httpsRequired: true,
			httpsConfigured: true,
		});
		// on/yes 等未知值按“未配置”处理，避免被当成知情关闭
		expect(loadConfig({ STELLA_REQUIRE_HTTPS: "yes" })).toMatchObject({
			httpsRequired: false,
			httpsConfigured: false,
		});
	});
});

interface Frame {
	readonly event: string;
	readonly data: string;
}

/** 读前若干帧（读到 view 就够，不必等流结束）。 */
async function readFrames(response: Response, limit = 1): Promise<Frame[]> {
	const reader = response.body!.getReader();
	const decoder = new TextDecoder();
	const frames: Frame[] = [];
	let buffer = "";
	try {
		while (frames.length < limit) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			for (;;) {
				const boundary = buffer.indexOf("\n\n");
				if (boundary < 0) break;
				const raw = buffer.slice(0, boundary);
				buffer = buffer.slice(boundary + 2);
				const event = /^event: (.*)$/m.exec(raw)?.[1] ?? "message";
				const data = /^data: (.*)$/m.exec(raw)?.[1] ?? "";
				frames.push({ event, data });
			}
		}
	} finally {
		void reader.cancel().catch(() => undefined);
	}
	return frames;
}
