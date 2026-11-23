export type UserNotifyLevel = "info" | "warning" | "error";

export type UserNotifier = (message: string, level?: UserNotifyLevel) => void;

let notifierGetter: (() => UserNotifier | undefined) | undefined;

export function wireUserNotifier(
  portsOrGetter: import("./host-ports.ts").HostPorts | (() => UserNotifier | undefined),
): void {
  notifierGetter =
    portsOrGetter instanceof Function ? portsOrGetter : () => portsOrGetter.notify.user;
}

export function resetUserNotifier(): void {
  notifierGetter = undefined;
}

export function hasUserNotifier(): boolean {
  return notifierGetter !== undefined;
}

export function notifyUserDegradation(message: string, level: UserNotifyLevel = "warning"): void {
  try {
    const notify = notifierGetter?.();
    notify?.(message, level);
  } catch {}
}
