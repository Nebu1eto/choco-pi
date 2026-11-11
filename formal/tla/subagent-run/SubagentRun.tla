------------------------------ MODULE SubagentRun ------------------------------
(***************************************************************************)
(* The subagent run lifecycle of AgentManager                               *)
(* (.pi/packages/choco-pi-subagents/src/agent-manager.ts): spawn, run to    *)
(* an outcome, usage-limit evaluation, park and wake at reset, user stop,   *)
(* foreground and background resume, deferred worktree cleanup, result      *)
(* publication, completion delivery and result reads.                       *)
(*                                                                         *)
(* One action is one stretch of synchronous code between two awaits. The   *)
(* README maps every variable and action to the code it stands for.        *)
(* Mutation names the deliberately broken variant being checked; "none" is *)
(* the code as it is.                                                      *)
(***************************************************************************)
EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS
    Agents,         \* record ids: keys of AgentManager.agents
    WT,             \* agents spawned with isolation "worktree"
    Full,           \* agents that use every caller action; the others only
                    \* spawn and resume in the background and are never read
    MaxGen,         \* bound on record.resultGeneration
    MaxConc,        \* getSchedulingMaxConcurrent()
    EnvCallbackMayThrow,       \* environment: the onComplete callback may throw
    VerdictRole,    \* agents subject to verdict recording (verdict task + verdict role)
    Mutation        \* "none", or the name of one mutation (see README)

ASSUME WT \subseteq Agents /\ Full \subseteq Agents /\ VerdictRole \subseteq Agents /\ MaxGen \in Nat \ {0} /\ MaxConc \in Nat \ {0}

Gens == 1..MaxGen
Terminal == {"done", "stopped"}
Live == {"running", "queued", "waiting"}
M(name) == Mutation = name
Throws == IF EnvCallbackMayThrow THEN BOOLEAN ELSE {FALSE}

VARIABLES
    rec,       \* per-agent AgentRecord fields plus manager maps keyed by id
    runs,      \* pending settle continuations (one per started run generation)
    queue,     \* AgentManager.queue
    pool,      \* AgentManager.runningBackground
    wakes,     \* wakeUsageLimited calls suspended at `await corroborateWithPolicy`
    switching, \* resume() calls suspended at `await applyResumeModel`
    later,     \* finishDeferredWorktreeThen callbacks waiting for worktree cleanup
    gh         \* ghost (history) state used only by the invariants

vars == <<rec, runs, queue, pool, wakes, switching, later, gh>>

-----------------------------------------------------------------------------
(* Ghost bookkeeping.                                                        *)

Bump(n) == IF n >= 2 THEN 2 ELSE n + 1

\* An outcome write (status, result, error) made on behalf of generation g.
GWrite(h, r, a, g) ==
    [h EXCEPT !.stale = @ \/ g # r[a].gen,
              !.postRead = @ \/ h.read[a] = g]

