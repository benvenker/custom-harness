import type { FlueContext } from '@flue/sdk/client';

export default async function ({
  init,
  payload,
  env,
}: FlueContext<{ goal: string }, { OPENROUTER_API_KEY?: string }>) {
  const agent = await init({
    model: 'openai/anthropic/claude-sonnet-4-6',
    sandbox: 'local',
    providers: {
      openai: {
        baseUrl: 'https://openrouter.ai/api/v1',
        apiKey: env.OPENROUTER_API_KEY ?? process.env.OPENROUTER_API_KEY ?? '',
      },
    },
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const session = await (agent as any).session('worker');
  const result = await session.task(payload.goal, { role: 'worker' });
  console.log(result.text);
  return { output: result.text };
}
