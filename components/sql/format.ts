import { toast } from "sonner";
import type { QueryResult } from "./types";

export function formatCell(value: unknown): string {
  if (value === null || value === undefined) {
    return "NULL";
  }
  if (typeof value === "string") {
    return value;
  }
  return JSON.stringify(value);
}

export function tabTitleFromSql(sql: string): string {
  const oneLine = sql.replace(/\s+/g, " ").trim();
  if (oneLine.length <= 36) {
    return oneLine;
  }
  return `${oneLine.slice(0, 33)}…`;
}

/** CSV с экранированием кавычек и UTF-8 BOM для Excel. */
export function resultToCsv(result: QueryResult): string {
  const escape = (value: unknown): string => {
    let text: string;
    if (value === null || value === undefined) {
      text = "";
    } else if (typeof value === "string") {
      text = value;
    } else {
      text = JSON.stringify(value) ?? "";
    }
    if (/[",\r\n]/.test(text)) {
      return `"${text.replaceAll('"', '""')}"`;
    }
    return text;
  };
  const header = result.columns.map(escape).join(",");
  const body = result.rows
    .map((row) => result.columns.map((column) => escape(row[column])).join(","))
    .join("\r\n");
  return `\uFEFF${header}\r\n${body}\r\n`;
}

export function resultToJson(result: QueryResult): string {
  return `${JSON.stringify(result.rows, null, 2)}\n`;
}

function stamp(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  );
}

export function downloadText(content: string, filename: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
  toast.success(`Saved ${filename}`);
}

export async function copyText(content: string, label: string) {
  try {
    await navigator.clipboard.writeText(content);
    toast.success(`${label} copied`);
  } catch (error) {
    toast.error(error instanceof Error ? error.message : `Failed to copy ${label}`);
  }
}

export function downloadResultCsv(result: QueryResult) {
  downloadText(resultToCsv(result), `query-result-${stamp()}.csv`, "text/csv;charset=utf-8");
}

export function downloadResultJson(result: QueryResult) {
  downloadText(
    resultToJson(result),
    `query-result-${stamp()}.json`,
    "application/json;charset=utf-8",
  );
}
