/**
 * Prompt @handle mention routing.
 */
import type { TypeInfo } from "../ui/agent-mention.ts";
import { getAvailableTypes, getAgentConfig, resolveSpawnType } from "../agent-types.ts";
import {
  parseMention,
  isReservedHandle,
  stripAgentPrefix,
  resolveHandleToType,
  handleBase,
  describeMention,
} from "../mention.ts";
import type { AgentRecord } from "../types.ts";
import { issueExemptTicket } from "../review-rounds.ts";
import { getOutputTranscriptDefault } from "../output-file.ts";
import { normalizeMaxTurns, getDefaultMaxTurns } from "../agent-runner.ts";
import { ResumeModelError } from "../agent-manager.ts";
import { pathExists } from "../fs-async.ts";
import { runMentionClone, shouldHandleMentionCloneCompletion } from "../mention-clone.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { SubagentsRuntime } from "./runtime.ts";

/** Routes leading @handle prompt input to agents. */
export function installMentionInput(pi: ExtensionAPI, rt: SubagentsRuntime) {
  /** Agent types `@` can start, in the shape the roster wants. */
  const mentionTypes = (): TypeInfo[] =>
    getAvailableTypes().map((name) => ({
      name,
      description: getAgentConfig(name)?.description ?? name,
    }));

  /**
   * `@handle message` typed at the prompt addresses that agent instead of the
   * main model — Claude Code's prompt mention, same grammar (see mention.ts).
   *
   * The handle names the *agent*, not one process, so one syntax covers its
   * whole lifecycle: message it while it runs, resume it once it has finished,
   * start it if it never ran. Everything that isn't an agent mention falls
   * through untouched, which is what keeps `@src/foo.ts summarize this`, a bare
   * `@handle`, and ordinary prose working. A delivered mention costs no
   * main-model turn; the answer arrives through the ordinary completion
   * notification either way.
   */
  pi.on("input", async (event, ctx) => {
    // Never hijack text the extension layer itself submitted (pi.sendMessage,
    // scheduled prompts) — only something a person typed can be a mention.
    if (event.source === "extension" || !rt.preferences.isAgentMentionsEnabled())
      return { action: "continue" };
    // Claiming the turn is TUI only, matching the `@` completion that teaches
    // the syntax. Pi defaults `session.prompt()` to source "interactive", so a
    // headless `pi -p "@explore …"` reaches here too — and claiming it would
    // answer with silence, which the background hold cannot fix: `handled`
    // returns from prompt() before any turn starts, so the loop that patch wraps
    // never runs (it holds subagents spawned by the Agent tool MID-turn, a
    // different path). The agent would detach, `ctx.ui.notify` is a no-op
    // outside the TUI, and print mode would exit having printed nothing.
    //
    // `model` mode has none of that problem: it queues a reminder and lets the
    // turn run, so the answer is the model's own, printed as usual. It is the
    // only branch allowed to act headlessly; everything else falls through to
    // the main model exactly as it did before mentions existed.
    const canDispatchDirectly = ctx.mode === "tui";
    if (!canDispatchDirectly && rt.preferences.getAgentMentionMode() !== "model")
      return { action: "continue" };

    const mention = parseMention(event.text);
    if (!mention) return { action: "continue" };

    // `@main` addresses the main conversation, never a subagent — the one name
    // `assignHandle` refuses to allocate. An explicit escape hatch for text
    // that would otherwise read as a mention, so the prefix is dropped and the
    // rest goes to the model with its attachments intact.
    if (isReservedHandle(mention.handle)) {
      return {
        action: "transform",
        text: mention.message,
        ...(event.images && { images: event.images }),
      };
    }

    // As typed first, so an agent actually called `agent-foo` wins over Claude
    // Code's `@agent-` + `foo` spelling rather than being shadowed by it.
    const alias = stripAgentPrefix(mention.handle);
    const resolved =
      rt.core.manager.resolveMention(mention.handle) ??
      (alias ? rt.core.manager.resolveMention(alias) : undefined);

    // Steering and resuming are direct in every mode, so headless they are not
    // available at all. Falling through here rather than dropping to the start
    // path below matters: the handle names an agent that already exists, and
    // asking the model to start another one is not what was typed.
    // A journaled agent evicted from memory or not revived after a restart.
    // Live records win; a dormant one is preferred over an in-memory tombstone
    // because it reopens under the same id.
    const dormant =
      resolved?.kind === "live"
        ? undefined
        : (rt.core.manager.findDormantByHandle(mention.handle) ??
          (alias ? rt.core.manager.findDormantByHandle(alias) : undefined));
    if ((resolved || dormant) && !canDispatchDirectly) return { action: "continue" };

    if (resolved?.kind === "live") {
      const record = resolved.record;
      const target = `@${record.alias ?? record.handle ?? mention.handle}`;

      if (record.status === "running" || record.status === "queued") {
        // Steering interrupts after the current tool call, exactly like the
        // steer_subagent tool. Un-consume the result so the agent's reply to
        // this message is still relayed even if the LLM read its last answer.
        record.resultConsumed = false;
        rt.core.manager.journalRecord(record.id);
        rt.core.manager.steer(record.id, mention.message);
        rt.notifications.emitLifecycle("subagents:steered", {
          id: record.id,
          message: mention.message,
        });
        ctx.ui.notify(`Sent to ${target}`, "info");
        return { action: "handled" };
      }

      if (record.session) {
        // Both derived from the record's OWN type: a mention names an existing
        // agent, so its frontmatter is what governs — `output_transcript: false`
        // must keep holding, since record.outputFile is the sole gate every
        // downstream consumer keys off and a resume must not re-open it.
        const config = getAgentConfig(record.type);
        let resumedRecord: AgentRecord | undefined;
        try {
          resumedRecord = await rt.background.startBackgroundResume(ctx, record, mention.message, {
            // A user-typed mention is user authority: exempt from, never refused by, the cap.
            reviewTicket: issueExemptTicket("user-mention"),
            outputTranscript: config?.outputTranscript ?? getOutputTranscriptDefault(),
            maxTurns: normalizeMaxTurns(config?.maxTurns ?? getDefaultMaxTurns()),
          });
        } catch (error) {
          // A closed provider refuses the resume with the usage-limit details.
          if (!(error instanceof ResumeModelError)) throw error;
          ctx.ui.notify(`Could not resume ${target}: ${error.message}`, "warning");
          return { action: "handled" };
        }
        ctx.ui.notify(
          resumedRecord
            ? `Resuming ${target}`
            : `Could not resume ${target} — it is still running.`,
          resumedRecord ? "info" : "warning",
        );
        return { action: "handled" };
      }
      // A live record with no session never got far enough to continue, so it
      // falls through to the start-fresh path below, like Claude's
      // `no_transcript`.
    }

    if (dormant !== undefined) {
      const target = `@${dormant.alias ?? dormant.handle ?? mention.handle}`;
      if (rt.core.manager.isRevivalPending(dormant.id)) {
        ctx.ui.notify(`${target} is being revived right now; try again in a moment.`, "warning");
        return { action: "handled" };
      }
      if (!rt.core.manager.canResumeDormant(dormant.id)) {
        ctx.ui.notify(`Could not resume ${target} \u2014 it has no saved session.`, "warning");
        return { action: "handled" };
      }
      const generation = rt.state.revivalGeneration;
      // Detached: reopening may wait for the previous runtime to release the
      // session file, and prompt() is blocked until this hook returns.
      rt.core.manager
        .resumeDormant(dormant.id, mention.message, rt.revival.revivalContext(ctx, generation), {
          reviewTicket: issueExemptTicket("user-mention"),
        })
        .then(
          () => {
            if (generation === rt.state.revivalGeneration)
              ctx.ui.notify(`Resumed ${target}`, "info");
          },
          (error) => {
            if (generation !== rt.state.revivalGeneration) return;
            ctx.ui.notify(
              `Could not resume ${target}: ${error instanceof Error ? error.message : String(error)}`,
              "warning",
            );
          },
        );
      ctx.ui.notify(`Resuming ${target}\u2026`, "info");
      return { action: "handled" };
    }

    // Evicted, but its conversation is still on disk: reopen it. This is an
    // ordinary spawn carrying a session file, so the new record picks up the
    // widget, fleet row, transcript and completion notification unchanged —
    // and `reclaim` hands it back the names the tombstone was holding.
    if (resolved?.kind === "tombstone") {
      const entry = resolved.entry;
      const target = `@${entry.alias ?? entry.handle}`;

      // Checked here rather than left to SessionManager.open: that runs inside
      // runAgent, whose rejection lands on the record as an agent error, not in
      // the catch below. A `/new` in another pi window or a manual delete makes
      // the conversation unrecoverable (Claude Code's `not_reachable`), so drop
      // the entry — a row that can only ever fail is worse than none — and say
      // so rather than quietly sending this message to an unrelated agent.
      const sessionGeneration = rt.state.revivalGeneration;
      const sessionFileExists = await pathExists(entry.sessionFile);
      // Same as a failed refresh below: a session that changed meanwhile gets
      // the input back untouched.
      if (sessionGeneration !== rt.state.revivalGeneration) return { action: "continue" };
      if (!sessionFileExists) {
        rt.core.manager.dropTombstone(entry.handle);
        ctx.ui.notify(`Could not resume ${target} — its session is gone.`, "warning");
        return { action: "handled" };
      }

      // The Agent tool deliberately falls back to general-purpose for a type it
      // cannot resolve (#183), which covers a deleted file AND a merely
      // disabled one. A resume must not inherit that: reopening this
      // conversation under a different agent's prompt and tools is not
      // continuing it, and the new record would re-tombstone under the
      // substitute, so the handle would never find its way back.
      if (!(await rt.revival.refreshAgentsForSession())) return { action: "continue" };
      const dispatch = resolveSpawnType(entry.type);
      if (!dispatch.ok || dispatch.fellBackFrom !== undefined) {
        // The tombstone stays: re-enabling the agent makes the handle work
        // again, which a drop would foreclose.
        ctx.ui.notify(
          `Could not resume ${target} — the ${entry.type} agent is no longer available.`,
          "warning",
        );
        return { action: "handled" };
      }

      try {
        // spawnResolved, not spawnTopLevel: the latter strips
        // `resumeSessionFile` and `reclaim` as untrusted. This path is the
        // exception — both come from a tombstone this extension wrote.
        rt.registry.spawnResolved(pi, ctx, dispatch.type, mention.message, {
          description: entry.description,
          reclaim: { handle: entry.handle, alias: entry.alias },
          resumeSessionFile: entry.sessionFile,
          isBackground: true,
          reviewTicket: issueExemptTicket("user-mention"),
        });
        // The tombstone deliberately stays. `resolveMention` prefers the live
        // record holding these same names, so it cannot shadow the resume — and
        // if this run dies before establishing its own session, the original
        // transcript is still the right thing for the next mention to reopen.
        // Once the resumed record is evicted it overwrites this entry in place,
        // keyed by the same handle, so nothing accumulates.
        ctx.ui.notify(`Resuming ${target}`, "info");
      } catch (err) {
        // The type is already settled above, so what is left is a spawn-time
        // failure: a strict worktree-isolation error, an unusable cwd.
        ctx.ui.notify(
          `Could not resume ${target}: ${err instanceof Error ? err.message : String(err)}`,
          "warning",
        );
      }
      return { action: "handled" };
    }

    // No agent under that handle — but the name may still be an agent type, in
    // which case the mention starts one.
    // Reloaded first so an agent file added mid session is mentionable, and
    // the spawn below resolves against the same fresh registry.
    if (!(await rt.revival.refreshAgentsForSession())) return { action: "continue" };
    const typeHandle = mention.handle;
    const type =
      resolveHandleToType(typeHandle, getAvailableTypes()) ??
      (alias ? resolveHandleToType(alias, getAvailableTypes()) : undefined);
    if (!type) return { action: "continue" };

    // Claude Code never starts the agent itself: `@agent-<type>` becomes an
    // attachment asking the main model to do it, and the model writes the
    // agent's prompt from the conversation rather than forwarding the typed
    // text. That buys a real `Agent` tool call — transcript, per-tool widget
    // detail, tool-use-id correlation, join grouping — and a prompt with the
    // context a cold spawn lacks.
    //
    // It also costs a visible turn, spent narrating a decision the user already
    // made by typing the handle. So the turn is taken by a clone of this
    // conversation instead (mention-clone.ts): same messages, same system
    // prompt, off-screen, holding only the `Agent` tool. Nothing reaches the
    // chat, and what it starts is an ordinary top-level agent.
    if (rt.preferences.getAgentMentionMode() === "model") {
      const label = `@${handleBase(type)}`;
      // "Prompting", not "Starting": in this mode nothing starts until the
      // off-screen clone has taken a whole model turn writing the agent's
      // prompt, and that wait is the one thing the chat cannot show. `direct`
      // says "Started" because by then it has. The distinction tells the user
      // which of the two they are waiting on.
      ctx.ui.notify(`Prompting ${label}…`, "info");
      // Not awaited: the clone runs a full model turn, and prompt() is blocked
      // until this hook returns. The user gets their prompt back immediately
      // and the agent appears in the widget when it starts.
      const mentionCloneGeneration = rt.state.activeMentionCloneGeneration;
      void runMentionClone({
        ctx,
        type,
        message: mention.message,
        agentTool: rt.agentTool.agentTool,
      }).then((result) => {
        // The clone is detached. A shutdown or replacement invalidates the
        // captured pi/ctx pair, so decide by activation generation before
        // touching either session-bound object. Pi creates a fresh context
        // wrapper for every event, so object identity cannot represent a
        // session. This continuation is synchronous after the check, so
        // lifecycle handlers cannot interleave with the fallback.
        if (
          !shouldHandleMentionCloneCompletion(
            mentionCloneGeneration,
            rt.state.activeMentionCloneGeneration,
          ) ||
          result.spawned
        )
          return;
        // A clone that could not run must not swallow the mention: start the
        // agent the direct way rather than leaving the user with a toast and
        // nothing running.
        try {
          rt.registry.spawnTopLevel(pi, ctx, type, mention.message, {
            description: describeMention(mention.message),
            isBackground: true,
            reviewTicket: issueExemptTicket("user-mention"),
          });
          ctx.ui.notify(`Started ${label} directly — ${result.error}`, "warning");
        } catch (err) {
          ctx.ui.notify(
            `Could not start ${label}: ${err instanceof Error ? err.message : String(err)}`,
            "error",
          );
        }
      });
      return { action: "handled" };
    }

    try {
      // Nothing else to pass: runAgent resolves model, thinking and max turns
      // from the agent's own config when the spawn omits them, and the
      // manager's onStart/onComplete callbacks own the widget, the fleet list
      // and the completion notification — the same contract the scheduler and
      // cross-extension RPC spawns run under.
      rt.registry.spawnTopLevel(pi, ctx, type, mention.message, {
        description: describeMention(mention.message),
        isBackground: true,
        reviewTicket: issueExemptTicket("user-mention"),
      });
      ctx.ui.notify(`Started @${handleBase(type)}`, "info");
    } catch (err) {
      ctx.ui.notify(
        `Could not start @${handleBase(type)}: ${err instanceof Error ? err.message : String(err)}`,
        "error",
      );
    }
    return { action: "handled" };
  });

  return { mentionTypes };
}
