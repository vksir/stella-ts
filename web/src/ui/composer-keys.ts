/**
 * Composer 的键盘判定（抽成独立模块以便单测：Composer 依赖 store 与浏览器 API，
 * 在 Node 里加载不了）。
 */

/**
 * 键盘事件是否发生在输入法组合过程中。
 *
 * 组合期间（中文/日文/韩文选词）的 Enter 属于「确认候选词」，应用层不能当成提交，
 * 否则用户敲拼音按回车会把半截内容发出去。`keyCode === 229` 是 Safari 旧版本在组合
 * 期间给出的值（此时 `isComposing` 可能为 undefined）。
 */
export function isComposingEvent(e: {
	keyCode?: number;
	nativeEvent?: { isComposing?: boolean };
}): boolean {
	return e.nativeEvent?.isComposing === true || e.keyCode === 229;
}
