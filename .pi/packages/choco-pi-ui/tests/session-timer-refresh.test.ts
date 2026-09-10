import assert from "node:assert/strict";
import test from "node:test";
import { loadZentuiModule, SKIP_WITHOUT_ZENTUI } from "../../../../tests/zentui-build.ts";

type ZentuiModule = {
  createSessionTimerTick: (options: {
    needsTime: boolean;
    needsDuration: boolean;
    timeLabel: () => string;
    durationLabel: () => string;
    refresh: () => void;
  }) => () => void;
};

async function loadZentui(): Promise<ZentuiModule> {
  // SAFETY: `session-timer.js` is compiled from session-timer.ts and exports
  // `createSessionTimerTick`, matching the shape declared above.
  return (await loadZentuiModule("session-timer.js")) as ZentuiModule;
}

test(
  "session timer skips refreshes while rendered time is unchanged",
  { skip: SKIP_WITHOUT_ZENTUI },
  async () => {
    const { createSessionTimerTick } = await loadZentui();
    let label = "12:34";
    let refreshes = 0;
    const tick = createSessionTimerTick({
      needsTime: true,
      needsDuration: false,
      timeLabel: () => label,
      durationLabel: () => "",
      refresh: () => refreshes++,
    });

    tick();
    tick();
    tick();
    assert.equal(refreshes, 0);

    label = "12:35";
    tick();
    assert.equal(refreshes, 1);

    tick();
    assert.equal(refreshes, 1);
  },
);

test(
  "session timer refreshes when either rendered timer label changes",
  { skip: SKIP_WITHOUT_ZENTUI },
  async () => {
    const { createSessionTimerTick } = await loadZentui();
    let time = "12:34";
    let duration = "1m";
    let refreshes = 0;
    const tick = createSessionTimerTick({
      needsTime: true,
      needsDuration: true,
      timeLabel: () => time,
      durationLabel: () => duration,
      refresh: () => refreshes++,
    });

    duration = "2m";
    tick();
    time = "12:35";
    tick();
    tick();

    assert.equal(refreshes, 2);
  },
);
