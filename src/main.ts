import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import "./style.css";
import {
  decodeServerControl,
  type ClientMessage,
} from "../shared/protocol.js";
import { createCommandPalette } from "./palette.js";
import { createManViewer } from "./manual.js";
import { createPreviewPanel, type PreviewResult } from "./preview.js";

const statusEl = document.getElementById("status")!;
const termEl = document.getElementById("terminal")!;

function setStatus(state: string, text: string) {
  statusEl.dataset.state = state;
  statusEl.textContent = text;
}

// Tokyo Night-ish palette to match the chrome in style.css.
const term = new Terminal({
  fontFamily:
    'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
  fontSize: 14,
  cursorBlink: true,
  allowProposedApi: true,
  theme: {
    background: "#16161e",
    foreground: "#c0caf5",
    cursor: "#c0caf5",
    black: "#15161e",
    red: "#f7768e",
    green: "#9ece6a",
    yellow: "#e0af68",
    blue: "#7aa2f7",
    magenta: "#bb9af7",
    cyan: "#7dcfff",
    white: "#a9b1d6",
    brightBlack: "#414868",
  },
});

const fit = new FitAddon();
term.loadAddon(fit);
term.loadAddon(new WebLinksAddon());
term.open(termEl);
term.focus();

// Fit once layout has settled. Running fit() in the same frame as open() can
// measure the container before CSS lays it out, yielding a 1x1 grid; a rAF
// (plus a refit when web fonts finish loading) avoids that.
requestAnimationFrame(() => sendResize());
document.fonts?.ready.then(() => sendResize());

