import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type UIEvent,
} from "react";
import {
  analyzeCompletionContext,
  completeSql,
  type CompletionItem,
  type CompletionUsage,
  type SchemaCatalog,
} from "../../lib/sql-completion";
import { highlightSql } from "./highlight-sql";

export type SqlEditorSelection = {
  selectionStart: number;
  selectionEnd: number;
};

type SqlCodeEditorProps = {
  value: string;
  onChange: (value: string) => void;
  onKeyDown?: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  /** Курсор / выделение изменились (для multi-statement UX). */
  onSelectionChange?: (selection: SqlEditorSelection) => void;
  /** Фоновая подсветка активного statement / selection. */
  activeRange?: { start: number; end: number } | null;
  /** Каталог схемы для автодополнения (null = только keywords). */
  catalog?: SchemaCatalog | null;
  usages?: CompletionUsage[];
  onAcceptCompletion?: (item: CompletionItem) => void;
  placeholder?: string;
  className?: string;
  style?: CSSProperties;
  "aria-label"?: string;
};

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** HTML-слой с фоном активного диапазона (текст прозрачный). */
function buildActiveMarkHtml(
  source: string,
  range: { start: number; end: number } | null | undefined,
): string {
  if (!source) {
    return "&nbsp;";
  }
  if (!range || range.start >= range.end) {
    const html = escapeHtml(source);
    return source.endsWith("\n") ? `${html}&nbsp;` : html;
  }
  const start = Math.max(0, Math.min(range.start, source.length));
  const end = Math.max(start, Math.min(range.end, source.length));
  const html =
    escapeHtml(source.slice(0, start)) +
    `<mark class="sql-active-range">${escapeHtml(source.slice(start, end))}</mark>` +
    escapeHtml(source.slice(end));
  return source.endsWith("\n") ? `${html}&nbsp;` : html;
}

/**
 * Редактируемый SQL с подсветкой и schema-aware автодополнением (0.6).
 */
