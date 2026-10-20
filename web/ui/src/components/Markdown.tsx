import { memo, isValidElement, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { CodeBlock } from "./Code";
import { cx } from "./ui";

function textOf(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement(node)) return textOf((node.props as { children?: ReactNode }).children);
  return "";
}

const components: Components = {
  pre({ children }) {
    // react-markdown renders fenced blocks as <pre><code class="language-x">…</code></pre>
    const child = Array.isArray(children) ? children[0] : children;
    const className = isValidElement(child) ? ((child.props as { className?: string }).className ?? "") : "";
    const lang = /language-([\w+#.-]+)/.exec(className)?.[1];
    return <CodeBlock code={textOf(children)} lang={lang} />;
  },
  a({ href, children }) {
    return (
      <a href={href} target="_blank" rel="noreferrer noopener">
        {children}
      </a>
    );
  },
  table({ children }) {
    return <table>{children}</table>;
  },
};

export const Markdown = memo(function Markdown({ text, streaming, className }: { text: string; streaming?: boolean; className?: string }) {
  return (
    <div className={cx("md", streaming && "streaming", className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components} skipHtml>
        {text}
      </ReactMarkdown>
    </div>
  );
});
