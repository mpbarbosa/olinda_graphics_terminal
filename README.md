# olinda_graphics_terminal

A graphics terminal developed in TypeScript, running inside a web browser.

The browser renders the terminal (via [xterm.js](https://xtermjs.org/)); a small
Node backend spawns a real **zsh** shell through a PTY ([node-pty](https://github.com/microsoft/node-pty))
and streams it over a WebSocket. You get an actual interactive zsh session in a browser tab.

## Requirements

- Node.js
- `zsh` installed (default `/usr/bin/zsh`, override with `SHELL_BIN`)

## Getting started

```bash
npm install
# node-pty is a native addon; if it fails to load after install, run:
#   npm rebuild node-pty

# Development (Vite dev server + backend, with reload):
npm run dev
# open http://localhost:5173

# Production build + serve:
npm run build
npm start
# open http://localhost:3000
```

## Features

- Real interactive **zsh** session in a browser tab (via a PTY on the backend).
- **Command palette** — press <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd> for a
  searchable dropdown of every executable on the server's `PATH`. Type to filter,
  ↑/↓ to navigate, <kbd>Enter</kbd> to insert the command at the prompt,
  <kbd>Esc</kbd> to dismiss. (The hotkey is free in Chromium; on Firefox it opens
  a private window, so pick another binding there.)
- **Live manual panel** — as you type a command at the prompt, its `man` page
  renders in a side panel. Toggle it from the **📖 Man** button in the titlebar.
- **Safe auto-run preview** — as you type, a syntactically-valid **read-only**
  command (ls, cat, git status, grep, `ls | grep …`…) runs in a throwaway shell —
  in your session's real working directory — and its output shows in a bottom
  panel, no Enter needed. Anything that could change state (rm, redirects, git
  push, `&&`, …) is reported but **never run**; your real session is untouched.
  Toggle it with **⚡ Auto-run**.

## Configuration

| Variable     | Default        | Description                        |
| ------------ | -------------- | ---------------------------------- |
| `PORT`       | `3000`         | Backend HTTP/WebSocket port        |
| `HOST`       | `127.0.0.1`    | Bind address (loopback by default) |
| `SHELL_BIN`  | `/usr/bin/zsh` | Shell to spawn for each connection |

## Security

Every connection opens an **unauthenticated, full `zsh` session** on the host
running the backend. It is intended for **local development only** and binds to
`127.0.0.1` by default. Do **not** set `HOST=0.0.0.0` or otherwise expose it on a
network without first adding authentication and sandboxing — anyone who can reach
the port gets a shell.

## How it works

```
browser (xterm.js)  <--- WebSocket /pty --->  Node server  ---(pty)--->  zsh
   src/main.ts                                server/index.ts
                    shared/protocol.ts (wire types, both sides)
```

See [CLAUDE.md](CLAUDE.md) for architecture details and gotchas.

## License

MIT
