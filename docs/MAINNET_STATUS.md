# Mainnet status

Snapshot date: **2026-10-16, America/New_York**. Source: upstream commit `99e0be62475ac95bb5f8030659c782d5275475a1`.

**The mainnet contract release candidate is frozen. Lincoln contracts have not been deployed to Robinhood mainnet, and this repository is not an assertion that the product is live.** Creating or publishing this audit repository does not authorize a mainnet transaction or a funding transfer.

## Completed

- Mainnet-only contract sources for chain **4663**, reproducible build artifacts, final production Groth16 verifiers, ABI exports and a frozen file inventory.
- Two recorded non-beacon contributions and the final committed future-block beacon; mathematical verification and public provenance evidence are included. Identity, independent environment control and destruction of secret randomness are not attested by those checks.
- Final-parameter native-pool local acceptance: **36 checks, 11 actual proofs and 43 local transactions**.
- Final-parameter fee-adapter local acceptance: **22 checks, four actual proofs and 73 local transactions**, including both router ABIs, wrap/unwrap, fee binding, recovery and withdrawal. Routers, tokens, factories and liquidity in this run were explicit mocks.
- Governance/fuzz/invariant evidence and separately recorded RH mainnet verification of the selected Safe as Safe 1.5.0, 2-of-3. Mock-verifier tests and real-final-proof tests have different scopes; see [Audit scope](AUDIT_SCOPE.md).

The core artifact SHA256 is `f3c286de48fa33a3025e3d6f5fec6987b5caa10ca1091d14f0b838a1a516f414`. The fee artifact SHA256 is `a171065c1d29c86f25227298137e6952ac2d135e18ea4a7cbf959efaed09c65d`. Other exact hashes are in `artifacts/phase2-mainnet/release-candidate-20261016.json`.

The frozen metadata deliberately retains `releaseCandidate:true`, `productionReady:false` and `mainnetDeployed:false`. Those flags have not been changed merely because the code was extracted into a dedicated repository.

## Selected deployment policy

| Item | Selected value |
| --- | --- |
| Guardian and DEX treasury | Safe `0x9CF17a6E3c75D200f58283A165C442a8A3994555` |
| Dedicated ASP provider | `0xce6770154D793dF78FbfA0D3615B2946366E6612` |
| ASP bootstrap | Self-hosted, all current notes; **no source screening** |
| Accepted policy window | Latest plus up to 15 predecessors, also subject to expiry and one-hour superseded grace |
| Provider rotation | Guardian proposal and new-provider acceptance after three days |
| Selected DEX fee | 20 bps, immutable treasury and rate per new adapter |
| Mainnet relay single-transaction gas ceiling | 5,000,000, separate from an explicit cumulative spending budget |
| Example initial pool/route selection | ETH, USDG and NVDA; six fixed UP/Uniswap routes |

Configuration listings of SPY or AAPL do not mean corresponding pools have been deployed or their market liquidity has been accepted. External adapter routing remains public; this is not confidential DEX execution.

## Required before a mainnet launch

1. **Finish fee deployment and activation.** The upstream core deployer currently deploys free adapters. The fee component has an offline deployment plan, with `deploymentExecutorImplemented:false`, `activationImplemented:false` and `executionEnabled:false`. Complete shared-ledger signing, canonical receipt/runtime/immutable verification and new-address route activation before claiming fee routes are live.
2. **Approve and configure actual mainnet funds.** The deployment gas budget, total funding cap, acceptance principal and maximum gas price remain unapproved/unset in the frozen target configuration. Fund and budget deployer, relay and dedicated ASP accounts explicitly. Earlier testnet gas authorization does not apply to real ETH.
3. **Deploy and verify real contracts.** Recheck the selected Safe and chain, final hashes, constructor inputs, actual DEX contracts/pools and token identities. Verify canonical deployment receipts, complete runtime and immutable getters, and produce actual deployed profiles. The frozen snapshot does not contain a successful mainnet deployment record.
4. **Start mainnet operations deliberately.** Configure the cloud mainnet API, independent signer and self-hosted ASP publisher using verified production profiles and persistent state. Mainnet signing is not currently enabled. Existing EC2 testnet operation does not establish a live mainnet service; extracting this core repository does not migrate the public endpoint.
5. **Run real mainnet acceptance with separate A/B wallets.** Use an explicitly approved small amount to test public deposits, merged payment, recipient recovery, continued spending, actual two-way DEX trading, net service fees, normal withdrawal and ownership-based public exit. Local mock liquidity and older testnet reports cannot replace this step.

Audit is intentionally deferred under the current launch decision. No independent audit has been completed; this document does not add audit as an unrequested approval gate or imply that postponing it removes contract risk.

## Repository and deployment boundary

This core snapshot is intended for contract/circuit review and reproducible validation. It excludes production keys, password files, signer ledgers, hosted secrets, wallet data and pending backend changes. Hosted relay performance work, publisher cadence changes and future DEX adapters are separate releases. A later mainnet operations release must identify exactly which frozen contract artifact and final proving manifests it uses.

Changing a budget or runtime configuration requires a new explicit configuration snapshot where the frozen inventory binds that file. It does not require another proving ceremony if the circuits, keys and verifier bindings remain unchanged. A new compatible DEX adapter can be deployed separately; changing note structure, circuit statements or core accounting requires a separately reviewed version.
