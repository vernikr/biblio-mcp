# Runbook: connect biblio-mcp through pnpm

For an AI agent working in an IDE or desktop client. The request is usually:

> Connect the MCP server https://www.npmjs.com/package/@vernikr/biblio-mcp through pnpm
> in the IDE you are working from.

Follow the steps in order. Stop and ask the user when a step says so. Do not install
global tools, edit files other than the one named in step 4, or use `sudo` without asking.

## 0. Facts to rely on

- Package: `@vernikr/biblio-mcp`. Use a **pinned** version, never `latest`.
- Launcher: `pnpm --silent dlx @vernikr/biblio-mcp@<version>`. Nothing is installed globally.
- `--silent` keeps package-manager output out of the MCP stdout stream. Keep it.
- `--print-config` prints the client entry as JSON. It exists from the first release that
  contains it. Older releases (for example 2.0.0) start the server instead, so do not run
  `--print-config` against them. Use the template in step 3.
- Keys (`BIBLIO_ANNAS_API_KEY` and others) belong in the client's `env` block, set by the
  user. Never write a key you were not given, and never print one back.

## 1. Check prerequisites

```bash
node --version    # must be v22.0.0 or newer
pnpm --version    # must be 10 or newer (dlx); this project pins 12.10.1
```

- Node older than 22: stop and tell the user.
- pnpm missing: stop and ask the user how they want it installed. Do not run
  `npm install -g pnpm` on your own: it can write a second global copy and change the
  global bin directory.

## 2. Verify the package runs (offline, no mirrors)

```bash
pnpm --silent dlx @vernikr/biblio-mcp@<version> --selfcheck --offline
```

Expected last line: `selfcheck passed.` The first run downloads the package and can take
a minute. If it fails, do not continue to the client config; report the printed error.

If it fails with `ERR_PNPM_RESOLVING_NPM_RESOLVER_NETWORK_ERROR` or a DNS error, the problem
is the network, not PATH. Keep the proxy variables (`HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`
and their lowercase forms) and check `pnpm config get registry`. Do not strip the whole
environment with `env -i` to test this; that removes the proxy settings and gives a false
failure. Report the error to the user instead of guessing.

## 3. Build the client entry

Preferred, if the version supports it:

```bash
pnpm --silent dlx @vernikr/biblio-mcp@<version> --print-config > /tmp/biblio-entry.json
```

Fallback for a version without `--print-config`: build the same JSON by hand, using the
absolute paths from `which pnpm` and `which node`:

```json
{
  "mcpServers": {
    "biblio": {
      "command": "<absolute path to pnpm>",
      "args": ["--silent", "dlx", "@vernikr/biblio-mcp@<version>"],
      "env": { "PATH": "<dirname of node>:<dirname of pnpm>:/usr/bin:/bin" }
    }
  }
}
```

The `PATH` in `env` matters. A GUI-started client does not inherit the shell PATH, and
`pnpm dlx` needs `node` on it. Omit `env` only if you have checked the client inherits PATH.

Never copy a path containing `fnm_multishells` (or any `/tmp` path) into a config. fnm creates
that per-shell directory and deletes it when the terminal closes. `which node` can return such
a path, so resolve the real install with `realpath "$(which node)"` and take its directory, or
use `--print-config`, which resolves it and warns when it finds a temporary path.

## 4. Find the client's MCP config file

Use the path for the client you are running in:

| Client | Config | Notes |
|---|---|---|
| Freebuff Desktop | `~/.freebuff/mcp.json` | top-level key `mcpServers` |
| Claude Code | `claude mcp add -s user biblio -- pnpm --silent dlx @vernikr/biblio-mcp@<version>` | the CLI writes the file for you |
| Anything else | ask the user, or read that client's documentation | do not guess a path |

Never write MCP entries into application state files such as `state.json`.

## 5. Merge the entry, safely

1. If the config file exists, copy it first:
   `cp <file> <file>.bak-$(date +%s)`
2. Parse the file as JSON. If it does not parse, stop and tell the user. Do not repair it.
3. Set only `mcpServers.biblio` to the entry from step 3. Keep every other key and entry.
   Do not add `allowedTools`, `autoApprove` or `disabled` unless the user asks. A stale
   allow-list silently blocks the real tools.
4. Write to `<file>.tmp`, validate it as JSON, then rename it over `<file>`.

Expected tool names for the allow-list, if the user wants one: `search_books`,
`book_details`, `get_download_links`, `download_book`, `search_papers`, `get_paper`,
`healthcheck`.

## 6. Enable it and restart

- Tell the user to restart the client and turn the `biblio` server on in its MCP settings
  by hand. Some clients need this even after the file is correct.
- Tell the user to approve tool use if the client asks.

## 7. Verify through the client, not the file

Success means the client lists these seven tools for `biblio`:
`search_books`, `book_details`, `get_download_links`, `download_book`, `search_papers`,
`get_paper`, `healthcheck`.

Then call `healthcheck`. If the client shows no tools, look at its MCP log, report what it
says, and do not claim the server is connected. A correct JSON file alone is not success.

## Rules that prevent the common failures

- Always back up before changing a shared config; never overwrite it wholesale.
- Use the real tool names; invented names in `allowedTools` block every call.
- `--selfcheck` in `args` makes the server exit immediately. Keep it out of client entries.
- A global install (`pnpm add -g`) needs `global-bin-dir` set and a PATH that GUI apps
  inherit. Prefer `dlx` unless the user explicitly wants a global binary.
- Do not claim success from file contents or exit codes alone. Report what the client shows.