\* publishTerminal(record): publishes the record's CURRENT generation.
GPub(h, r, a, g) ==
    [h EXCEPT !.pubN[a][r[a].gen] = Bump(@), !.stale = @ \/ g # r[a].gen]

\* One completion delivery (onComplete call or inline return) for generation g.
GNtf(h, r, a, g) ==
    [h EXCEPT !.ntfN[a][g] = Bump(@), !.stale = @ \/ g # r[a].gen]

GRead(h, a, g) == [h EXCEPT !.read[a] = g]

-----------------------------------------------------------------------------
(* Helpers.                                                                  *)

Run(a, g, kind, pc, slot, caller) ==
    [a |-> a, g |-> g, kind |-> kind, pc |-> pc, slot |-> slot, wt |-> FALSE,
     caller |-> caller, path |-> "then", park |-> TRUE, dec |-> "none"]

SetRun(x, y) == (runs \ {x}) \cup {y}

\* usageEvaluationEligible(record, generation, runBudget)
Eligible(x) ==
    /\ rec[x.a].gen = x.g
    /\ rec[x.a].st # "stopped"
    /\ rec[x.a].cancel # x.g

\* ownsPreparedRun(record, generation)
Owns(x) == rec[x.a].gen = x.g /\ rec[x.a].cancel # x.g

\* resumeBlockedByRun(id, record)
Blocked(a) ==
    \/ rec[a].st \in {"running", "queued"}
    \/ (rec[a].pub # rec[a].gen /\ ~M("resumeIgnoresPublication"))
    \/ rec[a].resv

\* ownsUnsettledGeneration(record)
Unsettled(a) == rec[a].st \in {"running", "queued"} \/ rec[a].pub # rec[a].gen


\* startAgent's synchronous start (transition running, runningBackground++).
StartAgentFx(a, r, rs, p) ==
    LET bg == r[a].bg IN
    [rec  |-> [r EXCEPT ![a].st = "running", ![a].session = TRUE],
     runs |-> rs \cup {Run(a, r[a].gen, "spawn",
                           IF a \in WT THEN "prep" ELSE "runner",
                           bg, IF bg THEN "bg" ELSE "fg")},
     pool |-> IF bg THEN p + 1 ELSE p]

\* startResume's synchronous start.
StartResumeFx(a, r, rs, p) ==
    [rec  |-> [r EXCEPT ![a].st = "running"],
     runs |-> rs \cup {Run(a, r[a].gen, "bg", "runner", TRUE, "bg")},
     pool |-> p + 1]

\* drainQueue(): one synchronous loop.
RECURSIVE DrainLoop(_, _, _, _)
DrainLoop(q, r, rs, p) ==
    IF q = <<>> \/ p >= MaxConc
    THEN [q |-> q, rec |-> r, runs |-> rs, pool |-> p]
    ELSE LET e == Head(q) IN
         IF r[e.a].st # "queued"
         THEN DrainLoop(Tail(q), r, rs, p)
         ELSE LET s == IF e.kind = "spawn" THEN StartAgentFx(e.a, r, rs, p)
                                           ELSE StartResumeFx(e.a, r, rs, p)
              IN DrainLoop(Tail(q), s.rec, s.runs, s.pool)

Commit(d) == rec' = d.rec /\ runs' = d.runs /\ pool' = d.pool /\ queue' = d.q

\* queueBackgroundResume(): new generation, queued or started at once.
QueueBgFx(a, wake, r) ==
    LET r1 == [r EXCEPT ![a].bg = TRUE, ![a].gen = @ + 1, ![a].cancel = 0,
                        ![a].st = "queued"]
    IN IF pool >= MaxConc
       THEN [q |-> Append(queue, [a |-> a, kind |-> "resume", wake |-> wake]),
             rec |-> r1, runs |-> runs, pool |-> pool]
       ELSE LET s == StartResumeFx(a, r1, runs, pool)
            IN [q |-> queue, rec |-> s.rec, runs |-> s.runs, pool |-> s.pool]

\* parkForReset(): waiting_for_reset, usageWaits entry, wake timer armed.
ParkFx(r, a, g) ==
    [r EXCEPT ![a].st = "waiting", ![a].bg = TRUE, ![a].waitG = g,
              ![a].timer = TRUE]

\* settleParked(record, wait, outcome): returns [rec, later, gh].
\* finishDeferredWorktreeThen owes an asynchronous step before publication:
\* a deferred worktree cleanup, or the verdict record of a verdict-role run.
Owed(a) == rec[a].defWT \/ a \in VerdictRole

SettleParkedFx(a, status, cancel, notify) ==
    LET g  == rec[a].gen
        r1 == [rec EXCEPT ![a].timer = FALSE, ![a].waitG = 0, ![a].st = status,
                          ![a].cancel = IF cancel THEN g ELSE @,
                          ![a].defWT = FALSE]
        h1 == GWrite(gh, rec, a, g)
    IN IF Owed(a) /\ M("parkedPublishBeforeCleanup")
       THEN \* mutation: publish now, let the cleanup write the result later
            [rec |-> [r1 EXCEPT ![a].pub = g], gh |-> GPub(h1, rec, a, g),
             later |-> later \cup {[a |-> a, g |-> g, what |-> "early",
                                    notify |-> notify]}]
       ELSE IF Owed(a)
       THEN [rec |-> r1, gh |-> h1,
             later |-> later \cup {[a |-> a, g |-> g, what |-> "parked",
                                    notify |-> notify]}]
       ELSE [rec |-> [r1 EXCEPT ![a].pub = g], later |-> later,
             gh |-> IF notify THEN GNtf(GPub(h1, rec, a, g), rec, a, g)
                              ELSE GPub(h1, rec, a, g)]

-----------------------------------------------------------------------------
(* Environment and caller actions.                                           *)

Init ==
    /\ rec = [a \in Agents |->
                [st |-> "none", gen |-> 0, pub |-> 0, cancel |-> 0, bg |-> FALSE,
                 session |-> FALSE, waitG |-> 0, timer |-> FALSE, wakeGen |-> 0,
                 defWT |-> FALSE, resv |-> FALSE, consumed |-> 0]]
    /\ runs = {}
    /\ queue = <<>>
    /\ pool = 0
    /\ wakes = {}
    /\ switching = {}
    /\ later = {}
    /\ gh = [sticky |-> [a \in Agents |-> FALSE],
             pubN |-> [a \in Agents |-> [g \in Gens |-> 0]],
             ntfN |-> [a \in Agents |-> [g \in Gens |-> 0]],
             read |-> [a \in Agents |-> 0],
             stale |-> FALSE, postRead |-> FALSE]

\* spawn() / spawnAndWait() -> spawnWith(): queue a background spawn at the
\* limit, otherwise startAgent() synchronously.
Spawn(a, fg) ==
    /\ rec[a].st = "none"
    /\ fg => a \in Full
    /\ LET r1 == [rec EXCEPT ![a].gen = 1, ![a].bg = ~fg, ![a].st = "queued"] IN
       IF ~fg /\ pool >= MaxConc
       THEN /\ rec' = r1
            /\ queue' = Append(queue, [a |-> a, kind |-> "spawn", wake |-> FALSE])
            /\ UNCHANGED <<runs, pool>>
       ELSE LET s == StartAgentFx(a, r1, runs, pool) IN
            /\ rec' = s.rec /\ runs' = s.runs /\ pool' = s.pool
            /\ UNCHANGED queue
    /\ UNCHANGED <<wakes, switching, later, gh>>

\* abort(id) -> stopRecord(record, true).
Stop(a) ==
    /\ rec[a].st \in Live
    /\ UNCHANGED <<wakes, switching>>
    /\ CASE rec[a].st = "waiting" ->
            LET s == SettleParkedFx(a, "stopped", TRUE, TRUE) IN
            /\ rec' = s.rec /\ later' = s.later
            /\ gh' = [s.gh EXCEPT !.sticky[a] = TRUE]
            /\ UNCHANGED <<runs, queue, pool>>
         [] rec[a].st = "queued" ->
            LET g    == rec[a].gen
                wake == \E i \in 1..Len(queue) : queue[i].a = a /\ queue[i].wake
                Keep(e) == e.a # a
                \* A post-reset continuation publishes through its finalizer;
                \* any other queued record through publishStoppedQueued: now,
                \* or for a verdict-role run after its verdict record
                \* (mutations: the old code published a continuation at once;
                \* verdictLineAfterPublish appends the line after publishing).
                verdictQ == ~wake /\ a \in VerdictRole
                pubNow   == IF wake
                            THEN M("droppedWakePublishesEarly") \/ M("droppedWakeRepublishes")
                            ELSE IF verdictQ THEN M("verdictLineAfterPublish")
                            ELSE ~M("stopQueuedNoPublish")
                \* settleDroppedWake's callback publishes, after the cleanup
                pubLater == wake /\ ~M("droppedWakePublishesEarly")
                r1   == [rec EXCEPT ![a].st = "stopped", ![a].cancel = g,
                                    ![a].pub = IF pubNow THEN g ELSE @]
                h0   == [GWrite(gh, rec, a, g) EXCEPT !.sticky[a] = TRUE]
                h1   == IF pubNow THEN GPub(h0, rec, a, g) ELSE h0
            IN /\ queue' = SelectSeq(queue, Keep)
               /\ UNCHANGED <<runs, pool>>
               /\ IF wake
                  THEN \* entry.finalize(true) -> settleDroppedWake()
                       IF Owed(a)
                       THEN /\ rec' = [r1 EXCEPT ![a].wakeGen = IF @ = g THEN 0 ELSE @,
                                                 ![a].defWT = FALSE]
                            /\ later' = later \cup
                                  {[a |-> a, g |-> g, notify |-> TRUE,
                                    what |-> IF pubLater THEN "dropped" ELSE "early"]}
                            /\ gh' = h1
                       ELSE \* nothing deferred: the callback runs at once
                            /\ rec' = [r1 EXCEPT ![a].wakeGen = IF @ = g THEN 0 ELSE @,
                                                 ![a].pub = IF pubLater THEN g ELSE @]
                            /\ gh' = GNtf(IF pubLater THEN GPub(h1, rec, a, g) ELSE h1,
                                          rec, a, g)
                            /\ UNCHANGED later
                  ELSE IF verdictQ
                  THEN /\ rec' = r1 /\ gh' = h1
                       \* published later, so the stop was reported pending: it notifies
                       \* once (the mutation published at once and so never notifies)
                       /\ later' = later \cup
                             {[a |-> a, g |-> g, notify |-> ~M("verdictLineAfterPublish"),
                               what |-> IF M("verdictLineAfterPublish") THEN "early" ELSE "queued"]}
                  ELSE /\ rec' = r1 /\ gh' = h1
                       /\ UNCHANGED later
         [] rec[a].st = "running" ->
            /\ rec' = [rec EXCEPT ![a].st = "stopped", ![a].cancel = rec[a].gen]
            /\ gh' = [GWrite(gh, rec, a, rec[a].gen) EXCEPT !.sticky[a] = TRUE]
            /\ UNCHANGED <<runs, queue, pool, later>>

