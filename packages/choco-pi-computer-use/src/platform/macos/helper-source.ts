import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

export type HelperArch = "arm64" | "x64";

export const HELPER_SOURCE_HASH_SCHEME = "pi-computer-use-helper-source-v1";

export const HELPER_SWIFT_SOURCES: readonly string[] = [
  "native/macos/agent_cursor.swift",
  "native/macos/agent_cursor_art.swift",
  "native/macos/agent_cursor_model.swift",
  "native/macos/agent_cursor_motion.swift",
  "native/macos/bridge.swift",
  "native/macos/bridge_act.swift",
  "native/macos/bridge_act_delivery.swift",
  "native/macos/bridge_act_evidence.swift",
  "native/macos/bridge_app_policy.swift",
  "native/macos/bridge_ax_attributes.swift",
  "native/macos/bridge_ax_elements.swift",
  "native/macos/bridge_capture.swift",
  "native/macos/bridge_cursor_overlay.swift",
  "native/macos/bridge_diagnostics.swift",
  "native/macos/bridge_dispatch.swift",
  "native/macos/bridge_extended_delivery.swift",
  "native/macos/bridge_focus.swift",
  "native/macos/bridge_foreground.swift",
  "native/macos/bridge_hid_destination.swift",
  "native/macos/bridge_input_suppression.swift",
  "native/macos/bridge_keyboard.swift",
  "native/macos/bridge_look.swift",
  "native/macos/bridge_look_outline.swift",
  "native/macos/bridge_off_space.swift",
  "native/macos/bridge_pointer_events.swift",
  "native/macos/bridge_request_context.swift",
  "native/macos/bridge_root_changes.swift",
  "native/macos/bridge_roots.swift",
  "native/macos/bridge_sessions.swift",
  "native/macos/bridge_text_entry.swift",
  "native/macos/bridge_window_pairing.swift",
];

export function helperSourcePaths(packageRoot: string = PACKAGE_ROOT): string[] {
  return HELPER_SWIFT_SOURCES.map((relativePath) => path.join(packageRoot, relativePath));
}

export async function helperSourceHash(
  arch: HelperArch,
  packageRoot: string = PACKAGE_ROOT,
): Promise<string> {
  const hash = createHash("sha256");
  hash.update(`${HELPER_SOURCE_HASH_SCHEME}\n${arch}\n`);
  for (const relativePath of [...HELPER_SWIFT_SOURCES].sort()) {
    const contents = await fs.readFile(path.join(packageRoot, relativePath));
    hash.update(`${relativePath}\n${contents.length}\n`);
    hash.update(contents);
    hash.update("\n");
  }
  return hash.digest("hex");
}
