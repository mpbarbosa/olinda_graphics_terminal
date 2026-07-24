// Safe auto-run preview panel. Given the command line currently being typed,
// asks the backend to run it (only if syntactically valid AND read-only) in a
// throwaway shell and shows the output. The real terminal session is untouched.

export interface PreviewResult {
  status: "ok" | "unsafe" | "invalid" | "empty" | "error";
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  timedOut?: boolean;
  reason?: string;
  cwd?: string;
}

export interface PreviewPanel {
  /** Preview `cmd` (the in-progress command line). */
  update(cmd: string): void;
  /** Collapse and empty the panel (e.g. the line was submitted with Enter). */
  clear(): void;
  setEnabled(on: boolean): void;
  readonly enabled: boolean;
  readonly current: string | null;
}

interface PreviewOptions {
  run: (cmd: string) => Promise<PreviewResult>;
  onLayoutChange?: () => void;
  onEnabledChange?: (enabled: boolean) => void;
}

export function createPreviewPanel(opts: PreviewOptions): PreviewPanel {
  const panel = document.getElementById("preview")!;
  const cmdEl = panel.querySelector<HTMLElement>(".preview-cmd")!;
  const metaEl = panel.querySelector<HTMLElement>(".preview-meta")!;
  const outEl = panel.querySelector<HTMLElement>(".preview-output")!;
  const closeBtn = panel.querySelector<HTMLButtonElement>(".preview-close")!;

  let enabled = true;
  let current: string | null = null;
  let requestSeq = 0;

  function setOpen(open: boolean): void {
    if ((panel.dataset.open === "true") === open) return;
    panel.dataset.open = String(open);
    opts.onLayoutChange?.();
  }

  function setMeta(text: string, kind: "ok" | "muted" | "warn"): void {
    metaEl.textContent = text;
    metaEl.dataset.kind = kind;
  }

  function render(cmd: string, r: PreviewResult): void {
    cmdEl.textContent = cmd;
    outEl.classList.remove("is-muted");

    switch (r.status) {
      case "ok": {
        const parts: string[] = [];
        if (r.stdout) parts.push(r.stdout);
        if (r.stderr) parts.push(r.stderr);
        outEl.textContent = parts.join("\n").replace(/\n+$/, "") || "(no output)";
        const bits = [`exit ${r.exitCode ?? 0}`];
        if (r.timedOut) bits.push("timed out (3s)");
        if (r.cwd) bits.push(r.cwd);
        setMeta(bits.join("  ·  "), r.exitCode ? "warn" : "ok");
        break;
      }
      case "unsafe":
        outEl.textContent = `⚠ Not auto-run: ${r.reason ?? "not a read-only command"}.\nPress Enter in the terminal to run it yourself.`;
        outEl.classList.add("is-muted");
        setMeta("not auto-run", "warn");
        break;
      case "invalid":
        outEl.textContent = "…waiting for a complete command";
        outEl.classList.add("is-muted");
        setMeta("incomplete", "muted");
        break;
      case "error":
      default:
        outEl.textContent = r.reason ?? "preview failed";
        outEl.classList.add("is-muted");
        setMeta("error", "warn");
        break;
    }
  }

  function update(cmd: string): void {
    if (!enabled) return;
    if (cmd === current) return;
    current = cmd;

    if (!cmd) {
      // Line cleared: leave the last preview in place rather than flicker.
      return;
    }

    setOpen(true);
    const seq = ++requestSeq;
    opts
      .run(cmd)
      .then((r) => {
        if (seq !== requestSeq) return;
        if (r.status === "empty") return;
        render(cmd, r);
      })
      .catch((err: unknown) => {
        if (seq !== requestSeq) return;
        render(cmd, {
          status: "error",
          reason: err instanceof Error ? err.message : "preview failed",
        });
      });
  }

  function clear(): void {
    current = null;
    requestSeq++; // invalidate any in-flight run() so it can't re-render
    setOpen(false);
    cmdEl.textContent = "";
    metaEl.textContent = "";
    outEl.textContent = "";
  }

  function setEnabled(on: boolean): void {
    if (on === enabled) return;
    enabled = on;
    if (!on) {
      setOpen(false);
    } else if (current) {
      const last = current;
      current = null;
      update(last);
    }
    opts.onEnabledChange?.(enabled);
  }

  closeBtn.addEventListener("click", () => setEnabled(false));

  return {
    update,
    clear,
    setEnabled,
    get enabled() {
      return enabled;
    },
    get current() {
      return current;
    },
  };
}
