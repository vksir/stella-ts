/**
 * Stella 的 harness 装配：pi-durable Harness + provider 目录 + 工具 + 人设 + 执行环境 + 存储。
 *
 * - 存储：SQLite（`node:sqlite`，Node ≥ 24）单文件 `data/stella.sqlite`；faux 模式用 MemoryStorage。
 * - 工具：自带 CodingTools（read/write/edit/bash），不自己写工具。
 * - 环境：`env` 回调按会话 agent 的 cwd 构建 NodeExecutionEnv，cwd 缺省为默认工作区。
 * - 提交重启恢复：打开存储后 `harness.resume()`。
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { parseModelSpec, type StellaConfig } from "./config.js";
import { StellaPersona } from "./persona.js";
import {
	createModels,
	discoverProviders,
	FAUX_MODEL,
	installFauxProvider,
	resolveDefaultModel,
	type MutableModels,
	type ResolvedDefaultModel,
} from "./providers.js";

export interface Stella {
	readonly config: StellaConfig;
	readonly harness: Harness;
	readonly defaultModel: ResolvedDefaultModel;
	/** pi-ai 模型目录：已装 provider 及其模型（模型列表端点与切换校验用）。 */
	readonly models: MutableModels;
	/** 已装 provider 名（装载顺序，与映射表一致）；模型目录按它排序。 */
	readonly registeredProviders: readonly string[];
	/** faux 模式下的句柄：测试脚本用它固定模型回答。 */
	readonly faux: ReturnType<typeof installFauxProvider> | undefined;
	close(): Promise<void>;
}

export interface CreateStellaOptions {
	/**
	 * faux 流式速率（tokens/s）。测试用它让 faux 回答逐 token 推进，
	 * 覆盖流式 partial 与停止场景；缺省瞬时完成，行为与 T1 一致。
	 */
	readonly fauxTokensPerSecond?: number;
	/**
	 * faux 模式的自定义模型目录（faux provider 原生支持）。缺省只有 faux-1；
	 * 模型切换测试传多个模型定义，才能验证「切换后下一条回答用新模型」。
	 */
	readonly fauxModels?: readonly { readonly id: string; readonly name?: string }[];
}

export async function createStella(
	config: StellaConfig,
	env: NodeJS.ProcessEnv = process.env,
	options: CreateStellaOptions = {},
): Promise<Stella> {
	const registry = createRegistry();
	registry.install(CodingTools); // read / write / edit / bash，自带即可
	registry.install(StellaPersona); // 英语人设 section

	const models: MutableModels = createModels();
	let faux: ReturnType<typeof installFauxProvider> | undefined;
	let registeredProviders: string[];
	if (config.faux) {
		faux = installFauxProvider(models, {
			...(options.fauxTokensPerSecond !== undefined
				? { tokensPerSecond: options.fauxTokensPerSecond }
				: {}),
			...(options.fauxModels !== undefined ? { fauxModels: options.fauxModels } : {}),
		});
		registeredProviders = ["faux"];
	} else {
		registeredProviders = discoverProviders(models, env);
		if (registeredProviders.length === 0) {
			throw new Error(
				"没有发现任何 provider 的 API key，Stella 无法启动。" +
					"请在 .env 中配置至少一个 key（支持 DEEPSEEK_API_KEY、ZAI_API_KEY、MOONSHOT_API_KEY、" +
					"OPENROUTER_API_KEY、OPENAI_API_KEY、ANTHROPIC_API_KEY、GROQ_API_KEY、XAI_API_KEY），" +
					"或设 STELLA_FAUX=1 以免 key 模式体验（faux provider + 内存存储）。" +
					"可参考 .env.example。",
			);
		}
	}

	// faux 模式固定用 faux/faux-1，忽略 STELLA_DEFAULT_MODEL
	const spec = config.faux ? FAUX_MODEL : parseModelSpec(config.defaultModelSpec);
	const defaultModel = resolveDefaultModel(models, spec, registeredProviders);
	if (defaultModel.fallbackFrom !== undefined) {
		console.warn(
			`[stella] 配置的默认模型 ${defaultModel.fallbackFrom} 不可用（provider 未装或模型不在目录），` +
				`已改用 ${defaultModel.provider}/${defaultModel.modelId}。` +
				`如需指定，请设置 STELLA_DEFAULT_MODEL（provider/modelId）。`,
		);
	}

	if (config.faux) {
		// faux + MemoryStorage：无运行时数据落盘
	} else {
		await mkdir(dirname(config.sqlitePath), { recursive: true });
	}
	await mkdir(config.workspaceDir, { recursive: true }); // 默认工作区

	const storage = config.faux ? new MemoryStorage() : await openNodeSqliteStorage(config.sqlitePath);
	const harness = await Harness.open(storage, {
		models,
		registry,
		env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? config.workspaceDir }),
	}, BACKGROUND_CONTEXT);
	harness.resume(); // 继续上一个进程未完成的运行

	return {
		config,
		harness,
		defaultModel,
		models,
		registeredProviders,
		faux,
		close: () => harness.close(BACKGROUND_CONTEXT).then(() => undefined),
	};
}
