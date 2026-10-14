/**
 * vim-editor.ts — modal (vim-like) editing for the pi input box.
 *
 *   pi --extension ./vim-editor.ts
 *   # or: cp vim-editor.ts ~/.pi/agent/extensions/
 *
 * Modes: insert, normal, visual (charwise), visual-line.
 *
 * Normal mode
 *   h j k l 0 ^ $ w b e gg G   motions
 *   i I a A o O                enter insert mode
 *   x X D C                    delete char / to end of line, change to end of line
 *   u                          undo
 *   v V                        visual / visual-line mode
 *   : !                        command / bash mode (see below)
 *   y d c                      operators (see below)
 *   p P                        paste after / before cursor
 *   enter                      submit the prompt
 *   ctrl+escape                abort the running agent (pi's normal escape)
 *   escape                     cancel a pending operator, otherwise nothing
 *
 * Ctrl+Escape needs a terminal that reports modified Escape (Kitty keyboard
 * protocol, or xterm's modifyOtherKeys), and a desktop that doesn't grab it
 * first -- KDE Plasma binds Ctrl+Esc to System Monitor by default.
 *
 * Operators compose with motions and the aw/iw text objects:
 *   yy dd cc     whole line (linewise)
 *   yaw yiw daw diw caw ciw
 *   yw yb ye y$ y0 y^ yh yl    (and the d/c equivalents)
 *   yj yk dj dk                two lines, linewise
 *
 * Visual / visual-line
 *   motions extend the selection, o swaps ends
 *   y d x c      yank / delete / change the selection
 *   v V escape   switch or leave
 *
 * Command mode
 *   ':' parks whatever you were drafting, clears the box and types "/", which
 *   brings up pi's own slash-command menu. '!' does the same with "!", for a
 *   shell command (type a second '!' for pi's !! form). Enter runs it; escape,
 *   or backspacing off the leading character, aborts. Either way your draft
 *   comes back, the way vim's command line leaves the buffer alone.
 *
 * Insert mode
 *   enter        inserts a newline (does NOT submit)
 *   ctrl+enter   submits
 *   escape       back to normal mode
 *
 * Submitting: ctrl+enter from any mode, or enter from NORMAL mode. Ctrl+Enter
 * needs a terminal that reports modified Enter (Kitty keyboard protocol:
 * kitty, ghostty, WezTerm, foot, recent Alacritty). Terminals without it send
 * a bare CR for both, indistinguishable from plain Enter -- normal-mode enter
 * is the fallback that always works. Shift+Enter and Ctrl+J still insert a
 * newline in either mode, as they do in stock pi.
 *
 * Visual and visual-line selections are highlighted in the input box.
 *
 * Cursor shape: normal and visual modes use pi's drawn block cursor. Insert
 * mode draws a thin one instead -- see INSERT_CURSOR_STYLE below.
 */

import { CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	CURSOR_MARKER,
	decodeKittyPrintable,
	matchesKey,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";

/** Start each prompt in normal mode rather than insert mode. */
const START_IN_NORMAL = true;

/**
 * SGR applied to the visual-mode selection. Reverse video works on every
 * terminal and under any theme. For a background tint instead, use something
 * like "\x1b[48;5;238m" (dark) or "\x1b[48;5;253m" (light) -- but those
 * assume a 256-colour terminal and a matching theme.
 */
const SELECTION_SGR = "\x1b[7m";
/**
 * Applied to the cursor cell when it falls inside the selection. pi draws the
 * cursor with reverse video, which a reverse-video selection would swallow, so
 * turn reverse back off there and the cursor reads as a hole in the block.
 * If SELECTION_SGR is changed to a background colour, set this to "" instead.
 */
const SELECTION_CURSOR_SGR = "\x1b[27m";
const RESET_SGR = "\x1b[0m";

/** The reverse-video run pi uses to draw its own block cursor. */
const BLOCK_CURSOR_SGR = "\x1b[7m";

/**
 * How the insert-mode cursor is drawn.
 *
 *   "underline"  Drawn into the frame, exactly like pi's block cursor but as a
 *                thin line. Always sits in the right place.
 *   "bar"        The terminal's own beam, via DECSCUSR. A true vertical bar,
 *                but its position is written after the frame rather than as
 *                part of it, so it can lag behind fast typing and sit at the
 *                edge of the input box until the next keypress settles it.
 *   "block"      Same block cursor as normal mode.
 */
const INSERT_CURSOR_STYLE: "underline" | "bar" | "block" = "underline";

/**
 * Put the parked draft back after a command actually runs, not just when it is
 * aborted. Set false if you would rather the box stay empty afterwards.
 */
const RESTORE_DRAFT_AFTER_COMMAND = true;

/** SGR for the "underline" style. 4 = underline, 4:3 = curly on some terminals. */
const UNDERLINE_CURSOR_SGR = "\x1b[4m";

/**
 * DECSCUSR shapes for the "bar" style. 6 = steady bar, 5 = blinking bar,
 * 2 = steady block, 4 = steady underline, 0 = terminal default.
 */
const INSERT_CURSOR_SHAPE = "\x1b[6 q";
const RESTORE_CURSOR_SHAPE = "\x1b[0 q";

type Mode = "insert" | "normal" | "visual" | "vline" | "command";
type Operator = "y" | "d" | "c";
type Pos = { line: number; col: number };
type Register = { text: string; linewise: boolean };
type Pending =
	| { op: Operator; want: "motion" }
	| { op: Operator; want: "textobject"; kind: "a" | "i" };
/** What was in the input box before ':' or '!' took it over. */
type Draft = { text: string; line: number; col: number };

/**
 * Normal-mode keys that open a command line, mapped to the character they type
 * into the cleared box and the label shown while it is open. The character is
 * sent as a real keystroke, so pi reacts exactly as it would to typing it --
 * "/" opens the slash-command menu, "!" starts a shell command.
 */
const COMMAND_KEYS: Record<string, { lead: string; label: string }> = {
	":": { lead: "/", label: " COMMAND " },
	"!": { lead: "!", label: " BASH " },
};

/**
 * Editor internals we reach into. These are `private` in the TypeScript
 * declarations but `private` is erased at runtime, so a subclass can use them.
 * This is the only version-fragile part of the extension: if pi's Editor
 * changes its internal state shape, this interface is what needs updating.
 * Verified against @earendil-works/pi-tui 0.85.0.
 */
interface EditorInternals {
	state: { lines: string[]; cursorLine: number; cursorCol: number };
	setCursorCol(col: number): void;
	pushUndoSnapshot(): void;
	undo(): void;
	lastAction: unknown;
	/** Only used for selection highlighting; see highlightSelection(). */
	layoutText(contentWidth: number): { text: string }[];
	lastWidth: number;
	scrollOffset: number;
	renderedVisibleLineCount: number;
}

/** One wrapped display line, mapped back to its logical line and column. */
interface VisualLine {
	logical: number;
	start: number;
	text: string;
	last: boolean;
}

/**
 * Length of the terminal escape sequence starting at `pos`, or 0.
 * Covers CSI (colours) and the string sequences (OSC/APC/DCS/PM) -- pi emits a
 * zero-width APC marker for hardware cursor placement, which must be passed
 * through untouched or IME candidate windows land in the wrong spot.
 */
function ansiLength(str: string, pos: number): number {
	if (str[pos] !== "\x1b") return 0;
	const next = str[pos + 1];
	if (next === "[") {
		let j = pos + 2;
		while (j < str.length && !/[a-zA-Z]/.test(str[j]!)) j++;
		return j < str.length ? j + 1 - pos : 0;
	}
	if (next === "]" || next === "_" || next === "P" || next === "^") {
		let j = pos + 2;
		while (j < str.length) {
			if (str[j] === "\x07") return j + 1 - pos;
			if (str[j] === "\x1b" && str[j + 1] === "\\") return j + 2 - pos;
			j++;
		}
		return 0;
	}
	return 0;
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * Wrap visible columns [c0, c1) of an already-rendered line in `sgr`.
 * Walks the string once so every escape sequence is preserved exactly where it
 * was, and re-asserts `sgr` after any reset inside the range -- the cursor cell
 * ends with one, which would otherwise cut the highlight short.
 */
function highlightColumns(line: string, c0: number, c1: number, sgr: string): string {
	if (c1 <= c0) return line;

	// Split into escape sequences and graphemes first, so the highlight can be
	// opened at a column boundary before any escape sequence sitting on it.
	const tokens: ({ ansi: string } | { text: string; width: number })[] = [];
	let i = 0;
	while (i < line.length) {
		const len = ansiLength(line, i);
		if (len > 0) {
			tokens.push({ ansi: line.slice(i, i + len) });
			i += len;
			continue;
		}
		let end = i;
		while (end < line.length && ansiLength(line, end) === 0) end++;
		for (const { segment } of graphemes.segment(line.slice(i, end))) {
			tokens.push({ text: segment, width: visibleWidth(segment) });
		}
		i = end;
	}

	let out = "";
	let col = 0;
	let on = false;
	for (const token of tokens) {
		if (!on && col >= c0 && col < c1) {
			out += sgr;
			on = true;
		} else if (on && col >= c1) {
			out += RESET_SGR;
			on = false;
		}
		if ("ansi" in token) {
			if (on && token.ansi === sgr) {
				out += SELECTION_CURSOR_SGR; // the cursor cell
			} else {
				out += token.ansi;
				// The cursor cell ends with a reset, which would otherwise cut
				// the highlight short.
				if (on && /^\x1b\[0?m$/.test(token.ansi)) out += sgr;
			}
		} else {
			out += token.text;
			col += token.width;
		}
	}
	return on ? out + RESET_SGR : out;
}

/**
 * Ctrl+Escape press (or repeat). Checked by hand as well as via matchesKey in
 * case pi-tui doesn't know the "ctrl+escape" id:
 *   \x1b[27;5u  / \x1b[27;5:1u / \x1b[27;5:2u   Kitty protocol (press/repeat)
 *   \x1b[27;5;27~                                xterm modifyOtherKeys
 * Legacy terminals send a bare \x1b for Ctrl+Esc, which can't be told apart
 * from Escape at all.
 */
function isCtrlEscape(data: string): boolean {
	return matchesKey(data, "ctrl+escape") || /^\x1b\[(?:27;5(?::[12])?u|27;5;27~)$/.test(data);
}

/**
 * The plain-Escape sequence to forward in place of a Ctrl+Escape, in the same
 * encoding the terminal used, so pi's own escape handling recognises it.
 */
function plainEscapeFor(data: string): string {
	return data.startsWith("\x1b[27;5") && data.endsWith("u") ? "\x1b[27u" : "\x1b";
}

const BLANK = 0;
const WORD = 1;
const PUNCT = 2;

function charClass(ch: string | undefined): number {
	if (!ch) return BLANK;
	if (/\s/.test(ch)) return BLANK;
	if (/[A-Za-z0-9_]/.test(ch)) return WORD;
	return PUNCT;
}

function cmp(a: Pos, b: Pos): number {
	return a.line !== b.line ? a.line - b.line : a.col - b.col;
}

class VimEditor extends CustomEditor {
	private mode: Mode = START_IN_NORMAL ? "normal" : "insert";
	private pending: Pending | null = null;
	private gPending = false;
	private anchor: Pos = { line: 0, col: 0 };
	private register: Register = { text: "", linewise: false };
	private draft: Draft | null = null;
	private commandLabel = " COMMAND ";

	// ---------------------------------------------------------------- access

	private get inner(): EditorInternals {
		return this as unknown as EditorInternals;
	}

	private get lines(): string[] {
		return this.inner.state.lines;
	}

	private get cur(): Pos {
		return { line: this.inner.state.cursorLine, col: this.inner.state.cursorCol };
	}

	private setCursor(line: number, col: number): void {
		const st = this.inner.state;
		st.cursorLine = Math.max(0, Math.min(line, st.lines.length - 1));
		const len = st.lines[st.cursorLine]?.length ?? 0;
		this.inner.setCursorCol(Math.max(0, Math.min(col, len)));
	}

	/** In normal/visual mode the cursor sits *on* a character, not past the end. */
	private clampNormal(): void {
		if (this.mode === "insert" || this.mode === "command") return;
		const st = this.inner.state;
		const len = st.lines[st.cursorLine]?.length ?? 0;
		if (st.cursorCol > Math.max(0, len - 1)) {
			this.inner.setCursorCol(Math.max(0, len - 1));
		}
	}

	/** Commit a whole-buffer edit, mirroring how Editor mutates itself. */
	private commit(lines: string[], line: number, col: number): void {
		const st = this.inner.state;
		this.inner.pushUndoSnapshot();
		this.inner.lastAction = null;
		st.lines = lines.length === 0 ? [""] : lines;
		this.setCursor(line, col);
		this.onChange?.(this.getText());
	}

	// ------------------------------------------------------------- offsets

	private toOffset(p: Pos): number {
		let off = 0;
		for (let i = 0; i < p.line; i++) off += (this.lines[i]?.length ?? 0) + 1;
		return off + p.col;
	}

	private toPos(off: number): Pos {
		const L = this.lines;
		let rem = Math.max(0, off);
		for (let i = 0; i < L.length; i++) {
			const len = L[i]?.length ?? 0;
			if (rem <= len) return { line: i, col: rem };
			rem -= len + 1;
		}
		const last = L.length - 1;
		return { line: last, col: L[last]?.length ?? 0 };
	}

	// ------------------------------------------------------- word motions

	private wordForward(off: number): number {
		const s = this.getText();
		const n = s.length;
		if (off >= n) return n;
		let i = off;
		const cls = charClass(s[i]);
		if (cls !== BLANK) while (i < n && charClass(s[i]) === cls) i++;
		while (i < n && charClass(s[i]) === BLANK) i++;
		return i;
	}

	private wordBackward(off: number): number {
		const s = this.getText();
		let i = off - 1;
		while (i >= 0 && charClass(s[i]) === BLANK) i--;
		if (i < 0) return 0;
		const cls = charClass(s[i]);
		while (i >= 0 && charClass(s[i]) === cls) i--;
		return i + 1;
	}

	private wordEnd(off: number): number {
		const s = this.getText();
		const n = s.length;
		let i = off + 1;
		while (i < n && charClass(s[i]) === BLANK) i++;
		if (i >= n) return Math.max(off, n - 1);
		const cls = charClass(s[i]);
		while (i + 1 < n && charClass(s[i + 1]) === cls) i++;
		return i;
	}

	/** aw / iw. Text objects do not cross line boundaries. */
	private wordObject(around: boolean): { a: Pos; b: Pos } | null {
		const p = this.cur;
		const line = this.lines[p.line] ?? "";
		if (line.length === 0) return null;
		const i = Math.min(p.col, line.length - 1);
		const cls = charClass(line[i]);
		let start = i;
		let end = i;
		while (start > 0 && charClass(line[start - 1]) === cls) start--;
		while (end + 1 < line.length && charClass(line[end + 1]) === cls) end++;
		let e = end + 1;
		if (around) {
			const before = e;
			while (e < line.length && charClass(line[e]) === BLANK) e++;
			if (e === before) {
				while (start > 0 && charClass(line[start - 1]) === BLANK) start--;
			}
		}
		return { a: { line: p.line, col: start }, b: { line: p.line, col: e } };
	}

	// ------------------------------------------------------------- regions

	private textBetween(a: Pos, b: Pos): string {
		const L = this.lines;
		if (a.line === b.line) return (L[a.line] ?? "").slice(a.col, b.col);
		const out = [(L[a.line] ?? "").slice(a.col)];
		for (let i = a.line + 1; i < b.line; i++) out.push(L[i] ?? "");
		out.push((L[b.line] ?? "").slice(0, b.col));
		return out.join("\n");
	}

	private removeBetween(a: Pos, b: Pos): string[] {
		const L = [...this.lines];
		const head = (L[a.line] ?? "").slice(0, a.col);
		const tail = (L[b.line] ?? "").slice(b.col);
		L.splice(a.line, b.line - a.line + 1, head + tail);
		return L;
	}

	// ----------------------------------------------------------- operators

	private applyCharwise(op: Operator, from: Pos, to: Pos): void {
		let a = from;
		let b = to;
		if (cmp(a, b) > 0) [a, b] = [b, a];
		this.register = { text: this.textBetween(a, b), linewise: false };
		if (op === "y") {
			this.setCursor(a.line, a.col);
			this.clampNormal();
			return;
		}
		this.commit(this.removeBetween(a, b), a.line, a.col);
		if (op === "c") this.enterInsert();
		else this.clampNormal();
	}

	private applyLinewise(op: Operator, from: number, to: number): void {
		const L = [...this.lines];
		const lo = Math.max(0, Math.min(from, to));
		const hi = Math.min(L.length - 1, Math.max(from, to));
		this.register = { text: L.slice(lo, hi + 1).join("\n"), linewise: true };
		if (op === "y") {
			this.setCursor(lo, this.cur.col);
			this.clampNormal();
			return;
		}
		if (op === "c") {
			L.splice(lo, hi - lo + 1, "");
			this.commit(L, lo, 0);
			this.enterInsert();
			return;
		}
		L.splice(lo, hi - lo + 1);
		const target = Math.min(lo, Math.max(0, L.length - 1));
		this.commit(L, target, 0);
		const first = (this.lines[this.cur.line] ?? "").search(/\S/);
		if (first > 0) this.setCursor(this.cur.line, first);
		this.clampNormal();
	}

	private paste(after: boolean): void {
		const reg = this.register;
		if (!reg.text) return;
		if (reg.linewise) {
			const L = [...this.lines];
			const at = after ? this.cur.line + 1 : this.cur.line;
			L.splice(at, 0, ...reg.text.split("\n"));
			this.commit(L, at, 0);
			const first = (this.lines[at] ?? "").search(/\S/);
			if (first > 0) this.setCursor(at, first);
			return;
		}
		const p = this.cur;
		const line = this.lines[p.line] ?? "";
		const at = after ? Math.min(p.col + 1, line.length) : p.col;
		const head = line.slice(0, at);
		const tail = line.slice(at);
		const parts = reg.text.split("\n");
		const L = [...this.lines];
		if (parts.length === 1) {
			L[p.line] = head + reg.text + tail;
			this.commit(L, p.line, at + reg.text.length - 1);
			return;
		}
		const rebuilt = [head + parts[0], ...parts.slice(1, -1), parts[parts.length - 1] + tail];
		L.splice(p.line, 1, ...rebuilt);
		this.commit(L, p.line, at);
	}

	// ------------------------------------------------------------- motions

	private motionTarget(key: string): { pos: Pos; inclusive: boolean } | null {
		const p = this.cur;
		const line = this.lines[p.line] ?? "";
		switch (key) {
			case "w":
				return { pos: this.toPos(this.wordForward(this.toOffset(p))), inclusive: false };
			case "b":
				return { pos: this.toPos(this.wordBackward(this.toOffset(p))), inclusive: false };
			case "e":
				return { pos: this.toPos(this.wordEnd(this.toOffset(p))), inclusive: true };
			case "h":
				return { pos: { line: p.line, col: Math.max(0, p.col - 1) }, inclusive: false };
			case "l":
				return { pos: { line: p.line, col: p.col + 1 }, inclusive: false };
			case "0":
				return { pos: { line: p.line, col: 0 }, inclusive: false };
			case "^": {
				const f = line.search(/\S/);
				return { pos: { line: p.line, col: f < 0 ? 0 : f }, inclusive: false };
			}
			case "$":
				return { pos: { line: p.line, col: line.length }, inclusive: false };
			default:
				return null;
		}
	}

	/** Cursor movement shared by normal and visual mode. Returns true if handled. */
	private motion(key: string): boolean {
		if (key === "j" || key === "k") {
			this.setCursor(this.cur.line + (key === "j" ? 1 : -1), this.cur.col);
			this.clampNormal();
			return true;
		}
		const t = this.motionTarget(key);
		if (!t) return false;
		this.setCursor(t.pos.line, t.pos.col);
		this.clampNormal();
		return true;
	}

	// --------------------------------------------------------------- modes

	/**
	 * Park the draft, clear the box and type the lead character as a real
	 * keystroke, so pi reacts exactly as it would to the user typing it.
	 */
	private enterCommand(entry: { lead: string; label: string }): void {
		// Expanded rather than raw text: setText() drops the paste registry, so
		// saved paste markers would come back as dangling literals.
		this.draft = { text: this.getExpandedText(), line: this.cur.line, col: this.cur.col };
		this.mode = "command";
		this.commandLabel = entry.label;
		this.pending = null;
		this.gPending = false;
		this.setText("");
		super.handleInput(entry.lead);
	}

	private restoreDraft(): void {
		const draft = this.draft;
		this.draft = null;
		this.setText(draft?.text ?? "");
		if (draft) this.setCursor(draft.line, draft.col);
	}

	/** Abandon the command line and put the draft back. */
	private cancelCommand(): void {
		this.mode = "normal";
		this.restoreDraft();
		this.clampNormal();
	}

	/** Run the command, then put the draft back the way vim leaves the buffer. */
	private runCommand(): void {
		const draft = this.draft;
		this.draft = null;
		this.mode = "normal";
		super.handleInput("\r"); // pi's own submit path
		if (RESTORE_DRAFT_AFTER_COMMAND && draft?.text) {
			this.draft = draft;
			this.restoreDraft();
			if (this.mode === "normal") this.clampNormal();
		}
	}

	private commandKey(data: string): void {
		if (matchesKey(data, "enter") && !this.isShowingAutocomplete()) {
			this.runCommand();
			return;
		}
		super.handleInput(data);
		// Backspacing off the lead character leaves command mode, as in vim.
		if (this.getText().length === 0) this.cancelCommand();
	}

	private enterInsert(): void {
		this.mode = "insert";
		this.pending = null;
		this.gPending = false;
	}

	private enterNormal(): void {
		this.mode = "normal";
		this.pending = null;
		this.gPending = false;
		if (this.cur.col > 0) this.setCursor(this.cur.line, this.cur.col - 1);
		this.clampNormal();
	}

	private openLine(below: boolean): void {
		const L = [...this.lines];
		const at = below ? this.cur.line + 1 : this.cur.line;
		L.splice(at, 0, "");
		this.commit(L, at, 0);
		this.enterInsert();
	}

	private applyVisual(op: Operator): void {
		if (this.mode === "vline") {
			const from = this.anchor.line;
			const to = this.cur.line;
			this.mode = "normal";
			this.applyLinewise(op, from, to);
			return;
		}
		let a = this.anchor;
		let b = this.cur;
		if (cmp(a, b) > 0) [a, b] = [b, a];
		this.mode = "normal";
		this.applyCharwise(op, a, { line: b.line, col: b.col + 1 });
	}

	// --------------------------------------------------------------- input

	handleInput(data: string): void {
		// Under the Kitty keyboard protocol plain letters arrive as CSI-u
		// sequences, so normalise before comparing against normal-mode keys.
		const key = decodeKittyPrintable(data) ?? data;

		// Ctrl+Enter submits from any mode. Checked before everything else so
		// it works mid-selection or with an operator pending. Terminals that
		// do not report modified Enter never produce this.
		if (matchesKey(data, "ctrl+enter")) {
			if (this.mode === "command") {
				this.runCommand();
				this.tui.requestRender();
				return;
			}
			this.pending = null;
			this.gPending = false;
			// this.mode = START_IN_NORMAL ? "normal" : "insert";
			super.handleInput("\r"); // pi's own submit path
			return;
		}

		// Ctrl+Escape aborts the agent from normal mode. Checked before plain
		// escape so a lenient escape match can't swallow it. Ignored in other
		// modes rather than forwarded, so it can't reach pi as an escape.
		if (isCtrlEscape(data)) {
			if (this.mode === "normal") {
				this.pending = null;
				this.gPending = false;
				super.handleInput(plainEscapeFor(data)); // let pi abort the agent
			}
			this.tui.requestRender();
			return;
		}

		if (matchesKey(data, "escape")) {
			if (this.mode === "command") {
				this.cancelCommand();
				this.tui.requestRender();
				return;
			}
			if (this.pending || this.gPending) {
				this.pending = null;
				this.gPending = false;
			} else if (this.mode === "insert") {
				this.enterNormal();
			} else if (this.mode !== "normal") {
				this.mode = "normal";
				this.clampNormal();
			}
			this.tui.requestRender();
			return;
		}

		if (this.mode === "command") {
			this.commandKey(data);
			this.tui.requestRender();
			return;
		}

		if (this.mode === "insert") {
			// Enter inserts a newline instead of submitting. Editor treats a
			// bare "\n" as its newline path, and "\r" as submit.
			if (matchesKey(data, "enter") && !this.isShowingAutocomplete()) {
				super.handleInput("\n");
				return;
			}
			super.handleInput(data);
			return;
		}

		this.normalKey(data, key);
		this.tui.requestRender();
	}

	private normalKey(data: string, key: string): void {
		if (this.pending) return this.operatorKey(key);

		if (this.gPending) {
			this.gPending = false;
			if (key === "g") {
				this.setCursor(0, 0);
				this.clampNormal();
			}
			return;
		}

		if (this.motion(key)) return;

		const line = this.lines[this.cur.line] ?? "";
		const visual = this.mode === "visual" || this.mode === "vline";

		// ':' and '!' open a command line. Not while a selection is live --
		// those are selection keys in vim, and eating the selection would be
		// surprising.
		const command = COMMAND_KEYS[key];
		if (command) {
			if (!visual) this.enterCommand(command);
			return;
		}

		switch (key) {
			case "i":
				if (!visual) this.enterInsert();
				return;
			case "I": {
				if (visual) return;
				const f = line.search(/\S/);
				this.setCursor(this.cur.line, f < 0 ? 0 : f);
				this.enterInsert();
				return;
			}
			case "a":
				if (!visual) {
					this.setCursor(this.cur.line, this.cur.col + 1);
					this.enterInsert();
				}
				return;
			case "A":
				if (visual) return;
				this.setCursor(this.cur.line, line.length);
				this.enterInsert();
				return;
			case "o":
				if (visual) {
					const swap = this.anchor;
					this.anchor = this.cur;
					this.setCursor(swap.line, swap.col);
				} else {
					this.openLine(true);
				}
				return;
			case "O":
				if (!visual) this.openLine(false);
				return;
			case "v":
				this.mode = this.mode === "visual" ? "normal" : "visual";
				if (this.mode === "visual") this.anchor = this.cur;
				return;
			case "V":
				this.mode = this.mode === "vline" ? "normal" : "vline";
				if (this.mode === "vline") this.anchor = this.cur;
				return;
			case "y":
			case "d":
			case "c":
				if (visual) this.applyVisual(key);
				else this.pending = { op: key, want: "motion" };
				return;
			case "x":
				if (visual) this.applyVisual("d");
				else if (line.length > 0) {
					this.applyCharwise("d", this.cur, { line: this.cur.line, col: this.cur.col + 1 });
				}
				return;
			case "X":
				if (!visual && this.cur.col > 0) {
					this.applyCharwise("d", { line: this.cur.line, col: this.cur.col - 1 }, this.cur);
				}
				return;
			case "D":
				if (!visual) this.applyCharwise("d", this.cur, { line: this.cur.line, col: line.length });
				return;
			case "C":
				if (!visual) this.applyCharwise("c", this.cur, { line: this.cur.line, col: line.length });
				return;
			case "p":
				if (!visual) this.paste(true);
				return;
			case "P":
				if (!visual) this.paste(false);
				return;
			case "u":
				if (!visual) {
					this.inner.undo();
					this.clampNormal();
				}
				return;
			case "g":
				this.gPending = true;
				return;
			case "G":
				this.setCursor(this.lines.length - 1, 0);
				this.clampNormal();
				return;
		}

		// Enter submits from normal mode.
		if (matchesKey(data, "enter")) {
			// this.mode = START_IN_NORMAL ? "normal" : "insert";
			super.handleInput(data);
			return;
		}

		// Swallow remaining printable characters so they are not inserted;
		// forward everything else (ctrl+c, ctrl+d, resize sequences, paste).
		if (key.length === 1 && key.charCodeAt(0) >= 32) return;
		super.handleInput(data);
	}

	// -------------------------------------------------------------- render

	/**
	 * Normal and visual modes use pi's drawn block cursor with the real one
	 * hidden. Insert mode does the reverse: show the terminal's own cursor as a
	 * bar and strip the drawn block, so there is exactly one cursor either way.
	 * Driven from render() rather than from each mode assignment so it cannot
	 * drift out of sync with the mode.
	 */
	private barCursor: boolean | null = null;

	private syncCursorShape(): void {
		if (INSERT_CURSOR_STYLE !== "bar") return;
		const bar = this.mode === "insert" || this.mode === "command";
		if (this.barCursor === bar) return;
		this.barCursor = bar;
		try {
			this.tui.setShowHardwareCursor(bar);
			this.tui.terminal.write(bar ? INSERT_CURSOR_SHAPE : RESTORE_CURSOR_SHAPE);
		} catch {
			// No terminal attached (tests, RPC mode); the drawn cursor still works.
		}
	}

	/** Hand the cursor back to the terminal. Idempotent. */
	restoreCursorShape(): void {
		if (INSERT_CURSOR_STYLE !== "bar") return;
		this.barCursor = null;
		try {
			this.tui.setShowHardwareCursor(false);
			this.tui.terminal.write(RESTORE_CURSOR_SHAPE);
		} catch {
			// Nothing to restore.
		}
	}

	/**
	 * Restyle pi's drawn block cursor, keeping the zero-width marker in place so
	 * IME candidate windows still land on the right cell. Passing "" strips the
	 * styling entirely, which is what the "bar" style wants so the terminal's
	 * own cursor is the only one visible. The marker is only emitted while
	 * focused, which is also the only time this should run.
	 */
	private restyleCursorCell(rendered: string[], sgr: string): void {
		const count = this.inner.renderedVisibleLineCount;
		for (let k = 1; k <= count; k++) {
			const row = rendered[k];
			if (row === undefined) continue;
			const at = row.indexOf(CURSOR_MARKER);
			if (at < 0) continue;
			const rest = row.slice(at + CURSOR_MARKER.length);
			if (!rest.startsWith(BLOCK_CURSOR_SGR)) return;
			const end = rest.indexOf(RESET_SGR, BLOCK_CURSOR_SGR.length);
			if (end < 0) return;
			const cell = rest.slice(BLOCK_CURSOR_SGR.length, end);
			const tail = rest.slice(end + RESET_SGR.length);
			rendered[k] =
				row.slice(0, at) +
				CURSOR_MARKER +
				(sgr ? sgr + cell + RESET_SGR : cell) +
				tail;
			return;
		}
	}

	render(width: number): string[] {
		this.syncCursorShape();
		const lines = super.render(width);
		if (lines.length === 0) return lines;

		if (this.mode === "insert" || this.mode === "command") {
			if (INSERT_CURSOR_STYLE === "underline") this.restyleCursorCell(lines, UNDERLINE_CURSOR_SGR);
			else if (INSERT_CURSOR_STYLE === "bar") this.restyleCursorCell(lines, "");
		} else if (this.mode === "visual" || this.mode === "vline") {
			try {
				this.highlightSelection(lines, width);
			} catch {
				// Highlighting reads Editor internals. If those move in a future
				// pi release we lose the highlight, not the editor.
			}
		}

		// The bottom border is not necessarily the last line: the autocomplete
		// list renders below it.
		let border = lines.length - 1;
		const visible = this.inner.renderedVisibleLineCount;
		if (typeof visible === "number" && visible + 1 < lines.length) border = visible + 1;

		const label = this.statusLabel();
		if (visibleWidth(lines[border]!) >= label.length) {
			lines[border] = truncateToWidth(lines[border]!, width - label.length, "") + label;
		}
		return lines;
	}

	/**
	 * Rebuild the wrapped-line -> logical-line mapping. layoutText() gives the
	 * wrapped chunks in order but not where each one started, so locate each
	 * chunk in its logical line. Chunks of one logical line are contiguous, and
	 * a chunk is always a substring of its line, which is enough to walk both.
	 */
	private visualLineMap(): VisualLine[] {
		const layout = this.inner.layoutText(this.inner.lastWidth);
		const map: VisualLine[] = [];
		let logical = 0;
		let from = 0;
		for (const chunk of layout) {
			const line = this.lines[logical] ?? "";
			let start = chunk.text.length > 0 ? line.indexOf(chunk.text, from) : from;
			if (start < 0) start = from;
			const end = start + chunk.text.length;
			const last = end >= line.length;
			map.push({ logical, start, text: chunk.text, last });
			if (last) {
				logical++;
				from = 0;
			} else {
				from = end;
			}
		}
		return map;
	}

	/** Selected visible columns within one wrapped line, or null. */
	private selectedColumns(vl: VisualLine): [number, number] | null {
		let a = this.anchor;
		let b = this.cur;
		if (cmp(a, b) > 0) [a, b] = [b, a];

		if (vl.logical < a.line || vl.logical > b.line) return null;

		if (this.mode === "vline") {
			// Whole line; show a single cell for an empty one.
			return [0, Math.max(visibleWidth(vl.text), 1)];
		}

		const chunkEnd = vl.start + vl.text.length;
		const lo = vl.logical === a.line ? Math.max(a.col, vl.start) : vl.start;
		const hi = vl.logical === b.line ? Math.min(b.col + 1, chunkEnd) : chunkEnd;
		// Visual mode is inclusive of the cursor cell, and a selection running
		// onto the next line covers the line break as one cell.
		const trailing = vl.logical < b.line && vl.last ? 1 : 0;
		if (hi <= lo && trailing === 0) return null;
		const c0 = visibleWidth(vl.text.slice(0, Math.max(0, lo - vl.start)));
		const c1 = visibleWidth(vl.text.slice(0, Math.max(0, hi - vl.start))) + trailing;
		return c1 > c0 ? [c0, c1] : null;
	}

	private highlightSelection(rendered: string[], width: number): void {
		const inner = this.inner;
		const count = inner.renderedVisibleLineCount;
		if (!count) return;
		const map = this.visualLineMap();
		// Mirror render()'s padding calculation so columns line up.
		const maxPadding = Math.max(0, Math.floor((width - 1) / 2));
		const padX = Math.min(this.getPaddingX(), maxPadding);

		for (let k = 0; k < count; k++) {
			const vl = map[inner.scrollOffset + k];
			const target = rendered[k + 1]; // index 0 is the top border
			if (!vl || target === undefined) continue;
			const cols = this.selectedColumns(vl);
			if (!cols) continue;
			rendered[k + 1] = highlightColumns(target, padX + cols[0], padX + cols[1], SELECTION_SGR);
		}
	}

	private statusLabel(): string {
		if (this.mode === "insert") return " INSERT ";
		if (this.mode === "command") return this.commandLabel;
		if (this.mode === "vline") {
			return ` V-LINE ${Math.abs(this.cur.line - this.anchor.line) + 1}L `;
		}
		if (this.mode === "visual") {
			let a = this.anchor;
			let b = this.cur;
			if (cmp(a, b) > 0) [a, b] = [b, a];
			const n = this.textBetween(a, { line: b.line, col: b.col + 1 }).length;
			return ` VISUAL ${n} `;
		}
		const pend = this.pending
			? this.pending.op + (this.pending.want === "textobject" ? this.pending.kind : "")
			: this.gPending
				? "g"
				: "";
		return pend ? ` NORMAL ${pend} ` : " NORMAL ";
	}

	private operatorKey(key: string): void {
		const p = this.pending;
		if (!p) return;

		if (p.want === "textobject") {
			this.pending = null;
			if (key === "w") {
				const r = this.wordObject(p.kind === "a");
				if (r) this.applyCharwise(p.op, r.a, r.b);
			}
			return;
		}

		// Doubled operator (yy, dd, cc) is linewise on the current line.
		if (key === p.op) {
			this.pending = null;
			this.applyLinewise(p.op, this.cur.line, this.cur.line);
			return;
		}

		if (key === "a" || key === "i") {
			this.pending = { op: p.op, want: "textobject", kind: key };
			return;
		}

		this.pending = null;

		// j/k are linewise motions for an operator.
		if (key === "j") return this.applyLinewise(p.op, this.cur.line, this.cur.line + 1);
		if (key === "k") return this.applyLinewise(p.op, this.cur.line - 1, this.cur.line);

		const t = this.motionTarget(key);
		if (!t) return;
		const target = t.inclusive ? { line: t.pos.line, col: t.pos.col + 1 } : t.pos;
		this.applyCharwise(p.op, this.cur, target);
	}
}

export default function (pi: ExtensionAPI) {
	let editor: VimEditor | undefined;

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		ctx.ui.setEditorComponent((tui, theme, keybindings) => {
			editor = new VimEditor(tui, theme, keybindings);
			return editor;
		});
	});

	// Leaving the terminal cursor as a bar would follow the user back to their
	// shell. session_shutdown also fires on /new and /fork.
	pi.on("session_shutdown", () => {
		editor?.restoreCursorShape();
		editor = undefined;
	});
}
