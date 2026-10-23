import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { isMap, isSeq, parseDocument } from "yaml";
import { additionalAgentHomes, CONTEXT_OWNER as OWNER, hermesConfigIsGenerated, type AdditionalAgentHome } from "./agent-installations.js";
import { writeFileAtomic, type AgentConfigChange, type AgentConfigRemoval } from "./agent-config.js";

const PLUGIN = "knowbase-context";
const MARKER = ".knowbase.json";
interface Ownership { owner: string; command?: string; enabledByKnowbase?: boolean; createdConfigHash?: string }

function rootFor(t: AdditionalAgentHome): string {
  return t.name === "Cursor" ? path.join(t.dir, "knowbase") : path.join(t.dir, "plugins", PLUGIN);
}

function runtimeFilesPresent(t: AdditionalAgentHome): boolean {
  const root = rootFor(t);
  const files = t.name === "Cursor"
    ? ["context.md", "workspace-open.cjs", "plugin/.cursor-plugin/plugin.json", "plugin/rules/knowbase.mdc"]
    : ["context.md", "__init__.py", "plugin.yaml"];
  return files.every(file => {
    try { return fs.statSync(path.join(root, file)).isFile(); } catch { return false; }
  });
}

function ownership(root: string): Ownership | null {
  try {
    const marker = JSON.parse(fs.readFileSync(path.join(root, MARKER), "utf8"));
    return marker?.owner === OWNER ? marker : null;
  } catch { return null; }
}

function put(file: string, content: string): boolean {
  if (fs.existsSync(file) && fs.readFileSync(file, "utf8") === content) return false;
  writeFileAtomic(file, content);
  return true;
}

function claim(root: string, previous: Ownership | null): void {
  if (fs.existsSync(root) && !previous) throw new Error(`同名目录不是 knowbase 托管的，未覆盖：${root}`);
}

