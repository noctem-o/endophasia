# Linux host inspection: incomplete, live gated

This research-only partial probe never establishes server parity and never grants execution authority. It is not wired to the A/A plan, continuation admission hook, or study reader. No real inference was performed. The result is **ENGINEERING INCOMPLETE / LIVE A/A GATED**.

On little-endian Linux the probe accepts an explicit PID, literal IPv4 loopback endpoint, executable and GGUF paths, and expected SHA-256 digests. It reads the selected process's start ticks, boot and network namespace identities, the IPv4 listening socket and a matching file descriptor, the running executable's filesystem identity, and mapped GGUF ranges, offsets, permissions and file identities. It hashes the opened executable and model under a time limit and checks the process, files, mapping and listener again. It only reads the selected process and files; it sends no HTTP requests and does not start, stop, or alter a service. The command prints a redacted status and writes details exclusively to an owner-only private directory pinned by file descriptor.

The command always returns `CRITICAL_UNAVAILABLE`, even after collecting these partial facts. It cannot establish that no other process owns a shared socket, that `SO_REUSEPORT` is disabled, or that an IPv6 listener cannot also accept the port. `/proc/net/tcp` shows active IPv4 sockets, not the socket's reuse-port setting. A robust single-owner and socket-option check must account for procfs visibility and permitted access to another process's descriptors; this partial probe does not supply it. PID/start-tick, file metadata and mapping checks are sampled observations and cannot eliminate substitution or in-place modification races. Timers cannot interrupt a synchronous filesystem syscall already blocked in the kernel.

The separate explicit-argument parser is an offline candidate for the historically observed build, not an applied runtime configuration check. The probe does not yet enforce the pinned binary/version and supported launch profile, inspect safely allowlisted environment values, query server-reported metadata or GPU telemetry, create real versioned admission evidence, or independently verify it from a fresh study reader. Its fake local process tests exercise procfs and file observations only; a fake process is not a llama.cpp server or a real attestation provider. The parser and historical hash do not establish source-to-binary provenance, GPU-resident bytes, RNG or KV state.

The candidate flag names were checked against the [server documentation at the previously reported llama.cpp commit](https://github.com/ggml-org/llama.cpp/blob/1f8fa52318b594b373e7447a3c2bb36cdba9515f/tools/server/README.md). That documentation describes available options; it does not establish the effective state of any running process.

The explicit command form is:

```text
node research/governed-initial-continuation/aa/inspect-linux.ts --pid PID --endpoint http://127.0.0.1:PORT --executable /absolute/server --executable-sha256 HEX --model /absolute/model.gguf --model-sha256 HEX --output /private/new-evidence.json --timeout-ms MILLISECONDS
```

The output parent must be owner-only. The command never starts Pi or a server, does not load a model, and contacts no endpoint. No next live step is authorized by this partial result.
