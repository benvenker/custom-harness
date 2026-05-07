import { describe, expect, it } from 'bun:test';

type InspectorNode = {
  id: string;
  type: string;
  title: string;
  prompt: string;
  smithers?: {
    meta?: unknown;
  };
};

type InspectorState = {
  structuredFields: Array<{
    id: string;
    label: string;
    kind: string;
    control: 'textarea' | 'input' | 'select';
    value: string;
    sourcePath: string[];
    destinationLabel: string;
  }>;
  canSaveStructuredEdits: boolean;
  canEditSource: boolean;
  renderedPromptPreview: {
    label: string;
    value: string;
    help: string;
  } | null;
  actions: Array<{
    id: string;
    label: string;
    visible: boolean;
  }>;
  visibleCopy: string[];
};

type BuildStudioInspectorState = (options: {
  mode: 'project-workflow' | 'run';
  workflowId?: string;
  workflowPath?: string;
  node: InspectorNode;
  sourceValuesByPath?: Record<string, string>;
}) => InspectorState;

async function loadInspectorHelper(): Promise<{
  buildStudioInspectorState: BuildStudioInspectorState;
}> {
  return import('../src/ui/studioInspector.js') as Promise<{
    buildStudioInspectorState: BuildStudioInspectorState;
  }>;
}

function projectInspectorState(
  node: InspectorNode,
  sourceValuesByPath: Record<string, string> = {},
): Promise<InspectorState> {
  return loadInspectorHelper().then(({ buildStudioInspectorState }) => buildStudioInspectorState({
    mode: 'project-workflow',
    workflowId: 'foo',
    workflowPath: '.smithers/workflows/foo.tsx',
    node,
    sourceValuesByPath,
  }));
}

function allVisibleText(value: unknown): string {
  const parts: string[] = [];
  const visit = (item: unknown) => {
    if (typeof item === 'string') {
      parts.push(item);
      return;
    }
    if (Array.isArray(item)) {
      item.forEach(visit);
      return;
    }
    if (item && typeof item === 'object') {
      Object.values(item).forEach(visit);
    }
  };
  visit(value);
  return parts.join('\n');
}

function visibleActionLabels(state: InspectorState): string[] {
  return state.actions.filter((action) => action.visible).map((action) => action.label);
}

const promptFieldMeta = {
  studio: {
    editable: true,
    fields: {
      prompt: {
        label: 'Prompt template',
        kind: 'multiline-text',
        sourcePath: ['tasks', 'variant-claude', 'prompt'],
      },
    },
  },
};

describe('workflow viewer studio inspector state', () => {
  it('keeps project workflow tasks without studio metadata read-only while exposing rendered prompt preview and source fallback', async () => {
    const state = await projectInspectorState({
      id: 'plain-task',
      type: 'task',
      title: 'Plain Task',
      prompt: 'USER REQUEST: Ship the alpha',
    });

    expect(state.structuredFields).toEqual([]);
    expect(state.canSaveStructuredEdits).toBe(false);
    expect(state.canEditSource).toBe(true);
    expect(state.renderedPromptPreview).toEqual({
      label: 'Rendered prompt',
      value: 'USER REQUEST: Ship the alpha',
      help: 'computed from workflow source + preview input',
    });

    const copy = allVisibleText(state);
    expect(copy).toContain('Rendered prompt');
    expect(copy).toContain('computed from workflow source + preview input');
    expect(copy).not.toContain('Temporary override');
    expect(copy).not.toContain('Agent prompt override');
    expect(copy).not.toContain('Prompt template');
    expect(copy).not.toContain('Save to workflow');
    expect(copy).not.toContain('Run with edits');
    expect(visibleActionLabels(state)).not.toContain('Start run with override');
  });

  it('shows a metadata-backed Prompt template textarea from source while keeping rendered prompt preview separate', async () => {
    const sourcePromptTemplate = 'USER REQUEST: ${ctx.input.prompt}';
    const state = await projectInspectorState(
      {
        id: 'variant-claude',
        type: 'task',
        title: 'Variant Claude',
        prompt: 'USER REQUEST: Ship the alpha',
        smithers: { meta: promptFieldMeta },
      },
      { 'tasks.variant-claude.prompt': sourcePromptTemplate },
    );

    const promptField = state.structuredFields.find((field) => field.id === 'prompt');
    expect(promptField).toEqual({
      id: 'prompt',
      label: 'Prompt template',
      kind: 'multiline-text',
      control: 'textarea',
      value: sourcePromptTemplate,
      sourcePath: ['tasks', 'variant-claude', 'prompt'],
      destinationLabel: '.smithers/workflows/foo.tsx · tasks.variant-claude.prompt',
    });
    expect(state.renderedPromptPreview).toEqual({
      label: 'Rendered prompt',
      value: 'USER REQUEST: Ship the alpha',
      help: 'computed from workflow source + preview input',
    });
    expect(promptField?.value).not.toBe(state.renderedPromptPreview?.value);
    expect(state.canSaveStructuredEdits).toBe(true);
    expect(state.canEditSource).toBe(true);

    const copy = allVisibleText(state);
    expect(copy).toContain('Rendered prompt');
    expect(copy).toContain('USER REQUEST: Ship the alpha');
    expect(copy).toContain('Prompt template');
    expect(copy).toContain('USER REQUEST: ${ctx.input.prompt}');
    expect(copy).toContain('.smithers/workflows/foo.tsx · tasks.variant-claude.prompt');
    expect(copy).not.toContain('Agent prompt override');
    expect(copy).not.toContain('Temporary override');
    expect(copy).not.toContain('Start run with override');

    const actions = visibleActionLabels(state);
    expect(actions.some((label) => label === 'Save to workflow' || label === 'Save as copy')).toBe(true);
    expect(actions).not.toContain('Start run with override');
  });

  it('does not make a project workflow task editable unless studio metadata explicitly enables a supported field', async () => {
    const state = await projectInspectorState(
      {
        id: 'variant-claude',
        type: 'task',
        title: 'Variant Claude',
        prompt: 'USER REQUEST: Ship the alpha',
        smithers: {
          meta: {
            studio: {
              fields: {
                prompt: {
                  label: 'Prompt template',
                  kind: 'multiline-text',
                  sourcePath: ['tasks', 'variant-claude', 'prompt'],
                },
              },
            },
          },
        },
      },
      { 'tasks.variant-claude.prompt': 'USER REQUEST: ${ctx.input.prompt}' },
    );

    expect(state.structuredFields).toEqual([]);
    expect(state.canSaveStructuredEdits).toBe(false);
    expect(state.canEditSource).toBe(true);

    const copy = allVisibleText(state);
    expect(copy).toContain('Rendered prompt');
    expect(copy).not.toContain('Prompt template');
    expect(copy).not.toContain('Save to workflow');
    expect(copy).not.toContain('Run with edits');
    expect(copy).not.toContain('Temporary override');
    expect(visibleActionLabels(state)).not.toContain('Start run with override');
  });
});
