import assert from "node:assert/strict";
import test from "node:test";
import {
  renderHalfBlockImage,
  shouldRenderHalfBlockMosaic,
} from "../src/ui/tool-rendering/halfblock-image.ts";

const CHECKERBOARD_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAH0lEQVR4AQXBAQEAAACAEP9PFyIqolARFYmoiEJFVDQsUB/hTURbbQAAAABJRU5ErkJggg==";
const ALPHA_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAACCAYAAACZgbYnAAAAD0lEQVR4AWP4zwAG//8DAAv+Av7oRheJAAAAAElFTkSuQmCC";

const RED_OVER_BLUE = "\x1b[38;2;255;0;0m\x1b[48;2;0;0;255m▀";
const BLUE_OVER_RED = "\x1b[38;2;0;0;255m\x1b[48;2;255;0;0m▀";
const CHECKERBOARD_LINE = `${RED_OVER_BLUE}${BLUE_OVER_RED}${RED_OVER_BLUE}${BLUE_OVER_RED}\x1b[0m`;

test("renders a 4x4 red/blue checkerboard as truecolor half-block lines", () => {
  assert.deepEqual(renderHalfBlockImage(CHECKERBOARD_PNG, "image/png"), [
    CHECKERBOARD_LINE,
    CHECKERBOARD_LINE,
  ]);
});

test("caps mosaic width and keeps its cell count", () => {
  const lines = renderHalfBlockImage(CHECKERBOARD_PNG, "image/png", { maxWidthCells: 2 });
  assert.equal(lines?.length, 1);
  assert.equal([...(lines ?? [""])[0]!.matchAll(/▀/g)].length, 2);
});

test("composites transparent pixels onto the dark mosaic background", () => {
  assert.deepEqual(renderHalfBlockImage(ALPHA_PNG, "image/png"), [
    "\x1b[38;2;26;26;26m\x1b[48;2;0;0;255m▀\x1b[0m",
  ]);
});

test("uses the text mosaic only for enabled truecolor TTY fallbacks", () => {
  const enabled = {
    imageProtocol: null,
    colorterm: "truecolor",
    showImages: true,
    stdoutIsTTY: true,
  };
  assert.equal(shouldRenderHalfBlockMosaic(enabled), true);
  assert.equal(shouldRenderHalfBlockMosaic({ ...enabled, imageProtocol: "kitty" }), false);
  assert.equal(shouldRenderHalfBlockMosaic({ ...enabled, showImages: false }), false);
  assert.equal(shouldRenderHalfBlockMosaic({ ...enabled, stdoutIsTTY: false }), false);
  assert.equal(shouldRenderHalfBlockMosaic({ ...enabled, colorterm: "256color" }), false);
  assert.equal(shouldRenderHalfBlockMosaic({ ...enabled, colorterm: "24bit" }), true);
  assert.equal(shouldRenderHalfBlockMosaic({ ...enabled, mosaic: "off" }), false);
});
