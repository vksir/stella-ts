/**
 * Provider 自动发现与默认模型解析。
 *
 * 按「provider → 环境变量」映射表扫描进程环境变量：有 key 才把该 provider 装进
 * pi-ai 的 `Models` 目录。provider 名以 pi-ai 实际导出为准（deepseek / zai /
 * moonshotai-cn / openrouter / openai / anthropic / groq / xai）。
 */
import type { FauxModelDefinition } from "@earendil-works/pi-ai/providers/faux";
import { createModels, type MutableModels, type Provider } from "@earendil-works/pi-ai/models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import {
	fauxAssistantMessage,
	fauxProvider,
	type FauxProviderHandle,
	type FauxResponseFactory,
} from "@earendil-works/pi-ai/providers/faux";
import { groqProvider } from "@earendil-works/pi-ai/providers/groq";
import { moonshotaiCnProvider } from "@earendil-works/pi-ai/providers/moonshotai-cn";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { xaiProvider } from "@earendil-works/pi-ai/providers/xai";
import { zaiProvider } from "@earendil-works/pi-ai/providers/zai";
import { PROVIDER_ENV_VARS } from "./config.js";

type ProviderFactory = () => Provider;

const PROVIDER_FACTORIES: Readonly<Record<string, ProviderFactory>> = {
	deepseek: deepseekProvider,
	zai: zaiProvider,
	"moonshotai-cn": moonshotaiCnProvider,
	openrouter: openrouterProvider,
	openai: openaiProvider,
	anthropic: anthropicProvider,
	groq: groqProvider,
	xai: xaiProvider,
};

/** faux 模式的默认模型（provider id 与模型 id 都来自 pi-ai 的 faux provider）。 */
export const FAUX_MODEL = { provider: "faux", modelId: "faux-1" } as const;

const FAUX_DEFAULT_ANSWER =
	"（faux 模式示例回答）你好，我是 Stella。当前未配置任何 provider API key，这是一条内置的固定回答，" +
	"用于体验页面与消息流程；在 .env 配置任一 provider 的 key 并关闭 STELLA_FAUX 后即可真实对话。";

/** faux 服务模式的自续填回答脚本：每次被消费后在队尾补一份，队列永不耗尽。 */
function endlessFauxAnswer(handle: FauxProviderHandle): FauxResponseFactory {
	return () => {
		handle.appendResponses([endlessFauxAnswer(handle)]);
		return fauxAssistantMessage(FAUX_DEFAULT_ANSWER);
	};
}

/** 按映射表装载所有配了 key 的 provider；返回已注册的 provider 名。 */
export function discoverProviders(models: MutableModels, env: NodeJS.ProcessEnv): string[] {
	const registered: string[] = [];
	for (const [provider, envVar] of Object.entries(PROVIDER_ENV_VARS)) {
		const factory = PROVIDER_FACTORIES[provider];
		if (factory === undefined) continue; // 防御：映射表与工厂表不一致时跳过
		if (!env[envVar]?.trim()) continue;
		models.setProvider(factory());
		registered.push(provider);
	}
	return registered;
}

/**
 * faux 模式：装 faux provider，返回句柄以便测试脚本固定回答。
 *
 * `tokensPerSecond` 让 faux 回答按 token 限速流出（pi-ai faux 的流式 delta 用真实定时器推进），
 * 供流式测试观察 pi.live 的 partial；不配则 delta 瞬时完成，partial 节流（100ms）多半来不及提交。
 *
 * `models` 自定义模型目录（faux provider 原生支持）：默认只有 faux-1 一个模型；
 * 模型切换测试传多个定义，才能验证「切换后下一条回答用新模型」。
 */
export function installFauxProvider(
	models: MutableModels,
	options?: { tokensPerSecond?: number; fauxModels?: readonly FauxModelDefinition[] },
): FauxProviderHandle {
	const faux = fauxProvider({
		...(options?.tokensPerSecond !== undefined ? { tokensPerSecond: options.tokensPerSecond } : {}),
		...(options?.fauxModels !== undefined ? { models: [...options.fauxModels] } : {}),
	});
	models.setProvider(faux.provider);
	faux.appendResponses([endlessFauxAnswer(faux)]); // 测试可用 setResponses 覆盖为确定性脚本
	return faux;
}

