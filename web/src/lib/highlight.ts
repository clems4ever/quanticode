import type { HighlighterCore, ThemedToken } from "shiki/core";

/**
 * Syntax highlighting for the file view.
 *
 * Three constraints shaped this.
 *
 * The file view is virtualised — only the forty-odd rows on screen are in the
 * DOM — so highlighting has to be **per line**, not one blob of HTML. Shiki's
 * `codeToTokens` returns exactly that: one token array per line, which drops
 * straight into the existing row renderer.
 *
 * Nothing may be fetched from a CDN. A quanticode instance is often a container
 * with a repository mounted into it and no route to the internet, so grammars
 * are dynamic imports that Vite turns into chunks served from the instance's own
 * `/assets`.
 *
 * And the initial bundle must not grow for a feature most visits never reach.
 * The core, the engine and every grammar load on first file open, not on page
 * load, and the JavaScript regex engine is used rather than the default so the
 * ~1 MB oniguruma wasm never ships at all.
 */

/** A line as ranges of text with a colour, or null where there is nothing to say. */
export type HighlightedLine = ThemedToken[] | null;

export interface Highlighted {
  lines: HighlightedLine[];
  /** The language actually used, for the file header. */
  lang: string;
}

/**
 * Grammars, by file extension.
 *
 * Every entry is a dynamic import so it becomes its own chunk. The list covers
 * what a repository's tracked source is mostly made of; anything absent renders
 * as plain text, which is the previous behaviour and perfectly readable.
 */
const LANGS: Record<string, () => Promise<unknown>> = {
  go: () => import("shiki/langs/go.mjs"),
  ts: () => import("shiki/langs/typescript.mjs"),
  tsx: () => import("shiki/langs/tsx.mjs"),
  mts: () => import("shiki/langs/typescript.mjs"),
  cts: () => import("shiki/langs/typescript.mjs"),
  js: () => import("shiki/langs/javascript.mjs"),
  mjs: () => import("shiki/langs/javascript.mjs"),
  cjs: () => import("shiki/langs/javascript.mjs"),
  jsx: () => import("shiki/langs/jsx.mjs"),
  py: () => import("shiki/langs/python.mjs"),
  rs: () => import("shiki/langs/rust.mjs"),
  java: () => import("shiki/langs/java.mjs"),
  kt: () => import("shiki/langs/kotlin.mjs"),
  kts: () => import("shiki/langs/kotlin.mjs"),
  swift: () => import("shiki/langs/swift.mjs"),
  c: () => import("shiki/langs/c.mjs"),
  h: () => import("shiki/langs/c.mjs"),
  cpp: () => import("shiki/langs/cpp.mjs"),
  cc: () => import("shiki/langs/cpp.mjs"),
  hpp: () => import("shiki/langs/cpp.mjs"),
  cs: () => import("shiki/langs/csharp.mjs"),
  rb: () => import("shiki/langs/ruby.mjs"),
  php: () => import("shiki/langs/php.mjs"),
  sh: () => import("shiki/langs/shellscript.mjs"),
  bash: () => import("shiki/langs/shellscript.mjs"),
  zsh: () => import("shiki/langs/shellscript.mjs"),
  lua: () => import("shiki/langs/lua.mjs"),
  sql: () => import("shiki/langs/sql.mjs"),
  yaml: () => import("shiki/langs/yaml.mjs"),
  yml: () => import("shiki/langs/yaml.mjs"),
  json: () => import("shiki/langs/json.mjs"),
  jsonc: () => import("shiki/langs/jsonc.mjs"),
  toml: () => import("shiki/langs/toml.mjs"),
  ini: () => import("shiki/langs/ini.mjs"),
  xml: () => import("shiki/langs/xml.mjs"),
  html: () => import("shiki/langs/html.mjs"),
  css: () => import("shiki/langs/css.mjs"),
  scss: () => import("shiki/langs/scss.mjs"),
  md: () => import("shiki/langs/markdown.mjs"),
  markdown: () => import("shiki/langs/markdown.mjs"),
  vue: () => import("shiki/langs/vue.mjs"),
  svelte: () => import("shiki/langs/svelte.mjs"),
  proto: () => import("shiki/langs/proto.mjs"),
  tf: () => import("shiki/langs/terraform.mjs"),
  hcl: () => import("shiki/langs/hcl.mjs"),
  diff: () => import("shiki/langs/diff.mjs"),
  dockerfile: () => import("shiki/langs/docker.mjs"),
  makefile: () => import("shiki/langs/make.mjs"),
  gradle: () => import("shiki/langs/groovy.mjs"),
};

