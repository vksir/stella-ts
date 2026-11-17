/**
 * 公网入口：请求体上限、HTTPS 感知、可信代理下的登录限速。
 *
 * 用 faux provider + MemoryStorage 起进程内 app，并通过 Hono `app.request` 的
 * 第三参数注入 `c.env.incoming.socket`，模拟真实 socket 的直连地址
 * （@hono/node-server 的 getConnInfo 从这里读 remoteAddress）。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";
import { createApp } from "../src/api.js";
import { loadConfig } from "../src/config.js";
import { createStella, type Stella } from "../src/stella.js";
import { LOGIN_FAILURE_LIMIT } from "../src/auth.js";

const KEY = "test-login-key-0123456789abcdefghijklmnopqrstuvwxyz";

/** 模拟 node-server 的 c.env：getConnInfo 读 incoming.socket.remoteAddress。 */
const peer = (address: string): Record<string, unknown> => ({
	incoming: { socket: { remoteAddress: address, remotePort: 443, remoteFamily: "IPv4" } },
});

interface Harness {
	readonly app: Hono;
	readonly stella: Stella;
	readonly dir: string;
}

async function startApp(env: Record<string, string>): Promise<Harness> {
	const dir = await mkdtemp(join(tmpdir(), "stella-ingress-"));
	const base = loadConfig({ STELLA_FAUX: "1", STELLA_DATA_DIR: dir, ...env });
	const stella = await createStella({ ...base, token: KEY }, {});
	return { app: createApp(stella), stella, dir };
}

async function login(
	app: Hono,
	options: { readonly key?: string; readonly body?: string; readonly headers?: Record<string, string> } = {},
	address = "203.0.113.7",
): Promise<Response> {
	return await app.request(
		"/api/auth/login",
		{
			method: "POST",
			headers: { "content-type": "application/json", ...options.headers },
			body: options.body ?? JSON.stringify({ key: options.key ?? KEY }),
		},
		peer(address),
	);
}

describe("请求体上限", () => {
	let harness: Harness;

	beforeEach(async () => {
		harness = await startApp({});
	});

	afterEach(async () => {
		await harness.stella.close();
		await rm(harness.dir, { recursive: true, force: true });
	});

	it("登录请求体超过 4KB 时 413（不进入 JSON 解析）", async () => {
		const response = await login(harness.app, { body: JSON.stringify({ key: "x".repeat(8 * 1024) }) });
		expect(response.status).toBe(413);
		expect(((await response.json()) as { error: string }).error).toMatch(/过大/);
	});

	it("正常大小的登录请求不受影响", async () => {
		expect((await login(harness.app)).status).toBe(200);
	});
});

