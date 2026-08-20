import assert from "node:assert/strict";
import test from "node:test";
import { codeModeMutationToolResults } from "../clients/code-mode-tool-results.ts";

test("dispatches changed files from a nested code-mode apply_patch result", () => {
  const content = [{ type: "text", text: "Applied patch successfully" }];
  const events = codeModeMutationToolResults(
    {
      details: {
        codeMode: true,
        traces: [
          {
            name: "apply_patch",
            status: "done",
            input: "*** Begin Patch",
            result: {
              content,
              details: {
                status: "success",
                result: {
                  changedFiles: ["clients/env-utils.ts"],
                  createdFiles: [],
                },
              },
            },
          },
        ],
      },
    },
    "/worktree",
  );

  assert.deepEqual(events, [
    {
      toolName: "edit",
      input: { path: "/worktree/clients/env-utils.ts" },
      content,
      details: {
        status: "success",
        result: {
          changedFiles: ["clients/env-utils.ts"],
          createdFiles: [],
        },
      },
    },
  ]);
});
