import Anthropic from '@anthropic-ai/sdk';
import { createTools, DONE_TOOL } from './tools.js';
import { createSession, addMessage } from './session.js';
import type { Goal, AgentResult } from '../types.js';

const MODEL = 'claude-sonnet-4-6';
const MAX_ITERATIONS = 50;

export async function runHarness(goal: Goal): Promise<AgentResult> {
  const client = new Anthropic();
  const tools = createTools();
  const session = createSession();

  let systemPrompt: string;
  try {
    systemPrompt = await Bun.file('AGENTS.md').text();
  } catch {
    systemPrompt =
      'You are a helpful agent. Accomplish the given goal using the available tools. Call `done` when finished.';
  }

  const allToolDefs = [
    ...Array.from(tools.values()).map((t) => t.definition),
    DONE_TOOL,
  ];

  addMessage(session, {
    role: 'user',
    content:
      goal.description +
      (goal.context ? `\n\nAdditional context:\n${goal.context}` : ''),
  });

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 8096,
      system: [
        {
          type: 'text',
          text: systemPrompt,
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: session.messages,
      tools: allToolDefs,
    });

    addMessage(session, {
      role: 'assistant',
      content: response.content,
    });

    if (response.stop_reason === 'end_turn') {
      const text = response.content
        .filter((c): c is Anthropic.TextBlock => c.type === 'text')
        .map((c) => c.text)
        .join('\n');
      return { success: true, output: text };
    }

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    let doneResult: AgentResult | null = null;

    for (const block of response.content) {
      if (block.type !== 'tool_use') continue;

      if (block.name === 'done') {
        const input = block.input as { summary: string; success: boolean };
        doneResult = { success: input.success, output: input.summary };
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: 'Acknowledged.',
        });
        break;
      }

      const tool = tools.get(block.name);
      if (!tool) {
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: `Unknown tool: "${block.name}"`,
          is_error: true,
        });
        continue;
      }

      try {
        const result = await tool.execute(
          block.input as Record<string, unknown>,
        );
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: result,
        });
      } catch (e) {
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: `Tool error: ${e}`,
          is_error: true,
        });
      }
    }

    if (doneResult) return doneResult;

    if (toolResults.length > 0) {
      addMessage(session, { role: 'user', content: toolResults });
    }
  }

  return {
    success: false,
    output: `Reached ${MAX_ITERATIONS} iterations without completing the goal.`,
  };
}
