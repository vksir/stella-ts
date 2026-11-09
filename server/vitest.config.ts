import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["test/**/*.test.ts"],
		// 单进程内起 app，faux provider 不打网络；保持默认 pool 即可
		testTimeout: 20_000,
	},
});
