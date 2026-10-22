import type { AppKeybinding, CustomEditor, ExtensionAPI } from "@earendil-works/pi-coding-agent";

type NormalModeFunction = { action: AppKeybinding } | { emit: string };

/** Pi actions and extension events available as standalone normal-mode keys. */
const NORMAL_MODE_FUNCTIONS = new Map<string, NormalModeFunction>([
	["t", { action: "app.thinking.toggle" }],
	["z", { emit: "toolview:toggle" }],
]);

/** Called only in normal mode, after pending operators and prefixes are resolved. */
export function handleNormalModeFunction(
	key: string,
	editor: Pick<CustomEditor, "actionHandlers">,
	emitEvent?: ExtensionAPI["events"]["emit"],
): boolean {
	const fn = NORMAL_MODE_FUNCTIONS.get(key);
	if (!fn) return false;

	if ("emit" in fn) {
		// No listener means a harmless no-op when the receiving extension is absent.
		emitEvent?.(fn.emit, undefined);
	} else {
		// Pi installs these handlers on CustomEditor. Reuse the real action rather
		// than hardcoding a shortcut or maintaining a second copy of its setting.
		editor.actionHandlers.get(fn.action)?.();
	}
	return true;
}
