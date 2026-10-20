import { memo, useMemo } from "react";
import { highlight, langFor, type Lang } from "../lib/highlight";
import { CopyButton, cx } from "./ui";

/** Highlighted code, optionally with line numbers. */
export const CodeView = memo(function CodeView({
  code,
  lang,
  numbers = true,
  className,
  maxHeight,
}: {
  code: string;
  lang: Lang;
  numbers?: boolean;
  className?: string;
  maxHeight?: number;
}) {
  const lines = useMemo(() => highlight(code.replace(/\n$/, ""), lang), [code, lang]);
  const width = String(lines.length).length;
  return (
    <div className={cx("overflow-auto font-mono text-[12.5px] leading-[1.6]", className)} style={maxHeight ? { maxHeight } : undefined}>
      <table className="code-table w-full border-collapse">
        <tbody>
          {lines.map((toks, i) => (
            <tr key={i} className="align-top hover:bg-white/[0.02]">
              {numbers && (
                <td
                  className="select-none border-r border-border/70 pl-3 pr-2.5 text-right text-muted/50"
                  style={{ width: `${width + 2.4}ch` }}
                >
                  {i + 1}
                </td>
              )}
              <td className="whitespace-pre px-3">
                {toks.length === 0 ? "​" : toks.map((t, j) => (t.c ? <span key={j} className={t.c}>{t.t}</span> : t.t))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
});

/** Fenced code block for markdown: header with language + copy, mono body. */
export function CodeBlock({ code, lang }: { code: string; lang?: string }) {
  const l = langFor(lang);
  return (
    <div className="not-prose my-2 overflow-hidden rounded-card border border-border bg-[#0a0e15]">
      <div className="flex h-8 items-center justify-between border-b border-border bg-[#0e131c] pl-3 pr-1.5">
        <span className="font-mono text-[11px] lowercase tracking-wide text-muted">{lang || "text"}</span>
        <CopyButton text={code.replace(/\n$/, "")} label="copy" />
      </div>
      <CodeView code={code} lang={l} numbers={code.split("\n").length > 6} className="py-2" maxHeight={520} />
    </div>
  );
}

/** Pretty JSON, highlighted. */
export function JsonBlock({ value, maxHeight = 320, className }: { value: unknown; maxHeight?: number; className?: string }) {
  const text = useMemo(() => {
    if (typeof value === "string") {
      try {
        return JSON.stringify(JSON.parse(value), null, 2);
      } catch {
        return value;
      }
    }
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }, [value]);
  return (
    <div className={cx("relative rounded-card border border-border bg-[#0a0e15]", className)}>
      <CopyButton text={text} className="absolute right-1 top-1 z-10" />
      <CodeView code={text} lang="json" numbers={false} className="py-2 pr-8" maxHeight={maxHeight} />
    </div>
  );
}