export interface ResolvedDefaultModel {
	readonly provider: string;
	readonly modelId: string;
	/**
	 * 配置的默认模型不可用（provider 未装，或 modelId 不在该 provider 目录）时改用了替代模型；
	 * 此处记录配置的原始写法（provider/modelId），供启动日志与界面提示回落来源。
	 */
	readonly fallbackFrom?: string;
}

/**
 * 校验默认模型，不可用时逐级回落（票 05：回落到第一个可用模型并提示）：
 *
 * 1. 配置的 provider 已装、modelId 在目录里 → 原样使用。
 * 2. modelId 不在目录（目录是静态生成的，provider 也可能在线刷新）→
 *    改用该 provider 目录里的第一个聊天模型。
 * 3. 配置的 provider 未装（环境里没有它的 API key）→ 改用第一个已装 provider 的第一个模型。
 * 4. 一个可用模型都没有 → 报错（faux 模式固定 faux/faux-1，不会走到这里；
 *    非 faux 零 key 在 stella.ts 更早拦截）。
 *
 * 2、3 两种回落都记入 fallbackFrom，由调用方在启动日志与 /api/models 里提示。
 */
export function resolveDefaultModel(
	models: MutableModels,
	spec: { provider: string; modelId: string },
	registeredProviders: readonly string[],
): ResolvedDefaultModel {
	const specText = `${spec.provider}/${spec.modelId}`;
	if (registeredProviders.includes(spec.provider)) {
		const catalog = models.getModels(spec.provider);
		if (catalog.some((model) => model.id === spec.modelId)) {
			return { provider: spec.provider, modelId: spec.modelId };
		}
		const first = catalog[0];
		if (first === undefined) {
			throw new Error(
				`provider "${spec.provider}" 目录中没有可用模型，无法设为默认模型。请检查 API key 或改设 STELLA_DEFAULT_MODEL。`,
			);
		}
		return { provider: first.provider, modelId: first.id, fallbackFrom: specText };
	}
	for (const provider of registeredProviders) {
		const first = models.getModels(provider)[0];
		if (first !== undefined) {
			return { provider: first.provider, modelId: first.id, fallbackFrom: specText };
		}
	}
	throw new Error(
		`没有任何已装 provider 提供可用模型，默认模型 ${specText} 无法使用。` +
			`请配置至少一个 provider 的 API key 或改设 STELLA_DEFAULT_MODEL。`,
	);
}

/** 模型目录条目：模型列表端点（/api/models）返回的形状，只含已装 provider 的聊天模型。 */
export interface ModelCatalogEntry {
	/** provider id（pi-ai Provider.id）。 */
	readonly provider: string;
	/** provider 显示名（pi-ai Provider.name），下拉分组标题用。 */
	readonly providerName: string;
	/** 模型 id（pi-ai Model.id），configure({ model }) 的 modelId。 */
	readonly modelId: string;
	/** 模型显示名（pi-ai Model.name）。 */
	readonly name: string;
}

/**
 * 构建可用模型目录：只含已装 provider 的聊天模型，provider 按装载顺序（映射表顺序）、
 * 组内按目录顺序，稳定可预期。未配 key 的 provider 不出现（discoverProviders 没装它）。
 */
export function buildModelCatalog(
	models: MutableModels,
	registeredProviders: readonly string[],
): ModelCatalogEntry[] {
	const entries: ModelCatalogEntry[] = [];
	for (const provider of registeredProviders) {
		const providerName = models.getProvider(provider)?.name ?? provider;
		for (const model of models.getModels(provider)) {
			entries.push({ provider, providerName, modelId: model.id, name: model.name });
		}
	}
	return entries;
}

export { createModels };
export type { MutableModels };
