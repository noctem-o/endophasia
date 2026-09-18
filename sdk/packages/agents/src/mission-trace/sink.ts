// =============================================================================
// MissionTraceSinkV0 — minimal in-memory sink for MissionTraceEventV0.
//
// The sink:
//   - appends events synchronously;
//   - never writes files, spawns tasks, performs async I/O, or calls the network;
//   - exposes an immutable/read-only snapshot of collected events.
// =============================================================================

import type { MissionTraceEventV0 } from "./types";

// -----------------------------------------------------------------------------
// Read-only snapshot
// -----------------------------------------------------------------------------

/** Immutable view of the events collected by a sink. */
export interface MissionTraceSnapshotV0 {
  /** Ordered collection of v0 events appended so far. */
  events: readonly MissionTraceEventV0[];
  /** Total number of v0 events collected. */
  count: number;
}

// -----------------------------------------------------------------------------
// Sink
// -----------------------------------------------------------------------------

/**
 * Minimal in-memory sink for MissionTraceEventV0.
 *
 * Suitable for tests and future UI experiments. Not durable — a sink
 * instance only lives for the lifetime of the object.
 */
export class MissionTraceSinkV0 {
  private events: MissionTraceEventV0[] = [];

  /**
   * Append a v0 event to the sink.
   *
   * Sync. No I/O. No scheduling. Callers (including the synchronous runtime
   * listener) must not await this.
   */
  append(event: MissionTraceEventV0): void {
    this.events.push(event);
  }

	/**
	 * Return a read-only snapshot of all events collected so far.
	 *
	 * The returned array is a fresh copy and each event is a fresh record
	 * (copy-isolation). Mission Trace v0 events carry only scalar / immutable
	 * payload fields, so `{ ...event }` fully isolates callers from the
	 * sink's internal state: mutating a snapshot event cannot rewrite the
	 * sink.
	 */
	snapshot(): MissionTraceSnapshotV0 {
		return {
			events: this.events.map((event) => ({ ...event })),
			count: this.events.length,
		};
	}

  /** True when no events have been appended. */
  get isEmpty(): boolean {
    return this.events.length === 0;
  }
}
