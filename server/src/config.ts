/**
 * Stella 服务端配置。
 *
 * 配置只读当前目录（server 进程工作目录）的 `.env`，外加仓库根目录的 `.env`
 * （npm workspaces 脚本会把工作目录切到 server/，此时仓库根是它的上一级）。
 * dotenv 不覆盖已存在的环境变量，因此先读到的（进程 cwd）优先。
 */
import { config as loadDotenvFile } from "dotenv";
import { resolve } from "node:path";

export function loadDotEnv(cwd: string = process.cwd()): void {
	loadDotenvFile({ path: resolve(cwd, ".env") });
	loadDotenvFile({ path: resolve(cwd, "../.env") });
}

export interface StellaConfig {
	/** 免 key 模式：faux provider + MemoryStorage，测试与本地体验用。 */
	readonly faux: boolean;
	/** server 监听端口。 */
	readonly port: number;
	/** SQLite 数据库路径（faux 模式下不使用）。 */
	readonly sqlitePath: string;
	/** 默认工作区目录（新会话工作目录的默认值）。 */
	readonly workspaceDir: string;
	/** 默认模型原始写法（provider/modelId）。 */
	readonly defaultModelSpec: string;
}

export const DEFAULT_MODEL_SPEC = "deepseek/deepseek-chat";
export const DEFAULT_PORT = 7090;
export const DEFAULT_DATA_DIR = "./data";

/** provider → 环境变量映射表（与 .env.example 一致）。 */
export const PROVIDER_ENV_VARS: Readonly<Record<string, string>> = {
	deepseek: "DEEPSEEK_API_KEY",
	zai: "ZAI_API_KEY",
	"moonshotai-cn": "MOONSHOT_API_KEY",
	openrouter: "OPENROUTER_API_KEY",
	openai: "OPENAI_API_KEY",
	anthropic: "ANTHROPIC_API_KEY",
	groq: "GROQ_API_KEY",
	xai: "XAI_API_KEY",
};

export function isFauxMode(env: NodeJS.ProcessEnv): boolean {
	return env.STELLA_FAUX === "1" || env.STELLA_FAUX === "true";
}

/** 解析 `provider/modelId` 形式的默认模型，写法非法时给出中文报错。 */
export function parseModelSpec(spec: string): { provider: string; modelId: string } {
	const slash = spec.indexOf("/");
	const provider = slash <= 0 ? "" : spec.slice(0, slash);
	const modelId = slash <= 0 ? "" : spec.slice(slash + 1);
	if (provider.length === 0 || modelId.length === 0) {
		throw new Error(
			`STELLA_DEFAULT_MODEL 写法无效："${spec}"。应为 provider/modelId 形式，例如 deepseek/deepseek-flash。`,
		);
	}
	return { provider, modelId };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): StellaConfig {
	const dataDir = env.STELLA_DATA_DIR?.trim() || DEFAULT_DATA_DIR;
	const spec = env.STELLA_DEFAULT_MODEL?.trim() || DEFAULT_MODEL_SPEC;
	parseModelSpec(spec); // 启动时即校验写法，给出明确中文报错
	const port = Number.parseInt(env.STELLA_PORT?.trim() ?? "", 10);
	return {
		faux: isFauxMode(env),
		port: Number.isInteger(port) && port > 0 ? port : DEFAULT_PORT,
		sqlitePath: resolve(dataDir, "stella.sqlite"),
		workspaceDir: resolve(dataDir, "workspace"),
		defaultModelSpec: spec,
	};
}
