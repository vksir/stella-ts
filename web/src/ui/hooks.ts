/** React 侧共享 hooks（独立文件，避免 App ↔ Composer 循环导入）。 */

import { useEffect, useState, useSyncExternalStore } from "react";
import { store, type AppSnapshot } from "../store/app-store";

/** 订阅 app 级快照。 */
export function useApp(): AppSnapshot {
	return useSyncExternalStore(store.subscribeApp, store.getApp);
}

/** 订阅单个 flow 节点。 */
export function useNode(key: string) {
	return useSyncExternalStore(
		(cb) => store.subscribeNode(key, cb),
		() => store.getNode(key),
	);
}

/** 订阅 flow keys 列表。 */
export function useFlowKeys(): readonly string[] {
	return useSyncExternalStore(store.subscribeKeys, store.getKeys);
}

/** matchMedia 响应式查询。 */
export function useMedia(query: string): boolean {
	const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
	useEffect(() => {
		const mql = window.matchMedia(query);
		const onChange = (): void => setMatches(mql.matches);
		mql.addEventListener("change", onChange);
		return () => mql.removeEventListener("change", onChange);
	}, [query]);
	return matches;
}
