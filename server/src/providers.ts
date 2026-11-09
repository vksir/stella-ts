/**
 * Provider 自动发现与默认模型解析。
 *
 * 按「provider → 环境变量」映射表扫描进程环境变量：有 key 才把该 provider 装进
 * pi-ai 的 `Models` 目录。provider 名以 pi-ai 实际导出为准（deepseek / zai /
 * moonshotai-cn / openrouter / openai / anthropic / groq / xai）。
 */
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
 */
export function installFauxProvider(
	models: MutableModels,
	options?: { tokensPerSecond?: number },
): FauxProviderHandle {
	const faux = fauxProvider(
		options?.tokensPerSecond !== undefined ? { tokensPerSecond: options.tokensPerSecond } : undefined,
	);
	models.setProvider(faux.provider);
	faux.appendResponses([endlessFauxAnswer(faux)]); // 测试可用 setResponses 覆盖为确定性脚本
	return faux;
}

export interface ResolvedDefaultModel {
	readonly provider: string;
	readonly modelId: string;
	/** 缺省写法在目录中不存在时改用目录里的第一个模型；此处说明替代来源。 */
	readonly fallbackFrom?: string;
}

/**
 * 校验默认模型：provider 必须已注册，modelId 最好在目录里。
 * 目录是静态生成的，provider 也可能在线刷新目录；modelId 不在目录时不报错，
 * 改用该 provider 的第一个聊天模型并在启动日志说明。
 */
export function resolveDefaultModel(
	models: MutableModels,
	spec: { provider: string; modelId: string },
	registeredProviders: readonly string[],
): ResolvedDefaultModel {
	if (!registeredProviders.includes(spec.provider) && !registeredProviders.includes("faux")) {
		throw new Error(
			`STELLA_DEFAULT_MODEL 指定的 provider "${spec.provider}" 未启用：` +
				`没有在环境中找到它的 API key。已启用的 provider：${registeredProviders.join("、") || "（无）"}。` +
				`请配置对应 key 或改设 STELLA_DEFAULT_MODEL。`,
		);
	}
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
	return { provider: spec.provider, modelId: first.id, fallbackFrom: spec.modelId };
}

export { createModels };
export type { MutableModels };
