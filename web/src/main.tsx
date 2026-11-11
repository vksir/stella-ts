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

void store.boot().catch((error) => store.showError(error));
