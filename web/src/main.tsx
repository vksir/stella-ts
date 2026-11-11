/** 入口：主题初始化 + React root + 启动 store。 */

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./ui/App";
import { store } from "./store/app-store";
import { initTheme } from "./theme";
import "./style.css";

initTheme();

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<App />
	</StrictMode>,
);

// DEV-only 诊断句柄：排查"增量更新没生效"这类问题时可从控制台直接读 store 内部状态。
// 生产构建会被 Vite 静态替换成 false 并摇掉。
if (import.meta.env.DEV) {
	(window as unknown as { __stellaStore?: typeof store }).__stellaStore = store;
}

void store.boot().catch((error) => store.showError(error));
