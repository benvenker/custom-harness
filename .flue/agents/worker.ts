import type { FlueContext } from '@flue/sdk/client';

export default async function ({
  init,
  payload,
  env,
}: FlueContext<{ goal: string }, { OPENROUTER_API_KEY?: string }>) {
  const agent = await init({
    model: 'openrouter/anthropic/claude-sonnet-4.6',
    sandbox: 'local',
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const session = await (agent as any).session('worker');
  const result = await session.task(payload.goal, { role: 'worker' });
  console.log(result.text);
  return { output: result.text };
}
