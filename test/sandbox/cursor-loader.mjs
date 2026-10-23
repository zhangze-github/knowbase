// Validate the shared desktop/CLI workspaceOpen contract in a real Cursor CLI image.
// A model dialogue still requires Cursor credentials and network access to its backend.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
import { execSync, execFileSync } from "node:child_process";

const home = os.homedir();
const version = execFileSync("agent", ["--version"], { encoding: "utf8" }).trim();
const hooks = JSON.parse(fs.readFileSync(path.join(home, ".cursor/hooks.json"), "utf8"));
const payload = JSON.parse(execSync(hooks.hooks.workspaceOpen[0].command, { encoding: "utf8", input: "{}" }));
assert.equal(payload.pluginPaths.length, 1);
const plugin = payload.pluginPaths[0];
assert.equal(JSON.parse(fs.readFileSync(path.join(plugin, ".cursor-plugin/plugin.json"), "utf8")).name, "knowbase-context");
const rule = fs.readFileSync(path.join(plugin, "rules/knowbase.mdc"), "utf8");
assert.match(rule, /^---\nalwaysApply: true\n---\n/);
assert.ok(rule.includes(path.join(home, "org-kb")) && rule.includes("team.md"));
assert.ok(fs.readFileSync(path.join(home, ".cursor/skills/org-sandbox-proof/SKILL.md"), "utf8").includes("HERMES-KNOWBASE-4819"));
console.log(JSON.stringify({ version, hook_executed: true, plugin_rule_prepared: true, skill_delivered: true, model_dialogue_tested: false }));
