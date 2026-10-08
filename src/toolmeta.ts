// Agent-facing tool metadata: call examples and human-readable argument errors.
//
// Two problems this solves, both observed while an agent tried to use the
// server:
//
//  1. Nothing in `tools/list` showed what a call looks like. One MCP bridge
//     advertised `search_books` as taking no parameters at all, which sent the
//     agent into a long loop of guesses. A single JSON line in the description
//     costs nothing and works in every client — cheaper than shipping a
//     SKILL.md that most clients never read.
//
//  2. Validation failures leaked zod's internal issue array
//     (`[{"expected":"string","code":"invalid_type","path":["output_dir"],...}]`).
//     That is a debugging artefact, not an instruction. An agent cannot act on
//     it; a sentence naming the missing argument and showing an example can be
//     acted on immediately.

/** Per-tool metadata used to build descriptions and error messages. */
export interface ToolMeta {
  /** One line of JSON showing a valid call. Appended to the description. */
  example: string;
  /** Plain sentence naming what the tool needs, used in validation errors. */
  requires: string;
}

export const TOOL_META: Record<string, ToolMeta> = {
  search_books: {
    example: '{"query":"dune frank herbert","limit":5}',
    requires: 'a "query" string. Optional: a non-empty "sources" list (annas, libgen, zlibrary; duplicates are ignored) and "limit" (1-100).',
  },
  book_details: {
    example: '{"md5":"524037f395462d37b31f2b28fede24fb"}',
    requires: 'an "md5" — the 32-character hex hash from a search_books result.',
  },
  get_download_links: {
    example: '{"md5":"524037f395462d37b31f2b28fede24fb"}',
    requires: 'an "md5" — the 32-character hex hash from a search_books result.',
  },
  download_book: {
    example: '{"md5":"524037f395462d37b31f2b28fede24fb","output_dir":"/home/me/books"}',
    requires:
      'an "md5" (32-character hex hash) and an "output_dir" (absolute path to a directory). Optional: "filename".',
  },
  search_papers: {
    example: '{"query":"attention is all you need","limit":5}',
    requires: 'a "query" string. Optional: "limit" (1-100).',
  },
  get_paper: {
    example: '{"identifier":"10.48550/arXiv.1706.03762"}',
    requires: 'an "identifier" — a DOI, a URL, or a paper title.',
  },
  healthcheck: {
    example: "{}",
    requires: "no arguments. Optional: \"timeoutMs\" per mirror probe.",
  },
};

/** Append the call example to a tool description. */
export function describeTool(name: string, base: string): string {
  const meta = TOOL_META[name];
  if (!meta) return base;
  return `${base}\n\nExample: ${meta.example}`;
}

/** Minimal shape of a zod issue, read defensively across zod versions. */
interface Issue {
  path?: Array<string | number>;
  code?: string;
  message?: string;
}

function issuesOf(error: unknown): Issue[] {
  if (error && typeof error === "object" && Array.isArray((error as { issues?: unknown }).issues)) {
    return (error as { issues: Issue[] }).issues;
  }
  return [];
}

/**
 * Turn a zod validation failure into one sentence an agent can act on.
 *
 * Format: `<tool>: <what is wrong with which argument>. It needs <requires>
 * Example: <json>`. Falls back to the raw message when the error is not shaped
 * like a zod error, so this can never make an error less informative than the
 * one it replaces.
 */
export function describeArgsError(name: string, error: unknown): string {
  const meta = TOOL_META[name];
  const issues = issuesOf(error);

  const problems: string[] = [];
  for (const issue of issues) {
    const field = issue.path && issue.path.length > 0 ? issue.path.join(".") : "arguments";
    // zod capitalises its messages ("Too big: ..."); lower-case the first letter
    // so the sentence reads naturally after the field name.
    const raw = issue.message ?? "is invalid";
    const message = raw.charAt(0).toLowerCase() + raw.slice(1);
    // zod reports a missing optional-vs-required field as invalid_type with
    // "received undefined"; say "missing" instead, which is what it means.
    const missing = issue.code === "invalid_type" && /undefined/.test(message);
    problems.push(missing ? `"${field}" is missing` : `"${field}" ${message}`);
  }

  const what = problems.length > 0 ? problems.join("; ") : String((error as Error)?.message ?? error);

  if (!meta) return `${name}: ${what}`;
  return `${name}: ${what}. It needs ${meta.requires} Example: ${meta.example}`;
}
