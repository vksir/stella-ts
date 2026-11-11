/**
 * 节点总线单测（`src/store/node-bus.ts`）。
 *
 * **这个文件的来历**：节点的「订阅桶」曾经和「快照源」各记一份、互不连通，
 * 于是 `set()` 之后 React 收不到通知——流式文本一直不刷新（store 里已 500 字、
 * DOM 还是 0 字），工具行状态永远停在「排队中」，只有切换会话才偶然更新。
 * 而"历史 DOM 稳定性"测试反而通过了，因为压根没重渲。
 *
 * 所以这里锁死三件事：
 * 1. `set()` 必须触发该 key 的订阅者（桥接存在）；
 * 2. 只通知**对应 key**，不惊动其他 key（细粒度订阅的前提）；
 * 3. 快照引用不变时不通知（避免无意义重渲），空的订阅桶会从 Map 里清掉（不泄漏）。
 */

import { describe, expect, it, vi } from "vitest";
import { NodeBus, Source } from "../src/store/node-bus";

describe("Source", () => {
	it("引用不变不通知，引用变化才通知", () => {
		const source = new Source<{ n: number }>({ n: 1 });
		const listener = vi.fn();
		source.subscribe(listener);

		source.set(source.get()); // 同一引用
		expect(listener).not.toHaveBeenCalled();

		source.set({ n: 2 });
		expect(listener).toHaveBeenCalledTimes(1);
	});

	it("退订后不再收到通知", () => {
		const source = new Source<number>(0);
		const listener = vi.fn();
		const off = source.subscribe(listener);
		off();
		source.set(1);
		expect(listener).not.toHaveBeenCalled();
	});
});

describe("NodeBus", () => {
	it("set(key) 会通知该 key 的订阅者（桥接存在的回归测试）", () => {
		const bus = new NodeBus<{ text: string }>();
		const listener = vi.fn();
		bus.subscribe("streaming", listener);

		// 先创建源（模拟座位挂载时 read/get 过）
		expect(bus.get("streaming")).toBe(null);
		bus.set("streaming", { text: "第一段" });

		expect(listener).toHaveBeenCalledTimes(1);
		expect(bus.get("streaming")).toEqual({ text: "第一段" });
	});

	it("只通知对应 key，不惊动其他 key（细粒度订阅）", () => {
		const bus = new NodeBus<{ text: string }>();
		const a = vi.fn();
		const b = vi.fn();
		bus.subscribe("e:1", a);
		bus.subscribe("e:2", b);

		bus.set("e:1", { text: "A" });
		expect(a).toHaveBeenCalledTimes(1);
		expect(b).not.toHaveBeenCalled();
	});

	it("同一 key 的多个订阅者都收到（座位与诊断并存）", () => {
		const bus = new NodeBus<number>();
		const first = vi.fn();
		const second = vi.fn();
		bus.subscribe("k", first);
		bus.subscribe("k", second);
		bus.set("k", 1);
		expect(first).toHaveBeenCalledTimes(1);
		expect(second).toHaveBeenCalledTimes(1);
	});

	it("重复写入相同引用不触发通知（引用不变即跳过）", () => {
		const bus = new NodeBus<{ v: number }>();
		const listener = vi.fn();
		bus.subscribe("k", listener);
		const value = { v: 1 };
		bus.set("k", value);
		bus.set("k", value);
		expect(listener).toHaveBeenCalledTimes(1);
	});

	it("退订后订阅桶被清掉（长时间切换会话不残留空 Set）", () => {
		const bus = new NodeBus<number>();
		const off = bus.subscribe("k", () => undefined);
		expect(bus.size.buckets).toBe(1);
		off();
		expect(bus.size.buckets).toBe(0);
	});

	it("clear() 丢弃全部源与订阅桶（切换会话）", () => {
		const bus = new NodeBus<number>();
		bus.subscribe("a", () => undefined);
		bus.set("a", 1);
		bus.set("b", 2);
		expect(bus.size.sources).toBe(2);

		bus.clear();
		expect(bus.size).toEqual({ sources: 0, buckets: 0 });
		expect(bus.get("a")).toBe(null);
	});

	it("clear() 之后重新订阅仍能收到通知（座位重挂）", () => {
		const bus = new NodeBus<number>();
		bus.set("k", 1);
		bus.clear();
		const listener = vi.fn();
		bus.subscribe("k", listener);
		bus.set("k", 2);
		expect(listener).toHaveBeenCalledTimes(1);
		expect(bus.get("k")).toBe(2);
	});

	it("订阅先于取值也要收到通知（座位尚未渲染时先 set）", () => {
		const bus = new NodeBus<string>();
		const listener = vi.fn();
		// 不先 get()，直接订阅再 set：桥接必须在 source() 创建时建立
		bus.subscribe("k", listener);
		bus.set("k", "v");
		expect(listener).toHaveBeenCalledTimes(1);
	});
});
