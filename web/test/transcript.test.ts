/**
 * 转写窗口合并单测（`src/store/transcript.ts`）。
 *
 * 这里是"客户端看到的历史是否连续"的唯一守门人：SSE 给的是窗口不是全量，
 * 条目 ID 还有空洞，所以缺口必须显式记成 `gap` 而不是硬拼。三条容易写错的语义：
 * 1. `view.before > newest` → 中间缺失，记 gap（不能直接追加）；
 * 2. 窗口与已见重叠 → 只追加更新条目（已见条目引用复用，避免整列表重渲）；
 * 3. `fillGap` 一页填不完 → 缺口收缩为剩余段（不是一次填完就丢）。
 */

import { describe, expect, it } from "vitest";
import { Transcript, type TranscriptPage } from "../src/store/transcript";

interface Entry {
	readonly id: number;
	readonly text: string;
}

const e = (id: number): Entry => ({ id, text: `e${id}` });

/** 可编排的加载器：记录调用参数，按序返回预设页。 */
function loader(pages: { before?: TranscriptPage<Entry>[]; between?: TranscriptPage<Entry>[] } = {}) {
	const calls = { before: [] as number[], between: [] as [number, number][] };
	const beforeQueue = [...(pages.before ?? [])];
	const betweenQueue = [...(pages.between ?? [])];
	return {
		calls,
		before: async (oldestId: number) => {
			calls.before.push(oldestId);
			return beforeQueue.shift() ?? { entries: [], hasMore: false };
		},
		between: async (afterId: number, upToId: number) => {
			calls.between.push([afterId, upToId]);
			return betweenQueue.shift() ?? { entries: [], hasMore: false };
		},
	};
}

