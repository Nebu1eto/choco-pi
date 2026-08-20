import type { RuntimeValue } from "../.pi/extensions/runtime-values.ts";
export type InstallLinkResult = {
  target: string;
  action: "unchanged" | "linked" | "backed-up";
  backup?: string;
};

export type InstallProfileOptions = {
  root?: string;
  agentDir?: string;
  backup?: boolean;
};

export function buildGlobalSettings(
  projectSettings: Record<string, RuntimeValue> & { packages: string[] },
  existingSettings: Record<string, RuntimeValue> & {
    packages?: string[];
    extensions?: string[];
    skills?: string[];
    prompts?: string[];
  },
  root: string,
): Record<string, RuntimeValue>;

export function installProfile(options?: InstallProfileOptions): Promise<{
  agentDir: string;
  settingsPath: string;
  links: InstallLinkResult[];
}>;
