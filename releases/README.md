# Preserved releases

`rc3/` is the current candidate reproduction capsule. It changes the pool cap-increase delay from 24 to 12 hours and fixes the seven user-approved stock constructor caps. Stock pools/routes remain disabled pending per-asset acceptance. Its artifact inventory, source mapping and test evidence are separately identified.

`rc2/` remains the complete immutable RC.2 reproduction capsule. It retains the original source layout, compiler inputs, parameter bindings, test tooling and release evidence. The original `v0.1.0-rc.2` Git tag remains unchanged.

The regular files under the root `contracts/`, `zk/`, `abi/` and `test/` directories are the readable review entry points. `review-manifest.json` maps each to its exact capsule file, byte length and SHA256. They are not a second implementation: `npm run check` rejects any drift between the review tree and its pinned release source.

## Why the capsule keeps original paths

Solidity source-unit paths influence metadata, fully qualified library links and bytecode. Parameter manifests also contain original logical paths. Renaming all compiler keys or rewriting frozen imports would produce a different build even if the contract behavior appeared unchanged.

The root wrappers first verify the review files, then execute preserved tooling at its original logical paths in the capsule. This makes RC.3 bytecode reproducible and preserves the existing final-key identity while keeping the public review tree concise. Original development names and historical documentation are reproduction details inside the capsule, not additional production deployment targets.

Use the repository-root commands:

```sh
npm run check
npm run build
npm run check:circuits
npm run test:contracts
npm run test:proofs
```

The exact package/compiler dependencies remain pinned. The tested toolchain is Node.js 22+, Foundry 1.8.4, Solidity 0.8.28 with via IR/Cancun and optimizer 10,000 runs, and npm Circom2 0.2.22 containing Circom 2.2.2. Ordinary direct compilation of renamed root paths is not a substitute for these reproduction commands.

## RC.2 identity

| Preserved item | SHA256 |
| --- | --- |
| Core artifact | `6bea6c23a5a6e80aec8411d8269978a584058e40a4cdf14e4eb231e4f7b7f41e` |
| Fee artifact | `52f71b538b613ec315727afce2eb4f86604adcce698be58a1ff12d8ab256a36a` |
| Release inventory | `abbb1064147919a7936569cd6f8105b39f885835ba19c002be75960b69aa58e3` |

Resolve physical capsule filenames through the root review manifest and preserved inventories. Embedded source paths remain the original logical identifiers; they must not be silently interpreted as a different root review file without checking the mapping.

RC.1 snapshots, source-change records and prior acceptance remain historical provenance inside the capsule and the original tags. Their successful reports do not certify arbitrary new code. A future contract change requires a separately identified release, refreshed evidence and an explicit mapping update; changing a review copy alone must fail verification.

The capsule contains public review/reproduction materials, not production keys, private witnesses, wallet recovery data, cloud secrets or permission to spend real ETH. The candidate has no completed mainnet deployment. Broadcasting is paused pending reconciliation of the unknown RC.2 PoseidonT4 transaction. RC.3 must reuse confirmed libraries only after code verification and retain the account-wide gas ledger. Fees in a live service, stock fork/DEX acceptance, funding and real-market launch acceptance remain separate operations work.
