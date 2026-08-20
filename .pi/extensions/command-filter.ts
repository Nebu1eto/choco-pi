import {
  ExtensionRunner,
  type ExtensionAPI,
  type ResolvedCommand,
} from "@earendil-works/pi-coding-agent";

type FilterableRunnerPrototype = typeof ExtensionRunner.prototype & {
  __chocoPiCommandFilterApplied?: boolean;
};

function isExcludedCommand(command: ResolvedCommand): boolean {
  return (
    command.name === "llama" ||
    command.name === "apex-refresh" ||
    command.name.startsWith("synthetic:") ||
    command.name.startsWith("lens-")
  );
}

export default function commandFilter(_pi: ExtensionAPI): void {
  const prototype = ExtensionRunner.prototype as FilterableRunnerPrototype;
  if (prototype.__chocoPiCommandFilterApplied) return;

  const getRegisteredCommands = prototype.getRegisteredCommands;

  prototype.getRegisteredCommands = function getFilteredCommands(): ResolvedCommand[] {
    return getRegisteredCommands.call(this).filter((command) => !isExcludedCommand(command));
  };
  prototype.__chocoPiCommandFilterApplied = true;
}
