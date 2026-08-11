import {
	ExtensionRunner,
	type ExtensionAPI,
	type ResolvedCommand,
} from "@earendil-works/pi-coding-agent";

type FilterableRunnerPrototype = typeof ExtensionRunner.prototype & {
	__chocoPiCommandFilterApplied?: boolean;
};

function isExcludedCommand(command: ResolvedCommand): boolean {
	return command.name === "llama" && command.sourceInfo.path === "<inline:llama.cpp>";
}

export default function commandFilter(_pi: ExtensionAPI): void {
	const prototype = ExtensionRunner.prototype as FilterableRunnerPrototype;
	if (prototype.__chocoPiCommandFilterApplied) return;

	const getRegisteredCommands = prototype.getRegisteredCommands;
	const getCommand = prototype.getCommand;

	prototype.getRegisteredCommands = function getFilteredCommands(): ResolvedCommand[] {
		return getRegisteredCommands.call(this).filter((command) => !isExcludedCommand(command));
	};
	prototype.getCommand = function getFilteredCommand(name: string): ResolvedCommand | undefined {
		const command = getCommand.call(this, name);
		return command && !isExcludedCommand(command) ? command : undefined;
	};
	prototype.__chocoPiCommandFilterApplied = true;
}
