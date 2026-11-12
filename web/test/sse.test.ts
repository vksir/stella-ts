/**
 * SSE 帧解析单测（`src/sse.ts` 的纯函数部分）。
 *
 * 服务端只发 `event: view|ping` + 单行 JSON，但网络分块是任意的：
 * 一帧可能拆成多个块、多帧可能挤在一个块里，换行可能是 CRLF。
 */
import { describe, expect, it } from "vitest";
import { createSseDecoder } from "../src/sse";

describe("SSE 帧解析", () => {
	it("解析单帧", () => {
		const decode = createSseDecoder();
		expect(decode('event: view\ndata: {"a":1}\n\n')).toEqual([{ event: "view", data: '{"a":1}' }]);
	});

	it("一个块里的多个帧按顺序产出", () => {
		const decode = createSseDecoder();
		expect(decode("event: ping\ndata: 1\n\nevent: view\ndata: {}\n\n")).toEqual([
			{ event: "ping", data: "1" },
			{ event: "view", data: "{}" },
		]);
	});

	it("帧跨块到达时等齐再产出", () => {
		const decode = createSseDecoder();
		expect(decode('event: view\ndata: {"conv')).toEqual([]);
		expect(decode('ersation":{"id":7}}\n')).toEqual([]);
		expect(decode("\n")).toEqual([{ event: "view", data: '{"conversation":{"id":7}}' }]);
	});

	it("CRLF 换行同样识别", () => {
		const decode = createSseDecoder();
		expect(decode("event: ping\r\ndata: 1\r\n\r\n")).toEqual([{ event: "ping", data: "1" }]);
	});

	it("data 里的冒号与空格原样保留", () => {
		const decode = createSseDecoder();
		expect(decode('event: view\ndata: {"text":"a: b"}\n\n')).toEqual([
			{ event: "view", data: '{"text":"a: b"}' },
		]);
	});

	it("注释行与空帧被忽略", () => {
		const decode = createSseDecoder();
		expect(decode(": keep-alive\n\n\nevent: ping\ndata: 1\n\n")).toEqual([{ event: "ping", data: "1" }]);
	});

	it("多行 data 用换行拼接", () => {
		const decode = createSseDecoder();
		expect(decode("event: view\ndata: line1\ndata: line2\n\n")).toEqual([{ event: "view", data: "line1\nline2" }]);
	});

	it("不完整的尾巴留在缓冲里，不丢字节", () => {
		const decode = createSseDecoder();
		expect(decode("event: view\ndata: {}\n")).toEqual([]);
		expect(decode("\n")).toEqual([{ event: "view", data: "{}" }]);
		expect(decode("event: ping\ndata: 1\n\n")).toEqual([{ event: "ping", data: "1" }]);
	});
});
