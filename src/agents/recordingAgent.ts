import type { z } from 'zod';
import type { RunRecorder } from '../runs/recorder.js';
import type { AgentGenerateOptions, AgentGenerateResult, AgentLike } from '../workflows/outcomeWorkflow.js';

export type RecordingAgentOptions<T> = {
  nodeId: string;
  agent: AgentLike;
  recorder: RunRecorder;
  outputSchema: z.ZodType<T>;
  onValidatedOutput?: (output: T) => void;
};

export class RecordingAgent<T> implements AgentLike {
  readonly model?: string;
  readonly id?: string;
  readonly cliEngine?: string;

  constructor(private readonly options: RecordingAgentOptions<T>) {
    this.model = options.agent.model;
    this.id = options.agent.id;
    this.cliEngine = options.agent.cliEngine;
  }

  async generate(options: AgentGenerateOptions = {}): Promise<AgentGenerateResult> {
    let streamed = false;
    let streamedText = '';
    let result: AgentGenerateResult;
    try {
      result = await this.options.agent.generate({
        ...options,
        onStdout: (text: string) => {
          streamed = true;
          streamedText += text;
          this.recordText(text);
          options.onStdout?.(text);
        },
        onStderr: (text: string) => {
          streamed = true;
          streamedText += text;
          this.recordText(text);
          options.onStderr?.(text);
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.options.recorder.event('run.error', {
        nodeId: this.options.nodeId,
        message,
        source: 'smithers',
      });
      throw error;
    }

    const text = String(result.text ?? streamedText);
    if (!streamed && text) this.recordText(text);

    const output = extractStructuredOutput(result);
    let parsed = this.options.outputSchema.safeParse(output);
    const trimmedText = text.trim();
    if (!parsed.success && output === undefined && trimmedText && !startsLikeJson(trimmedText)) {
      parsed = this.options.outputSchema.safeParse({ result: trimmedText });
    }
    if (!parsed.success) {
      const message = `Task output validation failed for ${this.options.nodeId}: ${parsed.error.message}`;
      this.options.recorder.event('run.error', {
        nodeId: this.options.nodeId,
        message,
        source: 'smithers',
      });
      throw new Error(message);
    }
    this.options.onValidatedOutput?.(parsed.data);
    return { ...result, output: parsed.data, _output: parsed.data };
  }

  private recordText(text: string) {
    if (!text) return;
    this.options.recorder.appendCli(text);
    this.options.recorder.appendAgentOutput(this.options.nodeId, text);
  }
}

export class FunctionPlannerAgent<T> implements AgentLike {
  constructor(private readonly fn: () => T | Promise<T>) {}

  async generate(options: AgentGenerateOptions = {}) {
    const output = await this.fn();
    const text = JSON.stringify(output);
    options.onStdout?.(text);
    return { text, output };
  }
}

function extractStructuredOutput(result: AgentGenerateResult) {
  if (result._output !== undefined && result._output !== null) return result._output;
  if (result.output !== undefined && result.output !== null) return result.output;
  const text = String(result.text ?? '').trim();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
    if (fenced) {
      try {
        return JSON.parse(fenced);
      } catch {
        // Fall through to balanced JSON extraction.
      }
    }
    const balanced = extractLastParseableJson(text);
    if (!balanced) return undefined;
    return balanced;
  }
}

function extractLastParseableJson(text: string) {
  let pos = text.lastIndexOf('{');
  while (pos >= 0) {
    const candidate = extractBalancedJson(text.slice(pos));
    if (candidate) {
      try {
        return JSON.parse(candidate);
      } catch {
        // Keep scanning; prose often contains pseudo-JSON examples.
      }
    }
    pos = text.lastIndexOf('{', pos - 1);
  }
  return null;
}

function startsLikeJson(text: string) {
  const trimmed = text.trim();
  return trimmed.startsWith('{') || trimmed.startsWith('[');
}

function extractBalancedJson(text: string) {
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (char === '\\') {
      escape = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(0, i + 1);
    }
  }
  return null;
}
