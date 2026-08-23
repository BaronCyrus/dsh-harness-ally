// Harness × 模型联盟的 prompt section：只贡献会话内行为说明。

export const name = 'ally-prompt'
export const inject = ['systemPrompt']

const SECTION_TEXT = `
This session uses Harness × Model Alliance mode.

The user independently chooses:
- a configured DSH model from the normal model selector; and
- an execution Harness: DSH, Claude Code, Codex, or Kimi Code.

The selected Harness executes the ordinary Agent model step while DSH remains the
owner of conversation history, turn lifecycle, cancellation, permissions, and
model identity. Never claim that changing Harness discards context or changes the
selected model.

Three explicit one-shot delegation tools are also available:
- subagent_claude_code for a self-contained Claude Code task;
- subagent_codex for a self-contained Codex task;
- subagent_kimi_code for a self-contained Kimi Code task.

Use those tools for independent or parallel subtasks, not as a substitute for the
user's selected foreground Harness. Delegated prompts must be complete and include
the required context, file pointers, constraints, and acceptance criteria. Do not
invent CLI flags, model availability, or execution results; the Host gateway owns
process, sandbox, protocol, and cleanup policy.
`.trim()

export function apply(ctx) {
  ctx.effect(
    () => ctx.systemPrompt.section({
      name: 'harness-ally',
      order: 110,
      text: SECTION_TEXT,
    }),
    'ally-prompt.section()',
  )
}
