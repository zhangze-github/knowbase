// Run only in a disposable container with its own HOME.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { syncAgentConfig } from "../../dist/agent-config.js";
import { syncSkills } from "../../dist/skills-sync.js";

const home = os.homedir();
const kb = path.join(home, "org-kb");
const write = (file, content) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); };
write(path.join(home, ".cursor/cli-config.json"), "{}\n");
write(path.join(home, ".hermes/config.yaml"), "model: test\n");
write(path.join(kb, "team.md"), "Sandbox launch code: ORBIT-7326.\n");
write(path.join(kb, "skills/sandbox-proof/SKILL.md"), "---\nname: sandbox-proof\ndescription: Retrieve the sandbox verification phrase when testing knowbase integration.\n---\nThe verification phrase is HERMES-KNOWBASE-4819.\n");
const changes = syncAgentConfig(kb);
assert.equal(changes.find(c => c.name === "Cursor")?.action, "created");
assert.equal(changes.find(c => c.name === "Hermes")?.action, "created");
const skills = syncSkills(kb);
assert.deepEqual(skills.map(c => c.tool), ["Claude Code", "Cursor", "Hermes"]);
console.log("Sandbox agent integrations prepared");
