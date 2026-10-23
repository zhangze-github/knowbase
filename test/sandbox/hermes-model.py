"""Optional live-model smoke test. Credentials must come from the environment."""
import json
import os
from run_agent import AIAgent

agent = AIAgent(
    base_url=os.environ["ARK_BASE_URL"], api_key=os.environ["ARK_API_KEY"],
    provider="custom", api_mode="chat_completions",
    model=os.environ.get("ARK_MODEL", "doubao-seed-2-0-lite-260428"),
    enabled_toolsets=["terminal", "file", "skills"], max_iterations=8,
    max_tokens=1024, quiet_mode=True, save_trajectories=False,
    reasoning_config={"enabled": False},
)
result = agent.run_conversation(
    "Use your organization knowledge-base instructions to locate and read team.md. "
    "Also load the org-sandbox-proof skill. Return the sandbox launch code from team.md "
    "and the verification phrase from the skill, in one short line."
)
output = json.dumps(result, ensure_ascii=False, default=str)
assert "ORBIT-7326" in output, "model did not retrieve knowledge from the mirror"
assert "HERMES-KNOWBASE-4819" in output, "model did not load the distributed skill"
print(json.dumps({"model": agent.model, "knowledge_retrieved": True, "skill_used": True}))
