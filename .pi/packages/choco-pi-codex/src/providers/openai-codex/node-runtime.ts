const dynamicImport = (specifier: string) => import(specifier);

type OsModule = { platform(): string; release(): string; arch(): string };
interface OsInfo {
  current: OsModule | null;
}

function createOsInfo(): OsInfo {
  return { current: null };
}

export const osInfo = createOsInfo();

if (globalThis.process !== undefined && (process.versions?.node || process.versions["bun"]!)) {
  dynamicImport("node:os")
    .then((module) => {
      osInfo.current = module;
    })
    .catch(() => {
      osInfo.current = null;
    });
}
