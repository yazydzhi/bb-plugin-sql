import {
  useEffect,
  useRef,
  type CSSProperties,
  type KeyboardEvent,
  type UIEvent,
} from "react";
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
 * Редактируемый SQL с подсветкой: цветной слой под прозрачным textarea,
 * синхронизация скролла; опционально фон активного statement.
 */
export function SqlCodeEditor({
  value,
  onChange,
  onKeyDown,
  onSelectionChange,
  activeRange = null,
  placeholder = "SELECT …  (⌘/Ctrl+Enter to run)",
  className = "",
  style,
  "aria-label": ariaLabel = "SQL editor",
}: SqlCodeEditorProps) {
  const markRef = useRef<HTMLPreElement | null>(null);
  const highlightRef = useRef<HTMLPreElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    syncOverlayScroll();
  }, [value, activeRange]);

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
    onSelectionChange?.({
      selectionStart: target.selectionStart,
      selectionEnd: target.selectionEnd,
    });
  }

  const highlighted = highlightSql(value);
  const markHtml = buildActiveMarkHtml(value, activeRange);

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
        onChange={(event) => {
          onChange(event.target.value);
          emitSelection(event.target);
        }}
        onKeyDown={onKeyDown}
        onKeyUp={(event) => emitSelection(event.currentTarget)}
        onClick={(event) => emitSelection(event.currentTarget)}
        onSelect={(event) => emitSelection(event.currentTarget)}
        onScroll={syncScroll}
        spellCheck={false}
        placeholder={placeholder}
        aria-label={ariaLabel}
      />
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
        .sql-code-highlight .sql-tok-ident {
          color: var(--foreground, inherit);
        }
        .sql-code-highlight .sql-tok-punct {
          color: #a855f7;
        }
        @media (prefers-color-scheme: dark) {
          .sql-code-highlight .sql-tok-keyword { color: #93c5fd; }
          .sql-code-highlight .sql-tok-string { color: #86efac; }
          .sql-code-highlight .sql-tok-comment { color: #6b7280; }
          .sql-code-highlight .sql-tok-number { color: #fbbf24; }
          .sql-code-highlight .sql-tok-punct { color: #d8b4fe; }
          .sql-active-mark-layer .sql-active-range {
            background: color-mix(in oklab, #60a5fa 28%, transparent);
          }
        }
        :root.dark .sql-code-highlight .sql-tok-keyword,
        .dark .sql-code-highlight .sql-tok-keyword { color: #93c5fd; }
        :root.dark .sql-code-highlight .sql-tok-string,
        .dark .sql-code-highlight .sql-tok-string { color: #86efac; }
        :root.dark .sql-code-highlight .sql-tok-comment,
        .dark .sql-code-highlight .sql-tok-comment { color: #6b7280; }
        :root.dark .sql-code-highlight .sql-tok-number,
        .dark .sql-code-highlight .sql-tok-number { color: #fbbf24; }
        :root.dark .sql-code-highlight .sql-tok-punct,
        .dark .sql-code-highlight .sql-tok-punct { color: #d8b4fe; }
        :root.dark .sql-active-mark-layer .sql-active-range,
        .dark .sql-active-mark-layer .sql-active-range {
          background: color-mix(in oklab, #60a5fa 28%, transparent);
        }
      `}</style>
    </div>
  );
}
