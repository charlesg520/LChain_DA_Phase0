// A small regex highlighter: strings, comments, keywords, numbers, plus a few
// language-specific touches. Deliberately tiny; no heavy dependency.

export type Lang =
  | "ts" | "js" | "py" | "sh" | "json" | "yaml" | "toml" | "sql" | "md" | "css" | "html" | "go" | "rust" | "pine" | "diff" | "text";

const KW: Record<string, string[]> = {
  ts: ["import", "export", "from", "default", "const", "let", "var", "function", "return", "if", "else", "for", "while", "do", "switch", "case", "break", "continue", "new", "class", "extends", "implements", "interface", "type", "enum", "async", "await", "try", "catch", "finally", "throw", "typeof", "instanceof", "in", "of", "as", "declare", "public", "private", "protected", "readonly", "static", "this", "super", "null", "undefined", "true", "false", "void", "yield", "keyof", "satisfies"],
  py: ["def", "class", "return", "if", "elif", "else", "for", "while", "in", "not", "and", "or", "is", "import", "from", "as", "with", "try", "except", "finally", "raise", "lambda", "yield", "async", "await", "pass", "break", "continue", "global", "nonlocal", "None", "True", "False", "self", "assert", "del", "match", "case"],
  sh: ["if", "then", "else", "elif", "fi", "for", "in", "do", "done", "while", "case", "esac", "function", "return", "export", "local", "set", "source", "echo", "cd", "exit", "sudo", "make", "git", "docker", "curl", "uv", "pnpm", "npm"],
  sql: ["select", "from", "where", "and", "or", "not", "insert", "into", "values", "update", "set", "delete", "create", "table", "index", "join", "left", "right", "inner", "outer", "on", "group", "by", "order", "limit", "offset", "having", "as", "distinct", "union", "all", "case", "when", "then", "else", "end", "null", "is", "in", "like", "desc", "asc", "sum", "count", "avg", "min", "max", "with", "returning"],
  go: ["package", "import", "func", "return", "if", "else", "for", "range", "switch", "case", "default", "go", "defer", "chan", "select", "struct", "interface", "map", "type", "var", "const", "nil", "true", "false", "err"],
  rust: ["fn", "let", "mut", "pub", "use", "mod", "struct", "enum", "impl", "trait", "match", "if", "else", "for", "while", "loop", "return", "self", "Self", "true", "false", "None", "Some", "Ok", "Err", "async", "await", "move", "where"],
  pine: ["if", "else", "for", "to", "while", "var", "varip", "true", "false", "and", "or", "not", "import", "export", "method", "type", "switch", "strategy", "indicator", "input", "plot", "ta", "math", "request"],
};
KW.js = KW.ts;

const EXT: Record<string, Lang> = {
  ts: "ts", tsx: "ts", mts: "ts", js: "js", jsx: "js", mjs: "js", cjs: "js", py: "py", sh: "sh", bash: "sh", zsh: "sh",
  json: "json", jsonl: "json", yaml: "yaml", yml: "yaml", toml: "toml", sql: "sql", md: "md", markdown: "md", css: "css",
  html: "html", xml: "html", go: "go", rs: "rust", pine: "pine", diff: "diff", patch: "diff",
};

export function langFor(nameOrLang: string | undefined): Lang {
  if (!nameOrLang) return "text";
  const s = nameOrLang.toLowerCase();
  if (s in EXT) return EXT[s];
  if (["typescript"].includes(s)) return "ts";
  if (["javascript"].includes(s)) return "js";
  if (["python"].includes(s)) return "py";
  if (["shell", "console", "shellscript"].includes(s)) return "sh";
  if (["dockerfile", "makefile"].includes(s)) return "sh";
  const base = s.split("/").pop() || s;
  if (base === "dockerfile" || base === "makefile" || base.startsWith(".env")) return "sh";
  const ext = base.includes(".") ? base.split(".").pop()! : "";
  return EXT[ext] || "text";
}

export function langForMime(mime: string, path: string): Lang {
  const byPath = langFor(path);
  if (byPath !== "text") return byPath;
  if (mime.includes("json")) return "json";
  if (mime.includes("yaml")) return "yaml";
  if (mime.includes("markdown")) return "md";
  if (mime.includes("python")) return "py";
  if (mime.includes("typescript")) return "ts";
  if (mime.includes("javascript")) return "js";
  if (mime.includes("x-sh")) return "sh";
  return "text";
}

