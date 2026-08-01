/**
 * Locate and parse every settings file that contributes permission rules,
 * in the precedence order Claude Code documents.
 *
 * Reads only. `node:fs` + `node:path` + `node:os`. No child processes, no shell,
 * no network, no writes. Nothing read here is ever executed.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

/** 2 MB is far past any real settings file; past it we stop rather than guess. */
const MAX_FILE_BYTES = 2 * 1024 * 1024;

/** How far up from `dir` we look for a project root before giving up. */
const MAX_ROOT_WALK = 24;

export type LayerId =
  | "managed"
  | "local"
  | "project"
  | "user"
  | "user-local";

export interface Source {
  layer: LayerId;
  /** Human label, as used in the docs. */
  label: string;
  path: string;
  exists: boolean;
  parsed: boolean;
  parseError?: string;
  /** Listed in the documented precedence table. */
  documented: boolean;
  /** What a rule specifier beginning with a single `/` anchors to, or null if unknown. */
  slashAnchor: string | null;
  data: Record<string, unknown>;
}

export type RuleKind = "allow" | "ask" | "deny";

export interface Rule {
  raw: string;
  tool: string;
  specifier: string | null;
  kind: RuleKind;
  source: Source;
}

export interface HookCommand {
  event: string;
  matcher: string | null;
  command: string;
  source: Source;
}

export interface Settings {
  /** Directory the scan was anchored at (as given). */
  dir: string;
  /** Directory used as the project root, and how it was chosen. */
  projectRoot: string;
  projectRootReason: string;
  sources: Source[];
  rules: Rule[];
  hooks: HookCommand[];
  /** defaultMode declarations, highest precedence first. */
  defaultModes: { value: string; source: Source }[];
  additionalDirectories: { value: string; source: Source }[];
  /** Guard settings, highest precedence first. */
  disableBypass: { value: unknown; source: Source }[];
  disableAuto: { value: unknown; source: Source }[];
  /** Names only — values are never read. */
  envNames: { name: string; source: Source }[];
  apiKeyHelpers: Source[];
  /** True when a managed-policy file exists on this machine. */
  managedPresent: boolean;
  platform: NodeJS.Platform;
}

