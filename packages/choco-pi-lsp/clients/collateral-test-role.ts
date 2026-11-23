import { detectFileRole } from "./file-role.ts";

export function isTestRoleCollateral(filePath: string): boolean {
  try {
    return detectFileRole(filePath) === "test";
  } catch {
    return false;
  }
}