/** Whole filenames that carry no extension but are still known. */
const BY_FILENAME: Record<string, string> = {
  dockerfile: "dockerfile",
  makefile: "makefile",
  ".gitignore": "sh",
  ".dockerignore": "sh",
};

/**
 * Themes chosen to stay out of the way.
 *
 * Heat is the encoding this app is built around, and syntax colour competes
 * with it for the reader's attention. These two are comparatively restrained,
 * and the row's heat wash and gutter bar stay the loudest thing on the line.
 */
const THEMES = {
  dark: "github-dark-default",
  light: "github-light-default",
} as const;

/** Files past this are rendered plain: tokenising them janks the open. */
const MAX_LINES = 20000;

let corePromise: Promise<HighlighterCore> | null = null;
const loaded = new Set<string>();

function core(): Promise<HighlighterCore> {
  // The engine and the core are imported here rather than at module scope on
  // purpose. A static import would pull them into the entry chunk through
  // FileViewer, and they are ~57 KB gzipped that a visit which never opens a
  // file should not pay for. Types above are erased and cost nothing.
  corePromise ??= (async () => {
    const [{ createHighlighterCore }, { createJavaScriptRegexEngine }] = await Promise.all([
      import("shiki/core"),
      import("shiki/engine/javascript"),
    ]);
    return createHighlighterCore({
      themes: [
        import("shiki/themes/github-dark-default.mjs"),
        import("shiki/themes/github-light-default.mjs"),
      ],
      langs: [],
      // Regex engine in JavaScript rather than the wasm one: a megabyte of
      // oniguruma for a view that is not the main one is not worth it.
      engine: createJavaScriptRegexEngine(),
    });
  })();
  return corePromise;
}

/** The grammar for a path, or null when there is none and plain text will do. */
export function languageFor(path: string): string | null {
  const base = path.split("/").pop()?.toLowerCase() ?? "";
  if (BY_FILENAME[base]) return BY_FILENAME[base];
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return null;
  const ext = base.slice(dot + 1);
  return LANGS[ext] ? ext : null;
}

/**
 * Tokenises a whole file, one entry per line.
 *
 * Never rejects. Highlighting is decoration on a view whose job is blame, so a
 * missing grammar, a parse failure or a file too large all fall back to plain
 * text rather than taking the view down with them.
 */
export async function highlight(
  path: string,
  lines: string[],
  scheme: "dark" | "light",
): Promise<Highlighted | null> {
  const lang = languageFor(path);
  if (!lang || lines.length > MAX_LINES) return null;

  try {
    const hl = await core();
    if (!loaded.has(lang)) {
      await hl.loadLanguage(LANGS[lang] as never);
      loaded.add(lang);
    }
    const { tokens } = hl.codeToTokens(lines.join("\n"), {
      lang,
      theme: THEMES[scheme],
    });
    // Blame decides how many rows there are; pad or trim so the two can never
    // drift and shift a file's colours off by a line.
    const out: HighlightedLine[] = new Array(lines.length).fill(null);
    for (let i = 0; i < Math.min(tokens.length, lines.length); i++) out[i] = tokens[i];
    return { lines: out, lang };
  } catch {
    return null;
  }
}