export type Token = { t: string; c?: string };

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const cache = new Map<string, RegExp>();

function tokenizer(lang: Lang): RegExp {
  const hit = cache.get(lang);
  if (hit) return hit;
  const parts: string[] = [];
  const hashComment = ["py", "sh", "yaml", "toml"].includes(lang);
  const slashComment = ["ts", "js", "go", "rust", "css", "pine", "json"].includes(lang);
  if (slashComment) parts.push("(?<com>\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/)");
  if (hashComment) parts.push("(?<com>#[^\\n]*)");
  if (lang === "sql") parts.push("(?<com>--[^\\n]*)");
  if (lang === "html") parts.push("(?<com><!--[\\s\\S]*?-->)");
  if (lang === "py") parts.push("(?<str>[rbfu]{0,2}(?:\"\"\"[\\s\\S]*?\"\"\"|'''[\\s\\S]*?'''))");
  parts.push("(?<str>\"(?:[^\"\\\\\\n]|\\\\.)*\"|'(?:[^'\\\\\\n]|\\\\.)*'|`(?:[^`\\\\]|\\\\.)*`)");
  if (lang === "yaml" || lang === "toml") parts.push("(?<key>^[ \\t-]*[A-Za-z0-9_.\\-\"']+(?=\\s*[:=]))");
  parts.push("(?<num>\\b(?:0x[0-9a-fA-F]+|\\d+(?:\\.\\d+)?(?:e[+-]?\\d+)?)\\b)");
  const kw = KW[lang];
  if (kw) parts.push(`(?<kw>\\b(?:${kw.map(escapeRe).join("|")})\\b)`);
  if (["ts", "js", "py", "go", "rust", "pine"].includes(lang)) {
    parts.push("(?<type>\\b[A-Z][A-Za-z0-9_]*\\b)");
    parts.push("(?<fn>\\b[a-zA-Z_][\\w]*(?=\\s*\\())");
  }
  if (lang === "sh") parts.push("(?<key>\\$\\{?[A-Za-z_][A-Za-z0-9_]*\\}?|\\s--?[a-zA-Z][\\w-]*)");
  if (lang === "html") parts.push("(?<kw><\\/?[a-zA-Z][\\w-]*|\\/?>)");
  if (lang === "css") parts.push("(?<key>[a-z-]+(?=\\s*:))");
  const re = new RegExp(parts.join("|"), lang === "sql" ? "gim" : "gm");
  cache.set(lang, re);
  return re;
}

const CLASS: Record<string, string> = { com: "hl-com", str: "hl-str", num: "hl-num", kw: "hl-kw", type: "hl-type", fn: "hl-fn", key: "hl-key" };

/** Tokenize text; returns lines of tokens (multi-line comments/strings are split per line). */
export function highlight(text: string, lang: Lang): Token[][] {
  if (lang === "diff") {
    return text.split("\n").map((line) => {
      const c = line.startsWith("+++") || line.startsWith("---") ? "hl-com" : line.startsWith("+") ? "hl-add" : line.startsWith("-") ? "hl-del" : line.startsWith("@@") ? "hl-hunk" : undefined;
      return [{ t: line, c }];
    });
  }
  if (lang === "text" || lang === "md" || text.length > 400_000) {
    return text.split("\n").map((t) => [{ t }]);
  }
  const re = tokenizer(lang);
  re.lastIndex = 0;
  const flat: Token[] = [];
  let last = 0;
  for (const m of text.matchAll(re)) {
    const start = m.index ?? 0;
    if (start > last) flat.push({ t: text.slice(last, start) });
    const group = Object.entries(m.groups || {}).find(([, v]) => v !== undefined)?.[0];
    if (lang === "json" && group === "str" && /^\s*:/.test(text.slice(start + m[0].length, start + m[0].length + 3))) {
      flat.push({ t: m[0], c: "hl-key" });
    } else {
      flat.push({ t: m[0], c: group ? CLASS[group] : undefined });
    }
    last = start + m[0].length;
    if (m[0].length === 0) re.lastIndex++;
  }
  if (last < text.length) flat.push({ t: text.slice(last) });
  const lines: Token[][] = [[]];
  for (const tok of flat) {
    const pieces = tok.t.split("\n");
    pieces.forEach((p, i) => {
      if (i > 0) lines.push([]);
      if (p) lines[lines.length - 1].push({ t: p, c: tok.c });
    });
  }
  return lines;
}
