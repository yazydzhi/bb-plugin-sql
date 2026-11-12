/**
 * Ранжирование кандидатов: качество префикса + личная частота/recency.
 */

import type { CompletionItem, CompletionUsage } from "./types.js";

function usageBoost(usage: CompletionUsage | undefined, nowMs: number): number {
  if (!usage || usage.uses <= 0) {
    return 0;
  }
  const freq = Math.log1p(usage.uses) * 12;
  const last = Date.parse(usage.lastUsedAt);
  if (!Number.isFinite(last)) {
    return freq;
  }
  const ageDays = Math.max(0, (nowMs - last) / (24 * 60 * 60 * 1000));
  const recency = Math.exp(-ageDays / 14) * 8;
  return freq + recency;
}

/**
 * Оценка совпадения префикса (чем выше — тем лучше).
 */
export function matchScore(label: string, prefix: string): number | null {
  if (!prefix) {
    return 40;
  }
  const lower = label.toLowerCase();
  const p = prefix.toLowerCase();
  if (lower === p) {
    return 100;
  }
  if (lower.startsWith(p)) {
    return 80 - Math.min(20, lower.length - p.length);
  }
  if (lower.includes(p)) {
    return 45;
  }
  // Простой fuzzy: все символы префикса по порядку.
  let pi = 0;
  for (let i = 0; i < lower.length && pi < p.length; i += 1) {
    if (lower[i] === p[pi]) {
      pi += 1;
    }
  }
  if (pi === p.length) {
    return 25;
  }
  return null;
}

/**
 * Присваивает score = match + usage; отбрасывает несовпадения; сортирует desc.
 */
export function rankCompletionItems(
  items: Omit<CompletionItem, "score">[],
  prefix: string,
  usages: CompletionUsage[],
  nowMs: number = Date.now(),
): CompletionItem[] {
  const byKey = new Map(usages.map((item) => [item.usageKey, item]));
  const ranked: CompletionItem[] = [];
  for (const item of items) {
    const labelMatch = matchScore(item.label, prefix);
    const filterMatch = item.filterText
      ? matchScore(item.filterText, prefix)
      : null;
    const match = Math.max(labelMatch ?? -1, filterMatch ?? -1);
    if (match < 0) {
      continue;
    }
    const score = match + usageBoost(byKey.get(item.usageKey), nowMs);
    ranked.push({ ...item, score });
  }
  ranked.sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }
    return a.label.localeCompare(b.label);
  });
  return ranked;
}
