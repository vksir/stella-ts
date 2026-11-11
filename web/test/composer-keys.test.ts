/**
 * 输入框键盘语义单测（`src/ui/Composer.tsx` 的 `isComposingEvent`）。
 *
 * 背景：中文/日文/韩文输入法在选词时按 Enter 是"确认候选"，不是提交。修复前
 * 应用层的 onKeyDown 无条件发送，导致用户敲拼音按回车时把半截内容发出去
 * （实测：`isComposing: true` 的 Enter 仍会把消息发走）。这里把判定规则钉住。
 */

import { describe, expect, it } from "vitest";
import { isComposingEvent } from "../src/ui/composer-keys";

function keyEvent(init: { isComposing?: boolean; keyCode?: number; key?: string }) {
	return {
		key: init.key ?? "Enter",
		keyCode: init.keyCode ?? 0,
		nativeEvent: { isComposing: init.isComposing } as KeyboardEvent & { isComposing?: boolean },
	} as never;
}

describe("输入法组合期间的键盘判定", () => {
	it("isComposing=true 视为组合中（不发送）", () => {
		expect(isComposingEvent(keyEvent({ isComposing: true }))).toBe(true);
	});

	it("keyCode 229 视为组合中（Safari 老版本兜底）", () => {
		expect(isComposingEvent(keyEvent({ keyCode: 229 }))).toBe(true);
	});

	it("普通 Enter 不算组合（正常发送）", () => {
		expect(isComposingEvent(keyEvent({ isComposing: false, keyCode: 13 }))).toBe(false);
	});

	it("isComposing 缺失（浏览器不填）时不阻断", () => {
		expect(isComposingEvent(keyEvent({ keyCode: 13 }))).toBe(false);
	});
});
