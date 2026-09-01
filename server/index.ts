import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { readdir, stat, readlink } from "node:fs/promises";
import { execFile } from "node:child_process";
import express from "express";
import { WebSocketServer, type WebSocket } from "ws";
import * as pty from "node-pty";
import {
  encodeServerControl,
  type ClientMessage,
} from "../shared/protocol.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 3000);

// SECURITY: every connection is an unauthenticated, full zsh session on this
// host. Bind to loopback by default so it is never exposed on the network.
// Only change HOST if you have added authentication and understand the risk.
const HOST = process.env.HOST ?? "127.0.0.1";

// The shell to launch. Defaults to zsh; overridable via SHELL_BIN so the
// backend can also run on hosts where zsh lives elsewhere.
const SHELL = process.env.SHELL_BIN ?? "/usr/bin/zsh";

const app = express();
app.use(express.json({ limit: "16kb" }));

// PIDs of the zsh processes we have spawned for live PTY sessions. The preview
// endpoint uses these to look up a session's cwd (via /proc/<pid>/cwd), and only
// trusts pids it spawned itself.
const ptyPids = new Set<number>();

// In production the built frontend (vite build -> dist/) is served directly.
// In dev, Vite serves the frontend and proxies /pty here, so this is a no-op.
// At runtime this file lives at dist-server/server/index.js, so the repo-root
// dist/ is two levels up.
const clientDir = resolve(__dirname, "..", "..", "dist");
if (existsSync(clientDir)) {
  app.use(express.static(clientDir));
}

app.get("/healthz", (_req, res) => {
  res.json({ ok: true, shell: SHELL });
});

// Enumerate every executable reachable via PATH. Used by the browser's command
// palette (Ctrl+Shift+P). Result is memoized with a short TTL since PATH
// contents rarely change within a session but a scan is thousands of syscalls.
let commandCache: { at: number; commands: string[] } | null = null;
const COMMAND_TTL_MS = 15_000;

async function listPathCommands(): Promise<string[]> {
  const dirs = (process.env.PATH ?? "").split(":").filter(Boolean);
  const seen = new Set<string>();
  await Promise.all(
    dirs.map(async (dir) => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return; // dir on PATH may not exist or be readable
      }
      for (const entry of entries) {
        if (entry.isDirectory() || seen.has(entry.name)) continue;
        try {
          // stat() follows symlinks, so symlinked executables are included.
          const st = await stat(join(dir, entry.name));
          if (st.isFile() && (st.mode & 0o111) !== 0) seen.add(entry.name);
        } catch {
          // broken symlink or race; skip
        }
      }
    }),
  );
  return [...seen].sort((a, b) => a.localeCompare(b));
}

app.get("/api/commands", async (_req, res) => {
  try {
    const now = Date.now();
    if (!commandCache || now - commandCache.at > COMMAND_TTL_MS) {
      commandCache = { at: now, commands: await listPathCommands() };
    }
    res.json({ commands: commandCache.commands });
  } catch {
    res.status(500).json({ error: "failed to list PATH commands" });
  }
});

// Render a command's manual page as clean text for the browser's live man panel.
// `man` is run via execFile (no shell) and cmd is charset-restricted, so there
// is no injection surface. Results are cached for the process lifetime.
const manCache = new Map<string, { ok: boolean; text: string }>();

// `man`/nroff mark bold as "X\bX" and underline as "_\bX"; some setups instead
// emit ANSI SGR. Strip both so the panel shows plain text everywhere.
function cleanManText(raw: string): string {
  return raw
    .replace(/\x1b\[[0-9;]*m/g, "")
    .replace(/.\x08/g, "")
    .replace(/[ \t]+$/gm, "");
}

app.get("/api/man", (req, res) => {
  const cmd = String(req.query.cmd ?? "");
  // Conservative allowlist: a manpage name is alnum plus . _ + -.
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._+-]{0,63}$/.test(cmd)) {
    res.status(400).json({ error: "invalid command name" });
    return;
  }

  const cached = manCache.get(cmd);
  if (cached) {
    if (cached.ok) res.json({ cmd, text: cached.text });
    else res.status(404).json({ error: cached.text });
    return;
  }

  execFile(
    "man",
    ["-P", "cat", cmd],
    {
      env: { ...process.env, MANWIDTH: "90", MANPAGER: "cat", PAGER: "cat" },
      maxBuffer: 8 * 1024 * 1024,
      timeout: 5000,
    },
    (err, stdout) => {
      if (err || !stdout.trim()) {
        const msg = `No manual entry for ${cmd}`;
        manCache.set(cmd, { ok: false, text: msg });
        res.status(404).json({ error: msg });
        return;
      }
      const text = cleanManText(stdout);
      manCache.set(cmd, { ok: true, text });
      res.json({ cmd, text });
    },
  );
});

