// Mapping 3 (over 2): arbitrary content-kind names have numeric counts; source IDs outside the plain identifier grammar are
// withheld rather than copied into lifecycle payloads. Mapping 2 committed to cwd and qualified recovery-written output. A store
// imported under an earlier mapping is refused on re-import ("mapping-changed"), never reinterpreted.
// The mapping version, kept apart so loss accounting and mapping can both name it without importing each other.
export const DSH_NATIVE_MAPPING_VERSION_V0 = "dsh-native-mapping.3";
