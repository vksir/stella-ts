/**
 * 增量 Markdown 内核单测（`src/markdown/incremental.ts`）。
 *
 * 冻结块策略是流式体感的核心：除末尾 UNSTABLE_TAIL_BLOCKS 块外的块必须跨 chunk
 * 保持同一 ast 引用（React 才能按引用跳过重渲），切点必须落在块边界上，且最终
 * 结果与整篇重 parse 一致。这些约束一旦被后续改动破坏，会静默退化成"每个 chunk
 * 全量重渲"，所以用测试钉住。
 */

import { describe, expect, it } from "vitest";
import { IncrementalMarkdown } from "../src/markdown/incremental";

/** 逐字符喂入（最细粒度流式），返回每次快照。 */
function streamByChar(src: string): { blocks: { start: number; node: { type: string } }[]; frozenEnd: number }[] {
	const parser = new IncrementalMarkdown();
	const snaps = [];
	for (let i = 1; i <= src.length; i += 1) snaps.push(parser.append(src.slice(0, i)));
	return snaps;
}

describe("增量 Markdown", () => {
	it("流式结果与整篇解析一致（块序列稳定）", () => {
		const src = [
			"# 标题",
			"",
			"第一段文字。",
			"",
			"- 列表一",
			"- 列表二",
			"",
			"```ts",
			"const a = 1;",
			"```",
			"",
			"| a | b |",
			"| --- | --- |",
			"| 1 | 2 |",
			"",
			"最后一段。",
		].join("\n");

		const snaps = streamByChar(src);
		const final = snaps[snaps.length - 1];
		expect(final).toBeDefined();
		if (final === undefined) return;

		// 落定路径（整篇重 parse）应与流式末态块数一致
		const settled = new IncrementalMarkdown().settle(src);
		expect(final.blocks.length).toBe(settled.blocks.length);
		// 块的起始偏移在两条路径上必须相同（React key 依赖它）
		expect(final.blocks.map((b) => b.start)).toEqual(settled.blocks.map((b) => b.start));
		// 块类型序列一致
		expect(final.blocks.map((b) => b.node.type)).toEqual(settled.blocks.map((b) => b.node.type));
	});

	it("冻结块跨 chunk 保持同一 ast 引用（不触发 remount）", () => {
		const head = "# 一\n\n段落甲。\n\n## 二\n\n段落乙。\n\n";
		const parser = new IncrementalMarkdown();
		parser.append(head);
		const before = parser.append(head);

		// 已冻结的前若干块引用必须与上一次快照完全相同（Object.is）
		const frozenCount = before.blocks.length - 2;
		expect(frozenCount).toBeGreaterThan(0);

		const after = parser.append(`${head}新的尾部段落。`);
		for (let i = 0; i < frozenCount; i += 1) {
			expect(Object.is(after.blocks[i]?.node, before.blocks[i]?.node)).toBe(true);
		}
	});

	it("末尾两块之前的内容被冻结：只重 parse 尾部切片", () => {
		const parser = new IncrementalMarkdown();
		const step1 = parser.append("段一。\n\n段二。\n\n段三。\n\n");
		// 3 块 → 冻结 1 块（3 - UNSTABLE_TAIL_BLOCKS(2)）
		expect(step1.blocks.length).toBe(3);
		expect(step1.frozenEnd).toBeGreaterThan(0);

		// 冻结切点必须等于第 1 块的结束偏移（块边界，不在块内部）
		const firstEnd = step1.blocks[0]?.node.position?.end.offset;
		expect(step1.frozenEnd).toBe(firstEnd);
	});

	it("文本未变时短路（StrictMode 双调安全，不重复解析）", () => {
		const parser = new IncrementalMarkdown();
		const src = "一段话。\n\n第二段。\n\n第三段。\n\n";
		const a = parser.append(src);
		const b = parser.append(src); // 同文本再喂一次
		expect(b.blocks.length).toBe(a.blocks.length);
		expect(b.frozenEnd).toBe(a.frozenEnd);
		for (let i = 0; i < a.blocks.length; i += 1) {
			expect(Object.is(a.blocks[i]?.node, b.blocks[i]?.node)).toBe(true);
		}
	});

	it("前缀失配（换会话 / 缺口补页改写历史）时整体重置", () => {
		const parser = new IncrementalMarkdown();
		parser.append("# 旧会话\n\n旧内容一。\n\n旧内容二。\n\n旧内容三。\n\n");
		const rewritten = parser.append("# 新会话\n\n完全不同的内容。\n\n第二段。\n\n第三段。\n\n");
		// 重置后块数与新文本一致，且不含旧文本的任何块
		expect(rewritten.blocks.length).toBeGreaterThan(0);
		const firstType = rewritten.blocks[0]?.node.type;
		expect(firstType).toBe("heading");
		expect(rewritten.blocks.map((b) => b.start)[0]).toBe(0);
	});

	it("未闭合围栏不丢内容（流式容错）", () => {
		const parser = new IncrementalMarkdown();
		const partial = parser.append("说明：\n\n```ts\nconst a = 1;\nconst b = 2;\n");
		expect(partial.blocks.length).toBeGreaterThanOrEqual(2);
		// 落定后应与完整文本一致
		const settled = parser.settle("说明：\n\n```ts\nconst a = 1;\nconst b = 2;\n```\n");
		expect(settled.blocks.length).toBe(2);
	});

	it("soft break 保留为段内换行（聊天惯例，不切块）", () => {
		const parser = new IncrementalMarkdown();
		const result = parser.settle("第一行\n第二行\n第三行\n");
		expect(result.blocks.length).toBe(1);
		expect(result.blocks[0]?.node.type).toBe("paragraph");
	});
});