\* resume(): the synchronous start after all checks (foreground or background).
ResumeStartFx(a, mode, r) ==
    LET r1 == [r EXCEPT ![a].wakeGen = 0] IN
    IF mode = "bg"
    THEN QueueBgFx(a, FALSE, r1)
    ELSE [q |-> queue,
          rec |-> [r1 EXCEPT ![a].gen = @ + 1, ![a].st = "running", ![a].cancel = 0],
          runs |-> runs \cup {Run(a, r[a].gen + 1, "fg", "runner", FALSE, "fg")},
          pool |-> pool]

\* resume(id, prompt, signal, options): entry checks; with a model switch it
\* reserves the record and awaits applyResumeModel.
Resume(a, mode, withModel) ==
    /\ rec[a].session
    /\ a \notin Full => mode = "bg" /\ ~withModel
    /\ ~Blocked(a)
    /\ rec[a].gen < MaxGen
    /\ UNCHANGED <<wakes, later>>
    /\ IF withModel
       THEN /\ rec' = [rec EXCEPT ![a].resv = TRUE]
            /\ switching' = switching \cup {[a |-> a, g |-> rec[a].gen, mode |-> mode]}
            /\ UNCHANGED <<runs, queue, pool, gh>>
       ELSE /\ Commit(ResumeStartFx(a, mode, rec))
            /\ gh' = [gh EXCEPT !.sticky[a] = FALSE]
            /\ UNCHANGED switching

