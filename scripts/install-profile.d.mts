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
  projectSettings: Record<string, unknown> & { packages: string[] },
  existingSettings: Record<string, unknown> & {
    packages?: string[];
    extensions?: string[];
    skills?: string[];
    prompts?: string[];
  },
  root: string,
): Record<string, unknown>;

export function installProfile(options?: InstallProfileOptions): Promise<{
  agentDir: string;
  settingsPath: string;
  links: InstallLinkResult[];
}>;
