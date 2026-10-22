// Mapping 2 (over 1): the header digest commits to the working directory (keyed, never stored); lifecycle turn-completed and
// run-unclassified carry the step output kind; tool results DSH wrote itself during recovery are not recorded as outcomes. A store
// imported under an earlier mapping is refused on re-import ("mapping-changed"), never reinterpreted.
// The mapping version, kept apart so loss accounting and mapping can both name it without importing each other.
export const DSH_NATIVE_MAPPING_VERSION_V0 = "dsh-native-mapping.2";