\* resume() after `await applyResumeModel`: finally releases the reservation,
\* then rechecks the generation and ownsUnsettledGeneration.
SwitchDone(s, ok) ==
    /\ s \in switching
    /\ switching' = switching \ {s}
    /\ UNCHANGED <<wakes, later>>
    /\ LET r0 == [rec EXCEPT ![s.a].resv = FALSE] IN
       IF ok /\ rec[s.a].gen = s.g /\ ~Unsettled(s.a) /\ rec[s.a].gen < MaxGen
       THEN /\ Commit(ResumeStartFx(s.a, s.mode, r0))
            /\ gh' = [gh EXCEPT !.sticky[s.a] = FALSE]
       ELSE /\ rec' = r0
            /\ UNCHANGED <<runs, queue, pool, gh>>

\* claimSubagentResultRead(): a terminal claim (get_subagent_result).
ReadResult(a) ==
    /\ a \in Full
    /\ rec[a].st \in Terminal
    /\ rec[a].pub = rec[a].gen
    /\ rec[a].consumed # rec[a].gen
    /\ rec' = [rec EXCEPT ![a].consumed = rec[a].gen]
    /\ gh' = GRead(gh, a, rec[a].gen)
    /\ UNCHANGED <<runs, queue, pool, wakes, switching, later>>

\* The wake timer fires: wakeUsageLimited() up to `await corroborateWithPolicy`.
WakeFire(a) ==
    /\ rec[a].timer
    /\ rec' = [rec EXCEPT ![a].timer = FALSE]
    /\ wakes' = IF rec[a].st = "waiting" /\ rec[a].gen = rec[a].waitG
                THEN wakes \cup {[a |-> a, g |-> rec[a].waitG]}
                ELSE wakes
    /\ UNCHANGED <<runs, queue, pool, switching, later, gh>>

\* isCurrentWait(record, wait)
CurrentWait(w) ==
    /\ rec[w.a].waitG = w.g
    /\ rec[w.a].st = "waiting"
    /\ rec[w.a].gen = w.g

