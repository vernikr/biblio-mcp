// The single list of environment settings the server reads.
//
// --help is generated from ENV_SETTINGS, and the numeric settings read their
// defaults from NUMBER_SETTINGS, so a default is written in exactly one place.
// README.md documents the same names; a test fails if either side drifts.

export interface NumberSetting {
  name: string;
  fallback: number;
}

/** Numeric budgets, in milliseconds. Non-numeric or non-positive input falls back. */
export const NUMBER_SETTINGS = {
  timeoutMs: { name: "BIBLIO_TIMEOUT_MS", fallback: 8000 },
  downloadTimeoutMs: { name: "BIBLIO_DOWNLOAD_TIMEOUT_MS", fallback: 600_000 },
  downloadStallMs: { name: "BIBLIO_DOWNLOAD_STALL_MS", fallback: 30_000 },
  mirrorDeadTtlMs: { name: "BIBLIO_MIRROR_DEAD_TTL_MS", fallback: 300_000 },
  mirrorStaggerMs: { name: "BIBLIO_MIRROR_STAGGER_MS", fallback: 120 },
} as const satisfies Record<string, NumberSetting>;

export function readNumber(setting: NumberSetting): number {
  const raw = process.env[setting.name];
  if (!raw) return setting.fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : setting.fallback;
}

export interface EnvSetting {
  name: string;
  help: string;
  /** Shown as "(default …)" in --help when set. */
  defaultText?: string;
}

/** Everything the user can set, in the order --help lists it. */
export const ENV_SETTINGS: readonly EnvSetting[] = [
  { name: NUMBER_SETTINGS.timeoutMs.name, help: "HTML request budget", defaultText: `${NUMBER_SETTINGS.timeoutMs.fallback}` },
  { name: NUMBER_SETTINGS.downloadTimeoutMs.name, help: "file download budget", defaultText: `${NUMBER_SETTINGS.downloadTimeoutMs.fallback}` },
  { name: NUMBER_SETTINGS.downloadStallMs.name, help: "abort a download idle this long", defaultText: `${NUMBER_SETTINGS.downloadStallMs.fallback}` },
  { name: NUMBER_SETTINGS.mirrorDeadTtlMs.name, help: "how long a failed mirror is skipped", defaultText: `${NUMBER_SETTINGS.mirrorDeadTtlMs.fallback}` },
  { name: NUMBER_SETTINGS.mirrorStaggerMs.name, help: "head start between mirror attempts", defaultText: `${NUMBER_SETTINGS.mirrorStaggerMs.fallback}` },
  {
    name: "BIBLIO_ANNAS_API_KEY",
    help: "Anna's Archive member key; enables the fast-download API (no DDoS-Guard challenge)",
  },
  { name: "BIBLIO_DISABLE_SOURCES", help: "comma list; defaults to \"zlibrary\"" },
  { name: "BIBLIO_ANNAS_MIRRORS", help: "override the Anna's Archive mirror list" },
  { name: "BIBLIO_LIBGEN_MIRRORS", help: "override the Library Genesis mirror list" },
  { name: "BIBLIO_SCIHUB_MIRRORS", help: "override the Sci-Hub mirror list" },
  { name: "BIBLIO_ZLIB_MIRRORS", help: "override the Z-Library mirror list" },
  { name: "BIBLIO_IPFS_GATEWAYS", help: "override the IPFS gateway list" },
  { name: "BIBLIO_SKIP_STARTUP_CHECK", help: "set to bypass the startup tool-surface check" },
];

/** The "Environment:" block of --help, aligned in two columns. */
export function environmentHelp(): string {
  const width = Math.max(...ENV_SETTINGS.map((s) => s.name.length)) + 2;
  return ENV_SETTINGS.map((s) => {
    const suffix = s.defaultText !== undefined ? ` (default ${s.defaultText})` : "";
    return `  ${s.name.padEnd(width)}${s.help}${suffix}`;
  }).join("\n");
}
