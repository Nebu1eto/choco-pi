export declare const HELPER_SOURCE_HASH_SCHEME: string;
export declare const HELPER_SWIFT_SOURCES: readonly string[];
export function helperSourcePaths(packageRoot?: string): string[];
export function helperSourceHash(arch: "arm64" | "x64", packageRoot?: string): Promise<string>;