function wsURL(): string {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}/pty`;
}

let socket: WebSocket | null = null;
let reconnectTimer: number | undefined;
// The backend's zsh pid for this session; the preview endpoint uses it to run in
// the session's own cwd.
let ptyPid: number | null = null;

function send(msg: ClientMessage) {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(msg));
  }
}

function sendResize() {
  fit.fit();
  send({ type: "resize", cols: term.cols, rows: term.rows });
}

function connect() {
  setStatus("connecting", "connecting…");
  const ws = new WebSocket(wsURL());
  socket = ws;

  ws.onopen = () => {
    setStatus("connected", "connected");
    sendResize();
  };

  ws.onmessage = (ev) => {
    const frame = typeof ev.data === "string" ? ev.data : "";
    const control = decodeServerControl(frame);
    if (control) {
      if (control.type === "ready") {
        ptyPid = control.pid;
        document.getElementById("title")!.textContent =
          `olinda — ${control.shell.split("/").pop()} · pid ${control.pid}`;
      } else if (control.type === "exit") {
        setStatus("exited", `shell exited (${control.code})`);
        term.write(`\r\n\x1b[90m[process exited: ${control.code}]\x1b[0m\r\n`);
      }
      return;
    }
    term.write(frame);
  };

  ws.onclose = () => {
    if (statusEl.dataset.state !== "exited") {
      setStatus("disconnected", "disconnected — retrying…");
      scheduleReconnect();
    }
  };

  ws.onerror = () => ws.close();
}

function scheduleReconnect() {
  window.clearTimeout(reconnectTimer);
  reconnectTimer = window.setTimeout(connect, 1000);
}

// Keystrokes / pasted text from the terminal go to the PTY.
term.onData((data) => send({ type: "input", data }));

// Keep the PTY's window size in sync with the rendered grid.
const resizeObserver = new ResizeObserver(() => sendResize());
resizeObserver.observe(termEl);
window.addEventListener("resize", sendResize);

// Shared, tab-lifetime cache of the backend's PATH executables. Used both by the
// command palette and by the live-man detector (to know when a typed token is a
// real command worth fetching a manual for).
let commandsPromise: Promise<string[]> | null = null;
let commandSet: Set<string> | null = null;
function loadCommands(): Promise<string[]> {
  if (!commandsPromise) {
    commandsPromise = fetch("/api/commands")
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<{ commands: string[] }>;
      })
      .then((d) => {
        commandSet = new Set(d.commands);
        return d.commands;
      })
      .catch((err) => {
        commandsPromise = null; // let the next caller retry
        throw err;
      });
  }
  return commandsPromise;
}
// Warm the cache so the man panel works from the first keystroke.
void loadCommands().catch(() => {});

// --- Command palette (Ctrl+Shift+P): searchable dropdown of PATH executables.
const palette = createCommandPalette({
  fetchCommands: loadCommands,
  onSubmit: (command) => send({ type: "input", data: command + " " }),
  onClose: () => term.focus(),
});

// --- Live manual panel: show `man <cmd>` for the command at the prompt. --------
const manToggle = document.getElementById("man-toggle") as HTMLButtonElement;
const man = createManViewer({
  fetchMan: (cmd) =>
    fetch(`/api/man?cmd=${encodeURIComponent(cmd)}`).then(async (r) => {
      const data = (await r.json().catch(() => ({}))) as {
        text?: string;
        error?: string;
      };
      if (!r.ok) throw new Error(data.error ?? `HTTP ${r.status}`);
      return data.text ?? "";
    }),
  onLayoutChange: () => sendResize(),
  onEnabledChange: (on) => {
    manToggle.dataset.on = String(on);
  },
});

manToggle.addEventListener("click", () => {
  man.setEnabled(!man.enabled);
  manToggle.dataset.on = String(man.enabled);
  if (man.enabled) {
    lastManCommand = null; // force a re-detect on re-enable
    scheduleManDetect();
  }
  term.focus();
});

// Pull the command name from the row the cursor sits on. The prompt ends in one
// of a few common markers (❯ ➜ % $ # >); we take the first token after the last
// such marker. Gated on the token being a known PATH command so partial typing
// ("gr") and non-commands ("./x") don't trigger fetches.
const PROMPT_RE = /[❯➜»%$#>]\s+(\S+)/g;
function commandAtPrompt(): string | null {
  const buf = term.buffer.active;
  const line = buf.getLine(buf.baseY + buf.cursorY);
  const text = line?.translateToString(true) ?? "";
  let match: RegExpExecArray | null;
  let last: string | null = null;
  PROMPT_RE.lastIndex = 0;
  while ((match = PROMPT_RE.exec(text)) !== null) last = match[1];
  return last;
}

let lastManCommand: string | null = null;
let manDetectTimer: number | undefined;
function scheduleManDetect(): void {
  if (!man.enabled) return;
  window.clearTimeout(manDetectTimer);
  manDetectTimer = window.setTimeout(() => {
    const cmd = commandAtPrompt();
    if (!cmd || cmd === lastManCommand) return;
    if (commandSet && !commandSet.has(cmd)) return; // not a real command
    lastManCommand = cmd;
    man.show(cmd);
  }, 300);
}
// --- Live safe-preview: run the typed command in a throwaway shell. -----------
// Extract the full command line as typed: the text on the cursor row between the
// prompt marker and the cursor column. Stopping at the cursor deliberately
// excludes zsh-autosuggestions (drawn *after* the cursor), so we never preview
// commands the user didn't actually type.
const PROMPT_MARKER_RE = /[❯➜»%$#>]\s/g;
function typedLineAtPrompt(): string {
  const buf = term.buffer.active;
  const line = buf.getLine(buf.baseY + buf.cursorY);
  if (!line) return "";
  const full = line.translateToString(false);
  let markerEnd = -1;
  let m: RegExpExecArray | null;
  PROMPT_MARKER_RE.lastIndex = 0;
  while ((m = PROMPT_MARKER_RE.exec(full)) !== null) markerEnd = m.index + m[0].length;
  if (markerEnd < 0 || buf.cursorX <= markerEnd) return "";
  return full.slice(markerEnd, buf.cursorX).trim();
}

const autoToggle = document.getElementById("auto-toggle") as HTMLButtonElement;
const preview = createPreviewPanel({
  run: (cmd) =>
    fetch("/api/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cmd, pid: ptyPid ?? undefined }),
    }).then((r) => r.json() as Promise<PreviewResult>),
  onLayoutChange: () => sendResize(),
  onEnabledChange: (on) => {
    autoToggle.dataset.on = String(on);
  },
});

autoToggle.addEventListener("click", () => {
  preview.setEnabled(!preview.enabled);
  autoToggle.dataset.on = String(preview.enabled);
  if (preview.enabled) {
    lastPreviewLine = null;
    schedulePreview();
  }
  term.focus();
});

let lastPreviewLine: string | null = null;
let previewTimer: number | undefined;
function schedulePreview(): void {
  if (!preview.enabled) return;
  window.clearTimeout(previewTimer);
  previewTimer = window.setTimeout(() => {
    const line = typedLineAtPrompt();
    if (line === lastPreviewLine) return;
    lastPreviewLine = line;
    preview.update(line);
  }, 550);
}

// onWriteParsed fires whenever PTY output is applied to the buffer — i.e. on
// every keystroke echo and prompt redraw — which is exactly when the command at
// the prompt can change. The timers then debounce the actual lookups.
term.onWriteParsed(() => {
  scheduleManDetect();
  schedulePreview();
});

// Capture phase + stopPropagation so Ctrl+Shift+P is swallowed before it reaches
// xterm's key handler (and thus the PTY). preventDefault keeps the browser from
// acting on it too. Ctrl+Shift+P is unbound in zsh's line editor, so nothing in
// the shell is shadowed.
window.addEventListener(
  "keydown",
  (e) => {
    if (e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey && e.code === "KeyP") {
      e.preventDefault();
      e.stopPropagation();
      palette.toggle();
    }
  },
  true,
);

connect();
