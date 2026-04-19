---
name: list-stacks
description: "Use this skill whenever the user asks for a listing / overview / enumeration of their Sandstorm stacks. Trigger phrases include: 'list my stacks', 'what stacks do I have', 'show me all my stacks', 'list stacks', 'what's running', 'give me a rundown of the stacks', 'which stacks are active'. This is a pure listing — it returns every stack with its status and services. Do NOT trigger for: asking about ONE specific stack (that's check-and-resume-stack or stack-inspect), creating a new stack (that's spec-and-dispatch), or any action on a stack."
---

# /list-stacks

Pure listing. Run the script exactly once, relay the JSON payload to the user as a readable table:

```bash
bash "$SANDSTORM_SKILLS_DIR/list-stacks/scripts/list-stacks.sh"
```

The script prints the raw JSON array returned by `list_stacks`. Format it for the user — typically a markdown table with columns: ID, project, ticket, branch, status, services. Do not follow up with other tool calls; listing is the complete action.

Do not call the `list_stacks` MCP tool directly — this skill is the only path.