function readJson(p: string): { ok: true; data: Record<string, unknown> } | { ok: false; err: string } {
  try {
    const st = fs.statSync(p);
    if (!st.isFile()) return { ok: false, err: "not a regular file" };
    if (st.size > MAX_FILE_BYTES) return { ok: false, err: `larger than ${MAX_FILE_BYTES} bytes; not parsed` };
    const parsed: unknown = JSON.parse(fs.readFileSync(p, "utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, err: "top level is not a JSON object" };
    }
    return { ok: true, data: parsed as Record<string, unknown> };
  } catch (e) {
    return { ok: false, err: e instanceof Error ? e.message : String(e) };
  }
}

function makeSource(
  layer: LayerId,
  label: string,
  p: string,
  documented: boolean,
  slashAnchor: string | null,
): Source {
  const base: Source = {
    layer,
    label,
    path: p,
    exists: false,
    parsed: false,
    documented,
    slashAnchor,
    data: {},
  };
  if (!fs.existsSync(p)) return base;
  base.exists = true;
  const r = readJson(p);
  if (r.ok) {
    base.parsed = true;
    base.data = r.data;
  } else {
    base.parseError = r.err;
  }
  return base;
}

/** Managed policy paths, per platform, in the order the docs list them. */
function managedPaths(platform: NodeJS.Platform): { file: string; dir: string } {
  if (platform === "darwin") {
    return {
      file: "/Library/Application Support/ClaudeCode/managed-settings.json",
      dir: "/Library/Application Support/ClaudeCode/managed-settings.d",
    };
  }
  if (platform === "win32") {
    return {
      file: "C:\\Program Files\\ClaudeCode\\managed-settings.json",
      dir: "C:\\Program Files\\ClaudeCode\\managed-settings.d",
    };
  }
  return { file: "/etc/claude-code/managed-settings.json", dir: "/etc/claude-code/managed-settings.d" };
}

/** `~/.claude` unless CLAUDE_CONFIG_DIR relocates it. */
export function userConfigDir(): string {
  const override = process.env.CLAUDE_CONFIG_DIR;
  if (override && override.trim()) return path.resolve(override.trim());
  return path.join(os.homedir(), ".claude");
}

export function resolveDir(dir?: string): string {
  const raw = dir && dir.trim() ? dir.trim() : process.cwd();
  const abs = path.resolve(raw);
  const st = fs.statSync(abs); // throws for a bad path — surfaced to the caller
  if (!st.isDirectory()) throw new Error(`${abs} is not a directory`);
  return fs.realpathSync(abs);
}

/**
 * Nearest ancestor that looks like a project root. Reported explicitly so the
 * caller never has to guess which directory the project rules came from.
 */
function findProjectRoot(start: string): { root: string; reason: string } {
  let cur = start;
  for (let i = 0; i < MAX_ROOT_WALK; i++) {
    if (fs.existsSync(path.join(cur, ".claude", "settings.json"))) {
      return { root: cur, reason: "nearest ancestor containing .claude/settings.json" };
    }
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  cur = start;
  for (let i = 0; i < MAX_ROOT_WALK; i++) {
    if (fs.existsSync(path.join(cur, ".git"))) {
      return { root: cur, reason: "nearest ancestor containing .git (no .claude/settings.json found)" };
    }
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return { root: start, reason: "the directory given (no .claude/settings.json and no .git above it)" };
}

/** `Tool` or `Tool(specifier)`. Everything else is returned as tool-only. */
export function parseRule(raw: string): { tool: string; specifier: string | null } {
  const s = raw.trim();
  const open = s.indexOf("(");
  if (open === -1 || !s.endsWith(")")) return { tool: s, specifier: null };
  return { tool: s.slice(0, open).trim(), specifier: s.slice(open + 1, -1) };
}

function pushRules(out: Rule[], src: Source, kind: RuleKind): void {
  const perms = src.data["permissions"];
  if (!perms || typeof perms !== "object" || Array.isArray(perms)) return;
  const arr = (perms as Record<string, unknown>)[kind];
  if (!Array.isArray(arr)) return;
  for (const entry of arr) {
    if (typeof entry !== "string") continue;
    const { tool, specifier } = parseRule(entry);
    out.push({ raw: entry, tool, specifier, kind, source: src });
  }
}

function permValue(src: Source, key: string): unknown {
  const perms = src.data["permissions"];
  if (!perms || typeof perms !== "object" || Array.isArray(perms)) return undefined;
  return (perms as Record<string, unknown>)[key];
}

/** Hook commands, flattened. Command strings are data and are never run. */
function pushHooks(out: HookCommand[], src: Source): void {
  const hooks = src.data["hooks"];
  if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) return;
  for (const [event, groupsRaw] of Object.entries(hooks as Record<string, unknown>)) {
    const groups = Array.isArray(groupsRaw) ? groupsRaw : [groupsRaw];
    for (const g of groups) {
      if (!g || typeof g !== "object") continue;
      const grp = g as Record<string, unknown>;
      const matcher = typeof grp["matcher"] === "string" ? (grp["matcher"] as string) : null;
      const list = Array.isArray(grp["hooks"]) ? (grp["hooks"] as unknown[]) : [];
      for (const h of list) {
        if (!h || typeof h !== "object") continue;
        const cmd = (h as Record<string, unknown>)["command"];
        if (typeof cmd === "string") out.push({ event, matcher, command: cmd, source: src });
      }
    }
  }
}

export function collect(dir?: string): Settings {
  const start = resolveDir(dir);
  const { root: projectRoot, reason: projectRootReason } = findProjectRoot(start);
  const platform = process.platform;
  const ucd = userConfigDir();
  const mp = managedPaths(platform);

  const sources: Source[] = [];

  // 1. Managed policy (highest; cannot be overridden).
  sources.push(makeSource("managed", "Managed policy", mp.file, true, null));
  try {
    if (fs.existsSync(mp.dir) && fs.statSync(mp.dir).isDirectory()) {
      for (const name of fs.readdirSync(mp.dir).sort()) {
        if (!name.toLowerCase().endsWith(".json")) continue;
        sources.push(makeSource("managed", "Managed policy (drop-in)", path.join(mp.dir, name), true, null));
      }
    }
  } catch {
    /* unreadable managed dir is reported by absence, not by throwing */
  }

  // 2. Command line arguments — not observable from disk. Noted in output.

  // 3. Local project settings.
  sources.push(
    makeSource(
      "local",
      "Local project",
      path.join(projectRoot, ".claude", "settings.local.json"),
      true,
      "the directory Claude Code was started from",
    ),
  );

  // 4. Shared project settings.
  sources.push(
    makeSource(
      "project",
      "Project",
      path.join(projectRoot, ".claude", "settings.json"),
      true,
      projectRoot,
    ),
  );

  // 5. User settings.
  sources.push(makeSource("user", "User", path.join(ucd, "settings.json"), true, ucd));

  // Observed but not in the documented precedence table. Reported, not ranked.
  sources.push(makeSource("user-local", "User local (undocumented)", path.join(ucd, "settings.local.json"), false, ucd));

  const rules: Rule[] = [];
  const hooks: HookCommand[] = [];
  const defaultModes: Settings["defaultModes"] = [];
  const additionalDirectories: Settings["additionalDirectories"] = [];
  const disableBypass: Settings["disableBypass"] = [];
  const disableAuto: Settings["disableAuto"] = [];
  const envNames: Settings["envNames"] = [];
  const apiKeyHelpers: Source[] = [];

  for (const src of sources) {
    if (!src.parsed) continue;
    pushRules(rules, src, "deny");
    pushRules(rules, src, "ask");
    pushRules(rules, src, "allow");
    pushHooks(hooks, src);

    const dm = permValue(src, "defaultMode");
    if (typeof dm === "string") defaultModes.push({ value: dm, source: src });

    const ad = permValue(src, "additionalDirectories");
    if (Array.isArray(ad)) {
      for (const d of ad) if (typeof d === "string") additionalDirectories.push({ value: d, source: src });
    }

    const db = permValue(src, "disableBypassPermissionsMode");
    if (db !== undefined) disableBypass.push({ value: db, source: src });

    const da = permValue(src, "disableAutoMode");
    if (da !== undefined) disableAuto.push({ value: da, source: src });

    // Names only. Settings files are a common place for plaintext API keys and
    // this server must never be the thing that reads one into a context window.
    const env = src.data["env"];
    if (env && typeof env === "object" && !Array.isArray(env)) {
      for (const name of Object.keys(env as Record<string, unknown>)) envNames.push({ name, source: src });
    }

    if (typeof src.data["apiKeyHelper"] === "string") apiKeyHelpers.push(src);
  }

  return {
    dir: start,
    projectRoot,
    projectRootReason,
    sources,
    rules,
    hooks,
    defaultModes,
    additionalDirectories,
    disableBypass,
    disableAuto,
    envNames,
    apiKeyHelpers,
    managedPresent: sources.some((s) => s.layer === "managed" && s.exists),
    platform,
  };
}
