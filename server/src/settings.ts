/**
 * Stella 运行配置：`data/stella.config.json`（可选文件，热更新）。
 *
 * 分工：
 * - `.env` 管部署相关、变更需要重启的项：provider key、端口、数据目录、默认模型。
 * - 本文件管运行策略与预设：pi-durable `HarnessSettings`、默认预设、默认 `maxTurns`。
 *
 * 语义对齐 pi-durable「Settings」：`settings` 以 getter 形式交给 `Harness.open`，每次使用时
 * 重新读取，所以热更新不需要重启 Harness；预设只在**创建会话时**解析进 `pi.agent`，
 * 因此修改预设只影响之后新建的会话（已有会话保留自己的 agent）。
 *
 * 容错：文件不存在用内置默认值；解析失败保留上一份生效配置并记录错误；不写回文件。
 */
import { readFileSync, watch, type FSWatcher } from "node:fs";
import { basename, dirname } from "node:path";
import type { HarnessSettings } from "@earendil-works/pi-durable";

/** 一个会话预设：创建会话时选择的一套能力与人设，按名字引用已安装的扩展/工具。 */
export interface PresetDefinition {
	readonly id: string;
	readonly name: string;
	readonly description?: string;
	/** 扩展名；`null`/缺省 = 全部已安装扩展。 */
	readonly extensions?: readonly string[] | null;
	/** 工具名；`null`/缺省 = 全部已启用工具。 */
	readonly tools?: readonly string[] | null;
	/** 模型可见工具名；`null`/缺省 = 默认（全部可调用工具，deferred 除外）。 */
	readonly modelTools?: readonly string[] | null;
	/** 渲染在扩展 section 之后的人设/指令。 */
	readonly instructions?: string | null;
	/** 单次运行的工具有限轮次；缺省用 defaultMaxTurns。 */
	readonly maxTurns?: number | null;
	/** 内置预设（目前只有 standard）。 */
	readonly builtin?: boolean;
}

/** 配置文件解析后的生效值。 */
export interface StellaRuntimeConfig {
	readonly settings: HarnessSettings;
	readonly presets: readonly PresetDefinition[];
	readonly defaultPreset: string;
	readonly defaultMaxTurns: number;
}

/** 内置标准预设：选择全部已安装扩展与工具（名单为 null，意味着跟随注册表）。 */
export const STANDARD_PRESET: PresetDefinition = {
	id: "standard",
	name: "标准",
	description: "全部已安装能力：读写文件、执行命令、代码模式、子代理。",
	extensions: null,
	tools: null,
	modelTools: null,
	instructions: null,
	maxTurns: null,
	builtin: true,
};

export const DEFAULT_MAX_TURNS = 128;

/** Stella 的默认运行策略：只显式化模型请求超时，其余沿用 pi-durable 默认值。 */
export const DEFAULT_SETTINGS: HarnessSettings = {
	stream: { timeoutMs: 120_000 },
};

export const DEFAULT_RUNTIME_CONFIG: StellaRuntimeConfig = {
	settings: DEFAULT_SETTINGS,
	presets: [STANDARD_PRESET],
	defaultPreset: STANDARD_PRESET.id,
	defaultMaxTurns: DEFAULT_MAX_TURNS,
};

/** `presets` 里允许的 id：小写字母/数字/短横线，且不以短横线开头。 */
const PRESET_ID = /^[a-z0-9][a-z0-9-]*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

function readStringArray(value: unknown): readonly string[] | null | undefined {
	if (value === null) return null;
	if (!Array.isArray(value)) return undefined;
	const names = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
	return names.map((name) => name.trim());
}

function readPreset(value: unknown): PresetDefinition | undefined {
	if (!isRecord(value)) return undefined;
	const id = typeof value.id === "string" ? value.id.trim() : "";
	if (!PRESET_ID.test(id)) return undefined;
	const extensions = readStringArray(value.extensions);
	const tools = readStringArray(value.tools);
	const modelTools = readStringArray(value.modelTools);
	const maxTurns = value.maxTurns === null || value.maxTurns === undefined ? null : value.maxTurns;
	if (maxTurns !== null && !isPositiveInteger(maxTurns)) return undefined;
	return {
		id,
		name: typeof value.name === "string" && value.name.trim().length > 0 ? value.name.trim() : id,
		...(typeof value.description === "string" ? { description: value.description } : {}),
		...(extensions !== undefined ? { extensions } : {}),
		...(tools !== undefined ? { tools } : {}),
		...(modelTools !== undefined ? { modelTools } : {}),
		...(typeof value.instructions === "string" ? { instructions: value.instructions } : {}),
		...(maxTurns !== null ? { maxTurns } : {}),
		builtin: id === STANDARD_PRESET.id,
	};
}

/**
 * 把配置文件内容解析成生效值。非法条目跳过并给出警告，不让一个坏预设拖垮启动。
 * 导出给测试直接使用（不必经过 fs.watch）。
 */
