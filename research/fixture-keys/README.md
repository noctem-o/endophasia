# Public fixture digest keys

**These keys are public. Digests made with them offer no secrecy.** Anyone with this repository can confirm a guess
about any argument digested under them (hash the guess with the key and compare).

That is acceptable only for fixtures. Fixtures are committed, so the key that verifies their digests has to be
committed too, and fixtures are synthetic scenarios in scratch workspaces with nothing to protect.

| File | Key id | Used for |
| :--- | :--- | :--- |
| `fixture-public.json` | `fixture-public` | every fixture recording (`scripts/record-lifecycle-fixture.ts`, `tests/fixtures/trajectory/record-fake.ts`) |
| `fixture-public-alt.json` | `fixture-public-alt` | only the hostile fixture that exercises a digest-domain difference |

**Fixtures must contain only synthetic scratch content**: invented prompts and files in scratch workspaces. Never
record anything real under these keys.

Several guards keep these keys and private keys apart:
- **Self-describing ids.** Each id is the key's name, so a reader of any digest sees it came from a public key.
- **Pinned bytes.** Which bytes each name stands for is pinned by fingerprint in `storage/digest-key.ts` (`ENDO_FIXTURE_DIGEST_KEYS_V0`). A file whose bytes do not match is refused.
- **Not accepted as the installation key.** A file marked `public` is never accepted where the installation key is expected (`readEndoDigestKeyV0`).
- **Separated recording modes.** Only the fixture recorders use these keys. The Pi attachment refuses to record a normal session under a public key, and refuses a fixture recording (`digestDomain: "fixture"`) under the installation key.

Real work uses the installation key, generated automatically in Endophasia's data directory (see docs/trajectory.md).
Normal use never touches the keys here, and their weakness does not affect the installation key.
