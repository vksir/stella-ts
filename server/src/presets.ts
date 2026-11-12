/**
 * 预设 → `pi.agent` 的解析：预设按**名字**引用扩展、技能与工具，创建会话时解析成对象
 * 交给 pi-durable（它再按名字存储），因此配置文件里不需要、也不允许出现代码。
 *
 * - `extensions`/`skills`/`tools`/`modelTools` 为 null/缺省 = 跟随宿主默认（全部已安装/已发现）。
 * - 名字未安装/未发现时跳过并记录；已有会话不受影响（agent 已存成名字）。
 * - 模型与工作目录不进预设：模型由模型选择器、cwd 由工作目录设置独立控制。
 */
import type { AgentChange, Extension, ModelRef, Registry, ToolRegistration } from "@earendil-works/pi-durable";
import { SKILLS_EXTENSION_NAME, type Skill } from "./extensions/skills/index.js";
import type { PresetDefinition, StellaSettingsStore } from "./settings.js";

/** `GET /api/presets` 的展示形状。 */
export interface PresetSummary {
	readonly id: string;
	readonly name: string;
	readonly description?: string;
	readonly builtin: boolean;
	readonly default: boolean;
	/** null = 全部已安装。 */
	readonly extensions: readonly string[] | null;
	/** null = 全部已发现技能。 */
	readonly skills: readonly string[] | null;
	/** null = 全部已启用。 */
	readonly tools: readonly string[] | null;
	/** 声明了但当前未安装/未发现的名字（创建会话时会被跳过）。 */
	readonly missing: readonly string[];
}

function toolIndex(registry: Registry): Map<string, ToolRegistration> {
	const index = new Map<string, ToolRegistration>();
	for (const entry of registry.snapshot().tools()) index.set(entry.tool.name, entry.tool);
	return index;
}

function resolveExtensions(
	registry: Registry,
	names: readonly string[] | null | undefined,
): readonly Extension[] | undefined {
	if (names === null || names === undefined) return undefined;
	const snapshot = registry.snapshot();
	const resolved: Extension[] = [];
	for (const name of names) {
		const extension = snapshot.extension(name);
		if (extension === undefined) {
			console.warn(`[stella] 预设引用了未安装的扩展 "${name}"，已跳过`);
			continue;
		}
		resolved.push(extension);
	}
	return resolved;
}

/** 按预设白名单挑技能；`null`/缺省 = 全部，`[]` = 无。名字未发现时跳过并记录。 */
function resolveSkills(preset: PresetDefinition, all: readonly Skill[]): readonly Skill[] {
	const names = preset.skills;
	if (names === null || names === undefined) return all;
	const byName = new Map(all.map((skill) => [skill.name, skill]));
	const resolved: Skill[] = [];
	const seen = new Set<string>();
	for (const name of names) {
		if (seen.has(name)) continue;
		const skill = byName.get(name);
		if (skill === undefined) {
			console.warn(`[stella] 预设引用了未发现的技能 "${name}"，已跳过`);
			continue;
		}
		seen.add(name);
		resolved.push(skill);
	}
	return resolved;
}

/**
 * 选了技能就把 `stella-skills` 扩展带上。预设的 `extensions` 为 null（全部已安装）时
 * 它已经在名单里，不用追加。
 */
function withSkillsExtension(
	registry: Registry,
	extensions: readonly Extension[] | undefined,
	skills: readonly Skill[],
): readonly Extension[] | undefined {
	if (skills.length === 0 || extensions === undefined) return extensions;
	if (extensions.some((extension) => extension.name === SKILLS_EXTENSION_NAME)) return extensions;
	const skillsExtension = registry.snapshot().extension(SKILLS_EXTENSION_NAME);
	return skillsExtension === undefined ? extensions : [...extensions, skillsExtension];
}

function resolveTools(
	registry: Registry,
	names: readonly string[] | null | undefined,
): readonly ToolRegistration[] | undefined {
	if (names === null || names === undefined) return undefined;
	const index = toolIndex(registry);
	const resolved: ToolRegistration[] = [];
	const seen = new Set<string>();
	for (const name of names) {
		if (seen.has(name)) continue;
		const tool = index.get(name);
		if (tool === undefined) {
			console.warn(`[stella] 预设引用了未安装的工具 "${name}"，已跳过`);
			continue;
		}
		seen.add(name);
		resolved.push(tool);
	}
	return resolved;
}

/**
 * 解析一个预设的 agent 变更。`model` 由调用方给出（不来自预设）；`allSkills` 是当前
 * 扫描到的技能，按预设白名单过滤后一并返回，供创建会话时写入技能快照。
 * 未知预设 id 回落到配置的默认预设；连默认预设都不存在时回落到标准预设。
 */
export function resolvePresetAgent(
	store: StellaSettingsStore,
	registry: Registry,
	presetId: string | undefined,
	model: ModelRef,
	allSkills: readonly Skill[] = [],
): { preset: PresetDefinition; agent: AgentChange; skills: readonly Skill[] } {
	const runtime = store.runtime;
	const preset =
		(presetId === undefined ? undefined : store.preset(presetId)) ??
		store.preset(runtime.defaultPreset) ??
		runtime.presets[0]!;
	const skills = resolveSkills(preset, allSkills);
	const extensions = withSkillsExtension(registry, resolveExtensions(registry, preset.extensions), skills);
	const tools = resolveTools(registry, preset.tools);
	const modelTools = resolveTools(registry, preset.modelTools);
	const agent: AgentChange = {
		model,
		...(extensions === undefined ? {} : { extensions }),
		...(tools === undefined ? {} : { tools }),
		...(modelTools === undefined ? {} : { modelTools }),
		...(preset.instructions === null || preset.instructions === undefined
			? {}
			: { instructions: preset.instructions }),
		maxTurns: preset.maxTurns ?? runtime.defaultMaxTurns,
	};
	return { preset, agent, skills };
}

/** 预设列表 + 缺失名字，供 `GET /api/presets` 与只读设置页使用。 */
export function presetSummaries(
	store: StellaSettingsStore,
	registry: Registry,
	allSkills: readonly Skill[] = [],
): readonly PresetSummary[] {
	const runtime = store.runtime;
	const snapshot = registry.snapshot();
	const toolNames = new Set(snapshot.tools().map((entry) => entry.tool.name));
	const skillNames = new Set(allSkills.map((skill) => skill.name));
	return runtime.presets.map((preset) => {
		const missing: string[] = [];
		for (const name of preset.extensions ?? []) {
			if (snapshot.extension(name) === undefined) missing.push(`extension:${name}`);
		}
		for (const name of preset.skills ?? []) {
			if (!skillNames.has(name)) missing.push(`skill:${name}`);
		}
		for (const name of [...(preset.tools ?? []), ...(preset.modelTools ?? [])]) {
			if (!toolNames.has(name)) missing.push(`tool:${name}`);
		}
		return {
			id: preset.id,
			name: preset.name,
			...(preset.description === undefined ? {} : { description: preset.description }),
			builtin: preset.builtin === true,
			default: preset.id === runtime.defaultPreset,
			extensions: preset.extensions ?? null,
			skills: preset.skills ?? null,
			tools: preset.tools ?? null,
			missing,
		};
	});
}
