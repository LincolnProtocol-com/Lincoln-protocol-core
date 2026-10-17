# Circuits and proving parameters

| Directory | Contents |
| --- | --- |
| [circuits/joinsplit/](circuits/joinsplit/) | [main.circom](circuits/joinsplit/main.circom) and [joinsplit.circom](circuits/joinsplit/joinsplit.circom): two-input/two-output private spending |
| [circuits/holder-exit/](circuits/holder-exit/) | [main.circom](circuits/holder-exit/main.circom): public full-note ownership exit |
| [parameters/joinsplit/](parameters/joinsplit/) | Final JoinSplit R1CS, witness WASM, zkey, verification key, manifest and transcript |
| [parameters/holder-exit/](parameters/holder-exit/) | Corresponding final holder-exit materials |
| [parameters/powersOfTau28_hez_final_15.ptau](parameters/powersOfTau28_hez_final_15.ptau) | Hash-pinned public power-15 transcript |
| [ceremony/](ceremony/) | Public beacon evidence; parent zkeys are in [ceremony/parents/](ceremony/parents/) |

Witness WASM files retain their `main_js/main.wasm` subpath within each parameter directory. The generated Solidity verifiers are reviewed under [`contracts/verifiers/`](../contracts/verifiers/). JoinSplit has **nine public inputs**, holder exit has **five**, and the note/association Merkle depth is **20**. Holder exit does not require ASP membership. The circuit sources and parameter manifests define the exact ordering and statements.

These are regular review files mapped to their exact RC.3 capsule files (unchanged from RC.2) by [review-manifest.json](../review-manifest.json). Renaming a display file does not rewrite the paths embedded in a parameter manifest. Those embedded paths are original logical release paths; `npm run check` resolves the mapping and checks identity, while the reproduction capsule retains the original layout.

```sh
npm run check
npm run check:circuits
npm run test:proofs
```

Run these commands from the repository root. Circuit reproduction uses the pinned compiler and Circomlib include closure, compares exact R1CS/WASM bytes and verifies final-key consistency. Proof acceptance uses isolated local chains, final production verifiers and synthetic DEX liquidity. The wrappers verify the review binding before executing preserved tooling.

Source bytes and comments are preserved. A legacy comment referring to development parameters is not permission to use a development key: the final keys are separately contributed and beacon-finalized, and their identities are listed in [parameter provenance](../docs/PARAMETER_PROVENANCE.md). Initial setup keys are not final deployment materials.

The transcript records two non-beacon contributions followed by a beacon. It does not authenticate contributor independence, honest entropy, destruction of toxic waste or an independently attested publication time. See [security model](../docs/SECURITY_MODEL.md) for those assumptions. Deposit caps and the selected fee rate do not change the frozen circuit statements or final keys.

RC.3 changes only the pool cap-delay behavior to 12 hours and approved stock constructor configuration. Neither requires a new proving-key ceremony. Fresh proofs must still be exercised against the newly compiled RC.3 pool before acceptance; the historical RC.2 results are not substituted for that run. Mainnet broadcasts remain paused.
