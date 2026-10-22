import assert from "node:assert/strict";
import test from "node:test";
import { createEventBus, type CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import vimEditor from "../extensions/vim-editor.ts";
import { handleNormalModeFunction } from "../extensions/lib/normal-mode-functions.ts";

function createEditor() {
	let start: Function;
	let editor: CustomEditor;
	let toggles = 0;
	let renders = 0;
	const events = createEventBus();
	vimEditor({
		events,
		on(event: string, handler: Function) {
			if (event === "session_start") start = handler;
		},
	} as unknown as ExtensionAPI);
	start!({}, {
		mode: "tui",
		ui: {
			setEditorComponent(factory: Function) {
				editor = factory(
					{ requestRender() { renders++; } },
					{ borderColor: (text: string) => text },
					{ matches: (data: string, action: string) => action === "app.thinking.toggle" && matchesKey(data, "ctrl+t") },
				);
			},
		},
	});
	// Pi copies its built-in handlers onto the editor after creation.
	editor!.onAction("app.thinking.toggle", () => { toggles++; });
	editor!.setText("draft text");
	return { editor: editor!, events, toggles: () => toggles, renders: () => renders };
}

test("t invokes pi's current action without modifying the draft or cursor", () => {
	const { editor, toggles, renders } = createEditor();
	const cursor = editor.getCursor();
	const before = renders();
	editor.handleInput("t");
	editor.handleInput("t");
	assert.equal(toggles(), 2);
	assert.equal(editor.getText(), "draft text");
	assert.deepEqual(editor.getCursor(), cursor);
	assert.ok(renders() > before);
	// Resolve the handler at keypress time, not once at initialization.
	editor.onAction("app.thinking.toggle", () => {});
	editor.handleInput("t");
	assert.equal(toggles(), 2);
});

test("Kitty-encoded t works in normal mode", () => {
	const { editor, toggles } = createEditor();
	editor.handleInput("\x1b[116u");
	assert.equal(toggles(), 1);
});

for (const mode of ["i", ":", "!", "v", "V"]) {
	test(`t does not toggle after entering mode with ${mode}`, () => {
		const { editor, toggles } = createEditor();
		editor.handleInput(mode);
		const before = editor.getText();
		editor.handleInput("t");
		assert.equal(toggles(), 0);
		if (["i", ":", "!"].includes(mode)) assert.equal(editor.getText().length, before.length + 1);
		else assert.equal(editor.getText(), before);
	});
}

for (const prefix of ["d", "y", "c", "di", "ca", "g"]) {
	test(`t does not toggle while ${prefix} is pending`, () => {
		const { editor, toggles } = createEditor();
		for (const key of prefix) editor.handleInput(key);
		editor.handleInput("t");
		assert.equal(toggles(), 0);
		assert.equal(editor.getText(), "draft text");
		editor.handleInput("t");
		assert.equal(toggles(), 1);
	});
}

test("Ctrl+T is still forwarded in normal and insert modes", () => {
	const { editor, toggles } = createEditor();
	editor.handleInput("\x14");
	editor.handleInput("i");
	editor.handleInput("\x14");
	assert.equal(toggles(), 2);
});

for (const key of ["z", "\x1b[122u"]) {
	test(`${JSON.stringify(key)} emits toolview:toggle without modifying the draft or cursor`, () => {
		const { editor, events, toggles, renders } = createEditor();
		const received: unknown[] = [];
		const off = events.on("toolview:toggle", (data) => { received.push(data); });
		const cursor = editor.getCursor();
		const before = renders();
		editor.handleInput(key);
		editor.handleInput(key);
		assert.deepEqual(received, [undefined, undefined]);
		assert.equal(toggles(), 0);
		assert.equal(editor.getText(), "draft text");
		assert.deepEqual(editor.getCursor(), cursor);
		assert.ok(renders() > before);
		off();
		// The receiving extension need not be installed.
		assert.doesNotThrow(() => editor.handleInput(key));
		assert.equal(editor.getText(), "draft text");
	});
}

for (const mode of ["i", ":", "!", "v", "V"]) {
	test(`z does not emit after entering mode with ${mode}`, () => {
		const { editor, events } = createEditor();
		let emissions = 0;
		events.on("toolview:toggle", () => { emissions++; });
		editor.handleInput(mode);
		const before = editor.getText();
		editor.handleInput("z");
		assert.equal(emissions, 0);
		if (["i", ":", "!"].includes(mode)) assert.ok(editor.getText().includes("z"));
		else assert.equal(editor.getText(), before);
	});
}

for (const prefix of ["d", "y", "c", "di", "ca", "g"]) {
	test(`z does not emit while ${prefix} is pending`, () => {
		const { editor, events } = createEditor();
		let emissions = 0;
		events.on("toolview:toggle", () => { emissions++; });
		for (const key of prefix) editor.handleInput(key);
		editor.handleInput("z");
		assert.equal(emissions, 0);
		assert.equal(editor.getText(), "draft text");
		editor.handleInput("z");
		assert.equal(emissions, 1);
	});
}

test("unknown keys and absent handlers are safe", () => {
	const editor = { actionHandlers: new Map() };
	assert.equal(handleNormalModeFunction("t", editor), true);
	assert.equal(handleNormalModeFunction("z", editor), true);
	assert.equal(handleNormalModeFunction("T", editor), false);
	assert.equal(handleNormalModeFunction("unknown", editor), false);
});
