---
name: stack-teardown
description: "Use this skill ONLY when the user has EXPLICITLY asked to tear down, destroy, remove, or dismantle a named Sandstorm stack. Trigger phrases include: 'tear down stack X', 'destroy stack X', 'remove stack X', 'dismantle stack X', 'clean up stack X and all its containers', 'I'm done with stack X, kill it'. This skill stops containers, removes the workspace, and archives the stack — it is IRREVERSIBLE and can lose unpushed work. Do NOT trigger on ambiguous phrases like 'clean up', 'reset', 'start over', 'remove the old one', 'stack is broken', or anything that might imply teardown without literal user words like tear down / destroy / delete. Do NOT trigger for: stopping containers (that's pause, not teardown), checking status, failure recovery, or as a precursor to creating a new stack. When in doubt, ASK the user before running."
---

# /stack-teardown

Before running: re-read the user's message. Did they literally ask to **tear down, destroy, remove, delete, or dismantle** a named stack? If the intent is ambiguous — even slightly — STOP and ask the user to confirm with the exact stack ID. Teardown is irreversible and has previously caused loss of unpushed work.

Once confirmed, run the script exactly once:

```bash
bash "$SANDSTORM_SKILLS_DIR/stack-teardown/scripts/teardown.sh" <stack-id>
```

The script prints `OK id=<stack>` on success or `ERROR <reason>` on failure. Relay it.

**Hard rules:**
- One stack per invocation — no batch teardowns.
- Never use this as a cleanup step for unrelated workflows.
- Never call the `teardown_stack` MCP tool directly — go through this skill so the explicit-confirmation rule is visible in context.
