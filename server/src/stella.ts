/**
 * Stella 的 harness 装配：pi-durable Harness + provider 目录 + 工具 + 人设 + 执行环境 + 存储。
 *
 * - 存储：SQLite（`node:sqlite`，Node ≥ 24）单文件 `data/stella.sqlite`；faux 模式用 MemoryStorage。
 * - 工具：CodingTools（read/write/edit/bash，read 带图片处理器）+ 代码模式 + 前台子代理。
 * - 安全：`StellaGuard` 只拦毁灭性命令；能力边界由预设负责。
 * - 配置：`data/stella.config.json`（可选）承载 HarnessSettings / 预设 / 默认 maxTurns；
 *   settings 以 getter 传入，文件变更热更新，不需要重启 Harness。
 * - 环境：`env` 回调按会话 agent 的 cwd 构建 NodeExecutionEnv，cwd 缺省为默认工作区。
 * - 提交重启恢复：打开存储后 `harness.resume()`。
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import {
	createRegistry,
	Harness,
	MemoryStorage,
	type Extension,
	type Registry,
	type Report,
} from "@earendil-works/pi-durable";
import { createNodePhotonImages } from "@earendil-works/pi-durable/images/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools, createCodingTools } from "@earendil-works/pi-durable/tools";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { parseModelSpec, type StellaConfig } from "./config.js";
import { ConversationMeta, initialConversationMeta } from "./conversations.js";
import { StellaGuard } from "./guard.js";
import { StellaPersona } from "./extensions/persona.js";
import { StellaSkills, SkillsStore } from "./extensions/skills/index.js";
import { StellaSettingsStore } from "./settings.js";
import { StellaSubagent } from "./extensions/subagent.js";
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
	/** 运行配置（HarnessSettings / 预设 / 默认 maxTurns），文件热更新。 */
	readonly settings: StellaSettingsStore;
	/** 扩展/工具注册表（预设按名字解析用）。 */
	readonly registry: Registry;
	/** 技能目录与扫描结果（新会话按预设白名单取用）。 */
	readonly skills: SkillsStore;
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

/** 标准预设的 read 工具：有图片处理器就带上，失败时退回纯文本/直传图片。 */
async function codingExtension(): Promise<Extension> {
	try {
		return createCodingTools({ images: await createNodePhotonImages() });
	} catch (error) {
		console.warn("[stella] 图片处理器初始化失败，read 将只直传小图：", error);
		return CodingTools;
	}
}

/** 调试/诊断用：把非致命失败分类打到服务端日志，不改变运行结果。 */
function logReport(report: Report): void {
	const task = "task" in report && report.task !== undefined ? report.task : undefined;
	const where = [
		task === undefined ? "" : `task=${task.id}(${task.kind})`,
		task?.conversationId === undefined ? "" : `conversation=${task.conversationId}`,
		"extension" in report && report.extension !== undefined ? `extension=${report.extension}` : "",
		"callback" in report ? `callback=${report.callback}` : "",
	]
		.filter((part) => part.length > 0)
		.join(" ");
	const message = report.error instanceof Error ? report.error.message : String(report.error);
	const line = `[stella] report ${report.kind}${where.length > 0 ? ` ${where}` : ""}: ${message}`;
	if (report.kind === "storage_failed" || report.kind === "task_faulted" || report.kind === "task_interrupted") {
		console.error(line);
	} else {
		console.warn(line);
	}
}

export async function createStella(
	config: StellaConfig,
	env: NodeJS.ProcessEnv = process.env,
	options: CreateStellaOptions = {},
): Promise<Stella> {
	const settingsStore = new StellaSettingsStore(config.configPath);
	settingsStore.load();

	const registry = createRegistry();
	registry.install(await codingExtension()); // read / write / edit / bash（read 带图片）
	registry.install(StellaPersona); // 万用日常型人设 section
	registry.install(StellaSkills); // 系统提示里的技能索引（正文由 read 按需读取）
	registry.install(StellaGuard); // 毁灭性命令兜底
	registry.install(
		createCodemodeExtension({
			sandbox: new CodemodeSandbox({ memoryLimitBytes: 256 * 1024 * 1024 }),
		}),
	);
	registry.install(StellaSubagent); // 前台子代理

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
	settingsStore.startWatching(); // 目录已存在，首次启动也能监听配置文件
	const skillsStore = new SkillsStore(config.skillsDir);
	await skillsStore.start(); // 建技能目录、扫描一次、监听变化（只影响新会话）

	const storage = config.faux ? new MemoryStorage() : await openNodeSqliteStorage(config.sqlitePath);
	const harness = await Harness.open(
		storage,
		{
			models,
			registry,
			env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? config.workspaceDir }),
			settings: () => settingsStore.settings,
			identity: { attribution: { name: "Stella", url: config.attributionUrl } },
			onReport: logReport,
			// 每个会话（含子代理创建的子会话）都在创建 commit 里拿到元数据文档。
			conversationCreated: async (tx, conversation) => {
				Object.assign(await tx.doc(ConversationMeta, conversation.id), initialConversationMeta());
			},
		},
		BACKGROUND_CONTEXT,
	);
	harness.resume(); // 继续上一个进程未完成的运行

	return {
		config,
		harness,
		defaultModel,
		models,
		registeredProviders,
		settings: settingsStore,
		registry,
		skills: skillsStore,
		faux,
		close: async () => {
			settingsStore.stop();
			skillsStore.stop();
			await harness.close(BACKGROUND_CONTEXT);
		},
	};
}
