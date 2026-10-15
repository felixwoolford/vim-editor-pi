import assert from "node:assert/strict";
import test from "node:test";
import type { CustomEditor, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, TuiMainScreen, type Terminal, visibleWidth } from "@earendil-works/pi-tui";
import vimEditor from "../extensions/vim-editor.ts";

function createEditor(text: string, padding = 0, rows = 40) {
	const tui = new TuiMainScreen({ rows, columns: 80 } as Terminal, false);
	tui.requestRender = () => {};
	let start: Function;
	let editor: CustomEditor;
	vimEditor({
		on(event: string, handler: Function) {
			if (event === "session_start") start = handler;
		},
	} as unknown as ExtensionAPI);
	start!({}, {
		mode: "tui",
		ui: {
			setEditorComponent(factory: Function) {
				editor = factory(tui, { borderColor: (s: string) => s }, { matches: () => false });
			},
		},
	});
	editor!.focused = true;
	editor!.setPaddingX(padding);
	editor!.setText(text);
	const keys = (input: string) => { for (const key of input) editor!.handleInput(key); };
	keys("gg0");
	return {
		editor: editor!, keys,
		render(width = 20) {
			const raw = editor!.render(width);
			assert.equal(raw.join("").split(CURSOR_MARKER).length - 1, 1, "retain the IME cursor marker");
			// Exercise pi's final deferred-cursor resolution, not just our raw SGR.
			const resolved = (tui as unknown as { resolveFakeCursors(lines: string[]): string[] }).resolveFakeCursors(raw);
			assert.ok(!resolved.join("").includes("\x1b_pi:fc"));
			assert.ok(!resolved.join("").includes("\x1b_pi:/fc"));
			return resolved.slice(1, -1).map(reverseCells);
		},
	};
}

/** Effective reverse-video state of every terminal column after pi renders. */
function reverseCells(row: string): boolean[] {
	row = row.replaceAll(CURSOR_MARKER, "");
	let reverse = false;
	const cells: boolean[] = [];
	for (const token of row.matchAll(/\x1b\[([\d;:]*)m|([^\x1b])/gu)) {
		if (token[1] !== undefined) {
			for (const code of token[1].split(";").map(Number)) {
				if (code === 0 || code === 27) reverse = false;
				if (code === 7) reverse = true;
			}
		} else {
			cells.push(...Array(visibleWidth(token[2]!)).fill(reverse));
		}
	}
	return cells;
}

test("forward visual selection highlights the cursor's row with a distinct cursor cell", () => {
	const { keys, render } = createEditor("abcdef");
	keys("vll");
	assert.deepEqual(render()[0], [true, true, ...Array(18).fill(false)]);
});

test("backward visual selection stays highlighted after the cursor", () => {
	const { keys, render } = createEditor("abcdef");
	keys("$v0");
	assert.deepEqual(render()[0], [false, ...Array(5).fill(true), ...Array(14).fill(false)]);
});

test("multiline visual selection highlights the cursor's row as well as other rows", () => {
	const { keys, render } = createEditor("abcdef\nghijkl");
	keys("j$vkh");
	const lines = render();
	assert.deepEqual(lines[0], [false, false, false, false, false, true, true, ...Array(13).fill(false)]);
	assert.deepEqual(lines[1], [...Array(6).fill(true), ...Array(14).fill(false)]);
});

test("swapping visual selection endpoints moves the cursor hole without losing highlighting", () => {
	const { keys, render } = createEditor("abcdef");
	keys("v$o");
	assert.deepEqual(render()[0].slice(0, 6), [false, true, true, true, true, true]);
	keys("o");
	assert.deepEqual(render()[0].slice(0, 6), [true, true, true, true, true, false]);
});

test("visual-line mode keeps highlighting after the cursor", () => {
	const { keys, render } = createEditor("abcdef\nghijkl");
	keys("Vjl");
	const lines = render();
	assert.deepEqual(lines[0].slice(0, 6), Array(6).fill(true));
	assert.deepEqual(lines[1].slice(0, 6), [true, false, true, true, true, true]);
});

test("wrapped visual selection respects padding and the cursor's display row", () => {
	const { editor, keys, render } = createEditor("abcdefghijkl", 2);
	keys("$v0");
	assert.deepEqual(render(10), [
		[false, false, false, true, true, true, true, true, false, false],
		[false, false, true, true, true, true, true, true, false, false],
	]);
	assert.equal(editor.getText(), "abcdefghijkl");
});

test("scrolled visual selection highlights the cursor's row", () => {
	const { keys, render } = createEditor(Array(9).fill("abcdef").join("\n"), 0, 10);
	keys("vG$");
	const lines = render();
	assert.equal(lines.length, 5);
	for (const line of lines.slice(0, -1)) assert.deepEqual(line.slice(0, 7), Array(7).fill(true));
	assert.deepEqual(lines.at(-1)!.slice(0, 6), [true, true, true, true, true, false]);
});
