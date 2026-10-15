import type { AppKeybinding, CustomEditor } from "@earendil-works/pi-coding-agent";

/** Pi actions available as standalone normal-mode keys, not Vim editing commands. */
const NORMAL_MODE_FUNCTIONS = new Map<string, AppKeybinding>([
	["t", "app.thinking.toggle"],
]);

/** Called only in normal mode, after pending operators and prefixes are resolved. */
export function handleNormalModeFunction(key: string, editor: Pick<CustomEditor, "actionHandlers">): boolean {
	const action = NORMAL_MODE_FUNCTIONS.get(key);
	if (!action) return false;

	// Pi installs these handlers on CustomEditor. Reuse the real action rather
	// than hardcoding a shortcut or maintaining a second copy of its setting.
	editor.actionHandlers.get(action)?.();
	return true;
}
