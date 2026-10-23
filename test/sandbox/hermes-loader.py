"""Exercise the installed Hermes runtime, not a mock PluginContext."""
import json
from hermes_cli.plugins import render_system_prompt_sections
from tools.skills_tool import skills_list, skill_view

sections = render_system_prompt_sections({
    "session_id": "knowbase-docker-smoke", "model": "test", "provider": "custom",
    "platform": "cli", "profile_name": "default", "cwd": "/tmp",
})
context = next(s.content for s in sections if s.id == "knowbase.organization")
assert "org-kb" in context and "team.md" in context, "knowledge context not registered"
catalog = skills_list()
assert "org-sandbox-proof" in catalog, "distributed skill not discovered"
skill = skill_view("org-sandbox-proof")
assert "HERMES-KNOWBASE-4819" in skill, "skill content not loaded"
print(json.dumps({"context_loaded": True, "skill_discovered": True, "skill_loaded": True}))
