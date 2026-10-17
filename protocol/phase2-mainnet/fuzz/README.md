# Mainnet contract fuzz suite

Foundry fuzz and invariant tests for `protocol/phase2-mainnet/contracts/`, compiled with the production settings (solc 0.8.28, via-IR, 10 000 runs, cancun).

```sh
cd protocol/phase2-mainnet
forge test                        # 1 000 fuzz runs, 128×40 invariant calls
FOUNDRY_PROFILE=deep forge test   # 20 000 fuzz runs, 512×80 invariant calls
```

Verifiers are mocks that accept every proof. These tests cover contract accounting, authorization and policy logic on the assumption that the circuits are sound. They do not test the proofs themselves.

| File | Covers |
| --- | --- |
| `Registry.t.sol` | Guardian rotation and suspension (M1); epoch acceptance checked against a reference model (M2) |
| `Pool.t.sol` | In-flight proofs across policy updates, the grace bound and the window cap; deposits; the Merkle tree against a from-scratch reference; signal, field and context tampering; fees; exits |
| `Caps.t.sol` | Per-deposit and accounted-TVL caps; Guardian authority; 24-hour delayed increases; proposal replacement/cancellation; deposit-only pause; donations and exits below lowered caps |
| `Invariant.t.sol` | Random deposit, transfer, withdraw, exit, ragequit, policy and time sequences, donation, deposit-cap and pause sequences, plus replay attacks. Invariants: accounted balance equals unspent notes; custody equals notes plus unsolicited donations, no double spend, and tree accounting |
| `Adapter.t.sol` | Real pools with a misbehaving router: swaps are exact or revert atomically, actions are bound to the proof, and only the adapter can submit |
| `FeeAdapter.t.sol` | `protocol/phase2-fees` fee adapter on the mainnet pools: exact fee/net/treasury accounting or atomic revert, tight `minimumGrossOutput`, fee terms bound to one adapter, ETH-output fees paid in WETH, in-flight swaps across a policy update |

`*_M3_*` and `*_F1_*` are regression tests for fixed findings (dust deposits can no longer evict roots; fee-cap headroom). The tree-capacity half of M3 is still open. `test_PoC_L1_*` shows on-chain behaviour kept by design (contract depositors may ragequit); the relay services refuse a ragequit to a configured route adapter instead.
