import type { SourceId } from "../types.js";

const FAILURE_THRESHOLD = 3;

type CircuitState = {
  consecutiveFailures: number;
  open: boolean;
  reason?: string;
};

const circuits = new Map<SourceId, CircuitState>();

export class SourceCircuitOpenError extends Error {
  readonly source: SourceId;

  constructor(source: SourceId, message: string) {
    super(message);
    this.name = "SourceCircuitOpenError";
    this.source = source;
  }
}

function errorMessage(error: unknown): string {
  return String((error as Error)?.message ?? error);
}

/** Convert mirror-level diagnostics into a short, actionable source error. */
export function summarizeSourceFailure(source: SourceId, error: unknown): string {
  if (error instanceof SourceCircuitOpenError) return error.message;

  const message = errorMessage(error);
  const mirrors = message.match(/All\s+(\d+)\s+[\w-]+\s+mirror\(s\)\s+failed/i)?.[1];
  if (source === "annas" && /(?:HTTP\s+403|\bforbidden\b|DDoS.?Guard)/i.test(message)) {
    const count = mirrors ? ` (${mirrors})` : "";
    return (
      `unavailable — DDoS-Guard challenge on all configured Anna's Archive mirrors${count}; ` +
      "retry later or set BIBLIO_ANNAS_API_KEY for member fast downloads"
    );
  }
  if (source === "annas" && /not Anna's Archive|parked or hijacked/i.test(message)) {
    return `unavailable — all ${mirrors ?? "configured"} Anna's Archive mirror(s) returned a non-archive page; run healthcheck or retry later`;
  }
  if (mirrors) {
    return `unavailable — all ${mirrors} ${source} mirror(s) failed; run healthcheck or retry later`;
  }

  // URLs and long mirror-by-mirror lists do not help the caller decide what to
  // do. Keep one sanitized hint for errors that do not follow our mirror format.
  const concise = message
    .replace(/https?:\/\/\S+/g, "mirror")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  return concise ? `unavailable — ${concise}` : "unavailable — source request failed";
}

function openMessage(source: SourceId, reason: string): string {
  if (source === "annas" && /DDoS-Guard challenge/i.test(reason)) {
    return "unavailable — DDoS-Guard challenge; circuit open until restart " +
      "(set BIBLIO_ANNAS_API_KEY for member fast downloads)";
  }
  return `unavailable (circuit open after ${FAILURE_THRESHOLD} consecutive failures; restart to retry)`;
}

/** Run one complete provider operation through a process-lifetime circuit. */
export async function withSourceCircuit<T>(
  source: SourceId,
  operation: () => Promise<T>
): Promise<T> {
  const current = circuits.get(source);
  if (current?.open) {
    throw new SourceCircuitOpenError(source, openMessage(source, current.reason ?? ""));
  }

  try {
    const result = await operation();
    // A success resets ordinary consecutive failures. Do not let a request that
    // was already in flight erase a circuit opened by three later completions.
    if (!circuits.get(source)?.open) circuits.delete(source);
    return result;
  } catch (error) {
    // Use the latest state here: concurrent calls can fail while another
    // operation is in flight, and each completed failure must count once.
    const latest = circuits.get(source);
    const next: CircuitState = {
      consecutiveFailures: (latest?.consecutiveFailures ?? 0) + 1,
      open: false,
    };
    if (next.consecutiveFailures >= FAILURE_THRESHOLD) {
      next.open = true;
      next.reason = summarizeSourceFailure(source, error);
    }
    circuits.set(source, next);
    throw error;
  }
}

export function isSourceCircuitOpen(source: SourceId): boolean {
  return circuits.get(source)?.open ?? false;
}

/** Human-readable reason for a source whose circuit has opened. */
export function sourceCircuitMessage(source: SourceId): string | undefined {
  const state = circuits.get(source);
  return state?.open ? openMessage(source, state.reason ?? "") : undefined;
}
