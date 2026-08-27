import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { HookDispatch } from "./supplemental-events.ts";

interface TaskRecord {
  id: string;
  subject: string;
  description?: string;
  status: "pending" | "in_progress" | "completed";
}

export function registerClaudeTaskTools(pi: ExtensionAPI, dispatch: HookDispatch): void {
  const tasks = new Map<string, TaskRecord>();
  let nextId = 1;
  pi.registerTool(
    defineTool({
      name: "TaskCreate",
      label: "TaskCreate",
      description: "Create a tracked task.",
      parameters: Type.Object({
        subject: Type.String(),
        description: Type.Optional(Type.String()),
      }),
      execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
        const id = String(nextId++);
        const decision = await dispatch("TaskCreated", ctx, {
          task_id: id,
          task_subject: params.subject,
          task_description: params.description,
        });
        if (decision.blocked) throw new Error(decision.reason ?? "Task creation blocked by hook");
        const task: TaskRecord = {
          id,
          subject: params.subject,
          description: params.description,
          status: "pending",
        };
        tasks.set(id, task);
        return { content: [{ type: "text", text: JSON.stringify(task) }], details: task };
      },
    }),
  );
  pi.registerTool(
    defineTool({
      name: "TaskUpdate",
      label: "TaskUpdate",
      description: "Update a tracked task.",
      parameters: Type.Object({
        task_id: Type.String(),
        status: Type.Optional(
          Type.Union([
            Type.Literal("pending"),
            Type.Literal("in_progress"),
            Type.Literal("completed"),
          ]),
        ),
        subject: Type.Optional(Type.String()),
        description: Type.Optional(Type.String()),
      }),
      execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
        const task = tasks.get(params.task_id);
        if (!task) throw new Error(`Unknown task: ${params.task_id}`);
        if (params.status === "completed") {
          const decision = await dispatch("TaskCompleted", ctx, {
            task_id: task.id,
            task_subject: params.subject ?? task.subject,
            task_description: params.description ?? task.description,
          });
          if (decision.blocked)
            throw new Error(decision.reason ?? "Task completion blocked by hook");
        }
        if (params.subject !== undefined) task.subject = params.subject;
        if (params.description !== undefined) task.description = params.description;
        if (params.status !== undefined) task.status = params.status;
        return { content: [{ type: "text", text: JSON.stringify(task) }], details: task };
      },
    }),
  );
}