function jsonObject(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function cursorHooks(dir: string): { file: string; config: Record<string, any> } {
  const file = path.join(dir, "hooks.json");
  const config = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : { version: 1, hooks: {} };
  if (!jsonObject(config) || (config.version !== undefined && config.version !== 1) ||
      (config.hooks !== undefined && !jsonObject(config.hooks)) ||
      (config.hooks?.workspaceOpen !== undefined && !Array.isArray(config.hooks.workspaceOpen))) {
    throw new Error(`Cursor hooks 配置格式不支持，未覆盖：${file}`);
  }
  return { file, config };
}

/** Commands are executed by the client's shell; quote every path as one literal argument. */
function shellArg(value: string): string {
  return process.platform === "win32" ? `"${value.replace(/"/g, '""')}"` : `'${value.replace(/'/g, "'\\''")}'`;
}

function syncCursor(t: AdditionalAgentHome, block: string, onlyExisting: boolean): AgentConfigChange {
  const root = rootFor(t);
  const file = path.join(root, "context.md");
  const previous = ownership(root);
  const result = { name: t.name, file };
  if (onlyExisting && (!previous || !runtimeFilesPresent(t))) return { ...result, action: "unchanged" };
  claim(root, previous);
  const hooks = cursorHooks(t.dir);
  const entries = hooks.config.hooks?.workspaceOpen ?? [];
  if (onlyExisting && !entries.some((h: any) => h?.command === previous?.command)) return { ...result, action: "unchanged" };
  const plugin = path.join(root, "plugin");
  const command = `${shellArg(process.execPath)} ${shellArg(path.join(root, "workspace-open.cjs"))}`;
  const nextEntries = entries.filter((h: any) => !previous?.command || h?.command !== previous.command);
  nextEntries.push({ command });
  const nextHooks = { ...hooks.config, version: 1, hooks: { ...hooks.config.hooks, workspaceOpen: nextEntries } };
  let changed = false;
  const save = (f: string, s: string) => { changed = put(f, s) || changed; };
  // Claim before writing so interrupted installs are safely resumable.
  save(path.join(root, MARKER), JSON.stringify({ owner: OWNER, command }) + "\n");
  save(file, block + "\n");
  save(path.join(plugin, ".cursor-plugin/plugin.json"), JSON.stringify({ name: PLUGIN, version: "1.0.0", description: "Organization knowledge context managed by knowbase" }, null, 2) + "\n");
  save(path.join(plugin, "rules/knowbase.mdc"), `---\nalwaysApply: true\n---\n${block}\n`);
  save(path.join(root, "workspace-open.cjs"), '// Managed by knowbase.\nconst path = require("node:path");\nprocess.stdout.write(JSON.stringify({pluginPaths: [path.join(__dirname, "plugin")]}));\n');
  // Do not reserialize existing settings unless the registration actually changed.
  if (JSON.stringify(hooks.config) !== JSON.stringify(nextHooks)) save(hooks.file, JSON.stringify(nextHooks, null, 2) + "\n");
  return { ...result, action: previous ? (changed ? "updated" : "unchanged") : "created" };
}

function hermesConfig(dir: string) {
  const file = path.join(dir, "config.yaml");
  const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const doc = parseDocument(text);
  if (doc.errors.length || (doc.contents !== null && !isMap(doc.contents))) throw new Error(`Hermes YAML 配置无效，未覆盖：${file}`);
  const plugins = doc.get("plugins", true);
  if (plugins !== undefined && !isMap(plugins)) throw new Error(`Hermes plugins 配置必须是映射：${file}`);
  const lists = (key: string): string[] => {
    const value = doc.getIn(["plugins", key], true);
    if (value === undefined) return [];
    if (!isSeq(value) || value.items.some(i => typeof (i as any)?.value !== "string")) throw new Error(`Hermes plugins.${key} 必须是字符串列表：${file}`);
    return value.toJSON() as string[];
  };
  return { file, doc, enabled: lists("enabled"), disabled: lists("disabled") };
}

const HERMES_PLUGIN = `"""Organization context managed by knowbase."""
from pathlib import Path

def register(ctx):
    def context(session_info):
        try:
            text = (Path(__file__).parent / "context.md").read_text(encoding="utf-8")
            if len(text) > 3800:
                text = text[:3700].rsplit("\\n", 1)[0] + "\\n…（Hermes 上下文长度限制，其余内容直接 grep 知识库定位）"
            return text
        except OSError:
            return ""
    ctx.register_system_prompt_section(
        "knowbase.organization", context, position="after_memory", max_chars=4000
    )
`;

function syncHermes(t: AdditionalAgentHome, block: string, onlyExisting: boolean): AgentConfigChange {
  const root = rootFor(t);
  const file = path.join(root, "context.md");
  const previous = ownership(root);
  const result = { name: t.name, file };
  if (onlyExisting && (!previous || !runtimeFilesPresent(t))) return { ...result, action: "unchanged" };
  claim(root, previous);
  const config = hermesConfig(t.dir);
  if (config.disabled.includes(PLUGIN)) return { ...result, action: "skipped", reason: "Hermes 已显式禁用 knowbase-context，保留该设置" };
  if (onlyExisting && !config.enabled.includes(PLUGIN)) return { ...result, action: "unchanged" };
  const enabledByKnowbase = previous?.enabledByKnowbase ?? !config.enabled.includes(PLUGIN);
  const generatedConfig = !fs.existsSync(config.file) || hermesConfigIsGenerated(t.dir);
  let nextConfig: string | undefined;
  if (!config.enabled.includes(PLUGIN)) {
    // Append to the AST sequence to preserve comments on existing entries.
    const seq = config.doc.getIn(["plugins", "enabled"], true);
    if (isSeq(seq)) seq.add(PLUGIN);
    else config.doc.setIn(["plugins", "enabled"], [PLUGIN]);
    nextConfig = config.doc.toString();
  }
  const createdConfigHash = generatedConfig
    ? createHash("sha256").update(nextConfig ?? fs.readFileSync(config.file, "utf8")).digest("hex")
    : undefined;
  let changed = false;
  const save = (f: string, s: string) => { changed = put(f, s) || changed; };
  save(path.join(root, MARKER), JSON.stringify({ owner: OWNER, enabledByKnowbase, createdConfigHash }) + "\n");
  save(file, block + "\n");
  save(path.join(root, "plugin.yaml"), `name: ${PLUGIN}\nversion: "1.0.0"\ndescription: Organization knowledge context managed by knowbase\n`);
  save(path.join(root, "__init__.py"), HERMES_PLUGIN);
  if (nextConfig !== undefined) save(config.file, nextConfig);
  return { ...result, action: previous ? (changed ? "updated" : "unchanged") : "created" };
}

export function syncAdditionalAgentConfig(block: string, home: string, onlyExisting = false, hermesHome?: string): AgentConfigChange[] {
  return additionalAgentHomes(home, false, hermesHome).map(t => {
    try {
      return t.name === "Cursor" ? syncCursor(t, block, onlyExisting) : syncHermes(t, block, onlyExisting);
    } catch (e) {
      return { name: t.name, file: path.join(rootFor(t), "context.md"), action: "skipped", reason: e instanceof Error ? e.message : String(e) };
    }
  });
}

export function uninstallAdditionalAgentConfig(home: string, hermesHome?: string): AgentConfigRemoval[] {
  return additionalAgentHomes(home, true, hermesHome).map(t => {
    const root = rootFor(t);
    const previous = ownership(root);
    const result = { name: t.name, file: path.join(root, "context.md"), removed: false };
    if (!previous) return result;
    try {
      if (t.name === "Cursor") {
        const hooks = cursorHooks(t.dir);
        const entries = hooks.config.hooks?.workspaceOpen;
        if (entries?.some((h: any) => h?.command === previous.command)) {
          hooks.config.hooks.workspaceOpen = entries.filter((h: any) => h?.command !== previous.command);
          if (hooks.config.hooks.workspaceOpen.length === 0) delete hooks.config.hooks.workspaceOpen;
          put(hooks.file, JSON.stringify(hooks.config, null, 2) + "\n");
        }
      } else {
        const config = hermesConfig(t.dir);
        if (hermesConfigIsGenerated(t.dir)) {
          fs.rmSync(config.file);
        } else if (previous.enabledByKnowbase && config.enabled.includes(PLUGIN)) {
          const seq = config.doc.getIn(["plugins", "enabled"], true);
          if (isSeq(seq)) seq.delete(config.enabled.indexOf(PLUGIN));
          put(config.file, config.doc.toString());
        }
      }
      fs.rmSync(root, { recursive: true, force: true });
      return { ...result, removed: true };
    } catch (e) {
      return { ...result, error: e instanceof Error ? e.message : String(e) };
    }
  });
}

export function additionalAgentConfigStatus(home = os.homedir(), hermesHome?: string): Array<{ name: string; state: string; error?: string }> {
  return additionalAgentHomes(home, false, hermesHome).map(t => {
    try {
      const root = rootFor(t);
      const previous = ownership(root);
      const runtimeExists = runtimeFilesPresent(t);
      let active = false;
      if (t.name === "Cursor") {
        const hooks = cursorHooks(t.dir);
        active = !!previous?.command && runtimeExists &&
          !!hooks.config.hooks?.workspaceOpen?.some((h: any) => h?.command === previous.command);
      } else {
        const config = hermesConfig(t.dir);
        if (config.disabled.includes(PLUGIN)) return { name: t.name, state: "已显式禁用" };
        active = !!previous && runtimeExists && config.enabled.includes(PLUGIN);
      }
      return { name: t.name, state: active ? "已配置（新工作区/会话生效）" : "未配置或已停用；运行 knowbase init 可重新接入" };
    } catch (e) {
      return { name: t.name, state: "配置异常", error: e instanceof Error ? e.message : String(e) };
    }
  });
}
