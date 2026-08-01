# Quality Check

## What shipped
`whats-allowed-mcp` v0.1.0 — the fourth free MIT MCP server. It answers a different question from the other three: **what can this agent do without asking me, and which file decided that?**

- Source: `/Users/jarvisstudio/Desktop/STC/tools/whats-allowed-mcp/src/{sources.ts,lint.ts,index.ts}`
- Repo: https://github.com/stcmain/whats-allowed-mcp (MIT, public, 7 topics)
- npm: `whats-allowed-mcp@0.1.0`
- MCP Registry: `io.github.stcmain/whats-allowed-mcp` (status active, isLatest true)

Four read-only tools: `whats_allowed`, `permission_sources`, `rule_findings`, `unattended_surface`.

## Prior art — disclosed, not hidden
The `whats-inherited-mcp` quality check **rejected** a permission-audit server as derivative, citing `ccperm`, `cc-audit` and `claude-permissions-manager`. That rejection was re-tested before publishing rather than ignored:

- All three are **CLIs**, not MCP servers. `claude-permissions-manager@1.5.9` (bin `cpm`, deps ink/react/commander/fast-glob — no MCP SDK) is the mature one: `cpm audit` with severity levels and `--fix` auto-editing, `cpm dedup`, `cpm preset`, `cpm init`. `ccperm@1.17.0` and `cc-audit@0.4.2` are also single-bin CLIs.
- The **official MCP registry has zero servers** on this subject. Searched `permission`, `permissions`, `settings`, `guardrail`, `allowlist`: the guardrail hits are all runtime enforcement layers that intercept calls, not readers of the settings hierarchy.

So the CLI surface is occupied and the MCP surface is empty. The differentiation is deliberate and is stated in the README rather than glossed:

1. **MCP-native** — the agent can ask what it is allowed to do; a CLI can only tell a human.
2. **Findings cite documented behaviour, not a severity score.** `cpm audit` ranks risk. This one reports only rules whose documented behaviour differs from their apparent intent, each linked to the paragraph it comes from. No score, no ranking, no heuristic "risky rule" detector.
3. **It never edits anything.** No `--fix`, no dedup, no presets. Where the docs give a corrected form it is quoted; where they don't, the finding stops at the observation.
4. **It refuses to simulate a verdict** for a hypothetical command, and says why: built-in read-only commands, wrapper stripping, compound splitting and hook results all participate in the real answer.

## Correctness sourced from the docs, not from memory
Every rule of behaviour encoded here was read from the live Anthropic docs during the build (`code.claude.com/docs/en/permissions` and `/settings`), not recalled. That mattered: `defaultMode` now documents `default`/`manual`/`acceptEdits`/`plan`/`auto`/`dontAsk`/`bypassPermissions`, and the settings page lists a different subset — so the server reports the raw value and labels an unrecognised one as unrecognised instead of asserting a meaning.

## How it was verified (end-to-end)
- Real MCP stdio JSON-RPC against the built server: initialize → `tools/list` → `tools/call` on all four tools, output read as rendered markdown rather than trusting exit codes.
- Exercised against three fixtures: a full-coverage fixture hitting every finding type, a shadowing fixture (deny/ask over narrower allow), and a small README demo. `CLAUDE_CONFIG_DIR` was used to control the user layer so results were deterministic.
- **Re-verified against the published npm artifact**: `npx -y whats-allowed-mcp` from an empty directory with an empty npm cache — initialize handshake OK, all four tools listed, `whats_allowed` returned a report. This is exactly the claim made in the Cline submission, so it was run before the claim was written.
- Security claims verified mechanically: `grep -rn "child_process\|spawn\|execFile\|fetch(\|http\.\|net\." src/` returns **nothing**. The write-API grep returns exactly **one** hit, and it is a documentation string quoting Anthropic's description of `acceptEdits` (`"…commands such as mkdir, touch, mv, cp…"`), not a call — stated here rather than rounded down to zero.
- Post-publish checks by API: npm registry API (0.1.0, funnel strings present in the **top-level** readme field, dist-tags latest), MCP registry API (`status: active`, `isLatest: true`), GitHub API, raw logo URL 200.

