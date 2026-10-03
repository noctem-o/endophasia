// Prime RPC Runtime Ingress v0: Prime's names for the runtime-neutral JSONL framing in adapters/rpc-jsonl/jsonl.ts.
// The framing moved there unchanged when Pi's documented RPC mode became the second consumer.
export {
	encodeJsonlRecordV0 as encodePrimeJsonlRecordV0,
	JSONL_DEFAULT_MAX_RECORD_BYTES as PRIME_JSONL_DEFAULT_MAX_RECORD_BYTES,
	JsonlDecoderV0 as PrimeJsonlDecoderV0,
	type JsonlFaultV0 as PrimeJsonlFaultV0,
	type JsonlRecordV0 as PrimeJsonlRecordV0,
} from "../../rpc-jsonl/jsonl.ts";
