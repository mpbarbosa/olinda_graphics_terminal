# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Olinda Graphics Terminal — a browser-based terminal emulator written in TypeScript. The browser renders the terminal; a Node backend spawns a real **zsh** process via a PTY and streams it over a WebSocket. This is the only way to get a genuine shell (zsh is a native process and cannot run in the browser).

## Commands

- `npm run dev` — run both halves for development via `concurrently`: the backend (`tsx watch`, port 3000) and the Vite dev server (port 5173). Open **http://localhost:5173**; Vite proxies `/pty` to the backend.
- `npm run dev:server` / `npm run dev:client` — run either half alone.
- `npm run build` — compile the server (`tsc -p tsconfig.server.json` → `dist-server/`) and bundle the client (`vite build` → `dist/`).
- `npm start` — run the built backend (`node dist-server/server/index.js`), which also serves the built client from `dist/`. Open **http://localhost:3000**.
- `npm run typecheck` — typecheck both the client (`tsconfig.json`) and server (`tsconfig.server.json`) projects.

There is no test runner or linter configured yet.

Environment variables (backend): `PORT` (default 3000), `HOST` (default `127.0.0.1`), `SHELL_BIN` (default `/usr/bin/zsh`).

## Security posture

Each connection is an **unauthenticated full zsh session** on the host — there is no login, no sandbox. The project is scoped to **local dev only** and binds to loopback (`127.0.0.1`) by default. Do not expose it on a network (`HOST=0.0.0.0`, reverse proxy, etc.) without first adding an auth gate and sandboxing the shell.

## Architecture

Three TypeScript surfaces, split by tsconfig:

- **`server/index.ts`** (Node, `tsconfig.server.json`, ESM/NodeNext) — Express HTTP server + `ws` WebSocket server on path `/pty`. Each WebSocket connection spawns one `zsh` via `node-pty` and wires PTY↔socket bidirectionally. Also serves the built client from `dist/` in production.
- **`src/main.ts`** (browser, `tsconfig.json`, bundler resolution) — creates an `@xterm/xterm` `Terminal`, connects the WebSocket, and pipes keystrokes→PTY and PTY output→renderer. Uses `FitAddon` to size the grid and auto-reconnects on drop. Also wires the command palette hotkey.
- **`src/palette.ts`** — the command palette overlay (see below).
- **`src/manual.ts`** — the live manual panel (see below).
- **`src/preview.ts`** — the safe auto-run preview panel (see below).
- **`shared/protocol.ts`** — the wire protocol, imported by both sides (hence its own presence in both tsconfig `include`s).

### Command palette (Ctrl+Shift+P)

A searchable dropdown of every executable on the backend's PATH.

- The backend owns PATH (it runs zsh), so `server/index.ts` scans every PATH directory for files with an execute bit and serves the deduped, sorted list at **`GET /api/commands`** (memoized, 15s TTL). The Vite dev proxy forwards `/api` to the backend.
- `src/palette.ts` (`createCommandPalette`) renders the overlay: fetches `/api/commands` once (cached for the tab), filters as you type (exact → prefix → substring ranking), caps rendered rows at 200 for responsiveness, and navigates with ↑/↓, Enter, Esc. Picking a command calls `onSubmit`.
- `src/main.ts` binds the hotkey in a **capture-phase** `window` keydown listener with `preventDefault` + `stopPropagation`, so `Ctrl+Shift+P` reaches neither xterm/the PTY nor the browser. It's chosen because it is unbound in zsh's line editor and free in Chromium (note: Firefox reserves it for private windows). On submit it sends the command name + a trailing space as PTY input (inserts at the prompt; does not auto-run).

### Live manual panel (📖 Man)

As you type a command at the prompt, its `man` page renders in a collapsible side panel.

- `server/index.ts` serves **`GET /api/man?cmd=<name>`**: runs `man -P cat <name>` via `execFile` (no shell) with `cmd` restricted to `^[a-zA-Z0-9][a-zA-Z0-9._+-]{0,63}$`, so there is no injection surface. Output is stripped of nroff overstrike (`X\bX`) and ANSI SGR, then cached per process. Unknown commands → 404.
- `src/manual.ts` (`createManViewer`) owns the panel: fetches + caches per command, guards against out-of-order responses with a request sequence number, and opens/collapses (calling `onLayoutChange` so the terminal can refit). **A command with no `man` entry collapses the panel rather than showing an error**, and to avoid flashing open for such commands it only opens on a successful fetch (showing an in-place "Loading…" only when already open). `close()` collapses without disabling the feature.
- `src/main.ts` `commandAtPrompt()` finds the command token: it **walks up** from the cursor row to the prompt line (marker `[❯➜»%$#>]`), so multi-line commands (`for`/`while`/`if`, whose cursor sits on a `do`/`done` continuation line) still resolve to their leading keyword. On the cursor's own row it reads only **up to `buffer.active.cursorX`**, so zsh-autosuggestions (drawn after the cursor) are never mistaken for typed input — important so an empty prompt showing a dimmed suggestion reads as empty. Debounced (300ms). The detector **closes** the panel when the token is empty or not in the shared PATH command set (`commandSet`) — e.g. a shell keyword like `for` — so a stale page never lingers; otherwise it calls `show()`, which itself closes if `man` has no entry.
- **Detection is driven by `term.onWriteParsed`, NOT `term.onRender`.** In this xterm build `onRender` does not fire on keystroke echoes (verified: 0 firings while typing), so it cannot be used to watch the prompt. `onWriteParsed` fires on every PTY write (echo/redraw), which is what we need. Don't "simplify" this back to `onRender`.
- The command list loader is shared: `loadCommands()` populates both the palette's `fetchCommands` and `commandSet`, and is warmed at startup so the man panel works from the first keystroke.

