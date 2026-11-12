/**
 * 准入客户端单测（`src/auth.ts`）：票据存取、过期清理、401 回调。
 * 与 theme.test.ts 一样，先装一个最小 localStorage 桩（测试环境没有 DOM）。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	authHeaders,
	clearCredential,
	notifyUnauthorized,
	readCredential,
	setUnauthorizedHandler,
	writeCredential,
} from "../src/auth";

const KEY = "stella-auth";

function installStorage(initial: Record<string, string> = {}): Map<string, string> {
	const map = new Map(Object.entries(initial));
	(globalThis as unknown as { localStorage: Storage }).localStorage = {
		getItem: (k: string) => map.get(k) ?? null,
		setItem: (k: string, v: string) => void map.set(k, v),
		removeItem: (k: string) => void map.delete(k),
		clear: () => map.clear(),
		key: () => null,
		length: 0,
	} as Storage;
	return map;
}

describe("登录票据的本地存储", () => {
	let map: Map<string, string>;

	beforeEach(() => {
		map = installStorage();
	});

	afterEach(() => {
		setUnauthorizedHandler(undefined);
	});

	it("写入后可读回，并转成 Bearer 头", () => {
		const expiresAt = Date.now() + 60_000;
		writeCredential({ token: "v1.1.sig", expiresAt });
		expect(readCredential()).toEqual({ token: "v1.1.sig", expiresAt });
		expect(authHeaders()).toEqual({ authorization: "Bearer v1.1.sig" });
		expect(map.get(KEY)).toContain("v1.1.sig");
	});

	it("没有票据时请求头为空", () => {
		expect(readCredential()).toBeUndefined();
		expect(authHeaders()).toBeUndefined();
	});

	it("已过期的票据被读取时清掉", () => {
		writeCredential({ token: "v1.1.sig", expiresAt: Date.now() - 1 });
		expect(readCredential()).toBeUndefined();
		expect(map.has(KEY)).toBe(false);
	});

	it("损坏的 JSON 当作没有票据", () => {
		map.set(KEY, "{not json");
		expect(readCredential()).toBeUndefined();
		map.set(KEY, JSON.stringify({ token: "", expiresAt: Date.now() + 1000 }));
		expect(readCredential()).toBeUndefined();
	});

	it("清除后不再带头", () => {
		writeCredential({ token: "v1.1.sig", expiresAt: Date.now() + 60_000 });
		clearCredential();
		expect(readCredential()).toBeUndefined();
		expect(authHeaders()).toBeUndefined();
	});

	it("401 回调只通知已注册的处理者", () => {
		let calls = 0;
		setUnauthorizedHandler(() => {
			calls += 1;
		});
		notifyUnauthorized();
		expect(calls).toBe(1);
		setUnauthorizedHandler(undefined);
		notifyUnauthorized();
		expect(calls).toBe(1);
	});
});
