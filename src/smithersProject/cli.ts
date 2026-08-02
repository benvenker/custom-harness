import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

export type SmithersCliCommand = {
  cmd: string[];
  cwd: string;
  source: 'root-local' | 'workflow-pack-local' | 'bunx';
};

export function buildSmithersWorkflowRunCommand(options: {
  projectRoot: string;
  workflowId: string;
  input: Record<string, unknown>;
}): SmithersCliCommand {
  const projectRoot = resolve(options.projectRoot);
  const runArgs = [
    'workflow',
    'run',
    options.workflowId,
    '--input',
    JSON.stringify(options.input),
    '--detach',
    '--format',
    'json',
    '--root',
    '.',
  ];

  const rootLocalBin = join(projectRoot, 'node_modules', '.bin', 'smithers');
  if (existsSync(rootLocalBin)) {
    return { cmd: ['bun', rootLocalBin, ...runArgs], cwd: projectRoot, source: 'root-local' };
  }

  const workflowPackLocalBin = join(projectRoot, '.smithers', 'node_modules', '.bin', 'smithers');
  if (existsSync(workflowPackLocalBin)) {
    return { cmd: ['bun', workflowPackLocalBin, ...runArgs], cwd: projectRoot, source: 'workflow-pack-local' };
  }

  return { cmd: ['bunx', 'smthrs', ...runArgs], cwd: projectRoot, source: 'bunx' };
}