export function SqlCodeEditor({
  value,
  onChange,
  onKeyDown,
  onSelectionChange,
  activeRange = null,
  catalog = null,
  usages = [],
  onAcceptCompletion,
  placeholder = "SELECT …  (⌘/Ctrl+Enter to run, Ctrl+Space complete)",
  className = "",
  style,
  "aria-label": ariaLabel = "SQL editor",
}: SqlCodeEditorProps) {
  const markRef = useRef<HTMLPreElement | null>(null);
  const highlightRef = useRef<HTMLPreElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [cursor, setCursor] = useState(0);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [manualOpen, setManualOpen] = useState(false);

  const items = useMemo(() => {
    if (!open && !manualOpen) {
      return [] as CompletionItem[];
    }
    return completeSql({
      sql: value,
      cursor,
      catalog,
      usages,
      limit: 40,
    });
  }, [open, manualOpen, value, cursor, catalog, usages]);

  const showPopup = (open || manualOpen) && items.length > 0;

  useEffect(() => {
    syncOverlayScroll();
  }, [value, activeRange]);

  const itemKey = items.map((item) => item.usageKey).join("|");
  useEffect(() => {
    setActiveIndex(0);
  }, [itemKey]);

  function syncOverlayScroll() {
    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }
    for (const layer of [markRef.current, highlightRef.current]) {
      if (!layer) {
        continue;
      }
      layer.scrollTop = textarea.scrollTop;
      layer.scrollLeft = textarea.scrollLeft;
    }
  }

  function syncScroll(event: UIEvent<HTMLTextAreaElement>) {
    const target = event.currentTarget;
    for (const layer of [markRef.current, highlightRef.current]) {
      if (!layer) {
        continue;
      }
      layer.scrollTop = target.scrollTop;
      layer.scrollLeft = target.scrollLeft;
    }
  }

  function emitSelection(target: HTMLTextAreaElement) {
    const next = {
      selectionStart: target.selectionStart,
      selectionEnd: target.selectionEnd,
    };
    setCursor(next.selectionStart);
    onSelectionChange?.(next);
  }

  const acceptItem = useCallback(
    (item: CompletionItem) => {
      const ctx = analyzeCompletionContext(value, cursor);
      const before = value.slice(0, ctx.prefixStart);
      const after = value.slice(cursor);
      const next = `${before}${item.insertText}${after}`;
      const nextCursor = before.length + item.insertText.length;
      onChange(next);
      onAcceptCompletion?.(item);
      setOpen(false);
      setManualOpen(false);
      requestAnimationFrame(() => {
        const textarea = textareaRef.current;
        if (!textarea) {
          return;
        }
        textarea.focus();
        textarea.setSelectionRange(nextCursor, nextCursor);
        setCursor(nextCursor);
        onSelectionChange?.({
          selectionStart: nextCursor,
          selectionEnd: nextCursor,
        });
      });
    },
    [value, cursor, onChange, onAcceptCompletion, onSelectionChange],
  );

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === " " && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      setManualOpen(true);
      setOpen(true);
      return;
    }

    if (showPopup) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActiveIndex((index) => (index + 1) % items.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setActiveIndex((index) => (index - 1 + items.length) % items.length);
        return;
      }
      if (event.key === "Tab") {
        const item = items[activeIndex];
        if (item) {
          event.preventDefault();
          acceptItem(item);
          return;
        }
      }
      // Enter — обычный перевод строки; подсказку закрываем.
      if (event.key === "Enter") {
        setOpen(false);
        setManualOpen(false);
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
        setManualOpen(false);
        return;
      }
    }

    onKeyDown?.(event);
  }

  function handleChange(next: string, target: HTMLTextAreaElement) {
    onChange(next);
    emitSelection(target);
    const ctx = analyzeCompletionContext(next, target.selectionStart);
    const shouldOpen =
      ctx.prefix.length >= 1 ||
      ctx.qualifierRelation !== null ||
      /(?:FROM|JOIN|SELECT|WHERE|AND|OR)\s+$/i.test(
        next.slice(Math.max(0, target.selectionStart - 24), target.selectionStart),
      );
    setOpen(shouldOpen);
    if (!shouldOpen) {
      setManualOpen(false);
    }
  }

  const highlighted = highlightSql(value);
  const markHtml = buildActiveMarkHtml(value, activeRange);
  const ctx = analyzeCompletionContext(value, cursor);
  const lineStart = value.lastIndexOf("\n", Math.max(0, ctx.prefixStart - 1)) + 1;
  const lineIndex = value.slice(0, lineStart).split("\n").length - 1;
  const colIndex = ctx.prefixStart - lineStart;
  const popupTop = 8 + (lineIndex + 1) * 20 - (textareaRef.current?.scrollTop ?? 0);
  const popupLeft = 12 + colIndex * 8.4;

  return (
    <div
      className={`sql-code-editor relative min-h-0 overflow-hidden ${className}`.trim()}
      style={style}
    >
      <pre
        ref={markRef}
        aria-hidden
        className="sql-active-mark-layer pointer-events-none absolute inset-0 m-0 overflow-auto whitespace-pre-wrap break-words px-3 py-2 font-mono text-sm leading-5"
        dangerouslySetInnerHTML={{ __html: markHtml }}
      />
      <pre
        ref={highlightRef}
        aria-hidden
        className="sql-code-highlight pointer-events-none absolute inset-0 m-0 overflow-auto whitespace-pre-wrap break-words px-3 py-2 font-mono text-sm leading-5"
        dangerouslySetInnerHTML={{ __html: highlighted }}
      />
      <textarea
        ref={textareaRef}
        className="absolute inset-0 z-10 h-full w-full resize-none overflow-auto bg-transparent px-3 py-2 font-mono text-sm leading-5 text-transparent caret-foreground outline-none selection:bg-state-active/40"
        value={value}
        onChange={(event) => handleChange(event.target.value, event.target)}
        onKeyDown={handleKeyDown}
        onKeyUp={(event) => emitSelection(event.currentTarget)}
        onClick={(event) => emitSelection(event.currentTarget)}
        onSelect={(event) => emitSelection(event.currentTarget)}
        onScroll={syncScroll}
        onBlur={() => {
          // Даём клику по popup успеть сработать.
          window.setTimeout(() => {
            setOpen(false);
            setManualOpen(false);
          }, 150);
        }}
        spellCheck={false}
        placeholder={placeholder}
        aria-label={ariaLabel}
        aria-autocomplete="list"
      />
      {showPopup ? (
        <ul
          role="listbox"
          className="absolute z-30 max-h-56 min-w-[16rem] overflow-auto rounded-md border border-border bg-background py-1 text-sm shadow-lg"
          style={{
            top: Math.max(8, Math.min(popupTop, 180)),
            left: Math.max(8, Math.min(popupLeft, 280)),
          }}
        >
          {items.map((item, index) => {
            const active = index === activeIndex;
            return (
              <li key={`${item.usageKey}:${item.label}:${index}`}>
                <button
                  type="button"
                  role="option"
                  aria-selected={active}
                  className={`flex w-full items-baseline gap-2 px-2 py-1 text-left font-mono ${
                    active ? "bg-state-active/20" : "hover:bg-muted/40"
                  }`}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    acceptItem(item);
                  }}
                >
                  <span className="shrink-0 text-[10px] uppercase text-muted-foreground">
                    {item.kind}
                  </span>
                  <span className="font-medium">{item.label}</span>
                  {item.detail ? (
                    <span className="truncate text-xs text-muted-foreground">
                      {item.detail}
                    </span>
                  ) : null}
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
      <style>{`
        .sql-code-editor {
          background: color-mix(in oklab, var(--background, transparent) 92%, transparent);
        }
        .sql-code-editor textarea::placeholder {
          color: var(--muted-foreground, #888);
          opacity: 0.7;
        }
        .sql-active-mark-layer {
          color: transparent;
        }
        .sql-active-mark-layer .sql-active-range {
          background: color-mix(in oklab, var(--state-active, #3b82f6) 22%, transparent);
          color: transparent;
          border-radius: 2px;
        }
        .sql-code-highlight .sql-tok-keyword {
          color: #3b82f6;
          font-weight: 600;
        }
        .sql-code-highlight .sql-tok-string {
          color: #16a34a;
        }
        .sql-code-highlight .sql-tok-comment {
          color: #9ca3af;
          font-style: italic;
        }
        .sql-code-highlight .sql-tok-number {
          color: #d97706;
        }
      `}</style>
    </div>
  );
}