### Safe auto-run preview (⚡ Auto-run)

As you type, a syntactically-valid **read-only** command is executed in a throwaway shell and its output shown in a bottom panel — no Enter. The interactive session is never touched.

- **`POST /api/preview`** (`server/index.ts`) takes `{cmd, pid}` and: (1) **syntax-checks** with `zsh -n -c` (never executes) — incomplete lines like `ls |` return `{status:"invalid"}`; (2) **classifies safety** with `classifyLine` — rejects shell metacharacters (`; & < > \` $() && ||`), env assignments, non-allowlisted commands, `git` write subcommands, `find -exec/-delete`, `tail -f`; only a bare command or a `|` pipeline of allow-listed read-only commands passes; (3) runs the survivor via `execFile(zsh, ["-c", cmd])` with `timeout: 3000`, `maxBuffer`, `SIGKILL`, **stdin closed** (so `cat`/`sort` with no args get EOF instead of hanging), and **cwd = the session's own dir** via `readlink(/proc/<pid>/cwd)` (only for pids in `ptyPids`, which we spawned). Output is truncated. The **safety gate is authoritative on the server** — the client cannot bypass it.
- **The classifier is a denylist-of-operators + allowlist-of-commands, on purpose.** Do not loosen `UNSAFE_META` or add write-capable commands (`sed`/`awk` can execute or write, so they're excluded) without understanding that anything that passes gets auto-executed as the user types. Verified: a typed `rm -f <file>` leaves the file intact.
- `src/preview.ts` (`createPreviewPanel`) owns the bottom panel: race-guarded fetch, renders per status (`ok`/`unsafe`/`invalid`), opens/collapses (with `onLayoutChange` → refit).
- `src/main.ts` extracts the **typed line** with `typedLineAtPrompt()`: the cursor-row text between the prompt marker and **`buffer.active.cursorX`**. Stopping at the cursor column excludes zsh-autosuggestions (drawn after the cursor), so we never preview text the user didn't type. Debounced 550ms, driven by the same `onWriteParsed` handler as the man panel.
- **Pressing Enter clears the preview.** A dedicated `term.onData` listener watches for a carriage return (`\r`) — how Enter reaches the PTY — and calls `preview.clear()` (collapse, empty, and bump the request sequence so an in-flight fetch can't re-render). Once the line is submitted, the throwaway preview is stale (the real output is now in the terminal); it re-opens when the next command is typed. This is a *second* `onData` listener, separate from the one that forwards input.

### Wire protocol (`shared/protocol.ts`)

- **Client → server**: JSON text frames — `{type:"input",data}` (keystrokes) and `{type:"resize",cols,rows}`.
- **Server → client**: raw PTY output is sent as **plain text frames** (not wrapped, for throughput). Server *control* messages (`ready`, `exit`) are JSON frames prefixed with the `0x01` SOH byte so the client can distinguish them from terminal output. Use `encodeServerControl` / `decodeServerControl` rather than parsing by hand.

### Things that will bite you

- **`node-pty` is a native addon.** npm 12 blocks its build script by default; it's allow-listed in `package.json` `allowScripts`. After a fresh `npm install`, if `require('node-pty')` fails to find `pty.node`, run `npm rebuild node-pty`.
- **Build output nesting.** `tsconfig.server.json` has `rootDir: "."` with `include: [server, shared]`, so the entrypoint compiles to `dist-server/server/index.js` (not `dist-server/index.js`). The `start` script and the static-dir path in `server/index.ts` (`../../dist`) both depend on this layout — keep them in sync if you change `rootDir`.
- **Initial fit timing.** `FitAddon.fit()` must run after the container has been laid out; calling it in the same frame as `term.open()` measures a 0-height container and yields a 1×1 grid. `src/main.ts` fits inside a `requestAnimationFrame` and refits on `document.fonts.ready` and container resize — preserve that.
