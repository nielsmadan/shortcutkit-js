import type { Conflict } from './conflicts';
import { formatShortcut } from './grammar';
import type { Shortcut } from './shortcut';

export interface KeyBindingEntry {
  readonly id: string;
  readonly contextId: string;
  readonly actionId: string;
  readonly displayName: string;
  readonly description: string | undefined;
  readonly shortcuts: readonly Shortcut[];
  readonly isCustomized: boolean;
  // A conflict appears on every entry it involves.
  readonly conflicts: readonly Conflict[];
}

export interface KeyBindingGroup {
  readonly contextId: string;
  readonly displayName: string;
  readonly entries: readonly KeyBindingEntry[];
}

export interface KeyBindings {
  readonly groups: readonly KeyBindingGroup[];
}

export interface FuzzyMatch {
  readonly score: number;
  readonly matched: readonly number[];
}

const WORD_SEPARATORS = new Set([' ', '-', '_', '+']);

export function fuzzyMatch(query: string, haystack: string): FuzzyMatch | undefined {
  const needle = [...query.toLowerCase()];
  const chars = [...haystack.toLowerCase()];
  if (needle.length === 0) return { score: 0, matched: [] };
  const matched: number[] = [];
  for (const [index, char] of chars.entries()) {
    if (matched.length === needle.length) break;
    if (char === needle[matched.length]) matched.push(index);
  }
  if (matched.length < needle.length) return undefined;
  const contiguous = matched.filter((index, i) => i > 0 && matched[i - 1] === index - 1).length;
  const wordStarts = matched.filter(
    (index) => index > 0 && WORD_SEPARATORS.has(chars[index - 1] ?? ''),
  ).length;
  const atStart = matched[0] === 0 ? 15 : 0;
  const score =
    matched.length * 5 + contiguous * 10 + wordStarts * 10 + atStart - (matched[0] ?? 0);
  return { score, matched };
}

function entryScore(entry: KeyBindingEntry, query: string): number | undefined {
  const scores = [entry.displayName, ...entry.shortcuts.map(formatShortcut)]
    .map((text) => fuzzyMatch(query, text)?.score)
    .filter((score) => score !== undefined);
  return scores.length === 0 ? undefined : Math.max(...scores);
}

// Fuzzy-matches display names and shortcut strings; entries sort by descending score
// and empty groups are dropped.
export function filterKeyBindings(bindings: KeyBindings, query: string): KeyBindings {
  const trimmed = query.trim();
  if (trimmed === '') return bindings;
  const groups = bindings.groups
    .map((group) => {
      const scored = group.entries
        .map((entry) => ({ entry, score: entryScore(entry, trimmed) }))
        .filter(
          (item): item is { entry: KeyBindingEntry; score: number } => item.score !== undefined,
        )
        .sort((a, b) => b.score - a.score);
      return { ...group, entries: scored.map((item) => item.entry) };
    })
    .filter((group) => group.entries.length > 0);
  return { groups };
}

export function boundOnly(bindings: KeyBindings): KeyBindings {
  const groups = bindings.groups
    .map((group) => ({ ...group, entries: group.entries.filter((e) => e.shortcuts.length > 0) }))
    .filter((group) => group.entries.length > 0);
  return { groups };
}
