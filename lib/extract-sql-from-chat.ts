/**
 * Достаёт SQL из выделения или первого fenced-блока `sql` / `postgres` в тексте сообщения.
 */
export function extractSqlFromChat(
  selectedText: string | undefined,
  messageText: string,
): string | null {
  const fromSelection = normalizeSqlCandidate(selectedText);
  if (fromSelection) {
    return fromSelection;
  }

  const fence = messageText.match(/```(?:sql|postgres|postgresql)?\s*\n([\s\S]*?)```/i);
  if (fence?.[1]) {
    const fromFence = normalizeSqlCandidate(fence[1]);
    if (fromFence) {
      return fromFence;
    }
  }

  return null;
}

function normalizeSqlCandidate(raw: string | undefined): string | null {
  if (!raw) {
    return null;
  }
  let text = raw.trim();
  if (!text) {
    return null;
  }
  // Выделение вместе с маркерами fence
  const wrapped = text.match(/^```(?:sql|postgres|postgresql)?\s*\n?([\s\S]*?)```$/i);
  if (wrapped?.[1]) {
    text = wrapped[1].trim();
  }
  return text.length > 0 ? text : null;
}
