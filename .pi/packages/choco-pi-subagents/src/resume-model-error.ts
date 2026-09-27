/**
 * Raised by `AgentManager.resume(..., { model })` before any run state changes.
 * Standalone so nested-tools can recognise it without importing the manager
 * (agent-manager -> agent-runner -> nested-tools would otherwise form a cycle).
 */
export class ResumeModelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResumeModelError";
  }
}
