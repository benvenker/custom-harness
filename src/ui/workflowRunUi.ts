export type ProjectRunInspectionResult = {
  runId: string;
  finalStatus: string | null;
  polls: number;
  fetchedUrls: string[];
};

export type PollProjectRunInspectionOptions = {
  runId: string;
  inspectionUrl?: string;
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
  setTimeout?: (callback: () => void, delayMs: number) => unknown;
  maxNotFoundRetries?: number;
  intervalMs?: number;
};

const TERMINAL_SMITHERS_STATUSES = new Set(['finished', 'failed', 'cancelled', 'canceled']);

export function buildProjectWorkflowRunPayload(
  input: Record<string, unknown>,
  _extras?: Record<string, unknown>,
): Record<string, unknown> {
  return { input: { ...input } };
}

export function isTerminalSmithersRunStatus(status: string | null | undefined): boolean {
  return typeof status === 'string' && TERMINAL_SMITHERS_STATUSES.has(status.toLowerCase());
}

export function buildProjectRunInspectionUrl(args: {
  runId: string;
  inspectionUrl?: string;
  eventsAfterSeq?: number;
  includeOutputs?: boolean;
}): string {
  const base = args.inspectionUrl || `/api/smithers/runs/${encodeURIComponent(args.runId)}`;
  const separator = base.includes('?') ? '&' : '?';
  const params = new URLSearchParams();
  params.set('eventsAfterSeq', String(Number.isFinite(args.eventsAfterSeq) ? args.eventsAfterSeq : 0));
  if (args.includeOutputs !== false) params.set('includeOutputs', 'true');
  return `${base}${separator}${params.toString()}`;
}

export async function pollProjectRunInspection(
  options: PollProjectRunInspectionOptions,
): Promise<ProjectRunInspectionResult> {
  const maxNotFoundRetries = options.maxNotFoundRetries ?? 4;
  const intervalMs = options.intervalMs ?? 1000;
  const sleep = (delayMs: number) => new Promise<void>((resolve) => {
    const timer = options.setTimeout ?? globalThis.setTimeout;
    timer(() => resolve(), delayMs);
  });
  const fetchedUrls: string[] = [];
  let polls = 0;
  let notFoundRetries = 0;

  while (true) {
    const url = buildProjectRunInspectionUrl({
      runId: options.runId,
      inspectionUrl: options.inspectionUrl,
      eventsAfterSeq: 0,
      includeOutputs: true,
    });
    fetchedUrls.push(url);
    polls += 1;
    const response = await options.fetch(url, { cache: 'no-store' });

    if (response.status === 404 && notFoundRetries < maxNotFoundRetries) {
      notFoundRetries += 1;
      await sleep(intervalMs);
      continue;
    }

    if (!response.ok) {
      throw new Error(`Smithers run inspection failed: HTTP ${response.status}`);
    }

    const body = await response.json().catch(() => ({}));
    const finalStatus = statusFromInspectionBody(body);
    return {
      runId: options.runId,
      finalStatus,
      polls,
      fetchedUrls,
    };
  }
}

function statusFromInspectionBody(body: unknown): string | null {
  if (!isRecord(body)) return null;
  const detail = body.detail;
  if (isRecord(detail) && isRecord(detail.run) && typeof detail.run.status === 'string') {
    return detail.run.status;
  }
  if (isRecord(body.run) && typeof body.run.status === 'string') return body.run.status;
  return typeof body.status === 'string' ? body.status : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
