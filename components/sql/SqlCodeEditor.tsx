import {
  useEffect,
  useRef,
  type CSSProperties,
  type KeyboardEvent,
  type UIEvent,
} from "react";
import { highlightSql } from "./highlight-sql";

type SqlCodeEditorProps = {
  value: string;
  onChange: (value: string) => void;
  onKeyDown?: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  placeholder?: string;
  className?: string;
  style?: CSSProperties;
  "aria-label"?: string;
};

/**
 * Редактируемый SQL с подсветкой: цветной слой под прозрачным textarea,
 * синхронизация скролла.
 */
export function SqlCodeEditor({
  value,
  onChange,
  onKeyDown,
  placeholder = "SELECT …  (⌘/Ctrl+Enter to run)",
  className = "",
  style,
  "aria-label": ariaLabel = "SQL editor",
}: SqlCodeEditorProps) {
  const highlightRef = useRef<HTMLPreElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    const highlight = highlightRef.current;
    const textarea = textareaRef.current;
    if (!highlight || !textarea) {
      return;
    }
    highlight.scrollTop = textarea.scrollTop;
    highlight.scrollLeft = textarea.scrollLeft;
  }, [value]);

  function syncScroll(event: UIEvent<HTMLTextAreaElement>) {
    const highlight = highlightRef.current;
    if (!highlight) {
      return;
    }
    highlight.scrollTop = event.currentTarget.scrollTop;
    highlight.scrollLeft = event.currentTarget.scrollLeft;
  }

  const highlighted = highlightSql(value);

  return (
    <div
      className={`sql-code-editor relative min-h-0 overflow-hidden ${className}`.trim()}
      style={style}
    >
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
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
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
      `}</style>
    </div>
  );
}
