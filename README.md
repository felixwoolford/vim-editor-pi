# vim-editor-pi

Vim-like editing for pi. Starts in **normal mode**; insert/command mode uses a drawn underline (`_`), normal/visual mode a block. The hardware cursor is hidden while the editor is active. Use pi-tui 1.2.0+.

## Install

```sh
pi install git:github.com/felixwoolford/vim-editor-pi
```

Restart pi or run `/reload`. Disable any manually installed copy of `vim-editor.ts` to avoid loading it twice. Add `--local` for a project-only install.

Update: `pi update git:github.com/felixwoolford/vim-editor-pi`.

## Keys

| Mode | Keys |
| --- | --- |
| Normal/visual motions | `h j k l`, `0 ^ $`, `w b e`, `gg G` |
| Normal → insert | `i I a A`, `o O` (new line below/above) |
| Normal edits | `x X` delete forward/backward; `D C` delete/change to line end; `u` undo; `p P` paste after/before |
| Operators | `y d c` + motion or `aw`/`iw`; `yy dd cc` act on whole lines |
| Selection | `v` characterwise, `V` linewise; motions extend; `o` swaps ends; `y d x c` yank/delete/change |
| Commands (normal) | `:` opens pi's `/` menu; `!` opens shell input; Enter runs; Escape or deleting the prefix cancels. Draft is restored. |
| Insert | Enter adds a newline; Escape returns to normal |
| Submit | Enter in normal; Ctrl+Enter in any mode |
| Newline | Shift+Enter or Ctrl+J in either mode |
| Escape | Cancels a pending operator/motion or leaves insert/visual mode; otherwise does nothing in normal |
| Abort agent | Ctrl+Escape in normal mode |
| Thinking visibility | `t` in normal mode toggles pi's **Hide thinking** setting |
| Tool visibility | `z` in normal mode emits `toolview:toggle` for the toggle-tools extension; no-op if absent |

Ctrl+Enter and Ctrl+Escape need a terminal reporting modified keys; your desktop must not intercept Ctrl+Escape. Other pi shortcuts are forwarded.

## Pi-specific normal-mode functions

`extensions/lib/normal-mode-functions.ts` keeps pi actions and extension events separate from Vim editing. It is part of the same extension, not a second extension to load. Add key/action or key/event mappings there for more normal-mode functions.

`t` invokes pi's built-in thinking-visibility action, updating the display and saved setting without changing the model's thinking level. It does not toggle in insert, command, or visual modes, or while an operator/prefix is pending.

`z` emits `toolview:toggle` on pi's shared event bus without importing or depending on toggle-tools. Like `t`, it only runs as a standalone normal-mode key; `z` remains typeable in insert and command modes.

For manual installs, keep `lib/` beside `vim-editor.ts`; copying the single file is no longer sufficient.
