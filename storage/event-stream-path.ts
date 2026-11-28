import { lstatSync } from "node:fs";
import { join } from "node:path";
import { isWellFormedKindV0 } from "../protocol/identity.ts";

export type EndoEventStreamIdV0 =
	| { readonly kind: "legacy"; readonly attachmentId?: never }
	| { readonly kind: "attachment"; readonly attachmentId: string };

export type EndoEventStreamKeyV0 = "legacy" | `attachment:${string}`;

export function endoEventStreamKeyV0(id: EndoEventStreamIdV0): EndoEventStreamKeyV0 {
	if (id.kind === "legacy") return "legacy";
	if (id.kind !== "attachment" || typeof id.attachmentId !== "string" || !isWellFormedKindV0(id.attachmentId))
		throw new TypeError("attachment must be a well-formed dotted kind");
	return `attachment:${id.attachmentId}`;
}

export function endoEventStreamPathV0(root: string, id: EndoEventStreamIdV0): string {
	endoEventStreamKeyV0(id);
	const events = join(root, "events");
	const directories =
		id.kind === "legacy"
			? [events]
			: [events, join(events, "attachments"), join(events, "attachments", id.attachmentId)];
	for (const directory of directories) {
		const stat = lstatSync(directory, { throwIfNoEntry: false });
		if (stat !== undefined && !stat.isDirectory())
			throw new TypeError(`not a regular stream directory: ${directory}`);
	}
	return join(directories.at(-1)!, "events.log");
}
