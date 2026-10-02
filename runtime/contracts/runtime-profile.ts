// The Runtime Profile service handle only, free of runtime code, so presentations can bind it. The closed v0
// capability catalogue and the profile schema are in protocol/runtime-profile.ts; the generic host publisher is in
// runtime/contracts/runtime-profile-facet.ts; the composition root that installs a worker's implementations supplies
// the profile.
import { defineService, type ReplicatedState } from "@earendil-works/chord";
import type { RuntimeProfileV0 } from "../../protocol/runtime-profile.ts";

/** The attached Session worker's Runtime Profile, fixed for that worker's lifetime. */
export interface EndophasiaRuntimeProfileV0 {
	readonly state: ReplicatedState<RuntimeProfileV0>;
}

export const EndophasiaRuntimeProfileV0 = defineService<EndophasiaRuntimeProfileV0>("endophasia.runtime-profile.v0");
