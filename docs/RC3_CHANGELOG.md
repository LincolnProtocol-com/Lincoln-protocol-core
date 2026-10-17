# RC.3 review changes

RC.3 supersedes the unfinished RC.2 pool deployment. The original RC.2 tag and its complete capsule remain unchanged.

The only on-chain logic change is `CAP_INCREASE_DELAY = 12 hours` in [PrivacyPool](../contracts/PrivacyPool.sol), with its corresponding notice updated. Immediate cap reductions, proposal replacement/cancellation, deposit-only pause and all exit rules are retained. All ten ABI exports are byte-identical to RC.2. The [artifact comparison](../releases/rc3/audit/rc3-bytecode-comparison.json) establishes that only the pool init/runtime bytecode changes; the other nine contract/library types and all compared public proof materials match exactly.

[Seven stock caps](STOCK_CAPS.md) are configured from the approved historical Robinhood token asks using integer floor arithmetic. This config change does not enable stock deployment or establish market liquidity. The default operation still deploys ETH/USDG core only.

The RC.2 root deployment entry is disabled. The [RC.3 operator](MAINNET_OPERATIONS.md) prepares a new public snapshot, verifies reused library CREATE transactions and runtimes, and references the original physical signer ledger. Historical gas costs, nonce reservations and cumulative limits are retained. Unknown prior broadcasts block new signing; no existing directory, journal, nonce or budget is reset. RC.3 also records sanitized RPC diagnostics rather than discarding the node error.

The [validation report](../audit/acceptance/rc3/validation.json) records 178 Node tests, 69 default Foundry tests, 19 deep cap/invariant tests and 15 final proofs over 124 local transactions. Deep fuzz cases use 20,000 runs, and the invariant campaign executes 40,960 calls with zero reverts. Proof DEX liquidity is synthetic. These results do not establish a completed public-mainnet deployment, actual stock markets or an independent audit.

The original RC.3 validation left mainnet deployment paused and sent no public transaction. The local operator subsequently recovered the original PoseidonT4 transaction and recorded its canonical confirmation. Both original libraries are now eligible for fresh receipt/runtime verification and reuse; the verifiers, registry and ETH/USDG pools remain to be deployed.

A subsequent [root-tooling fix](../audit/acceptance/rc3-clean-checkout/validation.json) prepares historical RC.2 dependencies on clean checkouts, with strict lock validation and regular compiler-source copies. Both frozen capsules, contract bytecode, final parameters, ABI exports and the release/review bindings remain unchanged.