describe("转写窗口合并", () => {
	it("首次并入：窗口整体成为转写，before 决定是否还有更早", () => {
		const t = new Transcript<Entry>(loader());
		t.merge({ entries: [e(10), e(11)], before: 9 });
		expect(t.items.map((i) => (i.kind === "entry" ? i.entry.id : "gap"))).toEqual([10, 11]);
		expect(t.newest).toBe(11);
		expect(t.hasEarlier).toBe(true);

		const noBefore = new Transcript<Entry>(loader());
		noBefore.merge({ entries: [e(1)] });
		expect(noBefore.hasEarlier).toBe(false);
	});

	it("窗口与已见条目重叠：只追加更新条目，已见条目引用复用", () => {
		const t = new Transcript<Entry>(loader());
		const first = e(10);
		t.merge({ entries: [first, e(11)], before: 9 });
		const beforeItems = t.items;
		t.merge({ entries: [e(10), e(11), e(12)], before: 9 });

		const ids = t.items.map((i) => (i.kind === "entry" ? i.entry.id : "gap"));
		expect(ids).toEqual([10, 11, 12]);
		expect(t.newest).toBe(12);
		// 已见的两条沿用原对象（不重建 → React 不会重渲这两行）
		const kept = t.items[0];
		const prev = beforeItems[0];
		expect(kept?.kind === "entry" && prev?.kind === "entry" ? kept.entry : undefined).toBe(
			prev?.kind === "entry" ? prev.entry : undefined,
		);
	});

	it("窗口完全重复：不产生任何变化", () => {
		const t = new Transcript<Entry>(loader());
		t.merge({ entries: [e(10), e(11)], before: 9 });
		const snapshot = t.items;
		t.merge({ entries: [e(10), e(11)], before: 9 });
		expect(t.items).toBe(snapshot); // 引用不变
	});

	it("窗口不接续（断线期间新增超过窗口）：先记缺口再接窗口", () => {
		const t = new Transcript<Entry>(loader());
		t.merge({ entries: [e(10), e(11)], before: 9 });
		// 服务端窗口已跳到 100 之前：新的 before=99 > 已见 newest=11 → 中间缺 12..98
		t.merge({ entries: [e(100), e(101)], before: 99 });

		const shape = t.items.map((i) => (i.kind === "entry" ? i.entry.id : `gap(${i.after},${i.upTo})`));
		expect(shape).toEqual([10, 11, "gap(11,99)", 100, 101]);
		expect(t.newest).toBe(101);
	});

	it("空窗口且从未有条目：只更新 hasEarlier", () => {
		const t = new Transcript<Entry>(loader());
		t.merge({ entries: [], before: 5 });
		expect(t.items).toEqual([]);
		expect(t.newest).toBeUndefined();
		expect(t.hasEarlier).toBe(true);
	});

	it("loadEarlier 把更早一页插到头部，并按 hasMore 决定还能不能继续", async () => {
		const l = loader({
			before: [
				{ entries: [e(6), e(7), e(8)], hasMore: true },
				{ entries: [e(1), e(2)], hasMore: false },
			],
		});
		const t = new Transcript<Entry>(l);
		t.merge({ entries: [e(10)], before: 9 });

		expect(await t.loadEarlier()).toBe(true);
		expect(l.calls.before).toEqual([10]);
		expect(t.items.map((i) => (i.kind === "entry" ? i.entry.id : "gap"))).toEqual([6, 7, 8, 10]);
		expect(t.hasEarlier).toBe(true);

		expect(await t.loadEarlier()).toBe(true);
		expect(l.calls.before).toEqual([10, 6]);
		expect(t.items.map((i) => (i.kind === "entry" ? i.entry.id : "gap"))).toEqual([1, 2, 6, 7, 8, 10]);
		expect(t.hasEarlier).toBe(false);

		// 已到头部：不再发请求
		expect(await t.loadEarlier()).toBe(false);
		expect(l.calls.before).toEqual([10, 6]);
	});

	it("loadEarlier 取回空页时关闭 hasEarlier", async () => {
		const l = loader({ before: [{ entries: [], hasMore: false }] });
		const t = new Transcript<Entry>(l);
		t.merge({ entries: [e(10)], before: 9 });
		expect(await t.loadEarlier()).toBe(false);
		expect(t.hasEarlier).toBe(false);
	});

	it("fillGap 用开区间取一页并移除缺口；一页填不完时缺口收缩", async () => {
		const l = loader({
			between: [
				// 第一次：只填一部分（还有更多），缺口应收缩为 tail..upTo
				{ entries: [e(30), e(31)], hasMore: true },
				// 第二次：填完剩余
				{ entries: [e(32), e(33)], hasMore: false },
			],
		});
		const t = new Transcript<Entry>(l);
		t.merge({ entries: [e(10), e(11)], before: 9 });
		t.merge({ entries: [e(40)], before: 39 }); // 制造缺口 (11,39)

		expect(await t.fillGap(11, 39)).toBe(true);
		expect(l.calls.between).toEqual([[11, 39]]);
		expect(t.items.map((i) => (i.kind === "entry" ? i.entry.id : `gap(${i.after},${i.upTo})`))).toEqual([
			10,
			11,
			30,
			31,
			"gap(31,39)",
			40,
		]);

		expect(await t.fillGap(31, 39)).toBe(true);
		expect(t.items.map((i) => (i.kind === "entry" ? i.entry.id : "gap"))).toEqual([10, 11, 30, 31, 32, 33, 40]);
	});

	it("fillGap 对不存在的缺口返回 false（不乱插内容）", async () => {
		const l = loader();
		const t = new Transcript<Entry>(l);
		t.merge({ entries: [e(10)], before: 9 });
		expect(await t.fillGap(1, 99)).toBe(false);
		expect(l.calls.between).toEqual([]);
	});

	it("reset 清空窗口、最新 ID 与 hasEarlier（切换会话）", () => {
		const t = new Transcript<Entry>(loader());
		t.merge({ entries: [e(10), e(11)], before: 9 });
		t.reset();
		expect(t.items).toEqual([]);
		expect(t.newest).toBeUndefined();
		expect(t.hasEarlier).toBe(false);
	});
});
