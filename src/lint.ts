/**
 * Findings: permission rules that do not do what they look like they do.
 *
 * Every finding below corresponds to behaviour Anthropic documents for Claude
 * Code — most of them cases where Claude Code accepts a rule and then ignores
 * it, or matches something wider than the author meant. Nothing here is a
 * heuristic guess about intent, and nothing here scores your configuration.
 *
 * Deliberately conservative: a rule is only reported when the documented
 * behaviour makes the report certain. Anything requiring a judgement call about
 * what you *meant* is left alone. Under-reporting is the correct failure mode
 * for a tool people use to decide whether their guard rails are real.
 */

import type { Rule, Settings } from "./sources.js";

export type FindingKind =
  | "inert" // Claude Code accepts the rule and never consults it
  | "misreads" // matches something other than what it looks like
  | "wider" // matches more than it looks like
  | "shadowed" // never reached, because deny/ask is evaluated first
  | "duplicate";

export interface Finding {
  kind: FindingKind;
  /** Short title, stable enough to grep for. */
  title: string;
  rule: string;
  ruleKind: Rule["kind"];
  /** "<layer label> — <path>" */
  where: string;
  /** Layer label alone, for compact listings. */
  sourceLabel: string;
  /** Why, in terms of documented behaviour. */
  why: string;
  /** The documented corrected form, when the docs give one. Never a deletion. */
  fix: string | null;
  docs: string;
}

const DOC_PERMISSIONS = "https://code.claude.com/docs/en/permissions";

/** Each tool's primary content field, which cannot be matched with `Tool(param:value)`. */
const PRIMARY_FIELD: Record<string, string> = {
  Bash: "command",
  PowerShell: "command",
  Read: "file_path",
  Edit: "file_path",
  Write: "file_path",
  Grep: "path",
  Glob: "path",
  NotebookEdit: "notebook_path",
  WebFetch: "url",
};

/** Path rules on these tools are accepted and never consulted. */
const PATH_RULE_IGNORED: Record<string, string> = {
  Write: "Edit",
  NotebookEdit: "Edit",
  MultiEdit: "Edit",
  Glob: "Read",
};

/** Tools whose specifier is a path pattern with `//`, `~/`, `/` anchoring. */
const PATH_TOOLS = new Set(["Read", "Edit", "Cd"]);

const SHELL_TOOLS = new Set(["Bash", "PowerShell"]);

/**
 * Commands that take another command as their argument. An allow rule with one
 * of these as its prefix approves whatever is written after it. The docs make
 * this point with `devbox run`: a rule like `Bash(devbox run *)` matches
 * `devbox run rm -rf .`.
 */
const COMMAND_RUNNERS = [
  "npx",
  "bunx",
  "pnpm dlx",
  "yarn dlx",
  "uvx",
  "uv run",
  "pipx run",
  "poetry run",
  "docker exec",
  "docker run",
  "devbox run",
  "direnv exec",
  "mise exec",
  "nix-shell",
  "bash -c",
  "sh -c",
  "zsh -c",
  "env",
  "eval",
  "xargs",
  "python -c",
  "python3 -c",
  "node -e",
  "node --eval",
  "perl -e",
  "ruby -e",
  "ssh",
];

function where(r: Rule): string {
  return `${r.source.label} — ${r.source.path}`;
}

/** The literal prefix a pattern requires, or null when it is not a prefix pattern. */
function literalPrefix(spec: string | null): string | null {
  if (spec === null || spec === "*") return "";
  if (spec.endsWith(":*")) return spec.slice(0, -2) + " ";
  if (spec.endsWith(" *")) return spec.slice(0, -1);
  if (spec.includes("*")) return null; // wildcard elsewhere — not a simple prefix
  return spec; // exact match: its own prefix
}

