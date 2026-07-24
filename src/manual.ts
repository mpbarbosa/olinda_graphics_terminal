// Live manual panel: given a command name, fetches its `man` page from the
// backend and renders it in a collapsible side panel. main.ts feeds it the
// command currently at the prompt.

export interface ManViewer {
  /** Fetch + display the manual for `cmd`, opening the panel if enabled. */
  show(cmd: string): void;
  /** Enable/disable the whole feature; disabling collapses the panel. */
  setEnabled(on: boolean): void;
  readonly enabled: boolean;
  /** The command currently displayed, or null. */
  readonly current: string | null;
}

interface ManOptions {
  fetchMan: (cmd: string) => Promise<string>;
  /** Called whenever the panel opens or closes, so the terminal can refit. */
  onLayoutChange?: () => void;
  /** Called whenever `enabled` changes (from the panel's own close button). */
  onEnabledChange?: (enabled: boolean) => void;
}

export function createManViewer(opts: ManOptions): ManViewer {
  const panel = document.getElementById("manpanel")!;
  const titleEl = panel.querySelector<HTMLElement>(".man-title")!;
  const contentEl = panel.querySelector<HTMLElement>(".man-content")!;
  const closeBtn = panel.querySelector<HTMLButtonElement>(".man-close")!;

  const cache = new Map<string, { ok: boolean; text: string }>();
  let enabled = true;
  let current: string | null = null;
  // Guards against a slow fetch for an old command overwriting a newer one.
  let requestSeq = 0;

  function setOpen(open: boolean): void {
    if ((panel.dataset.open === "true") === open) return;
    panel.dataset.open = String(open);
    opts.onLayoutChange?.();
  }

  function render(cmd: string, body: string, isError: boolean): void {
    titleEl.textContent = isError ? cmd : `man ${cmd}`;
    contentEl.textContent = body;
    contentEl.classList.toggle("is-error", isError);
    contentEl.parentElement!.scrollTop = 0;
  }

  function show(cmd: string): void {
    if (!enabled || cmd === current) return;
    current = cmd;
    setOpen(true);

    const cached = cache.get(cmd);
    if (cached) {
      render(cmd, cached.text, !cached.ok);
      return;
    }

    const seq = ++requestSeq;
    titleEl.textContent = `man ${cmd}`;
    contentEl.classList.remove("is-error");
    contentEl.textContent = "Loading…";

    opts
      .fetchMan(cmd)
      .then((text) => {
        cache.set(cmd, { ok: true, text });
        if (seq === requestSeq) render(cmd, text, false);
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : `No manual entry for ${cmd}`;
        cache.set(cmd, { ok: false, text: msg });
        if (seq === requestSeq) render(cmd, msg, true);
      });
  }

  function setEnabled(on: boolean): void {
    if (on === enabled) return;
    enabled = on;
    if (!on) {
      setOpen(false);
    } else if (current) {
      // Re-open and re-render whatever command we last saw.
      const last = current;
      current = null;
      show(last);
    }
    opts.onEnabledChange?.(enabled);
  }

  closeBtn.addEventListener("click", () => setEnabled(false));

  return {
    show,
    setEnabled,
    get enabled() {
      return enabled;
    },
    get current() {
      return current;
    },
  };
}