\* wakeUsageLimited() after corroboration: resumeAfterReset (ready), re-arm
\* (not ready), or settleParked as an error (auto-resume gave up).
WakeDone(w, res) ==
    /\ w \in wakes
    /\ wakes' = wakes \ {w}
    /\ res = "ready" => rec[w.a].gen < MaxGen
    /\ UNCHANGED switching
    /\ IF ~CurrentWait(w) /\ ~M("noWakeRecheck")
       THEN UNCHANGED <<rec, runs, queue, pool, later, gh>>
       ELSE CASE res = "ready" ->
                 \* resumeAfterReset(): delete the wait, mark the wake run, queue.
                 LET r1 == [rec EXCEPT ![w.a].waitG = 0, ![w.a].wakeGen = rec[w.a].gen + 1]
                 IN /\ Commit(QueueBgFx(w.a, TRUE, r1))
                    /\ UNCHANGED <<later, gh>>
              [] res = "notReady" ->
                 /\ rec' = [rec EXCEPT ![w.a].timer = ~M("noRearm")]
                 /\ UNCHANGED <<runs, queue, pool, later, gh>>
              [] res = "giveUp" ->
                 LET s == SettleParkedFx(w.a, "done", FALSE, TRUE) IN
                 /\ rec' = s.rec /\ later' = s.later /\ gh' = s.gh
                 /\ UNCHANGED <<runs, queue, pool>>

\* finishDeferredWorktreeThen(): the owed steps settled (the deferred cleanup
\* appended the retained-worktree notice to record.result; a verdict-role run's
\* verdict line was appended to it: both outcome writes); run `publish`.
\* "parked" (settleParked), "dropped" (settleDroppedWake) and "queued"
\* (publishStoppedQueued) then publish, and notify when asked. "early" exists
\* only in mutations: the result was published before the owed write.
Later(l) ==
    /\ l \in later
    /\ later' = later \ {l}
    /\ UNCHANGED <<runs, queue, pool, wakes, switching>>
    /\ LET a == l.a IN
       IF l.what \in {"parked", "dropped", "queued"}
       THEN /\ rec' = [rec EXCEPT ![a].pub = rec[a].gen]
            /\ gh' = LET h1 == GPub(GWrite(gh, rec, a, l.g), rec, a, l.g)
                     IN IF l.notify THEN GNtf(h1, rec, a, l.g) ELSE h1
       ELSE /\ UNCHANGED rec
            /\ gh' = LET h1 == GWrite(gh, rec, a, l.g)
                     IN IF l.notify THEN GNtf(h1, rec, a, l.g) ELSE h1

-----------------------------------------------------------------------------
(* Run continuations. x.kind: "spawn" = startAgent's promise chain,          *)
(* "fg" = resume()'s inline resumePromise, "bg" = startResume's chain.       *)

\* settleStaleRun() (spawn and background resume `finally`), or a plain return.
StaleReturn(x) ==
    IF x.kind = "fg"
    THEN /\ runs' = runs \ {x}
         /\ UNCHANGED <<rec, queue, pool, gh>>
    ELSE /\ Commit(DrainLoop(queue, rec, runs \ {x}, IF x.slot THEN pool - 1 ELSE pool))
         /\ UNCHANGED gh

\* startAgent's settle tail after the verdict await (.then or .catch):
\* generation check, transition unless stopped, publishTerminal, onComplete
\* (contained by try/catch on both paths), slot release, drainQueue.
SpawnFinal(x, path, throws) ==
    LET a  == x.a
        rs == runs \ {x}
    IN IF rec[a].gen # x.g /\ ~M("noFinalGenCheck")
       THEN StaleReturn(x)
       ELSE LET r1 == [rec EXCEPT ![a].st = IF @ = "stopped" THEN "stopped" ELSE "done",
                                  ![a].pub = rec[a].gen]
                h1 == GNtf(GPub(GWrite(gh, rec, a, x.g), rec, a, x.g), rec, a, x.g)
            IN IF x.caller = "bg"
               THEN LET p1 == IF x.slot THEN pool - 1 ELSE pool
                        \* mutation: the pre-fix .catch path let a throwing
                        \* onComplete escape, skipping drainQueue (scan S2)
                        d == IF throws /\ path = "catch" /\ M("catchCallbackUncontained")
                             THEN [q |-> queue, rec |-> r1, runs |-> rs, pool |-> p1]
                             ELSE DrainLoop(queue, r1, rs, p1)
                    IN Commit(d) /\ gh' = h1
               ELSE /\ rec' = [r1 EXCEPT ![a].consumed = rec[a].gen]
                    /\ runs' = rs
                    /\ UNCHANGED <<queue, pool>>
                    /\ gh' = GRead(h1, a, rec[a].gen)

\* Spawn park branch: deferredWorktrees, releaseRunPoolSlot, parkForReset, drainQueue.
SpawnPark(x) ==
    LET a  == x.a
        r1 == ParkFx([rec EXCEPT ![a].defWT = IF x.wt THEN TRUE ELSE @], a, x.g)
        p1 == IF x.slot /\ ~M("parkKeepsSlot") THEN pool - 1 ELSE pool
    IN /\ Commit(DrainLoop(queue, r1, runs \ {x}, p1))
       /\ gh' = GWrite(gh, rec, a, x.g)

\* resume() inline settle after the verdict await: transition,
\* markTerminalConsumed (the result is returned inline).
FgFinal(x) ==
    LET a == x.a IN
    /\ rec' = [rec EXCEPT ![a].st = IF rec[a].cancel = x.g THEN "stopped" ELSE "done",
                          ![a].pub = rec[a].gen, ![a].consumed = rec[a].gen]
    /\ runs' = runs \ {x}
    /\ gh' = GRead(GNtf(GPub(GWrite(gh, rec, a, x.g), rec, a, x.g), rec, a, x.g), a, rec[a].gen)
    /\ UNCHANGED <<queue, pool>>

