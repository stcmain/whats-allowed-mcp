# whats-allowed-mcp

[![npm](https://img.shields.io/npm/v/whats-allowed-mcp)](https://www.npmjs.com/package/whats-allowed-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![stcmain/whats-allowed-mcp MCP server](https://glama.ai/mcp/servers/stcmain/whats-allowed-mcp/badges/score.svg)](https://glama.ai/mcp/servers/stcmain/whats-allowed-mcp)

**You wrote a deny rule. Did it do anything?** An MCP server that reads every settings file feeding your agent's permissions, shows which one wins, and lists the rules your client accepts and then ignores.

## Why

Permission rules for a coding agent are not in one file. They are in up to five at once: a machine-wide managed policy, the project file your team commits, a git-ignored local file, your user file, and whatever a session wrote. They are merged, and then evaluated deny → ask → allow, where the first match wins and specificity does not break the tie.

That merge is hard enough. The part that actually bites is that several rule shapes are accepted and then quietly do nothing:

- `Write(docs/**)` — file permissions are checked against `Edit(path)` and `Read(path)` rules only. A `Write`, `NotebookEdit`, `MultiEdit` or `Glob` path rule is accepted and never consulted.
- `Bash(command:rm *)` — a rule can't match a tool's primary content field with the `param:value` form. It is ignored, because a compound command would bypass it.
- `"mcp__*"` in `allow` — an unanchored allow glob is skipped and auto-approves nothing.
- `Read(/.env)` in **user** settings — a single leading slash anchors at the settings source, so that rule protects `~/.claude/.env`, not the `.env` in each of your projects.
- `Bash(git push origin main)` in `allow` under a `Bash(git push *)` in `deny` — a deny rule cannot carry allowlist exceptions, so the allow rule is unreachable.

Claude Code warns about some of these at startup, in a scrollback you have already lost by the time you care. Nothing collects them, nothing tells the agent itself, and nothing shows you the merged picture across all five files at once. This does.

## What it looks like

Given a project `.claude/settings.json`:

```json
{
  "permissions": {
    "deny": ["Bash(git push *)", "Write(.env*)"],
    "allow": [
      "Bash(npm run test:*)",
      "Bash(git push origin main)",
      "Bash(npx *)",
      "Bash(ls*)"
    ]
  }
}
```

…and a user `~/.claude/settings.json` with `"deny": ["Read(/.env)"]` and `"defaultMode": "acceptEdits"`, `whats_allowed` returns (paths shortened here):

```
# Permissions in force

| | |
|---|---|
| Settings files contributing | 2 of 5 possible |
| Permission rules | 3 deny, 0 ask, 4 allow |
| Blanket allow rules (whole tool) | 0 |
| Hook commands wired to agent events | 0 |
| Extra directories granted | 0 |
| Rules that do not do what they look like | 5, of which 1 is ignored outright |

## Default mode

`defaultMode` = **`acceptEdits`**, set in User (`~/.claude/settings.json`).

> Automatically accepts file edits and common filesystem commands (`mkdir`,
> `touch`, `mv`, `cp`) for paths in the working directory or additionalDirectories.

## First things to look at

- **Path rule on Write** — `Write(.env*)` in Project settings
- **Allow rule on a command runner (`npx`)** — `Bash(npx *)` in Project settings
- **Trailing wildcard with no word boundary** — `Bash(ls*)` in Project settings
```

Seven rules. Five of them do something other than what they read as — and the one everybody would have bet on, `Write(.env*)`, is never consulted at all.

## Tools

| Tool | What it answers |
|---|---|
| `whats_allowed` | The headline: which files contribute, how many deny/ask/allow rules, the winning `defaultMode`, blanket allows, hooks, and how many rules misbehave. Start here |
| `permission_sources` | Which file decides, in precedence order — existence, parse state, rule counts, and what a leading `/` anchors to in each one |
| `rule_findings` | Every rule whose documented behaviour differs from its apparent intent, with the reason and the documented alternative |
| `unattended_surface` | What proceeds with nobody watching: default mode, blanket allows, extra directories, mode guards, and hook commands |

## Install

Register with Claude Code (available in every session):

```bash
claude mcp add --scope user whats-allowed -- npx -y whats-allowed-mcp
```

Or in any MCP client config:

```json
{
  "mcpServers": {
    "whats-allowed": {
      "command": "npx",
      "args": ["-y", "whats-allowed-mcp"]
    }
  }
}
```

<details>
<summary>From source</summary>

```bash
git clone https://github.com/stcmain/whats-allowed-mcp
cd whats-allowed-mcp && npm install && npm run build
# then point your client at node /path/to/whats-allowed-mcp/dist/index.js
```

</details>

Published as [`whats-allowed-mcp`](https://www.npmjs.com/package/whats-allowed-mcp) on npm and as `io.github.stcmain/whats-allowed-mcp` in the [MCP Registry](https://registry.modelcontextprotocol.io/).

No configuration. No environment variables. Respects `CLAUDE_CONFIG_DIR` when you have moved your user config.

## What it checks, and what it refuses to guess

Every finding corresponds to behaviour Anthropic documents, and every one links to the paragraph it comes from. There is no risk score, no severity ranking and no "suspicious rule" heuristic — those produce confident nonsense on ordinary configurations.

Reported:

- Path rules on `Write` / `NotebookEdit` / `MultiEdit` / `Glob`, which file permission checks never consult
- `Tool(param:value)` rules aimed at a tool's primary content field, which are ignored outright
- Unanchored tool-name globs in `allow`, which auto-approve nothing
- `:*` used anywhere but the end of a shell pattern, where the colon is literal
- `/path` rules in user settings, which anchor at the config directory rather than at your project
- Trailing `*` with no word boundary — `Bash(ls*)` also matches `lsof`
- Allow rules on commands that run other commands (`npx`, `docker exec`, `bash -c`, `xargs`, `devbox run`…), which approve whatever follows them
- Bash rules that try to constrain a URL, which the docs themselves call fragile
- Allow rules a deny or ask rule reaches first
- Rules declared in more than one file

Deliberately **not** reported:

- **Whether your rules express what you want.** That is a judgement about intent and this server does not have one.
- **Shadowing that needs a wildcard solver.** An allow rule is only called unreachable when the blocking rule is a prefix pattern that provably covers it. Anything subtler is left alone rather than guessed at, so this under-reports on purpose.
- **A verdict for a hypothetical command.** See below.

## Honest limitations

- **It does not simulate your client's decision.** There is no "would `git push` be allowed" tool, and that is a design choice: Claude Code's built-in read-only command set, wrapper stripping (`timeout`, `nice`, `xargs`…), compound-command splitting, sandbox state and PreToolUse hook results all participate in the real answer. A static verdict would be confidently wrong often enough to be worth less than no answer. Use `/permissions` in your client for the live view; use this to understand *why* it says what it says.
- **Command-line flags are invisible.** `--allowedTools`, `--disallowedTools`, `--permission-mode` and `--settings` sit between managed policy and local settings, and they are not on disk.
- **Session rules added through `/permissions` land in files this server reads**, but rules added for one session only do not.
- **It reports; it does not fix.** Nothing is edited, and no finding is ever a recommendation to delete a rule. Where the docs give a corrected form, it is quoted; where they don't, the finding stops at the observation.
- **`~/.claude/settings.local.json` is reported but not ranked.** It exists and Claude Code writes to it; the published precedence table lists four scopes and does not include it. This server refuses to invent its position.
- **Claude Code's schema is the model.** Other clients with their own permission systems are not parsed.
- **It never reads git history**, and it does not tell you who added a rule or when. `git log -p .claude/settings.json` does that better.

## Design notes / threat model

- **No child processes. No shell. No network. No writes.** The only Node APIs used are `node:fs` reads, `node:path` and `node:os`. There is no `child_process` import anywhere in the source, so nothing in a settings file can be executed by reading it — including the hook commands and `apiKeyHelper` scripts it reports on.
- **`env` values are never read — only names.** Settings files are one of the most common places for a plaintext API key, and a tool that pasted one into a context window would be worse than the problem it solves. The same applies to `apiKeyHelper`: presence is reported, the script is neither read nor run.
- **Settings-authored strings are fenced and labelled.** Rule text and hook commands have to be shown to be useful. They are emitted inside inline code spans with backticks neutralised, pipes escaped and newlines flattened, so a crafted string cannot break out of the span or out of a markdown table, and each block carries a standing note that the quoted text is data from a file, not instructions.
- **`dir` is the one model-controlled path**, and it is bounded by construction: resolved, real-pathed, and required to be an existing directory. From there only fixed filenames are read — `.claude/settings.json`, `.claude/settings.local.json`, the user config file, the platform's managed-policy path. No globbing, no traversal, no arbitrary file reads.
- **Bounded work:** a 2 MB ceiling per file, a capped walk when looking for the project root, and files that fail to parse are reported as unparsed rather than partially guessed at.
- **Findings are conservative by construction.** Every check is anchored to documented behaviour; anything that would need a judgement call about intent is not reported at all. For a tool people use to decide whether a guard rail is real, under-reporting is the correct failure mode.

## Who makes this

Built by [Shift The Culture](https://shifttheculture.media/?utm_source=github&utm_medium=readme&utm_campaign=whats-allowed-mcp) — we run a one-person company on AI agents and ship the tooling we needed ourselves. This server is free and MIT-licensed, no strings.

It has three siblings, all also free and MIT:

- [**whats-running-mcp**](https://github.com/stcmain/whats-running-mcp) — what is *actually* running on the box right now, instead of what an old transcript claims.
- [**whats-loaded-mcp**](https://github.com/stcmain/whats-loaded-mcp) — what is eating your context window before you type: skill descriptions, memory files and their imports.
- [**whats-inherited-mcp**](https://github.com/stcmain/whats-inherited-mcp) — what a checkout you did not write tells your agent to do: instruction files, hooks, and the MCP servers it declares.

The rest of that tooling is paid:

- **[Agent Fleet Ops Kit](https://stcai.gumroad.com/l/agent-fleet-ops-kit?wanted=true&utm_source=github&utm_medium=readme&utm_campaign=whats-allowed-mcp)** ($29) — the other failure modes of running three or four agents on one box: two sessions editing the same checkout, a dev server nobody owns (so the agent tests a different app than it edits), and MCP servers leaked from crashed sessions that hold ports and RAM for weeks.
  Prefer PayPal? Same kit on [Payhip](https://payhip.com/b/o9q0f).
- **[Agent Reliability Kit](https://stcai.gumroad.com/l/agent-reliability-kit?wanted=true&utm_source=github&utm_medium=readme&utm_campaign=whats-allowed-mcp)** ($29) — a Stop hook and two CLIs that block a turn when an agent claims "done" against a repo, URL, or build that was never actually checked.
  Prefer PayPal? Same kit on [Payhip](https://payhip.com/b/i0sSw).

The server above stays free and MIT either way — it has no upsell in it, no telemetry, and no dependency on the paid kits.

## License

MIT © Zachary Pampu
