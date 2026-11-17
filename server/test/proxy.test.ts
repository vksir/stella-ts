/**
 * 可信反向代理：来源地址与协议的信任模型（纯函数）。
 *
 * 规则：只有直连方在 `STELLA_TRUSTED_PROXY` 名单（IP 或 IPv4 CIDR）内，
 * 才读 `X-Forwarded-For` / `X-Forwarded-Proto`；否则头部一律当伪造忽略。
 */
import { describe, expect, it } from "vitest";
import { isTrustedProxy, requestProto, sourceFrom } from "../src/auth.js";

describe("可信代理判断", () => {
	it("精确 IP、IPv4 CIDR 与 IPv4-mapped IPv6", () => {
		expect(isTrustedProxy("127.0.0.1", ["127.0.0.1"])).toBe(true);
		expect(isTrustedProxy("::1", ["::1"])).toBe(true);
		expect(isTrustedProxy("::ffff:127.0.0.1", ["127.0.0.1"])).toBe(true);
		expect(isTrustedProxy("172.18.0.5", ["172.16.0.0/12"])).toBe(true);
		expect(isTrustedProxy("172.32.0.5", ["172.16.0.0/12"])).toBe(false);
		expect(isTrustedProxy("10.1.2.3", ["10.0.0.0/8", "127.0.0.1"])).toBe(true);
		expect(isTrustedProxy(undefined, ["127.0.0.1"])).toBe(false);
		expect(isTrustedProxy("203.0.113.9", ["127.0.0.1"])).toBe(false);
	});

	it("IPv6 只支持精确匹配与 /128", () => {
		expect(isTrustedProxy("2001:db8::1", ["2001:db8::1"])).toBe(true);
		expect(isTrustedProxy("2001:db8::1", ["2001:db8::1/128"])).toBe(true);
		expect(isTrustedProxy("2001:db8::2", ["2001:db8::1/128"])).toBe(false);
	});

	it("非法规则与边界不误判", () => {
		expect(isTrustedProxy("127.0.0.1", [""])).toBe(false);
		expect(isTrustedProxy("127.0.0.1", ["127.0.0.0/33"])).toBe(false);
		expect(isTrustedProxy("127.0.0.1", ["127.0.0.0/0"])).toBe(true);
		expect(isTrustedProxy("1.2.3.4", ["nope/8"])).toBe(false);
		// zone id 不影响匹配
		expect(isTrustedProxy("fe80::1%eth0", ["fe80::1"])).toBe(true);
	});
});

describe("来源地址与协议", () => {
	it("不可信来源忽略 X-Forwarded-*", () => {
		expect(sourceFrom("203.0.113.9", "1.1.1.1", ["127.0.0.1"])).toBe("203.0.113.9");
		expect(requestProto("203.0.113.9", "https", ["127.0.0.1"])).toBeUndefined();
	});

	it("可信来源取 X-Forwarded-For 最右一项", () => {
		expect(sourceFrom("127.0.0.1", "1.1.1.1, 203.0.113.9", ["127.0.0.1"])).toBe("203.0.113.9");
		expect(sourceFrom("127.0.0.1", undefined, ["127.0.0.1"])).toBe("127.0.0.1");
		expect(sourceFrom("127.0.0.1", " , ", ["127.0.0.1"])).toBe("127.0.0.1");
	});

	it("可信来源的 X-Forwarded-Proto 取最左一项，非法值不认", () => {
		expect(requestProto("127.0.0.1", "https, http", ["127.0.0.1"])).toBe("https");
		expect(requestProto("127.0.0.1", "http", ["127.0.0.1"])).toBe("http");
		expect(requestProto("127.0.0.1", "gopher", ["127.0.0.1"])).toBeUndefined();
		expect(requestProto("127.0.0.1", undefined, ["127.0.0.1"])).toBeUndefined();
	});
});