// --- Live "safe preview" of the command being typed ---------------------------
// The browser sends the in-progress command line; if it is syntactically valid
// AND consists only of read-only commands, we run it in a throwaway zsh (in the
// session's own cwd) and return the output. The interactive session is never
// touched. Anything that could mutate state is rejected, not run.

// Commands considered read-only enough to auto-run. Deliberately conservative;
// when in doubt, leave a command out (it just won't auto-preview).
const SAFE_COMMANDS = new Set([
  "ls", "cat", "echo", "pwd", "date", "whoami", "id", "uname", "hostname",
  "arch", "head", "tail", "wc", "grep", "egrep", "fgrep", "sort", "uniq",
  "cut", "tr", "df", "du", "free", "ps", "env", "printenv", "which", "type",
  "file", "stat", "basename", "dirname", "realpath", "readlink", "tree", "nl",
  "tac", "rev", "seq", "column", "fold", "comm", "cksum", "md5sum", "sha1sum",
  "sha256sum", "printf", "uptime", "w", "users", "groups", "nproc", "locale",
  "tty", "find", "cal", "wc", "less", "cat",
]);

// git subcommands that only read.
const GIT_READONLY = new Set([
  "status", "log", "diff", "show", "rev-parse", "describe", "blame",
  "ls-files", "ls-tree", "cat-file", "shortlog", "reflog", "whatchanged",
  "grep",
]);

interface Classification {
  safe: boolean;
  reason?: string;
}

// Reject anything with shell metacharacters that enable writes, side effects,
// backgrounding, or hidden command execution. A single `|` (pipeline) is allowed
// and each stage is checked; everything else in this set is refused.
const UNSAFE_META = /[;&<>`]|\$\(|\|\||&&|>>/;

function classifyLine(line: string): Classification {
  const l = line.trim();
  if (!l) return { safe: false, reason: "empty" };
  if (UNSAFE_META.test(l)) {
    return { safe: false, reason: "contains shell operators (; & < > ` $() && ||)" };
  }
  for (const segRaw of l.split("|")) {
    const seg = segRaw.trim();
    if (!seg) return { safe: false, reason: "empty pipeline stage" };
    const tokens = seg.split(/\s+/);
    let cmd = tokens[0];
    // Allow an absolute/relative path to a safe command (compare by basename).
    const base = cmd.split("/").pop() ?? cmd;
    cmd = base;
    if (cmd.includes("=")) {
      return { safe: false, reason: "environment assignment" };
    }
    if (cmd === "git") {
      const sub = tokens[1];
      if (!sub || !GIT_READONLY.has(sub)) {
        return { safe: false, reason: `git ${sub ?? ""}`.trim() + " is not read-only" };
      }
      continue;
    }
    if (cmd === "find") {
      const bad = ["-exec", "-execdir", "-delete", "-ok", "-okdir", "-fprintf", "-fprint", "-fls"];
      if (tokens.some((t) => bad.includes(t))) {
        return { safe: false, reason: "find with a side-effecting action" };
      }
    }
    if (cmd === "tail" && tokens.some((t) => t === "-f" || t === "-F" || /^-[a-eg-zA-Z]*[fF]/.test(t))) {
      return { safe: false, reason: "tail -f never terminates" };
    }
    if (!SAFE_COMMANDS.has(cmd)) {
      return { safe: false, reason: `${cmd} is not a known read-only command` };
    }
  }
  return { safe: true };
}

async function sessionCwd(pid: number | undefined): Promise<string> {
  const home = process.env.HOME ?? process.cwd();
  if (pid === undefined || !ptyPids.has(pid)) return home;
  try {
    return await readlink(`/proc/${pid}/cwd`);
  } catch {
    return home;
  }
}

