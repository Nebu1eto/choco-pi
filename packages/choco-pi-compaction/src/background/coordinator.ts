/**
 * Background compaction coordinator: one owner's candidate lifecycle from a
 * preparation request through admission, the backend run, arbitration with
 * the host compaction, adoption, and recovery of persisted records.
 *
 * Facade over the focused modules in `./coordinator/`; it keeps every public
 * export of the former single-file coordinator.
 */
export type {
  CandidateFailurePortEvent,
  CandidateTrigger,
  CoordinatorHandle,
  CoordinatorPort,
  DetailedCoordinatorStatus,
  SnapshotContext,
  SnapshotRefused,
  SuppressedPortEvent,
} from "./coordinator/types.ts";
export { createCoordinator } from "./coordinator/create.ts";
