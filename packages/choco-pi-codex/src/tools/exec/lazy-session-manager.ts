import type {
  ExecSessionChangeReason,
  ExecSessionManager,
  ExecSessionManagerOptions,
} from "./session-manager.ts";

export function createLazyExecSessionManager(
  options: ExecSessionManagerOptions = {},
): ExecSessionManager {
  let baseEnv: NodeJS.ProcessEnv = { ...(options.env ?? process.env) };
  let manager: ExecSessionManager | undefined;
  let managerPromise: Promise<ExecSessionManager> | undefined;
  const changeListeners = new Set<(reason: ExecSessionChangeReason) => void>();
  const exitListeners = new Set<(sessionId: number, command: string) => void>();

  const load = (): Promise<ExecSessionManager> => {
    managerPromise ??= import("./session-manager.ts").then(({ createExecSessionManager }) => {
      const loaded = createExecSessionManager({ ...options, env: baseEnv });
      loaded.onSessionChange((reason) => {
        for (const listener of changeListeners) listener(reason);
      });
      loaded.onSessionExit((sessionId, command) => {
        for (const listener of exitListeners) listener(sessionId, command);
      });
      manager = loaded;
      return loaded;
    });
    return managerPromise;
  };

  return {
    setBaseEnv(env) {
      baseEnv = { ...env };
      manager?.setBaseEnv(baseEnv);
    },
    async exec(input, cwd, signal, onUpdate) {
      return (await load()).exec(input, cwd, signal, onUpdate);
    },
    async write(input, signal, onUpdate) {
      return (await load()).write(input, signal, onUpdate);
    },
    hasSession: (sessionId) => manager?.hasSession(sessionId) ?? false,
    getSessionCommand: (sessionId) => manager?.getSessionCommand(sessionId),
    listSessions: (maxOutputChars) => manager?.listSessions(maxOutputChars) ?? [],
    terminateSession: (sessionId) => manager?.terminateSession(sessionId) ?? false,
    onSessionChange(listener) {
      changeListeners.add(listener);
      return () => changeListeners.delete(listener);
    },
    onSessionExit(listener) {
      exitListeners.add(listener);
      return () => exitListeners.delete(listener);
    },
    shutdown: () =>
      managerPromise ? managerPromise.then((loaded) => loaded.shutdown()) : Promise.resolve(),
  };
}
