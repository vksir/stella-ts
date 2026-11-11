/**
 * 客户端会话转写：对齐 pi-durable `ConversationTranscript` 的窗口合并语义。
 *
 * pi-durable 的 `conversation.watch()` 给出的是**窗口**（服务端当前 min 200 / max 400 条），
 * 不是整段历史：
 * - `view.before` 是窗口前一条条目的 ID；窗口与客户端已见条目之间不连续时（断线期间
 *   新增超过窗口、服务端换进程等），中间的条目就缺失，必须显式记为缺口再补，
 *   不能把两段直接拼成连续历史（官方 README「Watching a Conversation」）。
 * - 条目 ID **有空洞**，所以任何"按 ID 计数/推算范围"的判断都不成立；只能把
 *   开区间的边界换算成 `EntryQuery` 的闭区间（官方类的注释明确警告这一点）。
 *
 * 本类只做三件事：`merge`（吃每个 view）、`loadEarlier`（向前翻页）、`fillGap`（补中间缺口）。
 * 加载器由调用方注入（本项目的 REST 端点），浏览器侧因此不必把 pi-durable 整个包打进 bundle。
 */

/** 转写中的一行：一条条目，或一段缺失（`after` 与 `upTo` 之间，均为开区间）。 */
export type TranscriptItem<E extends { readonly id: number }> =
	| { readonly kind: "entry"; readonly entry: E }
	| { readonly kind: "gap"; readonly after: number; readonly upTo: number };

/** 一页条目（升序）与是否还有下一页。 */
export interface TranscriptPage<E> {
	readonly entries: readonly E[];
	readonly hasMore: boolean;
}

/** 转写的翻页加载器：`before` 取更早，`between` 取缺口内的一段。 */
export interface TranscriptLoader<E> {
	/** 严格早于 `oldestId` 的一页，升序。 */
	before(oldestId: number): Promise<TranscriptPage<E>>;
	/** 严格在 (`afterId`, `upToId`) 之间的一页，升序。 */
	between(afterId: number, upToId: number): Promise<TranscriptPage<E>>;
}

export class Transcript<E extends { readonly id: number }> {
	#items: readonly TranscriptItem<E>[] = [];
	#newest: number | undefined;
	#hasEarlier = false;
	readonly #load: TranscriptLoader<E>;

	constructor(load: TranscriptLoader<E>) {
		this.#load = load;
	}

	/** 客户端已持有的全部条目（含缺口标记），按条目 ID 升序。 */
	get items(): readonly TranscriptItem<E>[] {
		return this.#items;
	}

	/** 已见条目的最新 ID；还没有任何条目时 undefined。 */
	get newest(): number | undefined {
		return this.#newest;
	}

	/** 最早一条之前是否还有历史（"加载更早"按钮）。 */
	get hasEarlier(): boolean {
		return this.#hasEarlier;
	}

	/** 切换会话时清空（窗口、缺口、翻页状态都只属于当前会话）。 */
	reset(): void {
		this.#items = [];
		this.#newest = undefined;
		this.#hasEarlier = false;
	}

	/**
	 * 并入一个 `ConversationView`：窗口与已见条目重叠时只追加更新的条目；
	 * 窗口整体落在已见条目之后时记下一段缺口；窗口从转写起点开始时替换全部条目。
	 */
	merge(view: { readonly entries: readonly E[]; readonly before?: number }): void {
		const entries = view.entries;
		const first = entries[0];
		const last = entries[entries.length - 1];
		if (first === undefined || last === undefined) {
			// 空窗口：没有任何条目可并入（`before` 只说明窗口落在末尾之后）
			if (this.#newest === undefined && view.before !== undefined) this.#hasEarlier = true;
			return;
		}
		const newest = this.#newest;
		const append = (): TranscriptItem<E>[] => entries.map((entry): TranscriptItem<E> => ({ kind: "entry", entry }));
		if (newest === undefined || view.before === undefined) {
			// 首次并入，或窗口从转写起点开始：窗口本身就是从头开始的连续段，直接替换
			this.#items = append();
			this.#newest = last.id;
			this.#hasEarlier = view.before !== undefined;
			return;
		}
		if (view.before > newest) {
			// 窗口不接续已见条目：中间缺失，保留已有段，记缺口后接窗口
			this.#items = [...this.#items, { kind: "gap", after: newest, upTo: view.before }, ...append()];
			this.#newest = last.id;
			return;
		}
		// 窗口与已见条目重叠或紧接：只追加更晚的条目（条目不可变，已见的一律复用）
		const fresh = entries.filter((entry) => entry.id > newest);
		if (fresh.length === 0) return;
		this.#items = [...this.#items, ...fresh.map((entry): TranscriptItem<E> => ({ kind: "entry", entry }))];
		this.#newest = fresh[fresh.length - 1]?.id ?? newest;
	}

	/** 向前翻一页。返回是否新增了条目；没有更早的历史后 `hasEarlier` 变为 false。 */
	async loadEarlier(): Promise<boolean> {
		const oldest = this.#oldest();
		if (oldest === undefined || !this.#hasEarlier) return false;
		const page = await this.#load.before(oldest);
		if (page.entries.length > 0) {
			this.#items = [
				...page.entries.map((entry): TranscriptItem<E> => ({ kind: "entry", entry })),
				...this.#items,
			];
		}
		this.#hasEarlier = page.entries.length > 0 && page.hasMore;
		return page.entries.length > 0;
	}

	/**
	 * 补一段缺口（从缺口起点开始取一页）。返回是否发生了变化；一页填不完时
	 * 缺口收缩为剩余段（与官方 `fillGap` 语义一致）。
	 */
	async fillGap(after: number, upTo: number): Promise<boolean> {
		const index = this.#items.findIndex(
			(item) => item.kind === "gap" && item.after === after && item.upTo === upTo,
		);
		if (index < 0) return false;
		const page = await this.#load.between(after, upTo);
		const fresh: TranscriptItem<E>[] = page.entries.map((entry): TranscriptItem<E> => ({ kind: "entry", entry }));
		const tail = page.entries[page.entries.length - 1];
		const rest: TranscriptItem<E>[] =
			page.hasMore && tail !== undefined ? [{ kind: "gap", after: tail.id, upTo }] : [];
		this.#items = [...this.#items.slice(0, index), ...fresh, ...rest, ...this.#items.slice(index + 1)];
		return fresh.length > 0;
	}

	/** 最早一条条目的 ID（跳过开头的缺口标记，理论上不存在这种布局）。 */
	#oldest(): number | undefined {
		for (const item of this.#items) {
			if (item.kind === "entry") return item.entry.id;
		}
		return undefined;
	}
}