/** Conservative tool-name glob match (deny/ask accept globs in the tool position). */
function toolMatches(pattern: string, tool: string): boolean {
  if (pattern === tool) return true;
  if (!pattern.includes("*")) return false;
  const rx = new RegExp("^" + pattern.split("*").map(escapeRe).join(".*") + "$");
  return rx.test(tool);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function startsWithToken(spec: string, prefix: string): boolean {
  if (!spec.startsWith(prefix)) return false;
  const next = spec.charAt(prefix.length);
  return next === "" || next === " " || next === "*";
}

export function lint(s: Settings): Finding[] {
  const out: Finding[] = [];
  const rules = s.rules;

  for (const r of rules) {
    const spec = r.specifier;

    // Rule whose tool name cannot be a canonical tool name.
    if (/\s/.test(r.tool)) {
      out.push({
        kind: "inert",
        title: "Tool name contains a space",
        rule: r.raw,
        ruleKind: r.kind,
        where: where(r),
        sourceLabel: r.source.label,
        why:
          "Permission rules match a tool's canonical name, which never contains a space. " +
          "The label shown in the transcript can differ from the canonical name — `Stop Task` is `TaskStop`.",
        fix: "Use the canonical name from the tools reference.",
        docs: DOC_PERMISSIONS + "#tool-name-wildcards",
      });
      continue;
    }

    // `Tool(param:value)` aimed at the tool's primary content field.
    const primary = PRIMARY_FIELD[r.tool];
    if (spec && primary && new RegExp("^" + escapeRe(primary) + "\\s*:").test(spec)) {
      const suggestion =
        r.tool === "Bash" || r.tool === "PowerShell"
          ? `${r.tool}(${spec.slice(primary.length + 1).trimStart()})`
          : r.tool === "WebFetch"
            ? "WebFetch(domain:host)"
            : `${r.tool}(./path)`;
      out.push({
        kind: "inert",
        title: "Parameter rule on a primary content field",
        rule: r.raw,
        ruleKind: r.kind,
        where: where(r),
        sourceLabel: r.source.label,
        why:
          `A rule cannot match \`${primary}\` on ${r.tool} with the \`param:value\` form. ` +
          "Claude Code ignores the rule and emits a startup warning, because a rule like " +
          "`Bash(command:rm *)` would be bypassable by a compound command.",
        fix: `Write the tool's own specifier instead, e.g. \`${suggestion}\`.`,
        docs: DOC_PERMISSIONS + "#match-by-input-parameter",
      });
      continue;
    }

    // Path rule on a tool that file permission checks never consult.
    const replacement = PATH_RULE_IGNORED[r.tool];
    if (spec && replacement && !/^[A-Za-z_][A-Za-z0-9_]*\s*:/.test(spec)) {
      out.push({
        kind: "inert",
        title: `Path rule on ${r.tool}`,
        rule: r.raw,
        ruleKind: r.kind,
        where: where(r),
        sourceLabel: r.source.label,
        why:
          `File permissions are checked against \`Edit(path)\` and \`Read(path)\` rules only. ` +
          `Claude Code accepts a ${r.tool} path rule but never consults it, and warns at startup.` +
          (r.tool === "Glob" ? " A `Glob` rule passed in `--allowedTools` is the one exception." : ""),
        fix: `Use \`${replacement}(${spec})\` — ${replacement === "Edit" ? "Edit rules cover all file-editing tools" : "Read rules cover the file-reading tools"}.`,
        docs: DOC_PERMISSIONS + "#read-and-edit",
      });
      continue;
    }

    // Allow rule with a glob in the tool-name position.
    if (r.kind === "allow" && r.tool.includes("*")) {
      const anchored = /^mcp__[^_*]+(?:_[^_*]+)*__/.test(r.tool);
      if (!anchored) {
        out.push({
          kind: "inert",
          title: "Unanchored glob in an allow rule",
          rule: r.raw,
          ruleKind: r.kind,
          where: where(r),
          sourceLabel: r.source.label,
          why:
            "Allow rules accept tool-name globs only after a literal `mcp__<server>__` prefix with a " +
            "glob-free server segment. An unanchored allow glob is skipped with a warning and does not " +
            "auto-approve anything.",
          fix: "Name the tool, or anchor the glob to one server, e.g. `mcp__github__get_*`.",
          docs: DOC_PERMISSIONS + "#tool-name-wildcards",
        });
        continue;
      }
    }

    // `:*` used anywhere but the end of a shell pattern.
    if (spec && SHELL_TOOLS.has(r.tool) && spec.includes(":*") && !spec.endsWith(":*")) {
      out.push({
        kind: "misreads",
        title: "`:*` is only a wildcard at the end of a pattern",
        rule: r.raw,
        ruleKind: r.kind,
        where: where(r),
        sourceLabel: r.source.label,
        why:
          "The `:*` suffix is recognised only at the end of a pattern. Elsewhere the colon is a literal " +
          "character, so this rule matches commands that contain `:` at that position — usually none.",
        fix: `Use a space-separated wildcard, e.g. \`${r.tool}(${spec.replace(":*", " *")})\`.`,
        docs: DOC_PERMISSIONS + "#wildcard-patterns",
      });
      continue;
    }

    // `/path` in user settings anchors at the user config directory.
    if (
      spec &&
      PATH_TOOLS.has(r.tool) &&
      spec.startsWith("/") &&
      !spec.startsWith("//") &&
      (r.source.layer === "user" || r.source.layer === "user-local")
    ) {
      out.push({
        kind: "misreads",
        title: "`/path` in user settings does not mean the filesystem root",
        rule: r.raw,
        ruleKind: r.kind,
        where: where(r),
        sourceLabel: r.source.label,
        why:
          "A single leading slash anchors at the directory associated with the settings source. In user " +
          `settings that is \`${r.source.slashAnchor}\`, so this rule matches \`${r.source.slashAnchor}${spec}\` — ` +
          "not the same path inside each of your projects.",
        fix: `Use \`${r.tool}(~${spec})\` for a home-relative path or \`${r.tool}(/${spec})\` (double slash) for an absolute one.`,
        docs: DOC_PERMISSIONS + "#read-and-edit",
      });
      continue;
    }

    if (r.kind === "allow" && SHELL_TOOLS.has(r.tool) && spec && spec !== "*") {
      // Trailing `*` with no word boundary.
      if (spec.endsWith("*") && /[A-Za-z0-9._-]$/.test(spec.slice(0, -1))) {
        const prefix = spec.slice(0, -1);
        out.push({
          kind: "wider",
          title: "Trailing wildcard with no word boundary",
          rule: r.raw,
          ruleKind: r.kind,
          where: where(r),
          sourceLabel: r.source.label,
          why:
            `Without a space before \`*\`, there is no word-boundary constraint: \`${r.tool}(ls*)\` matches ` +
            "`lsof` as well as `ls -la`. This rule also matches commands whose name merely starts with " +
            `\`${prefix}\`.`,
          fix: `Add the space: \`${r.tool}(${prefix} *)\`.`,
          docs: DOC_PERMISSIONS + "#wildcard-patterns",
        });
        continue;
      }

      // Allow rule whose prefix is a command that runs another command.
      const p = literalPrefix(spec);
      if (p !== null) {
        const runner = COMMAND_RUNNERS.find((c) => startsWithToken(p.trimEnd() + " ", c + " ") || p.trimEnd() === c);
        if (runner) {
          out.push({
            kind: "wider",
            title: `Allow rule on a command runner (\`${runner}\`)`,
            rule: r.raw,
            ruleKind: r.kind,
            where: where(r),
            sourceLabel: r.source.label,
            why:
              `\`${runner}\` executes its arguments as a command, so this rule approves whatever follows it. ` +
              "The docs make the same point about `devbox run`: `Bash(devbox run *)` matches " +
              "`devbox run rm -rf .`. These runners are not in Claude Code's built-in wrapper list, so the " +
              "inner command is never matched against your other rules.",
            fix: `Write one rule per inner command you want to approve, e.g. \`${r.tool}(${runner} <specific command>)\`.`,
            docs: DOC_PERMISSIONS + "#process-wrappers",
          });
          continue;
        }
      }

      // Argument-constraining rule containing a URL.
      if (spec.includes("://")) {
        out.push({
          kind: "misreads",
          title: "Bash rule that tries to constrain a URL",
          rule: r.raw,
          ruleKind: r.kind,
          where: where(r),
          sourceLabel: r.source.label,
          why:
            "Bash patterns that constrain arguments are fragile: the documented example " +
            "`Bash(curl http://github.com/ *)` does not match options before the URL, a different scheme, " +
            "a redirect, a variable, or an extra space.",
          fix:
            "Deny the network commands and allow domains through `WebFetch(domain:host)`, or validate URLs " +
            "in a PreToolUse hook.",
          docs: DOC_PERMISSIONS + "#bash",
        });
        continue;
      }
    }
  }

  // Allow rules that a deny or ask rule reaches first.
  const blockers = rules.filter((r) => r.kind === "deny" || r.kind === "ask");
  for (const a of rules) {
    if (a.kind !== "allow") continue;
    const aPrefix = literalPrefix(a.specifier);
    for (const b of blockers) {
      if (!toolMatches(b.tool, a.tool)) continue;
      const bPrefix = literalPrefix(b.specifier);
      if (bPrefix === null) continue; // not a prefix pattern — no confident claim
      if (aPrefix === null) continue;
      if (!aPrefix.startsWith(bPrefix)) continue;
      out.push({
        kind: "shadowed",
        title: `Allow rule never reached — ${b.kind === "ask" ? "an ask" : "a deny"} rule matches first`,
        rule: a.raw,
        ruleKind: a.kind,
        where: where(a),
        sourceLabel: a.source.label,
        why:
          `Rules are evaluated deny, then ask, then allow, and specificity does not change the order. ` +
          `\`${b.raw}\` (${b.kind}, ${b.source.label}) covers everything this allow rule covers, so the ` +
          (b.kind === "deny"
            ? "call is blocked and the allow rule can never take effect."
            : "call prompts every time, even though a narrower allow rule matches."),
        fix:
          b.kind === "deny"
            ? "A deny rule cannot carry allowlist exceptions. Narrow the deny rule instead."
            : "Narrow the ask rule if you meant this allow rule to run without a prompt.",
        docs: DOC_PERMISSIONS + "#manage-permissions",
      });
      break; // one blocker is enough to make the point
    }
  }

  // Same rule string declared more than once.
  const seen = new Map<string, Rule[]>();
  for (const r of rules) {
    const key = `${r.kind}::${r.raw}`;
    const list = seen.get(key);
    if (list) list.push(r);
    else seen.set(key, [r]);
  }
  for (const [, list] of seen) {
    if (list.length < 2) continue;
    const first = list[0]!;
    out.push({
      kind: "duplicate",
      title: `Declared ${list.length} times`,
      rule: first.raw,
      ruleKind: first.kind,
      where: list.map((r) => `${r.source.label} (${r.source.path})`).join(", "),
      sourceLabel: list.map((r) => r.source.label).join(", "),
      why: "The same rule appears in more than one place. Harmless, but it means two files have to be kept in sync.",
      fix: null,
      docs: DOC_PERMISSIONS + "#settings-precedence",
    });
  }

  return out;
}
