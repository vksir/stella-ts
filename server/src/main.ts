/**
 * Stella 服务端入口：装配 harness 与 Hono 应用，启动 HTTP 服务。
 *
 * 开发：仓库根 `npm run dev`（tsx watch 热重载；前端由 Vite 伺服并代理 /api）。
 * 生产：仓库根 `npm run build` 后 `npm start`（node dist/main.js，同时伺服 web/dist）。
 */
import { serve } from "@hono/node-server";
import { loadConfig, loadDotEnv } from "./config.js";
import { createApp } from "./api.js";
import { createStella } from "./stella.js";

async function main(): Promise<void> {
	loadDotEnv();
	const config = loadConfig(process.env);
	const stella = await createStella(config, process.env);
	const app = createApp(stella);

	const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
		console.log(`[stella] 服务已启动：http://localhost:${info.port}`);
		if (config.faux) {
			console.log(
				"[stella] STELLA_FAUX=1：faux provider + 内存存储，回答为内置示例；" +
					"真实对话请配置 provider API key 并关闭 STELLA_FAUX。",
			);
		} else {
			console.log(`[stella] 默认模型：${stella.defaultModel.provider}/${stella.defaultModel.modelId}`);
			console.log(`[stella] 存储：${config.sqlitePath}，默认工作区：${config.workspaceDir}`);
		}
	});

	// harness 因存储错误自关时退出进程，交给进程管理器重启（README「Errors」）
	void stella.harness.closed.then((end) => {
		if (end.kind === "failed") {
			console.error("[stella] harness 失败，进程退出：", end.error);
			process.exitCode = 1;
			server.close();
		}
	});

	const shutdown = (signal: string): void => {
		console.log(`[stella] 收到 ${signal}，正在关闭…`);
		server.close(() => undefined);
		void stella.close().finally(() => process.exit(0));
	};
	process.once("SIGINT", () => shutdown("SIGINT"));
	process.once("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((error) => {
	console.error("[stella] 启动失败：", error instanceof Error ? error.message : error);
	process.exitCode = 1;
});
