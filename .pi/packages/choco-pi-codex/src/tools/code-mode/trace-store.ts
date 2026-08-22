import type { BoundaryValue } from "../boundary.ts";
import type {
  RuntimeResponse,
  RuntimeToolResult,
  RuntimeToolTrace,
  ToolExecutionContext,
} from "./types.ts";
import { boundRuntimeToolResult, cloneTrace, sanitizeTraceInput } from "./trace-values.ts";

const MAX_TRACE_COUNT = 50;
const MAX_TRACE_INPUT_CHARS = 16_384;
const MAX_TRACE_IMAGE_CHARS = 16 * 1024 * 1024;

interface RunningTraceDetails {
  cellId: string;
  status: "running";
  traces: RuntimeToolTrace[];
  droppedTraceCount?: number | undefined;
}

export class CodeModeTraceStore {
  private readonly traces = new Map<string, RuntimeToolTrace[]>();
  private readonly droppedCounts = new Map<string, number>();

  clear(): void {
    this.traces.clear();
    this.droppedCounts.clear();
  }

  delete(cellId: string): void {
    this.traces.delete(cellId);
    this.droppedCounts.delete(cellId);
  }

  start(cellId: string, id: string, name: string, input: BoundaryValue): RuntimeToolTrace {
    const traces = this.traces.get(cellId) ?? [];
    if (traces.length >= MAX_TRACE_COUNT) {
      traces.shift();
      this.droppedCounts.set(cellId, (this.droppedCounts.get(cellId) ?? 0) + 1);
    }
    const trace: RuntimeToolTrace = {
      id,
      name,
      input: sanitizeTraceInput(input, MAX_TRACE_INPUT_CHARS),
      status: "running",
    };
    traces.push(trace);
    this.traces.set(cellId, traces);
    return trace;
  }

  captureResult(
    cellId: string,
    current: RuntimeToolTrace,
    result: RuntimeToolResult,
  ): RuntimeToolResult {
    const usedImageChars = (this.traces.get(cellId) ?? [])
      .filter((trace) => trace !== current)
      .flatMap((trace) => trace.result?.content ?? [])
      .reduce(
        (total, item) => total + (item.type === "image" && item.data ? item.data.length : 0),
        0,
      );
    return boundRuntimeToolResult(result, Math.max(0, MAX_TRACE_IMAGE_CHARS - usedImageChars));
  }

  emitUpdate(cellId: string, context: ToolExecutionContext): void {
    try {
      const details: RunningTraceDetails = {
        cellId,
        status: "running",
        traces: (this.traces.get(cellId) ?? []).map(cloneTrace),
      };
      const droppedTraceCount = this.droppedCounts.get(cellId);
      if (droppedTraceCount) details.droppedTraceCount = droppedTraceCount;
      context.onUpdate?.({ content: [], details });
    } catch {
      // Rendering updates must not change nested tool execution.
    }
  }

  attach(response: RuntimeResponse): RuntimeResponse {
    const traces = this.traces.get(response.cellId)?.map(cloneTrace);
    const droppedTraceCount = this.droppedCounts.get(response.cellId) ?? 0;
    if (response.kind !== "yielded") this.delete(response.cellId);
    if ((!traces || traces.length === 0) && droppedTraceCount === 0) return response;
    const attached: RuntimeResponse = { ...response };
    if (traces && traces.length > 0) attached.traces = traces;
    if (droppedTraceCount > 0) attached.droppedTraceCount = droppedTraceCount;
    return attached;
  }
}
