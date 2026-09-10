type SessionTimerTickOptions = {
  needsTime: boolean;
  needsDuration: boolean;
  timeLabel: () => string;
  durationLabel: () => string;
  refresh: () => void;
};

export function createSessionTimerTick(options: SessionTimerTickOptions): () => void {
  const displayedValue = () =>
    JSON.stringify([
      options.needsTime ? options.timeLabel() : "",
      options.needsDuration ? options.durationLabel() : "",
    ]);
  let lastDisplayedValue = displayedValue();
  return () => {
    const nextDisplayedValue = displayedValue();
    if (nextDisplayedValue === lastDisplayedValue) return;
    lastDisplayedValue = nextDisplayedValue;
    options.refresh();
  };
}
