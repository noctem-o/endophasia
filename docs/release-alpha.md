# First alpha: what it is, what is verified, and the release checklist

This is the preparation for a first versioned alpha. **Nothing here publishes anything**: the package stays
`private: true` at `0.0.0` until the owner decides, and tagging, publishing and changing visibility are owner actions.

## What the alpha is

An experimental research instrument. It attaches to a user-installed agent harness (Pi), records what it observes in a
durable store, and reads that store back. It does not install, upgrade or patch Pi, and it does not claim stable
multi-runtime support.

## What is verified, and where

| Claim | Evidence | Where it runs |
| --- | --- | --- |
| The tarball is compiled JavaScript that runs under plain Node outside the checkout, with no runtime dependencies | `npm run test:package` (inventory, import closure, isolated install, no state created) | CI job `package` |
| `doctor` → `harness check` → `harness attach` → `harness status`/`overview` → `trajectory show`, from the installed tarball, using the default store, against a prepared **fake** Pi and a fake model endpoint | `npm run test:package` (loop section) | CI job `package` |
| The same loop against a **real Pi at the pinned version**, with a fake OpenAI-compatible endpoint (no credentials, no provider cost); the run fails if Pi reports any other version or a reduced identity | `npm run test:acceptance` | CI job `acceptance` |
| Everything else (adapters, protocol, storage, studies) | `npm test` | CI job `check` |

The pinned Pi is the verified baseline in `adapters/pi/version.ts` (1.0.0). Other Pi releases are *unverified releases*:
they can be attached, and earn capability admission through the same local checks and live study; nothing is assumed.

## What is not claimed

- Any Pi version other than the pinned one, any other runtime, any platform other than the CI image (Ubuntu, Node 22).
- That a prompt's acceptance means the model run succeeded: the CLI reports acceptance and settling separately.
- Anything about a live model provider: automated acceptance never calls one. A live study stays behind
  `--authorize-live-study` and may incur provider cost.
- Model-internal observation, a cockpit, new adapters, or schema migrations.

## Checklist before a first alpha (owner actions marked)

1. `main` is green: `check`, `package`, `acceptance`, `exchange`.
2. Decide the version (suggested `0.1.0-alpha.1`) and set it in `package.json`; remove `private: true` **(owner)**.
3. Confirm `npm pack --dry-run` lists only `dist/`, `README.md`, `LICENSE` and `package.json` (the package smoke asserts this).
4. Re-run `npm run test:acceptance` against the exact tarball to be published.
5. Write release notes from this page (verified / not claimed), and link `docs/install.md`.
6. Tag and publish with a dist-tag that is not `latest` (for example `alpha`) **(owner)**.
7. After publishing, install it from the registry into a clean prefix and run `endo doctor` and the loop once more.