// Run `cmd` without executing it (zsh -n) to confirm it parses.
function checkSyntax(cmd: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(SHELL, ["-n", "-c", cmd], { timeout: 2000 }, (err) => {
      resolve(!err);
    });
  });
}

const PREVIEW_MAX_OUTPUT = 64 * 1024;
const PREVIEW_MAX_LINES = 400;

function truncateOutput(s: string): string {
  let out = s.length > PREVIEW_MAX_OUTPUT ? s.slice(0, PREVIEW_MAX_OUTPUT) + "\n…(truncated)" : s;
  const lines = out.split("\n");
  if (lines.length > PREVIEW_MAX_LINES) {
    out = lines.slice(0, PREVIEW_MAX_LINES).join("\n") + "\n…(truncated)";
  }
  return out;
}

app.post("/api/preview", async (req, res) => {
  const cmd = typeof req.body?.cmd === "string" ? req.body.cmd.trim() : "";
  const pid = typeof req.body?.pid === "number" ? req.body.pid : undefined;

  if (!cmd) {
    res.json({ status: "empty" });
    return;
  }

  // Syntax check first (zsh -n never executes), so an in-progress line like
  // "ls |" reads as incomplete rather than being mislabeled unsafe.
  if (!(await checkSyntax(cmd))) {
    res.json({ status: "invalid" });
    return;
  }

  const verdict = classifyLine(cmd);
  if (!verdict.safe) {
    res.json({ status: "unsafe", reason: verdict.reason });
    return;
  }

  const cwd = await sessionCwd(pid);
  const child = execFile(
    SHELL,
    ["-c", cmd],
    {
      cwd,
      env: { ...process.env, TERM: "dumb", GIT_PAGER: "cat", PAGER: "cat" },
      timeout: 3000,
      maxBuffer: 4 * 1024 * 1024,
      killSignal: "SIGKILL",
    },
    (err, stdout, stderr) => {
      const e = err as { killed?: boolean; code?: unknown } | null;
      const timedOut = Boolean(e?.killed);
      const exitCode = typeof e?.code === "number" ? e.code : 0;
      res.json({
        status: "ok",
        cwd,
        exitCode,
        timedOut,
        stdout: truncateOutput(stdout ?? ""),
        stderr: truncateOutput(stderr ?? ""),
      });
    },
  );
  // No stdin for the throwaway command: close it so tools that would read stdin
  // (cat, sort, wc with no file args) get EOF immediately instead of hanging.
  child.stdin?.end();
});

const server = createServer(app);
const wss = new WebSocketServer({ server, path: "/pty" });

wss.on("connection", (ws: WebSocket) => {
  const shell = pty.spawn(SHELL, [], {
    name: "xterm-256color",
    cols: 80,
    rows: 24,
    cwd: process.env.HOME ?? process.cwd(),
    env: { ...process.env, TERM: "xterm-256color" },
  });

  ptyPids.add(shell.pid);
  ws.send(encodeServerControl({ type: "ready", shell: SHELL, pid: shell.pid }));

  // PTY output -> browser. Sent as raw frames; the client feeds anything
  // that is not a control frame straight into the terminal renderer.
  const onData = shell.onData((data) => {
    if (ws.readyState === ws.OPEN) ws.send(data);
  });

  const onExit = shell.onExit(({ exitCode, signal }) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(encodeServerControl({ type: "exit", code: exitCode, signal }));
      ws.close();
    }
  });

  // Browser -> PTY. All client frames are JSON control messages.
  ws.on("message", (raw) => {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    switch (msg.type) {
      case "input":
        shell.write(msg.data);
        break;
      case "resize":
        if (msg.cols > 0 && msg.rows > 0) shell.resize(msg.cols, msg.rows);
        break;
    }
  });

  const cleanup = () => {
    ptyPids.delete(shell.pid);
    onData.dispose();
    onExit.dispose();
    try {
      shell.kill();
    } catch {
      // already gone
    }
  };

  ws.on("close", cleanup);
  ws.on("error", cleanup);
});

server.listen(PORT, HOST, () => {
  console.log(`olinda terminal backend listening on http://${HOST}:${PORT}`);
  console.log(`  shell: ${SHELL}`);
  console.log(`  ws:    ws://${HOST}:${PORT}/pty`);
});