\* startResume settle: transition unless stopped, record.result, then
\* `await finishDeferredWorktree` (which takes the deferred cleanup at once).
BgPreFdw(x) ==
    LET a == x.a IN
    /\ rec' = [rec EXCEPT ![a].st = IF @ = "stopped" THEN "stopped" ELSE "done",
                          ![a].defWT = FALSE]
    /\ runs' = SetRun(x, [x EXCEPT !.pc = "fdw"])
    /\ gh' = GWrite(gh, rec, a, x.g)
    /\ UNCHANGED <<queue, pool>>

\* startResume after the verdict await: generation check, publishTerminal,
\* settle() (onComplete contained, slot release, drainQueue).
BgFinal(x) ==
    LET a == x.a IN
    IF rec[a].gen # x.g /\ ~M("noFinalGenCheck")
    THEN StaleReturn(x)
    ELSE LET r1 == [rec EXCEPT ![a].pub = rec[a].gen,
                               ![a].wakeGen = IF @ = x.g THEN 0 ELSE @]
         IN /\ Commit(DrainLoop(queue, r1, runs \ {x}, IF x.slot THEN pool - 1 ELSE pool))
            /\ gh' = GNtf(GPub(gh, rec, a, x.g), rec, a, x.g)

\* The settle tail that follows the verdict point, for run x taking `path`.
Finish(x, path, throws) ==
    /\ (throws => x.kind = "spawn" /\ x.caller = "bg")
    /\ CASE x.kind = "spawn" -> SpawnFinal(x, path, throws)
         [] x.kind = "fg" ->
            IF rec[x.a].gen # x.g /\ ~M("noFinalGenCheck") THEN StaleReturn(x) ELSE FgFinal(x)
         [] x.kind = "bg" -> BgFinal(x)

\* The verdict point. A verdict-role run (recordsVerdict: verdict task and
\* verdict role) suspends at `await this.recordRunVerdict(...)`; any other run
\* goes straight on in the same step (no await, so no interleaving point).
ToVerdict(x, path) ==
    IF x.a \in VerdictRole
    THEN /\ runs' = SetRun(x, [x EXCEPT !.pc = "verdict", !.path = path])
         /\ UNCHANGED <<rec, queue, pool, gh>>
    ELSE \E th \in Throws : Finish(x, path, th)

\* The runner promise settles (runAgent / resumeAgent). For "ok" and "quota"
\* the handler runs up to `await evaluateRunUsageLimit` (for a quota failure:
\* inside evaluateUsageLimit, up to `await preferenceFromPolicy`). "reject"
\* is a rejection (or, on the spawn path, an aborted run, which skips the
\* evaluation): the .catch handler runs up to its first await.
RunnerReturns(x, out) ==
    /\ x \in runs
    /\ x.pc = "runner"
    /\ UNCHANGED <<wakes, switching, later>>
    /\ CASE out = "reject" /\ x.kind = "spawn" ->
            IF x.wt
            THEN /\ runs' = SetRun(x, [x EXCEPT !.pc = "cleanup", !.path = "catch"])
                 /\ UNCHANGED <<rec, queue, pool, gh>>
            ELSE ToVerdict(x, "catch")
         [] out = "reject" /\ x.kind = "fg" ->
            IF rec[x.a].gen # x.g THEN StaleReturn(x) ELSE ToVerdict(x, "catch")
         [] out = "reject" /\ x.kind = "bg" ->
            IF rec[x.a].gen # x.g THEN StaleReturn(x) ELSE BgPreFdw(x)
         [] OTHER ->
            LET park == IF x.kind = "bg" THEN rec[x.a].wakeGen # x.g ELSE TRUE
                pc   == IF out = "quota" /\ Eligible(x) THEN "pref" ELSE "caller"
            IN /\ runs' = SetRun(x, [x EXCEPT !.pc = pc, !.park = park, !.dec = "none"])
               /\ UNCHANGED <<rec, queue, pool, gh>>

