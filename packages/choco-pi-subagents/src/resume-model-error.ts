export class ResumeModelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResumeModelError";
  }
}
