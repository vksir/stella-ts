/**
 * 增量 Markdown 解析（复刻 dsh incremental.ts 的冻结块策略）：
 *
 * - mdast-util-from-markdown + GFM 解析；除末尾 UNSTABLE_TAIL_BLOCKS 块外全部冻结。
 * - 流式 append 只从 frozenEnd（最后冻结块的结束偏移）重 parse 尾部切片，
 *   冻结块沿用旧 ast 引用（React.memo 按引用拦截，DOM 纹丝不动）。
 * - React key = 块源文本起始偏移（绝对偏移，跨冻结边界 reconcile 不 remount）。
 * - 前缀失配（换会话 / 缺口补页改写历史）整体重置。
 * - 落定（settle）用整篇新 parse 替换，保证最终一致。
 * - 已知取舍：引用式链接跨冻结边界时流式期间显示字面量，落定自愈（dsh 同款）。
 */

import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import type { Root } from "mdast";

/** 末尾保持不稳（可被后续 chunk 改写）的块数；dsh 同值。 */
const UNSTABLE_TAIL_BLOCKS = 2;

export interface MdBlocNode {
	/** mdast 块节点（paragraph/code/table/list/heading/…）。 */
	node: Root["children"][number];
	/** 块在源文本中的起始偏移（React key）。 */
	start: number;
	/**
	 * 块在源文本中的结束偏移（绝对，非切片内相对）。
	 * 冻结切点必须用它：切片重 parse 出的 node.position.end 是相对切片的偏移，
	 * 直接拿来做 frozenEnd 会让切点回退、把已冻结的块重复解析进结果。
	 */
	end: number;
}

export interface IncrementalResult {
	/** 冻结 + 尾部全部块（含 ast 引用可能沿用的旧节点）。 */
	blocks: MdBlocNode[];
	/** 冻结区结束偏移（下一次增量的起点）。 */
	frozenEnd: number;
}

interface ParseState {
	prefix: string;
	frozen: MdBlocNode[];
	tail: MdBlocNode[];
	frozenEnd: number;
}

function parseBlocks(src: string, baseOffset: number): MdBlocNode[] {
	const root = fromMarkdown(src, {
		extensions: [gfm()],
		mdastExtensions: [gfmFromMarkdown()],
	});
	return root.children.map((node) => ({
		node,
		start: baseOffset + (node.position?.start.offset ?? 0),
		end: baseOffset + (node.position?.end.offset ?? 0),
	}));
}

/** 全新解析（落定 / 重置后首次）。 */
function parseFull(src: string): IncrementalResult & { state: ParseState } {
	const all = parseBlocks(src, 0);
	const frozenCount = Math.max(0, all.length - UNSTABLE_TAIL_BLOCKS);
	const frozen = all.slice(0, frozenCount);
	const tail = all.slice(frozenCount);
	const lastFrozen = frozen[frozen.length - 1];
	const frozenEnd = lastFrozen ? nodeEnd(lastFrozen, src.length) : 0;
	return {
		blocks: all,
		frozenEnd,
		state: { prefix: src.slice(0, frozenEnd), frozen, tail, frozenEnd },
	};
}

function nodeEnd(block: MdBlocNode, fallback: number): number {
	return block.end > 0 ? block.end : fallback;
}

/**
 * 流式增量：append 到 src，返回新的块视图。
 * 前缀（旧冻结区文本）失配时自动整体重置。
 */
export class IncrementalMarkdown {
	private state: ParseState | undefined;
	private src = "";

	/** 当前源文本（调试 / 测试用）。 */
	get text(): string {
		return this.src;
	}

	reset(): void {
		this.state = undefined;
		this.src = "";
	}

	/** 落定：整篇重 parse（流式期间引用式链接等边缘在此自愈）。 */
	settle(src: string): IncrementalResult {
		if (src === this.src && this.state !== undefined) {
			return { blocks: [...this.state.frozen, ...this.state.tail], frozenEnd: this.state.frozenEnd };
		}
		this.src = src;
		const parsed = parseFull(src);
		this.state = parsed.state;
		return parsed;
	}

	/** 流式追加解析：只重 parse frozenEnd 之后的切片。 */
	append(next: string): IncrementalResult {
		if (next === this.src && this.state !== undefined) {
			// 文本未变（StrictMode 双调 / 无关重渲）：直接复用上次结果
			return { blocks: [...this.state.frozen, ...this.state.tail], frozenEnd: this.state.frozenEnd };
		}
		const prev = this.state;
		if (prev === undefined || !next.startsWith(prev.prefix) || !next.startsWith(this.src.slice(0, prev.frozenEnd))) {
			// 首次 / 前缀改写（理论上流式只 append，防御性重置）
			const parsed = parseFull(next);
			this.src = next;
			this.state = parsed.state;
			return parsed;
		}
		this.src = next;
		// 从冻结区末尾重 parse（尾部切片的偏移以 frozenEnd 为基）
		const sliced = parseBlocks(next.slice(prev.frozenEnd), prev.frozenEnd);
		// 旧尾部里未变的块沿用旧 ast 引用（同起始 + 同结束 + 同类型）
		const prevTail = new Map<number, MdBlocNode>();
		for (const block of prev.tail) prevTail.set(block.start, block);
		const reuseTail = sliced.map((block) => {
			const old = prevTail.get(block.start);
			if (old !== undefined && old.node.type === block.node.type && nodeEnd(old, 0) === nodeEnd(block, 0)) {
				return old;
			}
			return block;
		});
		const all = [...prev.frozen, ...reuseTail];
		const frozenCount = Math.max(0, all.length - UNSTABLE_TAIL_BLOCKS);
		const frozen = all.slice(0, frozenCount);
		const tail = all.slice(frozenCount);
		const lastFrozen = frozen[frozen.length - 1];
		const frozenEnd = lastFrozen ? nodeEnd(lastFrozen, next.length) : 0;
		this.state = { prefix: next.slice(0, frozenEnd), frozen, tail, frozenEnd };
		return { blocks: all, frozenEnd };
	}
}