describe("HTTPS 感知", () => {
	let harness: Harness;

	beforeEach(async () => {
		harness = await startApp({ STELLA_TRUSTED_PROXY: "10.0.0.0/8", STELLA_REQUIRE_HTTPS: "1" });
	});

	afterEach(async () => {
		await harness.stella.close();
		await rm(harness.dir, { recursive: true, force: true });
	});

	it("可信反代标为 http 时拒绝登录（密钥不能明文过网）", async () => {
		const response = await login(
			harness.app,
			{ headers: { "x-forwarded-proto": "http" } },
			"10.1.2.3",
		);
		expect(response.status).toBe(400);
		expect(((await response.json()) as { error: string }).error).toMatch(/HTTPS/);
	});

	it("反代没给 X-Forwarded-Proto 时也拒绝（REQUIRE_HTTPS=1）", async () => {
		expect((await login(harness.app, {}, "10.1.2.3")).status).toBe(400);
	});

	it("可信反代给出 https 时放行", async () => {
		const response = await login(harness.app, { headers: { "x-forwarded-proto": "https" } }, "10.1.2.3");
		expect(response.status).toBe(200);
		expect(((await response.json()) as { token: string }).token).toMatch(/^v1\./);
	});

	it("不可信来源伪造 X-Forwarded-Proto: https 不算数", async () => {
		const response = await login(
			harness.app,
			{ headers: { "x-forwarded-proto": "https" } },
			"203.0.113.7",
		);
		expect(response.status).toBe(400);
	});

	it("登录后的普通 API 也要求 HTTPS，而不是只保护登录", async () => {
		const logged = await login(harness.app, { headers: { "x-forwarded-proto": "https" } }, "10.1.2.3");
		expect(logged.status).toBe(200);
		const { token } = (await logged.json()) as { token: string };
		const auth = { authorization: `Bearer ${token}` };

		// 可信反代没有给出 X-Forwarded-Proto（或直连）：拒绝
		const missing = await harness.app.request("/api/conversations", { headers: auth }, peer("10.1.2.3"));
		expect(missing.status).toBe(400);

		// 反代明确给出 http：拒绝
		const overHttp = await harness.app.request(
			"/api/conversations",
			{ headers: { ...auth, "x-forwarded-proto": "http" } },
			peer("10.1.2.3"),
		);
		expect(overHttp.status).toBe(400);

		// 不可信来源伪造 https：拒绝
		const forged = await harness.app.request(
			"/api/conversations",
			{ headers: { ...auth, "x-forwarded-proto": "https" } },
			peer("203.0.113.7"),
		);
		expect(forged.status).toBe(400);

		// 可信反代 + https：放行
		const ok = await harness.app.request(
			"/api/conversations",
			{ headers: { ...auth, "x-forwarded-proto": "https" } },
			peer("10.1.2.3"),
		);
		expect(ok.status).toBe(200);
	});

	it("健康探针不需要 HTTPS（负载均衡器可继续用）", async () => {
		const response = await harness.app.request("/api/health", {}, peer("203.0.113.7"));
		expect(response.status).toBe(200);
	});

	it("未开启 REQUIRE_HTTPS 时，反代明确标为 http 的 API 仍被拒", async () => {
		const other = await startApp({ STELLA_TRUSTED_PROXY: "10.0.0.0/8", STELLA_REQUIRE_HTTPS: "0" });
		try {
			const logged = await login(other.app, { headers: { "x-forwarded-proto": "https" } }, "10.1.2.3");
			const { token } = (await logged.json()) as { token: string };
			const response = await other.app.request(
				"/api/conversations",
				{ headers: { authorization: `Bearer ${token}`, "x-forwarded-proto": "http" } },
				peer("10.1.2.3"),
			);
			expect(response.status).toBe(400);
		} finally {
			await other.stella.close();
			await rm(other.dir, { recursive: true, force: true });
		}
	});
});

describe("登录限速按代理后的真实来源", () => {
	let harness: Harness;

	beforeEach(async () => {
		harness = await startApp({ STELLA_TRUSTED_PROXY: "10.0.0.0/8" });
	});

	afterEach(async () => {
		await harness.stella.close();
		await rm(harness.dir, { recursive: true, force: true });
	});

	const wrong = (address: string, forwardedFor?: string): Promise<Response> =>
		login(
			harness.app,
			{
				key: "wrong",
				headers: forwardedFor === undefined ? {} : { "x-forwarded-for": forwardedFor },
			},
			address,
		);

	it("同一 XFF 来源连错后限速；换一个 XFF 来源不受影响", async () => {
		for (let i = 0; i < LOGIN_FAILURE_LIMIT; i += 1) {
			expect((await wrong("10.0.0.1", "1.1.1.1")).status).toBe(401);
		}
		expect((await wrong("10.0.0.1", "1.1.1.1")).status).toBe(429);
		// 另一个客户端（不同 XFF）用同一个反代地址，仍有自己的计数
		expect((await wrong("10.0.0.1", "2.2.2.2")).status).toBe(401);
	});

	it("不可信来源的 XFF 被忽略：所有人共用直连地址的桶", async () => {
		for (let i = 0; i < LOGIN_FAILURE_LIMIT; i += 1) {
			expect((await wrong("203.0.113.7", `9.9.9.${i}`)).status).toBe(401);
		}
		expect((await wrong("203.0.113.7", "8.8.8.8")).status).toBe(429);
	});
});
