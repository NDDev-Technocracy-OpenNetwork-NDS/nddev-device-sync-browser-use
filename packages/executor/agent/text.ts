// Text views that keep agent output small: a search over lines, and a line diff against the view
// an agent saw last.

export type Search = string | RegExp;

const MATCHES = 10;
// Above this many cells the line table costs more than printing the whole view again.
const DIFF_CELLS = 4_000_000;

/** Whether a line matches: a string case-insensitively, a pattern as written. */
export function matches(search: Search): (line: string) => boolean {
  if (typeof search === "string") {
    const needle = search.toLowerCase();
    return (line) => line.toLowerCase().includes(needle);
  }
  const pattern = new RegExp(search.source, search.flags.replace(/[gy]/g, ""));
  return (line) => pattern.test(line);
}

/** The first matching lines, each with `around` lines of context; overlapping ranges merge. */
export function searched(text: string, search: Search, around = 0): string {
  const lines = text.split("\n");
  const matching = matches(search);
  const ranges: [number, number][] = [];
  // The limit counts matching lines: dense matches merge their ranges, and counting ranges would
  // let one merged range run through the whole view.
  let found = 0;
  for (let index = 0; index < lines.length && found < MATCHES; index++) {
    if (!matching(lines[index] ?? "")) continue;
    found++;
    const start = Math.max(0, index - around);
    const end = Math.min(lines.length - 1, index + around);
    const last = ranges.at(-1);
    if (last && start <= last[1] + 1) last[1] = end;
    else ranges.push([start, end]);
  }
  if (ranges.length === 0) return "No matches found";
  return ranges.map(([start, end]) => lines.slice(start, end + 1).join("\n")).join("\n---\n");
}

/**
 * The changed lines between two views, `+` for added and `-` for removed, with one line of
 * context, or undefined when the diff would not be shorter than the current view.
 */
export function diffed(previous: string, current: string): string | undefined {
  if (previous === current) return "No changes since last call";
  const before = previous.split("\n");
  const after = current.split("\n");
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let end = 0;
  while (
    end < before.length - start &&
    end < after.length - start &&
    before[before.length - 1 - end] === after[after.length - 1 - end]
  ) {
    end++;
  }
  const removed = before.slice(start, before.length - end);
  const added = after.slice(start, after.length - end);
  if (removed.length * added.length > DIFF_CELLS) return undefined;
  const changes = middle(removed, added);
  const lines: string[] = [];
  if (start > 0) lines.push(`  ${after[start - 1]}`);
  lines.push(...changes);
  if (end > 0) lines.push(`  ${after[after.length - end]}`);
  const diff = lines.join("\n");
  return diff.length < current.length ? diff : undefined;
}

// A longest-common-subsequence walk over the differing middle part.
function middle(before: string[], after: string[]): string[] {
  const width = after.length + 1;
  const table = new Uint32Array((before.length + 1) * width);
  for (let i = before.length - 1; i >= 0; i--) {
    for (let j = after.length - 1; j >= 0; j--) {
      table[i * width + j] =
        before[i] === after[j]
          ? (table[(i + 1) * width + j + 1] ?? 0) + 1
          : Math.max(table[(i + 1) * width + j] ?? 0, table[i * width + j + 1] ?? 0);
    }
  }
  const lines: string[] = [];
  let [i, j] = [0, 0];
  while (i < before.length || j < after.length) {
    if (i < before.length && j < after.length && before[i] === after[j]) {
      lines.push(`  ${before[i]}`);
      i++;
      j++;
    } else if (
      i < before.length &&
      (j === after.length || (table[(i + 1) * width + j] ?? 0) >= (table[i * width + j + 1] ?? 0))
    ) {
      lines.push(`- ${before[i]}`);
      i++;
    } else {
      lines.push(`+ ${after[j]}`);
      j++;
    }
  }
  return lines;
}

export type ViewOptions = {
  /** Lines to keep, the first ten matches. */
  search?: Search | undefined;
  /** Only the changes since the last call; defaults to on without a search, off with one. */
  showDiffSinceLastCall?: boolean | undefined;
};

/**
 * Remembers the last view per page and scope, and answers the diff since it, the search result
 * or the full view. The snapshot, HTML and markdown helpers share it.
 */
export class Views<K extends object> {
  private readonly last = new WeakMap<K, Map<string, string>>();

  constructor(private readonly around: number) {}

  show(key: K, scope: string, header: string, view: string, options: ViewOptions): string {
    const seen = this.last.get(key) ?? new Map<string, string>();
    this.last.set(key, seen);
    const previous = seen.get(scope);
    seen.set(scope, view);
    const { search } = options;
    const pick = (text: string) =>
      search === undefined ? text : searched(text, search, this.around);
    const body = pick(view);
    const diff = options.showDiffSinceLastCall ?? search === undefined;
    const changes = diff && previous !== undefined ? diffed(pick(previous), body) : undefined;
    return `${header}\n\n${changes ?? body}`;
  }

  /** A navigation starts a new document, so the next view is shown in full. */
  forget(key: K): void {
    this.last.delete(key);
  }
}
