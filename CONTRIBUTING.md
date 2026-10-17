# Working on the core

The public review layout is hash-bound to the RC.2 capsule under `releases/rc2/`. Review `contracts/`, `zk/`, `abi/` and `test/` first; the mapping is in `review-manifest.json`.

The initial audit snapshot preserves upstream commit `99e0be62475ac95bb5f8030659c782d5275475a1`. Its exact source paths, final proof materials, compiler inputs, configuration and public evidence are bound by the frozen inventory. Documentation and standalone tooling are separately identified additions.

Run `npm ci --ignore-scripts` and `npm run test:all` before submitting a change. Tests run locally without production accounts or credentials. Use `npm run test:proofs` for real-proof integration runs; the low-level upstream scripts would overwrite their historical report files.

For an audit fix, describe the violated invariant, the concrete trigger, the change and a regression that exercises the failure. Preserve the current candidate and its evidence as a versioned baseline. A subsequent contract/circuit candidate needs its own explicit artifact inventory and review reference; changing a frozen file and refreshing a hash alone is not verification.

Keep compatible new DEX adapters in a separate versioned component, with typed routes, constrained approvals, net-output/fee binding and real integration evidence. Existing immutable pools can be reused when the public interfaces and proof statement remain compatible. A note or circuit-statement change needs separate parameter/version planning.

The operational application repository consumes an identified core version. Changing this standalone repository does not automatically deploy, activate a route, update EC2 or alter existing on-chain contracts.

Each source file retains its SPDX identifier. Preserve generated-verifier and dependency notices; see `THIRD_PARTY_NOTICES.md`. Do not commit wallets, recovery data, `.env`, witnesses, passwords, runtime ledgers or cloud credentials.
