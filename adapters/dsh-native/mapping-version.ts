// Mapping 4 (over 3): all tool-call references use domain-separated keyed identities, preserving pairing without raw IDs.
// Mapping 3 fixed content counts and withheld unsafe source IDs; mapping 2 qualified recovery-written output. A store
// imported under an earlier mapping is refused on re-import ("mapping-changed"), never reinterpreted.
// The mapping version, kept apart so loss accounting and mapping can both name it without importing each other.
export const DSH_NATIVE_MAPPING_VERSION_V0 = "dsh-native-mapping.4";
