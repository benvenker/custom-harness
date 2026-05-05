import type Anthropic from '@anthropic-ai/sdk';

export interface Tool {
  definition: Anthropic.Tool;
  execute: (input: Record<string, unknown>) => Promise<string>;
}

export function createTools(): Map<string, Tool> {
  const tools = new Map<string, Tool>();

  tools.set('bash', {
    definition: {
      name: 'bash',
      description: 'Run a bash command and return stdout + stderr',
      input_schema: {
        type: 'object' as const,
        properties: {
          command: { type: 'string', description: 'The bash command to run' },
        },
        required: ['command'],
      },
    },
    execute: async (input) => {
      const { command } = input as { command: string };
      const proc = Bun.spawn(['bash', '-c', command], {
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      await proc.exited;
      const exitCode = proc.exitCode;
      const out = stdout.trimEnd();
      const err = stderr.trimEnd();
      return [
        out,
        err ? `STDERR: ${err}` : '',
        exitCode !== 0 ? `Exit code: ${exitCode}` : '',
      ]
        .filter(Boolean)
        .join('\n');
    },
  });

  tools.set('read_file', {
    definition: {
      name: 'read_file',
      description: 'Read the contents of a file',
      input_schema: {
        type: 'object' as const,
        properties: {
          path: { type: 'string', description: 'Path to the file' },
        },
        required: ['path'],
      },
    },
    execute: async (input) => {
      const { path } = input as { path: string };
      try {
        return await Bun.file(path).text();
      } catch (e) {
        return `Error reading file: ${e}`;
      }
    },
  });

  tools.set('write_file', {
    definition: {
      name: 'write_file',
      description: 'Write content to a file (creates or overwrites)',
      input_schema: {
        type: 'object' as const,
        properties: {
          path: { type: 'string', description: 'Path to write the file' },
          content: { type: 'string', description: 'Content to write' },
        },
        required: ['path', 'content'],
      },
    },
    execute: async (input) => {
      const { path, content } = input as { path: string; content: string };
      try {
        await Bun.write(path, content);
        return `Wrote ${content.length} bytes to ${path}`;
      } catch (e) {
        return `Error writing file: ${e}`;
      }
    },
  });

  tools.set('list_files', {
    definition: {
      name: 'list_files',
      description: 'List files in a directory',
      input_schema: {
        type: 'object' as const,
        properties: {
          path: {
            type: 'string',
            description: 'Directory path (defaults to current directory)',
          },
        },
        required: [],
      },
    },
    execute: async (input) => {
      const { path = '.' } = input as { path?: string };
      const proc = Bun.spawn(['ls', '-la', path], {
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      await proc.exited;
      return stdout + (stderr ? `\nSTDERR: ${stderr}` : '');
    },
  });

  return tools;
}

export const DONE_TOOL: Anthropic.Tool = {
  name: 'done',
  description:
    'Signal that the goal has been fully accomplished. Call this when you are finished.',
  input_schema: {
    type: 'object' as const,
    properties: {
      summary: {
        type: 'string',
        description: 'Clear summary of what was accomplished and any key outputs',
      },
      success: {
        type: 'boolean',
        description: 'Whether the goal was successfully achieved',
      },
    },
    required: ['summary', 'success'],
  },
};
