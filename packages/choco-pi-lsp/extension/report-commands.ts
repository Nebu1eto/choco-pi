import { getDegradationSummary } from "../clients/degradation-ledger.ts";
import * as path from "node:path";
import { getDiagnosticTracker } from "../clients/diagnostic-tracker.ts";
import { loadDispatchIntegration } from "../clients/dispatch/lazy.ts";
import { getAllToolStatuses } from "../clients/installer/index.ts";
import { getLSPService } from "../clients/lsp/index.ts";
import { buildMemorySample, formatMemoryHealthLine } from "../clients/memory-sampler.ts";
import { isDebugHeapEnabled, writeHeapSnapshotNow } from "../clients/debug-heap.ts";
import { countRecentSmells, formatSmellsHealthLine } from "../clients/smells-rollup.ts";
import { t } from "../i18n.ts";
import { getEventLoopStats } from "../clients/event-loop-monitor.ts";
import type { ExtensionActivation } from "./activation.ts";
import { processState } from "./process-state.ts";
import { notifyUi } from "./shared.ts";

export function registerReportCommands(activation: ExtensionActivation): void {
  const { pi, runtime } = activation;
  pi.registerCommand("lens-tdi", {
    description: "Show Technical Debt Index (TDI) and project health trend. Usage: /lens-tdi",
    handler: async (_args, ctx) => {
      const { loadHistory, computeTDI } = await import("../clients/metrics-history.ts");
      const history = loadHistory();
      const tdi = computeTDI(history);

      let summary = "🔴 High debt - run diagnostics_report mode=full for details";
      if (tdi.score <= 30) {
        summary = "✅ Codebase is healthy!";
      } else if (tdi.score <= 60) {
        summary = "⚠️ Moderate debt - consider refactoring";
      }
      const lines = [
        `📊 TECHNICAL DEBT INDEX: ${tdi.score}/100 (${tdi.grade})`,
        ``,
        `Files analyzed: ${tdi.filesAnalyzed}`,
        `Files with debt: ${tdi.filesWithDebt}`,
        `Avg MI: ${tdi.avgMI}`,
        `Total cognitive complexity: ${tdi.totalCognitive}`,
        ``,
        `Debt breakdown:`,
        `  Maintainability: ${tdi.byCategory.maintainability}% (MI-based)`,
        `  Cognitive: ${tdi.byCategory.cognitive}%`,
        `  Nesting: ${tdi.byCategory.nesting}%`,
        `  Max Cyclomatic: ${tdi.byCategory.maxCyclomatic}% (worst function)`,
        `  Entropy: ${tdi.byCategory.entropy}% (code unpredictability)`,
        ``,
        summary,
      ];

      notifyUi(ctx, lines.join("\n"), "info");
    },
  });

  pi.registerCommand("lens-map", {
    description:
      "Render the review graph as a self-contained interactive HTML project map (pan/zoom/hover/click) and write it to disk. Usage: /lens-map",
    handler: async (_args, ctx) => {
      const cwd = ctx.cwd ?? process.cwd();
      try {
        const { generateLensMap } = await import("../clients/lsp-map.ts");
        const result = await generateLensMap(cwd);
        const testNote =
          result.testFileCount > 0 ? `, ${result.testFileCount} test files excluded` : "";
        const twinNote =
          result.compiledTwinCount > 0 ? `, ${result.compiledTwinCount} compiled twins merged` : "";
        const ignoredNote =
          result.ignoredFileCount > 0
            ? `, ${result.ignoredFileCount} gitignored files excluded`
            : "";
        const lines = [
          `🗺️ Project map written to ${result.filePath}`,
          `${result.fileCount} files, ${result.edgeCount} edges, ${result.externalCount} external deps excluded${testNote}${twinNote}${ignoredNote}.`,
        ];
        if (result.truncated) {
          lines.push(
            "Graph exceeded the map's node cap — showing the highest-degree files only (see the in-page note).",
          );
        }
        notifyUi(ctx, lines.join("\n"), "info");
      } catch (err) {
        notifyUi(
          ctx,
          `Failed to generate the project map: ${err instanceof Error ? err.message : String(err)}`,
          "error",
        );
      }
    },
  });

  pi.registerCommand("lens-health", {
    description:
      "Show choco-pi-lsp runtime health: pipeline crashes, slow runners, and last dispatch latency. Usage: /lens-health",
    handler: async (_args, ctx) => {
      const crashEntries = runtime.getCrashEntries().sort((a, b) => b[1] - a[1]);
      const totalCrashes = crashEntries.reduce((sum, [, count]) => sum + count, 0);

      const dispatchIntegration =
        processState.loadedDispatchIntegration ?? (await loadDispatchIntegration());
      processState.loadedDispatchIntegration = dispatchIntegration;
      const reports = dispatchIntegration.getLatencyReports();
      const last = reports.length > 0 ? reports[reports.length - 1] : undefined;
      const diagStats = getDiagnosticTracker().getStats();
      const slowRunners = last
        ? [...last.runners].sort((a, b) => b.durationMs - a.durationMs).slice(0, 3)
        : [];

      const sessionAge = Date.now() - runtime.sessionStartedAt;
      const sessionMins = Math.floor(sessionAge / 60_000);
      const sessionHrs = Math.floor(sessionMins / 60);
      const sessionAgeStr =
        sessionHrs > 0 ? `${sessionHrs}h ${sessionMins % 60}m` : `${sessionMins}m`;
      const startedAt = new Date(runtime.sessionStartedAt).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      });

      const lines: string[] = [
        t("lens.health.title", "🩺 PI-LENS HEALTH"),
        `Session started: ${startedAt} (${sessionAgeStr} ago)`,
        "",
        t("lens.health.crashes", "Pipeline crashes (session): {count}", {
          count: totalCrashes,
        }),
        t("lens.health.files", "Files affected: {count}", {
          count: crashEntries.length,
        }),
      ];
      const slopScoreLine = dispatchIntegration.getDispatchSlopScoreLine();

      if (crashEntries.length > 0) {
        lines.push("", t("lens.health.topCrashFiles", "Top crash files:"));
        for (const [file, count] of crashEntries.slice(0, 5)) {
          lines.push(`  ${path.basename(file)}: ${count}`);
        }
      }

      if (last) {
        lines.push(
          "",
          `Last dispatch: ${path.basename(last.filePath)} (${last.totalDurationMs}ms, ${last.totalDiagnostics} diagnostics)`,
        );
        if (slowRunners.length > 0) {
          lines.push("Top runners (last dispatch):");
          for (const runner of slowRunners) {
            lines.push(`  ${runner.runnerId}: ${runner.durationMs}ms (${runner.status})`);
          }
        }
      } else {
        lines.push("", t("lens.health.noLatency", "No dispatch latency reports yet."));
      }

      lines.push(
        "",
        t("lens.health.diagnosticsShown", "Diagnostics shown: {count}", {
          count: diagStats.totalShown,
        }),
        t("lens.health.autoFixed", "Auto-fixed: {count}", {
          count: diagStats.totalAutoFixed,
        }),
        t("lens.health.agentFixed", "Agent-fixed: {count}", {
          count: diagStats.totalAgentFixed,
        }),
        t("lens.health.unresolved", "Unresolved carryover: {count}", {
          count: diagStats.totalUnresolved,
        }),
      );

      const elStats = getEventLoopStats();
      if (elStats) {
        lines.push(
          "",
          `Event loop: worst genuine block ${processState.sessionWorstRealBlockMs}ms (session) · p99 ${elStats.p99Ms}ms · mean ${elStats.meanMs}ms (turn)`,
        );
        if (processState.sessionWorstRealBlockMs > 100) {
          lines.push(
            "  ⚠ a >100ms synchronous block can stutter the TUI — check latency.log (#192)",
          );
        }
        if (processState.sessionSuspectedStalls > 0) {
          lines.push(
            `  ${processState.sessionSuspectedStalls} suspected system stall(s) (sleep/paging) this session — excluded from the block figure above (#1122)`,
          );
        }
      }

      try {
        lines.push("", formatMemoryHealthLine(buildMemorySample(runtime.wordIndex)));
      } catch {}

      if (isDebugHeapEnabled()) {
        try {
          const snap = writeHeapSnapshotNow("lsp_health");
          if (snap) {
            lines.push(
              `Heap snapshot written: ${snap.path} (RSS ${Math.round(snap.rssBytes / (1024 * 1024))}MB, ${snap.durationMs}ms) — open in Chrome DevTools › Memory`,
            );
          }
        } catch {}
      }

      try {
        lines.push(formatSmellsHealthLine(countRecentSmells()));
      } catch {}

      if (diagStats.repeatOffenders.length > 0) {
        lines.push(t("lens.health.repeatOffenders", "Repeat offenders:"));
        for (const offender of diagStats.repeatOffenders.slice(0, 5)) {
          lines.push(
            `  ${path.basename(offender.filePath)}:${offender.line} ${offender.ruleId} (${offender.count}x)`,
          );
        }
      }

      if (diagStats.topViolations.length > 0) {
        lines.push(t("lens.health.topNoisyRules", "Top noisy rules:"));
        for (const v of diagStats.topViolations.slice(0, 5)) {
          const samplePath =
            v.samplePaths.length > 0
              ? path.relative(runtime.projectRoot, v.samplePaths[0]).replace(/\\/g, "/")
              : "";
          const pathSuffix = samplePath ? ` (e.g. ${samplePath})` : "";
          lines.push(`  ${v.ruleId}: ${v.count}${pathSuffix}`);
        }
      }

      const lspClients = getLSPService().getStatus();
      if (lspClients.length > 0) {
        lines.push("", "LSP servers:");
        for (const { serverId, root, connected } of lspClients) {
          const state = connected ? "✓" : "✗";
          const rootLabel = path.relative(runtime.projectRoot, root) || ".";
          lines.push(`  ${state} ${serverId} (${rootLabel})`);
        }
      } else {
        lines.push("", "LSP servers: none started");
      }

      const cascadeStats = dispatchIntegration.getCascadeSessionStats();
      if (cascadeStats.runs > 0) {
        lines.push(
          "",
          `Cascade runs: ${cascadeStats.runs}`,
          `Cascade diagnostics surfaced: ${cascadeStats.diagnosticsSurfaced}`,
        );
        if (cascadeStats.coldSnapshotTouches > 0) {
          lines.push(`Cold-snapshot touches: ${cascadeStats.coldSnapshotTouches}`);
        }
      }

      if (slopScoreLine) {
        lines.push("", slopScoreLine);
      }

      notifyUi(ctx, lines.join("\n"), "info");
    },
  });

  pi.registerCommand("lens-perf", {
    description:
      "Show the slowest latency-log phases by p50 and p99 for the current process session and machine-wide active log window. Usage: /lens-perf",
    handler: async (_args, ctx) => {
      try {
        const { collectLatencyPerformance, renderLatencyPerformanceReport } =
          await import("../clients/performance-report.ts");
        const report = await collectLatencyPerformance({
          sessionStartedAt: runtime.sessionStartedAt,
        });
        const degradations = getDegradationSummary();
        const degradationText = degradations.length
          ? `\n\nDegradations:\n${degradations.map((group) => `  ${group.kind}: ${group.count} (${group.latestReasons.at(-1)?.subject}: ${group.latestReasons.at(-1)?.reason})`).join("\n")}`
          : "";
        notifyUi(ctx, `${renderLatencyPerformanceReport(report)}${degradationText}`, "info");
      } catch (err) {
        notifyUi(
          ctx,
          `Failed to read performance telemetry: ${err instanceof Error ? err.message : String(err)}`,
          "error",
        );
      }
    },
  });

  pi.registerCommand("lens-tools", {
    description:
      "Show choco-pi-lsp tool installation status: globally installed, auto-installed, or npx fallback. Usage: /lens-tools",
    handler: async (_args, ctx) => {
      const statuses = await getAllToolStatuses();

      const bySource = {
        "global-path": statuses.filter((s) => s.source === "global-path"),
        "npm-global": statuses.filter((s) => s.source === "npm-global"),
        "pip-user": statuses.filter((s) => s.source === "pip-user"),
        "choco-pi-lsp-auto": statuses.filter((s) => s.source === "choco-pi-lsp-auto"),
        "github-release": statuses.filter((s) => s.source === "github-release"),
        "npx-fallback": statuses.filter((s) => s.source === "npx-fallback"),
        "not-installed": statuses.filter((s) => s.source === "not-installed"),
      };

      const lines: string[] = [
        "🔧 PI-LENS TOOLS STATUS",
        "",
        `Installed: ${statuses.filter((s) => s.installed).length}/${statuses.length}`,
      ];

      if (bySource["global-path"].length > 0) {
        lines.push("", `📍 Global PATH (${bySource["global-path"].length}):`);
        for (const tool of bySource["global-path"]) {
          const version = tool.version ? ` (${tool.version})` : "";
          lines.push(`  ✓ ${tool.name}${version}`);
        }
      }

      if (bySource["npm-global"].length > 0) {
        lines.push("", `📦 npm global (${bySource["npm-global"].length}):`);
        for (const tool of bySource["npm-global"]) {
          lines.push(`  ✓ ${tool.name}`);
        }
      }

      if (bySource["pip-user"].length > 0) {
        lines.push("", `🐍 pip user (${bySource["pip-user"].length}):`);
        for (const tool of bySource["pip-user"]) {
          lines.push(`  ✓ ${tool.name}`);
        }
      }

      if (bySource["github-release"].length > 0) {
        lines.push("", `⬇️ GitHub releases (${bySource["github-release"].length}):`);
        for (const tool of bySource["github-release"]) {
          lines.push(`  ✓ ${tool.name}`);
        }
      }

      if (bySource["choco-pi-lsp-auto"].length > 0) {
        lines.push("", `🤖 Auto-installed (${bySource["choco-pi-lsp-auto"].length}):`);
        for (const tool of bySource["choco-pi-lsp-auto"]) {
          lines.push(`  ✓ ${tool.name}`);
        }
      }

      if (bySource["npx-fallback"].length > 0) {
        lines.push("", `📦 npx fallback (${bySource["npx-fallback"].length} - on-demand install):`);
        for (const tool of bySource["npx-fallback"]) {
          lines.push(`  ⬜ ${tool.name}`);
        }
      }

      const trulyMissing = bySource["not-installed"].filter((s) => s.strategy !== "npm");
      if (trulyMissing.length > 0) {
        lines.push("", `❌ Missing (${trulyMissing.length}):`);
        for (const tool of trulyMissing) {
          lines.push(`  ✗ ${tool.name} (${tool.strategy})`);
        }
        lines.push(
          "",
          "Note: GitHub-release tools auto-install when you open files of those languages",
        );
      }

      notifyUi(ctx, lines.join("\n"), "info");
    },
  });
}
