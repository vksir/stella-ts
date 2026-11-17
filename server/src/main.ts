/**
 * Stella 服务端入口：装配 harness 与 Hono 应用，启动 HTTP 服务。
 *
 * 开发：仓库根 `npm run dev`（tsx watch 热重载；前端由 Vite 伺服并代理 /api）。
 * 生产：仓库根 `npm run build` 后 `npm start`（node dist/main.js，同时伺服 web/dist）。
 */
import { serve } from "@hono/node-server";
import { isLoopbackHost, loadConfig, loadDotEnv } from "./config.js";
import { createApp } from "./api.js";
import { assertDeploymentSafety, resolveLoginKey } from "./auth.js";
import { createStella } from "./stella.js";

async function main(): Promise<void> {
	loadDotEnv();
	const base = loadConfig(process.env);
	// 登录密钥：显式配置 → 直接生效；faux → 免登录；其余（首次部署）→ 生成并写入 .env。
	const auth = base.token === undefined ? resolveLoginKey(process.env, { faux: base.faux }) : { key: base.token };
	const config = { ...base, token: auth.key };
	// 非回环 + 无密钥 / 弱密钥 / 未显式配置 HTTPS 时，直接在启动阶段失败，
	// 不把“无鉴权”或“明文”的入口暴露到网络上。
	assertDeploymentSafety(config);
	const stella = await createStella(config, process.env, {
		...(config.fauxRate !== undefined ? { fauxTokensPerSecond: config.fauxRate } : {}),
	});
	const app = createApp(stella);

	const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
		console.log(`[stella] 服务已启动：http://${config.host === "0.0.0.0" ? "localhost" : config.host}:${info.port}`);
		if (auth.note !== undefined) console.log(`[stella] ${auth.note}`);
		if (config.token === undefined) {
			console.warn("[stella] 当前未启用登录密钥：任何能访问该端口的人都能使用 Stella。");
		} else {
			console.log(
				"[stella] 已启用登录密钥：首次打开页面需输入。" +
					"轮换方式：改 .env 的 STELLA_TOKEN 后重启（所有浏览器需重新登录）。",
			);
		}
		if (!isLoopbackHost(config.host)) {
			console.warn(
				`[stella] 监听 ${config.host}:${info.port} —— 局域网/公网可达；` +
					"请确认已启用登录密钥，并让反向代理终止 TLS（Stella 自身不提供 HTTPS）。",
			);
			if (config.httpsRequired) {
				console.log(
					"[stella] 已开启 HTTPS 强制：除 /api/health 外的所有 /api 请求都要求" +
						"可信 X-Forwarded-Proto: https。",
				);
			} else if (config.httpsConfigured) {
				console.warn(
					"[stella] 已显式关闭 HTTPS 强制（STELLA_REQUIRE_HTTPS=0）：" +
						"非回环监听上的登录密钥与 30 天票据可能明文过网。",
				);
			}
			if (config.trustedProxies.every((entry) => entry === "127.0.0.1" || entry === "::1")) {
				console.warn(
					"[stella] STELLA_TRUSTED_PROXY 仍是默认回环：若反向代理不在本机" +
						"（Docker 网桥/另一台机器），真实来源与 X-Forwarded-Proto 都不会生效；" +
						"请把反代地址或网段加进该变量。",
				);
			}
		}
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

	// 端口被占用时给出可行动的中文提示，而不是裸 EADDRINUSE 堆栈
	server.on("error", (err: NodeJS.ErrnoException) => {
		if (err.code === "EADDRINUSE") {
			console.error(
				`[stella] 端口 ${config.port} 已被占用（可能是上一进程未退出）。` +
					` 可执行 netstat -ano | findstr :${config.port} 找到 PID 后 taskkill /F /PID <PID>，或用 STELLA_PORT 换端口。`,
			);
		} else {
			console.error("[stella] HTTP 服务出错：", err);
		}
		process.exit(1);
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
