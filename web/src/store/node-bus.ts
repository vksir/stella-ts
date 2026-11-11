/**
 * 节点总线：按 key 保存节点快照，并把「每个 key 一个订阅桶」与「快照源」正确接通。
 *
 * 这里曾经有一个**致命但静默**的 bug：订阅桶注册在 store 自己的 Map 里，而快照源
 * （`Source`）的 `set()` 只通知它自己的监听器 —— 两者没有桥接，于是
 *
 *   - 流式文本永远不刷新（store 里已经长到 500 字，DOM 一直是 0 字）；
 *   - 工具行状态停在「排队中」，只有切换会话/刷新才变成「已完成」；
 *   - 而"历史 DOM 稳定性"测试反而是**通过**的，因为根本没有重渲。
 *
 * 现在把桥接做进 `source()`：源变化 → 该 key 的订阅桶 → React。抽成独立类是为了
 * 能在 Node 里直接单测（store 本身在 import 期就会读 localStorage，无法直接加载）。
 */

/** 极简快照源：引用不变即不通知。 */
export class Source<T> {
	private listeners = new Set<() => void>();
	private snap: T;

	constructor(initial: T) {
		this.snap = initial;
	}

	readonly get = (): T => this.snap;

	readonly set = (next: T): void => {
		if (Object.is(next, this.snap)) return;
		this.snap = next;
		for (const listener of [...this.listeners]) listener();
	};

	readonly subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	};
}

export class NodeBus<T> {
	private readonly sources = new Map<string, Source<T | null>>();
	private readonly buckets = new Map<string, Set<() => void>>();

	/** 取（或创建）某个 key 的源；创建时把源的通知桥接到该 key 的订阅桶。 */
	source(key: string): Source<T | null> {
		let source = this.sources.get(key);
		if (source === undefined) {
			source = new Source<T | null>(null);
			source.subscribe(() => {
				const bucket = this.buckets.get(key);
				if (bucket === undefined) return;
				for (const listener of [...bucket]) listener();
			});
			this.sources.set(key, source);
		}
		return source;
	}

	/** 读取某个 key 的当前快照（不存在时为 null）。 */
	get(key: string): T | null {
		return this.sources.get(key)?.get() ?? null;
	}

	/** 写入某个 key 的快照。 */
	set(key: string, next: T | null): void {
		this.source(key).set(next);
	}

	/** 订阅某个 key（源变化时触发）。 */
	subscribe(key: string, listener: () => void): () => void {
		let bucket = this.buckets.get(key);
		if (bucket === undefined) {
			bucket = new Set();
			this.buckets.set(key, bucket);
		}
		const target = bucket;
		target.add(listener);
		return () => {
			target.delete(listener);
			// 桶空了就删掉：长时间切换会话不应留下成百上千个空 Set
			if (target.size === 0) this.buckets.delete(key);
		};
	}

	/** 丢弃全部快照与订阅桶（切换会话时调用；座位会整体重挂并重新订阅）。 */
	clear(): void {
		this.sources.clear();
		this.buckets.clear();
	}

	/** 诊断用：当前持有多少 key（内存泄漏排查）。 */
	get size(): { sources: number; buckets: number } {
		return { sources: this.sources.size, buckets: this.buckets.size };
	}
}
