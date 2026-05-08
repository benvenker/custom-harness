export function buildStudioInspectorState(options) {
  const canEditSource = hasText(options.workflowPath);
  const structuredFields = options.mode === 'project-workflow'
    ? structuredFieldsForNode(options)
    : [];
  const canSaveStructuredEdits = canEditSource && structuredFields.length > 0;
  const renderedPromptPreview = {
    label: 'Rendered prompt',
    value: options.node.prompt,
    help: 'computed from workflow source + preview input',
  };
  const actions = [
    ...(canSaveStructuredEdits
      ? [{
        id: 'save-to-workflow',
        label: 'Save to workflow',
        visible: true,
        enabled: true,
        help: 'writes source-backed fields into workflow source',
      }]
      : []),
    ...(canEditSource ? [{ id: 'edit-source', label: 'Edit source', visible: true, enabled: true }] : []),
  ];

  return {
    structuredFields,
    canSaveStructuredEdits,
    canEditSource,
    renderedPromptPreview,
    actions,
    visibleCopy: visibleCopyForState({ renderedPromptPreview, structuredFields, actions }),
  };
}

function structuredFieldsForNode(options) {
  const studio = studioMetadata(options.node);
  if (!isRecord(studio) || studio.editable !== true || !isRecord(studio.fields)) return [];

  return Object.entries(studio.fields)
    .filter((entry) => isSupportedStudioField(entry[1]))
    .map(([id, field]) => {
      const sourcePath = [...field.sourcePath];
      const sourcePathKey = sourcePath.join('.');
      return {
        id,
        label: hasText(field.label) ? field.label : defaultFieldLabel(id, field.kind),
        kind: field.kind,
        control: field.kind === 'model-select' ? 'select' : 'textarea',
        value: options.sourceValuesByPath?.[sourcePathKey] ?? field.value ?? '',
        sourcePath,
        destinationLabel: options.workflowPath ? `${options.workflowPath} · ${sourcePathKey}` : sourcePathKey,
      };
    });
}

function studioMetadata(node) {
  if (node.type !== 'task') return undefined;
  const meta = node.smithers?.meta;
  if (!isRecord(meta)) return undefined;
  return meta.studio;
}

function isSupportedStudioField(value) {
  return isRecord(value)
    && (value.kind === 'multiline-text' || value.kind === 'model-select')
    && Array.isArray(value.sourcePath)
    && value.sourcePath.length > 0
    && value.sourcePath.every(hasText)
    && (value.label === undefined || typeof value.label === 'string')
    && (value.value === undefined || typeof value.value === 'string');
}

function defaultFieldLabel(id, kind) {
  if (kind === 'model-select') return 'Model';
  if (id === 'prompt') return 'Prompt template';
  return id;
}

function visibleCopyForState(args) {
  return [
    args.renderedPromptPreview.label,
    args.renderedPromptPreview.value,
    args.renderedPromptPreview.help,
    ...args.structuredFields.flatMap((field) => [
      field.label,
      field.value,
      field.destinationLabel,
    ]),
    ...args.actions.filter((action) => action.visible).flatMap((action) => [
      action.label,
      ...(action.help ? [action.help] : []),
    ]),
  ];
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}
