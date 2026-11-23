export interface SseEvent {
  event: string | undefined;
  data: string;
}

export class SseParser {
  #buffer = "";
  #data: string[] = [];
  #event: string | undefined;
  #hasData = false;

  push(text: string): SseEvent[] {
    this.#buffer += text;
    return this.#drain(false);
  }

  end(): SseEvent[] {
    return this.#drain(true);
  }

  #drain(final: boolean): SseEvent[] {
    const events: SseEvent[] = [];
    let start = 0;
    const buffer = this.#buffer;
    for (let index = 0; index < buffer.length; index += 1) {
      const char = buffer[index];
      if (char !== "\n" && char !== "\r") continue;
      if (char === "\r" && index === buffer.length - 1 && !final) break;
      this.#line(buffer.slice(start, index), events);
      if (char === "\r" && buffer[index + 1] === "\n") index += 1;
      start = index + 1;
    }
    this.#buffer = buffer.slice(start);
    if (final) {
      if (this.#buffer !== "") this.#line(this.#buffer, events);
      this.#buffer = "";
      this.#dispatch(events);
    }
    return events;
  }

  #line(line: string, events: SseEvent[]): void {
    if (line === "") {
      this.#dispatch(events);
      return;
    }
    if (line.startsWith(":")) return;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") {
      this.#data.push(value);
      this.#hasData = true;
    } else if (field === "event") {
      this.#event = value;
    }
  }

  #dispatch(events: SseEvent[]): void {
    if (this.#hasData) events.push({ event: this.#event, data: this.#data.join("\n") });
    this.#data = [];
    this.#hasData = false;
    this.#event = undefined;
  }
}
