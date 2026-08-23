import {
  containsManagedSessionRestoreKey,
  isWrapperManagedSessionName,
} from "../../managed-session-capabilities.ts";
import { hasRuntimeType, isRecord } from "../../parsing.ts";

function isWrapperManagedSessionListItem<Value>(item: Value): boolean {
  if (hasRuntimeType(item, "string")) return isWrapperManagedSessionName(item);
  if (!isRecord(item)) return false;
  return ["name", "session", "id"].some((key) =>
    isWrapperManagedSessionName(hasRuntimeType(item[key], "string") ? item[key] : undefined),
  );
}

function containsManagedStateCapability<Value>(value: Value): boolean {
  if (hasRuntimeType(value, "string")) return containsManagedSessionRestoreKey(value);
  if (Array.isArray(value)) return value.some(containsManagedStateCapability);
  return isRecord(value) && Object.values(value).some(containsManagedStateCapability);
}

export function filterCallerOwnedSessionListItems<Value>(items: Value[]): Value[] {
  return items.filter((item) => !isWrapperManagedSessionListItem(item));
}

export function filterCallerOwnedStateListItems<Value>(items: Value[]): Value[] {
  return items.filter((item) => !containsManagedStateCapability(item));
}

export function filterManagedSessionListRows<Value>(data: Value) {
  if (!isRecord(data) || !Array.isArray(data.sessions)) return data;
  return { ...data, sessions: filterCallerOwnedSessionListItems(data.sessions) };
}

export function filterManagedStateListRows<Value>(data: Value) {
  if (!isRecord(data)) return data;
  return Object.fromEntries(
    Object.entries(data).map(([key, value]) => [
      key,
      (key === "states" || key === "files") && Array.isArray(value)
        ? filterCallerOwnedStateListItems(value)
        : value,
    ]),
  );
}