## Bugs found and fixed before publishing
1. **Blanket-allow list was wrong.** `mcp__*` and `mcp__github__get_*` were being counted as "allow rules covering a whole tool". `mcp__*` is skipped by Claude Code entirely (it auto-approves nothing) and the anchored one is scoped — presenting either as a blanket grant would have been an alarming false positive. Blanket now means: no glob and no whitespace in the tool name.
2. **`Stop Task` counted as a blanket allow** for the same reason; it matches no tool at all and is now reported only as an inert rule.
3. Registry publish rejected at 422 — `server.json` description over the 100-char limit. Shortened and re-published; the npm/README description is unchanged.
4. Grammar in generated prose ("a ask rule", "1 are ignored") — fixed, because output that reads as machine-generated undermines a report people are meant to act on.

## Conservatism, deliberately
- Shadowing is only reported when the blocking rule is a prefix pattern that **provably** covers the allow rule. Anything needing a wildcard solver is skipped. This under-reports on purpose.
- The command-runner list excludes `npm run`, `make`, `just` and `task` — they run project-defined recipes, and Anthropic's own docs use `Bash(npm run *)` as a normal allow example. Flagging it would be crying wolf.
- `~/.claude/settings.local.json` is read and reported but explicitly **not ranked**, because the published precedence table does not include it.
- No number in the output is invented: rule counts, file counts and hook counts are all direct counts of parsed input, and files that fail to parse are reported as unparsed rather than silently skipped.

## Set drift (the recurring failure) — checked
Adding a fourth tool made the other three READMEs wrong: `whats-running-mcp` and `whats-loaded-mcp` listed the wrong number of siblings, and `whats-inherited-mcp` said "two siblings". All three were updated and pushed. Their **npm** READMEs still show the old list and will pick up the fourth link on their next release — deliberately not force-published, because another session was mid-flight in those repos and the `whats-running-mcp` Product Hunt launch is Tuesday.

## Known gaps at time of writing
- **Glama has not crawled the repo yet** (badge 404). It crawls automatically; the three siblings' badges took time to appear too. The README badge will start rendering when it does.
- **Smithery not submitted** (the siblings are 2 of 3 there); it needs a web login.
- The three awesome-list PRs and the two directory issues are queued, not merged. That is normal and outside our control.

## Truth check
- **0 sales / $0.00 collected lifetime** remains true; nothing in this work claims otherwise, and neither the README nor any submission cites a user count, a download count, a rating or a testimonial.
- The README's worked example is a **fixture**, labelled as one, with paths shortened — it is not presented as a real machine's configuration, and no number in it was typed by hand: it is the server's actual output for the settings shown directly above it.
- "The MCP registry has zero servers on this subject" is a checked claim (five searches against the live registry API), not an assumption.
- "Verified from a clean directory with an empty npm cache" in the Cline submission was run before it was written.
- The Glama badge in the README currently 404s. That is disclosed above rather than presented as live.

## Failure modes considered
- **Being wrong in the alarming direction.** A permission report that cries wolf gets ignored, and one that misses a real inert rule is worse than nothing. Mitigation: every finding is anchored to documented behaviour, shadowing is only claimed when provable, and the runner list excludes project-recipe runners that Anthropic's own docs allowlist.
- **Becoming an exfiltration path.** Settings files hold plaintext API keys. Mitigation: `env` values are never read, only names; `apiKeyHelper` is reported as present and never read or run.
- **Becoming an injection vector.** Rule text and hook commands are attacker-controllable in a cloned repo. Mitigation: fenced with backticks neutralised, pipes escaped, newlines flattened, plus a standing note that quoted text is data.
- **Being derivative.** Three CLIs already do adjacent work. Mitigation: checked before publishing, disclosed in this document, and differentiated on contract (MCP-native, doc-cited findings, never edits, refuses to simulate).
- **Schema drift.** Claude Code's permission schema moves. Mitigation: unrecognised `defaultMode` values are reported as unrecognised rather than given an invented meaning, and rule shapes we cannot classify are left unreported.

## Reversal plan
- npm: `npm deprecate whats-allowed-mcp@0.1.0 "<reason>"`, or `npm unpublish whats-allowed-mcp@0.1.0` within the 72-hour window.
- MCP registry: re-run `mcp-publisher` with the server marked deleted, or leave it — the record points at the npm package and the repo, both of which are reversible.
- Directories: the three awesome-list PRs (punkpeye #11334, TensorBlock #1512, rohitg00 #305) and the two queue issues (chatmcp/mcpso #3401, cline/mcp-marketplace #2172) are all closable by us at any time before merge.
- GitHub: `gh repo delete stcmain/whats-allowed-mcp`, or archive it.
- Sibling cross-links: one revert commit per repo; nothing was force-published to npm, so their released artifacts are untouched.
- MIT commitment is one-way by design: anything published free and MIT stays free and MIT. Reversal means withdrawal, never re-licensing.
