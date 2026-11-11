import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// 开发时把 /api 代理到 server 端口（STELLA_PORT，默认 7090）
const serverOrigin = process.env.STELLA_ORIGIN ?? "http://localhost:7090";

export default defineConfig({
	plugins: [react()],
	server: {
		proxy: {
			"/api": {
				target: serverOrigin,
				changeOrigin: false,
			},
		},
	},
});
