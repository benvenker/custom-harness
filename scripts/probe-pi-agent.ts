#!/usr/bin/env bun
import { PiAgent } from '@smthrs/agents';

function parseArgs(args: string[]) {
  const get = (flag: string, fallback?: string) => {
    const i = args.indexOf(flag);
    return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
  };
  return {
    model: get('--model', process.env.PI_PROBE_MODEL ?? 'openrouter/anthropic/claude-3.5-haiku')!,
    provider: get('--provider', process.env.PI_PROBE_PROVIDER),
    mode: get('--mode', process.env.PI_PROBE_MODE ?? 'json') as 'text' | 'json' | 'rpc',
    prompt:
      get(
        '--prompt',
        'Use the read tool to read README.md line 1, then answer with exactly: FIRST_LINE=<line>',
      )!,
    cwd: get('--cwd', process.cwd())!,
    apiKey: get('--api-key', process.env.OPENROUTER_API_KEY),
  };
}

const opts = parseArgs(process.argv.slice(2));
console.log('[probe] node', process.version);
console.log('[probe] bun', Bun.version);
console.log('[probe] cwd', opts.cwd);
console.log('[probe] model', opts.model);
console.log('[probe] provider', opts.provider ?? '(inferred by pi)');
console.log('[probe] mode', opts.mode);
console.log('[probe] prompt', opts.prompt);

const agent = new PiAgent({
  model: opts.model,
  provider: opts.provider,
  apiKey: opts.apiKey,
  cwd: opts.cwd,
  noSession: true,
  mode: opts.mode,
  tools: ['read', 'ls', 'bash', 'grep', 'find'],
  timeoutMs: 120_000,
  idleTimeoutMs: 45_000,
});

const events: unknown[] = [];
const stdout: string[] = [];
const stderr: string[] = [];

try {
  const result = await agent.generate({
    prompt: opts.prompt,
    rootDir: opts.cwd,
    maxOutputBytes: 200_000,
    onStdout: (text) => {
      stdout.push(text);
      process.stdout.write(text);
    },
    onStderr: (text) => {
      stderr.push(text);
      process.stderr.write(text);
    },
    onEvent: (event) => {
      events.push(event);
      const e = event as { type?: string; action?: { kind?: string; title?: string }; phase?: string; engine?: string };
      if (e.type === 'action') console.error(`[event] ${e.phase} ${e.action?.kind} ${e.action?.title}`);
      else console.error(`[event] ${e.type ?? 'unknown'} ${e.engine ?? ''}`.trim());
    },
  });

  console.log('\n[probe] success');
  console.log('[probe] text:', JSON.stringify(result.text?.slice(0, 1000) ?? ''));
  console.log('[probe] usage:', JSON.stringify(result.usage ?? result.totalUsage ?? null));
  console.log('[probe] events:', events.length);
  console.log('[probe] stdoutBytes:', Buffer.byteLength(stdout.join(''), 'utf8'));
  console.log('[probe] stderrBytes:', Buffer.byteLength(stderr.join(''), 'utf8'));
} catch (error) {
  console.error('\n[probe] failed');
  console.error(error);
  console.error('[probe] events:', events.length);
  console.error('[probe] stdoutBytes:', Buffer.byteLength(stdout.join(''), 'utf8'));
  console.error('[probe] stderrBytes:', Buffer.byteLength(stderr.join(''), 'utf8'));
  process.exit(1);
}
