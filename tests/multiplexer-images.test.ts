import assert from "node:assert/strict";
import test from "node:test";
import type { TerminalCapabilities } from "@earendil-works/pi-tui";
import {
  applyMultiplexerImagePolicy,
  detectMultiplexer,
  readImageProtocolPreference,
  resolveImageProtocol,
} from "../.pi/extensions/lib/multiplexer-images.ts";

const GHOSTTY = { TERM: "xterm-ghostty" };
const GHOSTTY_IN_ZELLIJ = { TERM: "xterm-ghostty", ZELLIJ: "0", ZELLIJ_SESSION_NAME: "Main" };

const kittyCapabilities: TerminalCapabilities = {
  images: "kitty",
  trueColor: true,
  hyperlinks: true,
};

test("Zellij is detected from its own variables, not from terminal identity", () => {
  assert.equal(detectMultiplexer(GHOSTTY), null);
  assert.equal(detectMultiplexer(GHOSTTY_IN_ZELLIJ), "zellij");
  assert.equal(detectMultiplexer({ TERM: "xterm-ghostty", ZELLIJ: "0" }), "zellij");
  assert.equal(detectMultiplexer({ TERM: "xterm-ghostty", ZELLIJ_SESSION_NAME: "Main" }), "zellij");
  assert.equal(detectMultiplexer({ TERM: "screen-256color" }), "screen");
  assert.equal(
    detectMultiplexer({ TERM: "xterm-256color", TMUX: "/tmp/tmux-501/default,1,0" }),
    "tmux",
  );
});

test("Ghostty keeps Kitty images on its own and under Zellij 0.45+", () => {
  assert.equal(resolveImageProtocol("kitty", GHOSTTY), "kitty");
  assert.equal(resolveImageProtocol("kitty", GHOSTTY_IN_ZELLIJ), null);
  assert.equal(resolveImageProtocol("kitty", GHOSTTY_IN_ZELLIJ, [0, 45, 0]), "kitty");
  assert.equal(resolveImageProtocol("kitty", GHOSTTY_IN_ZELLIJ, [0, 46, 1]), "kitty");
  assert.equal(resolveImageProtocol("kitty", GHOSTTY_IN_ZELLIJ, [0, 44, 0]), null);
  assert.equal(resolveImageProtocol("kitty", GHOSTTY_IN_ZELLIJ, null), null);
});

test("iTerm2 inline images are dropped under a multiplexer too", () => {
  assert.equal(resolveImageProtocol("iterm2", { TERM: "xterm-256color" }), "iterm2");
  assert.equal(resolveImageProtocol("iterm2", { ZELLIJ: "0" }), null);
  assert.equal(resolveImageProtocol("iterm2", { ZELLIJ: "0" }, [0, 45, 0]), null);
});

test("a terminal without image support is left alone", () => {
  assert.equal(resolveImageProtocol(null, GHOSTTY), null);
  assert.equal(resolveImageProtocol(null, GHOSTTY_IN_ZELLIJ), null);
});

test("CHOCO_PI_IMAGE_PROTOCOL overrides the Zellij policy in both directions", () => {
  const forced = { ...GHOSTTY_IN_ZELLIJ, CHOCO_PI_IMAGE_PROTOCOL: "kitty" };
  assert.equal(resolveImageProtocol("kitty", forced), "kitty");
  assert.equal(resolveImageProtocol(null, forced), "kitty");

  assert.equal(
    resolveImageProtocol("kitty", { ...GHOSTTY, CHOCO_PI_IMAGE_PROTOCOL: "none" }),
    null,
  );
  assert.equal(resolveImageProtocol("kitty", { ...GHOSTTY, CHOCO_PI_IMAGE_PROTOCOL: "off" }), null);
  assert.equal(
    resolveImageProtocol("kitty", { ...GHOSTTY, CHOCO_PI_IMAGE_PROTOCOL: "iterm2" }),
    "iterm2",
  );
});

test("the escape hatch is forgiving about spelling", () => {
  assert.deepEqual(readImageProtocolPreference(undefined), { kind: "auto" });
  assert.deepEqual(readImageProtocolPreference(""), { kind: "auto" });
  assert.deepEqual(readImageProtocolPreference("auto"), { kind: "auto" });
  assert.deepEqual(readImageProtocolPreference("nonsense"), { kind: "auto" });
  assert.deepEqual(readImageProtocolPreference("  Kitty \n"), { kind: "force", protocol: "kitty" });
});

test("only the image protocol is rewritten, so the fallback keeps its hyperlink", () => {
  const patched = applyMultiplexerImagePolicy(kittyCapabilities, GHOSTTY_IN_ZELLIJ);
  assert.deepEqual(patched, { images: null, trueColor: true, hyperlinks: true });
});

test("capabilities are left untouched when detection already agrees", () => {
  assert.equal(applyMultiplexerImagePolicy(kittyCapabilities, GHOSTTY), undefined);
  const noImages: TerminalCapabilities = { images: null, trueColor: true, hyperlinks: true };
  assert.equal(applyMultiplexerImagePolicy(noImages, GHOSTTY_IN_ZELLIJ), undefined);
});

test("parseZellijVersion reads the CLI banner and rejects garbage", async () => {
  const { parseZellijVersion } = await import("../.pi/extensions/lib/multiplexer-images.ts");
  assert.deepEqual(parseZellijVersion("zellij 0.45.0"), [0, 45, 0]);
  assert.deepEqual(parseZellijVersion("zellij 1.2.10\n"), [1, 2, 10]);
  assert.equal(parseZellijVersion("zellij"), null);
  assert.equal(parseZellijVersion(undefined), null);
});
