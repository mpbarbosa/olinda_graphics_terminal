// A command palette overlay: a searchable dropdown of every executable found on
// the backend's PATH. Opened with a hotkey (wired up in main.ts), it filters as
// you type, is navigable with the arrow keys, and calls `onSubmit` with the
// chosen command name.

export interface CommandPalette {
  open(): void;
  close(): void;
  toggle(): void;
  readonly isOpen: boolean;
}

interface PaletteOptions {
  /** Loads the command list. Called lazily on first open; result is cached. */
  fetchCommands: () => Promise<string[]>;
  /** Invoked with the chosen command name when the user picks one. */
  onSubmit: (command: string) => void;
  /** Invoked after the palette closes (e.g. to refocus the terminal). */
  onClose?: () => void;
}

// Cap the number of rendered rows so a PATH with thousands of binaries stays
// snappy. Filtering still considers the whole list; only rendering is capped.
const MAX_ROWS = 200;

export function createCommandPalette(opts: PaletteOptions): CommandPalette {
  const root = document.createElement("div");
  root.className = "palette";
  root.hidden = true;
  root.innerHTML = `
    <div class="palette-box" role="dialog" aria-modal="true" aria-label="PATH command palette">
      <input class="palette-input" type="text" role="combobox" aria-expanded="true"
             aria-controls="palette-list" placeholder="Search PATH commands…"
             autocomplete="off" autocapitalize="off" spellcheck="false" />
      <ul class="palette-list" id="palette-list" role="listbox"></ul>
      <div class="palette-footer">
        <span><kbd>↑</kbd><kbd>↓</kbd> navigate</span>
        <span><kbd>⏎</kbd> insert</span>
        <span><kbd>esc</kbd> close</span>
        <span class="palette-count"></span>
      </div>
    </div>`;
  document.body.appendChild(root);

  const input = root.querySelector<HTMLInputElement>(".palette-input")!;
  const list = root.querySelector<HTMLUListElement>(".palette-list")!;
  const count = root.querySelector<HTMLSpanElement>(".palette-count")!;

  let all: string[] = [];
  let loaded = false;
  let loadError = false;
  let filtered: string[] = [];
  let active = 0;
  let isOpen = false;

  function rank(cmd: string, q: string): number {
    const c = cmd.toLowerCase();
    if (c === q) return 0;
    if (c.startsWith(q)) return 1;
    return 2; // substring match
  }

  function applyFilter(): void {
    const q = input.value.trim().toLowerCase();
    if (!q) {
      filtered = all;
    } else {
      filtered = all
        .filter((c) => c.toLowerCase().includes(q))
        .sort((a, b) => {
          const ra = rank(a, q);
          const rb = rank(b, q);
          if (ra !== rb) return ra - rb;
          if (a.length !== b.length) return a.length - b.length;
          return a.localeCompare(b);
        });
    }
    active = 0;
    render();
  }

  function render(): void {
    if (!loaded) {
      list.innerHTML = `<li class="palette-empty">${
        loadError ? "Failed to load commands." : "Loading commands…"
      }</li>`;
      count.textContent = "";
      return;
    }
    if (filtered.length === 0) {
      list.innerHTML = `<li class="palette-empty">No matching commands.</li>`;
      count.textContent = "0";
      return;
    }
    const shown = filtered.slice(0, MAX_ROWS);
    list.innerHTML = shown
      .map(
        (cmd, i) =>
          `<li class="palette-item${i === active ? " is-active" : ""}" role="option" data-i="${i}"${
            i === active ? ' aria-selected="true"' : ""
          }>${escapeHtml(cmd)}</li>`,
      )
      .join("");
    count.textContent =
      filtered.length > MAX_ROWS
        ? `${MAX_ROWS} of ${filtered.length}`
        : String(filtered.length);
    scrollActiveIntoView();
  }

  function scrollActiveIntoView(): void {
    const el = list.querySelector<HTMLElement>(".palette-item.is-active");
    el?.scrollIntoView({ block: "nearest" });
  }

  function move(delta: number): void {
    const n = Math.min(filtered.length, MAX_ROWS);
    if (n === 0) return;
    active = (active + delta + n) % n;
    // Re-render only the active flag for cheapness.
    list
      .querySelectorAll<HTMLElement>(".palette-item")
      .forEach((el, i) => {
        const on = i === active;
        el.classList.toggle("is-active", on);
        if (on) el.setAttribute("aria-selected", "true");
        else el.removeAttribute("aria-selected");
      });
    scrollActiveIntoView();
  }

  function submit(): void {
    const cmd = filtered[active];
    if (cmd) {
      opts.onSubmit(cmd);
      close();
    }
  }

  async function ensureLoaded(): Promise<void> {
    if (loaded) return;
    try {
      all = await opts.fetchCommands();
      loaded = true;
      loadError = false;
    } catch {
      loadError = true;
    }
    if (isOpen) applyFilter();
  }

  function open(): void {
    if (isOpen) return;
    isOpen = true;
    root.hidden = false;
    input.value = "";
    render();
    input.focus();
    void ensureLoaded();
  }

  function close(): void {
    if (!isOpen) return;
    isOpen = false;
    root.hidden = true;
    opts.onClose?.();
  }

  function toggle(): void {
    isOpen ? close() : open();
  }

  input.addEventListener("input", applyFilter);

  input.addEventListener("keydown", (e) => {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        move(1);
        break;
      case "ArrowUp":
        e.preventDefault();
        move(-1);
        break;
      case "Enter":
        e.preventDefault();
        submit();
        break;
      case "Escape":
        e.preventDefault();
        close();
        break;
    }
  });

  // Mouse: hover highlights, click inserts.
  list.addEventListener("mousemove", (e) => {
    const li = (e.target as HTMLElement).closest<HTMLElement>(".palette-item");
    if (!li) return;
    const i = Number(li.dataset.i);
    if (i !== active) move(i - active);
  });
  list.addEventListener("click", (e) => {
    const li = (e.target as HTMLElement).closest<HTMLElement>(".palette-item");
    if (!li) return;
    active = Number(li.dataset.i);
    submit();
  });

  // Clicking the dimmed backdrop closes.
  root.addEventListener("mousedown", (e) => {
    if (e.target === root) close();
  });

  return {
    open,
    close,
    toggle,
    get isOpen() {
      return isOpen;
    },
  };
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[c]!,
  );
}
