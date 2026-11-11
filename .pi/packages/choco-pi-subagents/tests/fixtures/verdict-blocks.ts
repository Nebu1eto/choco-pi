/** Structured final-message blocks for the verdict-record tests. */

export const WORK_TASK = "demo-task";

export function fence(info: string, body: string): string {
  return `Summary prose.\n\n\`\`\`${info}\n${body}\n\`\`\`\n`;
}

const finding = (id: string, cls: "finding" | "candidate") => ({
  id,
  class: cls,
  severity: "high",
  path: "src/a.ts",
  invariant: "results are delivered once",
  evidence: "code_path",
  reproduction: "",
});

export const REVIEW_TEXT = fence(
  "choco-pi-review",
  JSON.stringify({
    schema: 1,
    verdict: "FINDINGS",
    bundleDigest: "sha256:abc",
    findings: [finding("F1", "finding"), finding("F2", "finding"), finding("C1", "candidate")],
  }),
);

export function claimsVerdictText(workTask = WORK_TASK): string {
  return fence(
    "choco-pi-verdict",
    JSON.stringify({
      schema: 1,
      kind: "claims",
      workTask,
      snapshot: { head: "0123456789abcdef", clean: true },
      claims: [
        {
          id: "F1",
          outcome: "CONFIRMED",
          reproduction: { path: "/tmp/f1.test.ts", cmd: "node --test /tmp/f1.test.ts", exit: 1 },
        },
        { id: "C1", outcome: "UNPROVEN" },
      ],
    }),
  );
}
