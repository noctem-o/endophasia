// The few types the model and the state share.

/**
 * What the operator has open in the inspector: one event of the loaded window, or one capability of the chosen attachment. There is no
 * other selection. An event is named by its storage position and its event id together, so a selection is kept across a read only when
 * the record at that position is still the same record.
 */
export type Selection =
	| { kind: "event"; sequence: number; eventId: string }
	| { kind: "capability"; name: string }
	| null;

/** The two facts that name one event of a window: its storage position and its event id. */
export type EventKey = { sequence: number; eventId: string };
