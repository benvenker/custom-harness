type InspectorNode = {
  id: string;
  type: string;
  title: string;
  prompt: string;
  smithers?: {
    meta?: unknown;
  };
};

type StructuredField = {
  id: string;
  label: string;
  kind: string;
  control: "textarea" | "input" | "select";
  value: string;
  sourcePath: string[];
  destinationLabel: string;
};

export type InspectorAction = {
  id: string;
  label: string;
  visible: boolean;
  enabled?: boolean;
  help?: string;
};

export type StudioInspectorState = {
  structuredFields: StructuredField[];
  canSaveStructuredEdits: boolean;
  canEditSource: boolean;
  renderedPromptPreview: {
    label: string;
    value: string;
    help: string;
  } | null;
  actions: InspectorAction[];
  visibleCopy: string[];
};

export type BuildStudioInspectorStateOptions = {
  mode: "project-workflow" | "run";
  workflowId?: string;
  workflowPath?: string;
  node: InspectorNode;
  sourceValuesByPath?: Record<string, string>;
};

type StudioFieldMeta = {
  label?: string;
  kind: "multiline-text" | "model-select";
  sourcePath: string[];
  value?: string;
};

export function buildStudioInspectorState(
  options: BuildStudioInspectorStateOptions
): StudioInspectorState {
  const canEditSource = hasText(options.workflowPath);
  const structuredFields =
    options.mode === "project-workflow" ? structuredFieldsForNode(options) : [];
  const canSaveStructuredEdits = canEditSource && structuredFields.length > 0;
  const renderedPromptPreview = {
    label: "Rendered prompt",
    value: options.node.prompt,
    help: "computed from workflow source + preview input",
  };
  const actions: InspectorAction[] = [
    ...(canSaveStructuredEdits
      ? [
          {
            id: "save-to-workflow",
            label: "Save to workflow",
            visible: true,
            enabled: true,
            help: "writes source-backed fields into workflow source",
          },
        ]
      : []),
    ...(canEditSource
      ? [
          {
            id: "edit-source",
            label: "Edit source",
            visible: true,
            enabled: true,
          },
        ]
      : []),
  ];

  return {
    structuredFields,
    canSaveStructuredEdits,
    canEditSource,
    renderedPromptPreview,
    actions,
    visibleCopy: visibleCopyForState({
      renderedPromptPreview,
      structuredFields,
      actions,
    }),
  };
}

function structuredFieldsForNode(
  options: BuildStudioInspectorStateOptions
): StructuredField[] {
  const studio = studioMetadata(options.node);
  if (!isRecord(studio) || studio.editable !== true || !isRecord(studio.fields))
    return [];

  return Object.entries(studio.fields)
    .filter((entry): entry is [string, StudioFieldMeta] =>
      isSupportedStudioField(entry[1])
    )
    .map(([id, field]) => {
      const sourcePath = [...field.sourcePath];
      const sourcePathKey = sourcePath.join(".");
      return {
        id,
        label: hasText(field.label)
          ? field.label
          : defaultFieldLabel(id, field.kind),
        kind: field.kind,
        control: field.kind === "model-select" ? "select" : "textarea",
        value: options.sourceValuesByPath?.[sourcePathKey] ?? field.value ?? "",
        sourcePath,
        destinationLabel: options.workflowPath
          ? `${options.workflowPath} · ${sourcePathKey}`
          : sourcePathKey,
      };
    });
}

function studioMetadata(node: InspectorNode): unknown {
  if (node.type !== "task") return undefined;
  const meta = node.smithers?.meta;
  if (!isRecord(meta)) return undefined;
  return meta.editor;
}

function isSupportedStudioField(value: unknown): value is StudioFieldMeta {
  return (
    isRecord(value) &&
    (value.kind === "multiline-text" || value.kind === "model-select") &&
    Array.isArray(value.sourcePath) &&
    value.sourcePath.length > 0 &&
    value.sourcePath.every(hasText) &&
    (value.label === undefined || typeof value.label === "string") &&
    (value.value === undefined || typeof value.value === "string")
  );
}

function defaultFieldLabel(id: string, kind: string) {
  if (kind === "model-select") return "Model";
  if (id === "prompt") return "Prompt template";
  return id;
}

function visibleCopyForState(args: {
  renderedPromptPreview: NonNullable<
    StudioInspectorState["renderedPromptPreview"]
  >;
  structuredFields: StructuredField[];
  actions: InspectorAction[];
}): string[] {
  return [
    args.renderedPromptPreview.label,
    args.renderedPromptPreview.value,
    args.renderedPromptPreview.help,
    ...args.structuredFields.flatMap((field) => [
      field.label,
      field.value,
      field.destinationLabel,
    ]),
    ...args.actions
      .filter((action) => action.visible)
      .flatMap((action) => [
        action.label,
        ...(action.help ? [action.help] : []),
      ]),
  ];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