export function resolveRuntimeConfig(raw: unknown): StellaRuntimeConfig {
	if (!isRecord(raw)) return DEFAULT_RUNTIME_CONFIG;

	const fileSettings = isRecord(raw.settings) ? raw.settings : {};
	const { extensions: _ignored, ...rest } = fileSettings as Record<string, unknown>;
	const settings: HarnessSettings = {
		...DEFAULT_SETTINGS,
		...rest,
		stream: {
			...DEFAULT_SETTINGS.stream,
			...(isRecord(fileSettings.stream) ? fileSettings.stream : {}),
		},
	};

	const defaultMaxTurns = isPositiveInteger(raw.defaultMaxTurns) ? raw.defaultMaxTurns : DEFAULT_MAX_TURNS;

	// 内置标准预设先入位；文件里的同名预设整体覆盖它，其余按文件顺序追加。
	const presets = new Map<string, PresetDefinition>([[STANDARD_PRESET.id, STANDARD_PRESET]]);
	if (raw.presets !== undefined) {
		if (!Array.isArray(raw.presets)) {
			console.warn("[stella] 配置 presets 应为数组，已忽略");
		} else {
			for (const item of raw.presets) {
				const preset = readPreset(item);
				if (preset === undefined) {
					console.warn("[stella] 配置里有非法预设，已跳过：", JSON.stringify(item));
					continue;
				}
				presets.set(preset.id, preset);
			}
		}
	}

	const presetList = [...presets.values()];
	const requested = typeof raw.defaultPreset === "string" ? raw.defaultPreset : STANDARD_PRESET.id;
	const defaultPreset = presetList.some((preset) => preset.id === requested) ? requested : STANDARD_PRESET.id;
	if (defaultPreset !== requested) {
		console.warn(`[stella] 默认预设 "${requested}" 不存在，改用 "${defaultPreset}"`);
	}
	return { settings, presets: presetList, defaultPreset, defaultMaxTurns };
}

/** 配置文件的读取、校验与热更新。 */
export class StellaSettingsStore {
	readonly #path: string;
	#runtime: StellaRuntimeConfig = DEFAULT_RUNTIME_CONFIG;
	#watcher: FSWatcher | undefined;
	#timer: NodeJS.Timeout | undefined;

	constructor(path: string) {
		this.#path = path;
	}

	/** 当前生效值；`Harness.open` 的 settings getter 与预设解析都读它。 */
	get runtime(): StellaRuntimeConfig {
		return this.#runtime;
	}

	get settings(): HarnessSettings {
		return this.#runtime.settings;
	}

	get path(): string {
		return this.#path;
	}

	/** 按 id 找预设；找不到返回 undefined。 */
	preset(id: string): PresetDefinition | undefined {
		return this.#runtime.presets.find((preset) => preset.id === id);
	}

	/** 启动时读一次；文件不存在时保持默认值。 */
	load(): void {
		this.reload();
	}

	/** 立即重读一次（测试与 fs.watch 共用）。返回是否成功采纳了新值。 */
	reload(): boolean {
		let text: string;
		try {
			text = readFileSync(this.#path, "utf8");
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			// 文件是可选的：不存在时静默使用内置默认值（示例见仓库根 stella.config.example.json）。
			if (code !== "ENOENT") {
				console.warn(`[stella] 读取配置失败，继续使用当前值：${this.#path}`, error);
			}
			return false;
		}
		try {
			const parsed: unknown = JSON.parse(text);
			this.#runtime = resolveRuntimeConfig(parsed);
			return true;
		} catch (error) {
			console.error(`[stella] 配置文件解析失败，继续使用上一份生效配置：${this.#path}`, error);
			return false;
		}
	}

	/** 监听所在目录（编辑器常以替换文件的方式保存），防抖后重读。 */
	startWatching(): void {
		if (this.#watcher !== undefined) return;
		try {
			this.#watcher = watch(dirname(this.#path), { persistent: false }, (_event, filename) => {
				if (filename !== null && String(filename) !== basename(this.#path)) return;
				this.#scheduleReload();
			});
			this.#watcher.on("error", (error) => {
				console.error(`[stella] 配置文件监听失败：${this.#path}`, error);
			});
		} catch (error) {
			// 目录不存在（例如首次启动、faux 模式）时不监听；文件建好后重启即可生效。
			console.warn(`[stella] 无法监听配置文件目录，热更新不可用：${this.#path}`, error);
		}
	}

	stop(): void {
		if (this.#timer !== undefined) {
			clearTimeout(this.#timer);
			this.#timer = undefined;
		}
		this.#watcher?.close();
		this.#watcher = undefined;
	}

	#scheduleReload(): void {
		if (this.#timer !== undefined) clearTimeout(this.#timer);
		this.#timer = setTimeout(() => {
			this.#timer = undefined;
			this.reload();
		}, 150);
		this.#timer.unref?.();
	}
}
