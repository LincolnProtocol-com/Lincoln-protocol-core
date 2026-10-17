# Contract review entry points

These **nine Solidity source files contain ten deployable contract/library types**. Pools and fixed routes can have multiple deployed instances; the count does not describe already deployed addresses.

| Review source | Preserved Solidity identifier | Purpose |
| --- | --- | --- |
| [`PrivacyPool.sol`](PrivacyPool.sol) | `Phase2ASPPool` | Asset custody, notes, private spending, public exits and deposit controls |
| [`AssociationSetRegistry.sol`](AssociationSetRegistry.sol) | `Phase2ASPRegistry` | Association roots, accepted epochs, suspension and provider rotation |
| [`adapters/V3RouteAdapter.sol`](adapters/V3RouteAdapter.sol) | `Phase2RouteAdapter` | Typed exact-input V3/UP routes |
| [`adapters/Router02Adapter.sol`](adapters/Router02Adapter.sol) | `Phase2Router02Adapter` | Typed Router02 exact-input routes |
| [`adapters/FeeAdapters.sol`](adapters/FeeAdapters.sol) | `Phase2FeeRouteAdapter`, `Phase2FeeRouter02Adapter` | Measured-output service fees and net reshielding |
| [`verifiers/JoinSplitVerifier.sol`](verifiers/JoinSplitVerifier.sol) | `Phase2ASPJoinSplitVerifier` | Final Groth16 verifier with nine public inputs |
| [`verifiers/HolderExitVerifier.sol`](verifiers/HolderExitVerifier.sol) | `Phase2ASPExitVerifier` | Final Groth16 verifier with five public inputs |
| [`libraries/PoseidonT3.sol`](libraries/PoseidonT3.sol) | `PoseidonT3` | Two-element Poseidon hash library |
| [`libraries/PoseidonT4.sol`](libraries/PoseidonT4.sol) | `PoseidonT4` | Three-element Poseidon hash library |

`Phase2FeeRouteBase` and interface declarations support those contracts; they do not add deployable types to the table. OpenZeppelin dependency sources and their pinned compiler inputs remain part of the preserved build boundary.

The readable filenames do not rename Solidity identifiers. Every review file must be a regular file with the exact byte length and SHA256 of its mapped RC.2 source. The root `review-manifest.json` connects these paths to the immutable reproduction capsule in `releases/rc2/`. `npm run check` rejects a missing, changed or independently drifting review copy.

Use `npm run build` and `npm run test:contracts` from the repository root. The wrappers verify review-file equality before running the preserved compiler/test tooling at its original logical paths. A plain compilation under renamed source-unit paths can change Solidity metadata and library-link names even when the source text is identical; it must not be presented as the frozen RC.2 build.

Review [audit scope](../docs/AUDIT_SCOPE.md) for the exact obligations and [security model](../docs/SECURITY_MODEL.md) for trust assumptions. This directory supplies no upgrade, owner sweep or mainnet deployment claim.
