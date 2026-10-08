// Agent-facing tool metadata: call examples and human-readable argument errors.
/** Per-tool examples; required and optional arguments come from Zod schemas. */
export interface ToolMeta {
  example: string;
}

export const TOOL_META: Record<string, ToolMeta> = {
  search_books: { example: '{"query":"dune frank herbert","limit":5}' },
  book_details: { example: '{"md5":"524037f395462d37b31f2b28fede24fb"}' },
  get_download_links: { example: '{"md5":"524037f395462d37b31f2b28fede24fb"}' },
  download_book: {
    example: '{"md5":"524037f395462d37b31f2b28fede24fb","output_dir":"/home/me/books"}',
  },
  search_papers: { example: '{"query":"attention is all you need","limit":5}' },
  get_paper: { example: '{"identifier":"10.48550/arXiv.1706.03762"}' },
  healthcheck: { example: "{}" },
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

/** Minimal Zod object-field shape needed for agent-facing requirements. */
interface InputFieldSchema {
  description?: string;
  isOptional?: () => boolean;
}

function requirementsFromSchema(schema: unknown): string | undefined {
  if (!schema || typeof schema !== "object") return undefined;
  const shape = (schema as { shape?: Record<string, InputFieldSchema> }).shape;
  if (!shape) return undefined;

  const fields = Object.entries(shape);
  if (fields.length === 0) return "no arguments";
  const label = ([name, field]: [string, InputFieldSchema]) => {
    const description = typeof field.description === "string" ? field.description.trim() : "";
    return `"${name}"${description ? ` — ${description.replace(/[.!?]+$/, "")}` : ""}`;
  };
  const required = fields.filter(([, field]) => !field.isOptional?.());
  const optional = fields.filter(([, field]) => field.isOptional?.());
  return [
    required.length ? `required: ${required.map(label).join(", ")}` : "no required arguments",
    optional.length ? `optional: ${optional.map(label).join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("; ");
}

/** Format one validation failure from its issues and the tool's own schema. */
export function describeArgsError(name: string, error: unknown, schema?: unknown): string {
  const meta = TOOL_META[name];
  const issues = issuesOf(error);
  const problems: string[] = [];

  for (const issue of issues) {
    const field = issue.path && issue.path.length > 0 ? issue.path.join(".") : "arguments";
    const raw = issue.message ?? "is invalid";
    const message = raw.charAt(0).toLowerCase() + raw.slice(1);
    const missing = issue.code === "invalid_type" && /undefined/.test(message);
    problems.push(missing ? `"${field}" is missing` : `"${field}" ${message}`);
  }

  const what = problems.length > 0 ? problems.join("; ") : String((error as Error)?.message ?? error);
  const requirements = requirementsFromSchema(schema);
  return [
    `${name}: ${what}.`,
    requirements ? `Schema: ${requirements}.` : "",
    meta ? `Example: ${meta.example}` : "",
  ]
    .filter(Boolean)
    .join(" ");
}