\* startAgent prepareRun after `await createWorktree`: ownsPreparedRun, or
\* remove the fresh copy (await) and throw into .catch.
PrepDone(x) ==
    /\ x \in runs
    /\ x.pc = "prep"
    /\ runs' = SetRun(x, IF Owns(x)
                         THEN [x EXCEPT !.pc = "runner", !.wt = TRUE]
                         ELSE [x EXCEPT !.pc = "unwind", !.path = "catch"])
    /\ UNCHANGED <<rec, queue, pool, wakes, switching, later, gh>>

\* After removing an unowned fresh worktree: .catch with no record.worktree,
\* up to the verdict await.
Unwind(x) ==
    /\ x \in runs
    /\ x.pc = "unwind"
    /\ ToVerdict(x, "catch")
    /\ UNCHANGED <<wakes, switching, later>>

\* evaluateUsageLimit after `await preferenceFromPolicy`: eligible(), then
\* `await corroborateWithPolicy`.
Pref(x) ==
    /\ x \in runs
    /\ x.pc = "pref"
    /\ runs' = SetRun(x, [x EXCEPT !.pc = IF Eligible(x) \/ M("noInnerEvalChecks")
                                         THEN "corr" ELSE "evalRet"])
    /\ UNCHANGED <<rec, queue, pool, wakes, switching, later, gh>>

\* evaluateUsageLimit after corroboration: eligible(), decide park
\* (allowPark, auto-resume, quota, confirmed), return.
Corr(x, confirmed) ==
    /\ x \in runs
    /\ x.pc = "corr"
    /\ runs' = SetRun(x, [x EXCEPT !.pc = "evalRet",
                          !.dec = IF (Eligible(x) \/ M("noInnerEvalChecks")) /\ x.park /\ confirmed
                                  THEN "park" ELSE "none"])
    /\ UNCHANGED <<rec, queue, pool, wakes, switching, later, gh>>

\* evaluateRunUsageLimit after `await this.evaluateUsageLimit`: final eligible().
EvalRet(x) ==
    /\ x \in runs
    /\ x.pc = "evalRet"
    /\ runs' = SetRun(x, [x EXCEPT !.pc = "caller",
                          !.dec = IF x.dec = "park" /\ (Eligible(x) \/ M("noEvalReturnCheck"))
                                  THEN "park" ELSE "none"])
    /\ UNCHANGED <<rec, queue, pool, wakes, switching, later, gh>>

\* The caller resumes after `await this.evaluateRunUsageLimit(...)`:
\* currentUsageDecision, then park or continue to settle.
Caller(x) ==
    /\ x \in runs
    /\ x.pc = "caller"
    /\ UNCHANGED <<wakes, switching, later>>
    /\ LET a    == x.a
           park == x.dec = "park" /\ (Eligible(x) \/ M("noCallerRecheck"))
       IN CASE x.kind = "spawn" ->
               IF park THEN SpawnPark(x)
               ELSE IF x.wt
                    THEN /\ runs' = SetRun(x, [x EXCEPT !.pc = "cleanup"])
                         /\ UNCHANGED <<rec, queue, pool, gh>>
                    ELSE ToVerdict(x, "then")
            [] x.kind = "fg" ->
               IF rec[a].gen # x.g THEN StaleReturn(x)
               ELSE IF park
                    THEN /\ rec' = ParkFx(rec, a, x.g)
                         /\ runs' = runs \ {x}
                         /\ gh' = GWrite(gh, rec, a, x.g)
                         /\ UNCHANGED <<queue, pool>>
                    ELSE ToVerdict(x, "then")
            [] x.kind = "bg" ->
               IF rec[a].gen # x.g THEN StaleReturn(x)
               ELSE IF park
                    THEN LET p1 == IF x.slot /\ ~M("parkKeepsSlot") THEN pool - 1 ELSE pool
                         IN /\ Commit(DrainLoop(queue, ParkFx(rec, a, x.g), runs \ {x}, p1))
                            /\ gh' = GWrite(gh, rec, a, x.g)
                    ELSE BgPreFdw(x)

\* startAgent after `await cleanupWorktree` / `removeHookWorktree`: generation check.
Cleanup(x) ==
    /\ x \in runs
    /\ x.pc = "cleanup"
    /\ UNCHANGED <<wakes, switching, later>>
    /\ IF rec[x.a].gen # x.g THEN StaleReturn(x) ELSE ToVerdict(x, x.path)

