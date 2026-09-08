import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { stripVTControlCharacters } from "node:util";
import { withLiveCtx } from "../extension/live-context.ts";
import type {
  SteeringObserver,
  SteeringStatus,
} from "../providers/openai-codex/native-steering.ts";

const WIDGET = "codex-steering";
type SteeringUIContext = Pick<ExtensionContext, "hasUI"> & {
  sessionManager: Pick<ExtensionContext["sessionManager"], "getSessionId">;
  ui: { setWidget(key: string, lines: string[] | undefined): void };
};
const labels = {
  queued: "Queued (Pi path)",
  sent: "Mid-turn sent",
  accepted: "Mid-turn accepted",
  applied: "Mid-turn applied",
  fallback: "Queue fallback",
} satisfies Record<SteeringStatus | "queued", string>;

interface Row {
  number: number;
  preview: string;
  status: SteeringStatus | "queued";
}

/** Session-local, per-submission receipts. Never enters model context or session history. */
export class SteeringStatusWidget {
  private generation = 0;
  private sequence = 0;
  private rows: Row[] = [];

  clear(ctx: SteeringUIContext): void {
    this.generation++;
    this.rows = [];
    if (ctx.hasUI) withLiveCtx(() => ctx.ui.setWidget(WIDGET, undefined));
  }

  add(text: string, ctx: SteeringUIContext): SteeringObserver {
    const generation = this.generation;
    const owner = ctx.sessionManager.getSessionId();
    const preview = stripVTControlCharacters(text)
      .replace(/[\p{Cc}\p{Cf}]/gu, " ")
      .replace(/\s+/g, " ")
      .trim();
    const row: Row = {
      number: ++this.sequence,
      preview:
        Array.from(preview).slice(0, 64).join("") + (Array.from(preview).length > 64 ? "…" : ""),
      status: "queued",
    };
    this.rows = [...this.rows.slice(-3), row];
    const draw = () => {
      if (generation !== this.generation || !this.rows.includes(row)) return;
      withLiveCtx(() => {
        if (!ctx.hasUI || ctx.sessionManager.getSessionId() !== owner) return;
        ctx.ui.setWidget(
          WIDGET,
          this.rows.map(
            (item) => `Steer #${item.number} · ${labels[item.status]} · ${item.preview}`,
          ),
        );
      });
    };
    draw();
    return (status) => {
      if (generation !== this.generation || row.status === "applied" || row.status === "fallback")
        return;
      row.status = status;
      // Keep host UI calls outside the provider's protocol-error containment.
      queueMicrotask(draw);
    };
  }
}
