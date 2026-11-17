import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// 开发时把 /api 代理到 server 端口（STELLA_PORT，默认 5810）
const serverOrigin = process.env.STELLA_ORIGIN ?? "http://localhost:5810";
// 监听地址显式用 IPv4 回环：Node 在 Windows 上把 "localhost" 解析成 ::1，只绑 IPv6 时
// 连 127.0.0.1 的都过不来（例如 SSH 隧道转发的目标）。
const host = process.env.STELLA_WEB_HOST ?? "127.0.0.1";
const port = Number(process.env.STELLA_WEB_PORT ?? 5811);

export default defineConfig({
	plugins: [react()],
	server: {
		host,
		port,
		// 端口被占用时直接失败，而不是悄悄换到 5174——隧道是按固定端口配的
		strictPort: true,
		proxy: {
			"/api": {
				target: serverOrigin,
				changeOrigin: false,
			},
		},
	},
});