\* startResume after `await finishDeferredWorktree`: generation check.
Fdw(x) ==
    /\ x \in runs
    /\ x.pc = "fdw"
    /\ UNCHANGED <<wakes, switching, later>>
    /\ IF rec[x.a].gen # x.g THEN StaleReturn(x) ELSE ToVerdict(x, x.path)

\* After `await this.recordRunVerdict(...)` (verdict-role runs only).
Verdict(x, throws) ==
    /\ x \in runs
    /\ x.pc = "verdict"
    /\ UNCHANGED <<wakes, switching, later>>
    /\ Finish(x, x.path, throws)

-----------------------------------------------------------------------------

\* Named steps, so TLC traces show which action was taken.
DoSpawn == \E a \in Agents, fg \in BOOLEAN : Spawn(a, fg)
DoStop == \E a \in Agents : Stop(a)
DoWakeFire == \E a \in Agents : WakeFire(a)
DoReadResult == \E a \in Agents : ReadResult(a)
DoResume == \E a \in Agents, mode \in {"fg", "bg"}, wm \in BOOLEAN : Resume(a, mode, wm)
DoSwitchDone == \E s \in switching, ok \in BOOLEAN : SwitchDone(s, ok)
DoWakeDone == \E w \in wakes, res \in {"ready", "notReady", "giveUp"} : WakeDone(w, res)
DoLater == \E l \in later : Later(l)
DoRunnerReturns == \E x \in runs, out \in {"ok", "quota", "reject"} : RunnerReturns(x, out)
DoPrepDone == \E x \in runs : PrepDone(x)
DoUnwind == \E x \in runs : Unwind(x)
DoPref == \E x \in runs : Pref(x)
DoCorr == \E x \in runs, c \in BOOLEAN : Corr(x, c)
DoEvalRet == \E x \in runs : EvalRet(x)
DoCaller == \E x \in runs : Caller(x)
DoCleanup == \E x \in runs : Cleanup(x)
DoFdw == \E x \in runs : Fdw(x)
DoVerdict == \E x \in runs, th \in Throws : Verdict(x, th)

Next ==
    \/ DoSpawn \/ DoStop \/ DoWakeFire \/ DoReadResult \/ DoResume \/ DoSwitchDone
    \/ DoWakeDone \/ DoLater \/ DoRunnerReturns \/ DoPrepDone \/ DoUnwind \/ DoPref
    \/ DoCorr \/ DoEvalRet \/ DoCaller \/ DoCleanup \/ DoFdw \/ DoVerdict

Spec == Init /\ [][Next]_vars

-----------------------------------------------------------------------------
(* Invariants.                                                                *)

TypeOK ==
    /\ \A a \in Agents :
          /\ rec[a].st \in {"none", "queued", "running", "waiting", "done", "stopped"}
          /\ rec[a].gen \in 0..MaxGen /\ rec[a].pub \in 0..MaxGen
    /\ pool \in Nat
    /\ Len(queue) <= 2 * Cardinality(Agents)

\* A user stop is never undone: until the user explicitly resumes the agent,
\* it is not running, queued, or parked again.
StopSticks == \A a \in Agents : gh.sticky[a] => rec[a].st \notin Live

\* Each generation is published at most once and its completion is delivered
\* (onComplete or inline return) at most once.
PublishOnce ==
    \A a \in Agents, g \in Gens : gh.pubN[a][g] <= 1 /\ gh.ntfN[a][g] <= 1

\* Once nothing is pending for a terminal record, its generation is published.
SettledIsPublished ==
    \A a \in Agents :
       (/\ rec[a].st \in Terminal
        /\ ~(\E x \in runs : x.a = a)
        /\ ~(\E l \in later : l.a = a))
       => rec[a].pub = rec[a].gen

\* Code acting for a superseded generation never writes the outcome,
\* publishes, or delivers a completion.
StaleInert == ~gh.stale

\* A result that was read (or returned inline) is never changed afterwards.
ReadSeesFinal == ~gh.postRead

\* A parked record always has a wake pending: an armed timer or a wake in flight.
ParkedHasWake ==
    \A a \in Agents :
       rec[a].st = "waiting" =>
          /\ rec[a].waitG = rec[a].gen
          /\ (rec[a].timer \/ [a |-> a, g |-> rec[a].gen] \in wakes)

\* runningBackground counts exactly the runs holding a pool slot.
PoolExact == pool = Cardinality({x \in runs : x.slot}) /\ pool <= MaxConc

\* No queued record is stranded while a pool slot is free.
QueueProgress ==
    pool < MaxConc => \A i \in 1..Len(queue) : rec[queue[i].a].st # "queued"

=============================================================================
