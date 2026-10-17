# Proving parameter provenance

The initial RC.1 import of this Robinhood mainnet core repository came from
`LincolnProtocol-com/LincolnProtocol` commit
`99e0be62475ac95bb5f8030659c782d5275475a1`. The pushed `v0.1.0-rc.1` remains a
historical snapshot; RC.2 changes deposit caps, planning and fee policy while
preserving final public proving materials and their byte-level identities.
`audit/upstream-files.json` records the initial import, and
`audit/source-changes-r2.json` is the explicit RC.2 change ledger. RC.2 is not a
claim that every imported file remains byte-for-byte unchanged. The repository
does not contain wallet keys, private notes, private witnesses, contributor
entropy, or an assertion that an independent security audit has been completed.

## RC.2 candidate and historical RC.1 identity

RC.2 real-proof native/fee acceptance has passed. Its release-inventory path is
`artifacts/phase2-mainnet/release-candidate-20261016-r2.json`; its frozen SHA256 is
`abbb1064147919a7936569cd6f8105b39f885835ba19c002be75960b69aa58e3`. The actually compiled RC.2 core
artifact `artifacts/phase2-mainnet/contracts.json` has SHA256
`6bea6c23a5a6e80aec8411d8269978a584058e40a4cdf14e4eb231e4f7b7f41e`.
The RC.2 fee artifact binds that changed core and has SHA256
`52f71b538b613ec315727afce2eb4f86604adcce698be58a1ff12d8ab256a36a`.
Standalone integrity, core/fee bytecode reproduction, circuit recompilation and a second public-only native/fee acceptance run have passed.

For provenance, the **historical RC.1** source inventory is
`artifacts/phase2-mainnet/release-candidate-20261016.json`, SHA256
`b4290759e353e434aaa539fe5b2adcbae456aa56339a28980019d157a0f1ddc8`.
It bound the RC.1 core artifact SHA256
`f3c286de48fa33a3025e3d6f5fec6987b5caa10ca1091d14f0b838a1a516f414`
and RC.1 fee artifact SHA256
`a171065c1d29c86f25227298137e6952ac2d135e18ea4a7cbf959efaed09c65d`.
These old bindings do not validate the RC.2 artifacts now occupying the current
artifact paths. Preserved RC.1 build/report copies are under
`audit/baselines/v0.1.0-rc.1/`; validate an old release against its historical
snapshot rather than substituting new artifacts under old hashes.

The final R1CS, WASM, zkeys and parameter manifests listed below are unchanged
between RC.1 and RC.2. Caps, deposit-only pause and a new 30-bps adapter selection
do not change the circuit statements or require a new contribution ceremony.
The changed pool has passed fresh real-final-proof acceptance; new
source/artifact/ABI bindings must be included in the final RC.2 inventory.
Unchanged key identity cannot make an old passed contract report certify a new
pool.

The selected system uses Groth16 over BN128, a current-note ASP policy, two note
inputs and two note outputs, and a Merkle depth of 20. JoinSplit has nine public
inputs; holder exit has five. The holder-exit proof does not require ASP
membership. The manifests and circuits define the exact public signal ordering.

## Phase 1 transcript

The public prepared power-15 transcript is available at:

<https://storage.googleapis.com/zkevm/ptau/powersOfTau28_hez_final_15.ptau>

It is stored under the historical project path:

`vendor/nocturne-protocol/packages/circuits/data/powersOfTau28_hez_final_15.ptau`

| Property | Pinned value |
| --- | --- |
| Bytes | `37831832` |
| SHA256 | `3ef2ecc5b75d687048cf2d59195119b42fb07c5af639c5f283d84bfa69829e7f` |
| BLAKE2b-512 | `982372c867d229c236091f767e703253249a9b432c1710b4f326306bfa2428a17b06240359606cfe4d580b10a5a1f63fbed499527069c18ae17060472969ae6e` |

The path is retained because it is part of the original file references. It does
not mean this core package vendors the Nocturne protocol or uses its deployed
contracts. A downloaded ptau must match the pinned bytes before use; the build
also verifies the final keys against their R1CS and this phase-1 transcript.

## Circuit tooling and computation

The preserved original tool lockfile is
`scripts/private-transfer/deps/package-lock.json`, SHA256
`da570567d77761a94a2f56ad17c601e9e7acfb91f7a484fab97ed4ebb3ae4f6e`.
The recorded tools are `circom2@0.2.22` (Circom compiler 2.2.2),
`circomlib@2.0.5`, and `snarkjs@0.7.5`, with Circom optimization `O2`.

The source circuits are:

- `protocol/phase2-asp/circuits/joinsplit/main.circom`
- `protocol/phase2-asp/circuits/joinsplit/joinsplit.circom`
- `protocol/phase2-asp/circuits/holder-exit/main.circom`

Their Circomlib include closure contains `poseidon.circom`,
`poseidon_constants.circom`, `comparators.circom`, `bitify.circom`,
`aliascheck.circom`, `binsum.circom`, and `compconstant.circom` from the pinned
release. Each final manifest records the source digests, compiler entrypoint and
WASM digests, library source-set digest, and original dependency-lock digest.

| Circuit | R1CS SHA256 | Witness WASM SHA256 |
| --- | --- | --- |
| JoinSplit | `f5e6448b8c432cd28027f9b6f09f3ae1721c0648caf1a54b1368caced6bc5f2d` | `54dd12b723c5a3da1b3bae05b554404aa13b3cbaedbbd07f08a26957a6294fdf` |
| Holder exit | `899c9e5e9feb4db2184cd14a0d0f44b0a552abc706879a238e4bf67df8d4f87b` | `fb570f26df068248b980b0460bb13ce5fc886462201206fcdafea26e6901ae3f` |

These R1CS/WASM computations match the pinned tested development computation.
The final phase-2 keys are different from the development keys; matching a
development R1CS does not authorize substituting a development zkey.

## Phase 2 contributions and final beacon

Both final zkeys contain two non-beacon contribution records, followed by a
beacon record. The recorded contributor labels are
`lincoln-local-20261016` and `leo-independent-20261016`. Those are transcript
labels, not authenticated identities or a cryptographic count of independent
people or machines.

The second-contribution parent keys are preserved under
`artifacts/phase2-ceremony/contributions/leo-independent-20261016/`. The final
`ceremony-transcript.json` files bind the contribution records to the R1CS, ptau,
and final-key digests. The final build reads embedded binary contribution records
rather than trusting the manifest labels alone.

The precommitment was recorded at this immutable Git revision:

<https://raw.githubusercontent.com/LincolnProtocol-com/beacon/1229e4e1a0259bce86fa6b5c4edc030b3069eea5/artifacts/phase2-ceremony/beacon-commitment.json>

The recorded final beacon hash is
`0x5b9e2e64568bf74f5892c0d26211590d3159ddcca3b6c3a922abbc940ed48ed1`;
the SnarkJS beacon iteration exponent is `20`. The preserved application,
commitment, publication observation, and source observation are:

- `artifacts/phase2-ceremony/beacon-commitment.applied.json`
- `artifacts/phase2-ceremony/beacon-commitment.json`
- `artifacts/phase2-ceremony/beacon-commitment.publication.json`
- `artifacts/phase2-ceremony/beacon-commitment.observation.json`

The evidence records Ethereum mainnet as the beacon source and observations from
two RPC hosts. The local records are not a consensus light-client proof or an
independent timestamping service.

## Final key identity

| Circuit | Final zkey SHA256 | Final manifest SHA256 |
| --- | --- | --- |
| JoinSplit | `36a228e5cf8b81e6930bcb42b82fb60bbfa2fe7e7039d450b1e49e2fa31059ed` | `ff7dd97461c7190b13808add36cc73254f0c1b1c9b3bb03cceb39d3019bd59b0` |
| Holder exit | `d17b8e06b15c48b97dc4dc18a1d0a89014fbc4d807c222792edda7f271d500d3` | `b80c9987281b10a20697511b31716bd2c1fd6c0b08887ad6c7af4cb8f64b0cba` |

The corresponding `verification_key.json`, final `main.r1cs`, witness WASM,
transcript, and generated Solidity verifiers remain in their original relative
paths under `protocol/phase2-mainnet/`. SnarkJS verifies final-key consistency
against R1CS/ptau, exports the verification key, and re-exports the Solidity
verifier for byte comparison. The only deterministic verifier transformations
are the Solidity pragma and contract name recorded by the builder.

## What the evidence does and does not establish

Both explicit assurance limits remain **false** in the final manifests and
beacon bindings:

```json
{
  "independentOperatorIdentityAuthenticated": false,
  "publicPrecommitTimingCryptographicallyAuthenticated": false
}
```

Hash checks establish byte identity. Final-key verification establishes the
mathematical consistency checked by SnarkJS and the embedded contribution chain.
Neither demonstrates contributor independence, honest entropy generation,
destruction of toxic waste, participant identity, the absence of compromised
machines, or independent audit completion. A public Git URL and local/RPC
observations do not cryptographically authenticate that the commitment was
published before the future block became predictable.

This focused core repository preserves the original tool lock and final public
materials, but does not copy the entire historical ceremony working directory,
all installed tool files, development setup artifacts, or every intermediate
contribution. Consequently it supports verification of the packaged final
candidate and its public bindings; it must not be described as a complete replay
of every historical ceremony-stage file check. The original full tool-freeze
verifier can require files intentionally outside this repository's scope.

The local final-proof acceptance reports cover actual final proof generation,
verification and contract execution on an isolated Anvil chain for their exact
recorded build. RC.1 reports remain historical evidence in
`audit/baselines/v0.1.0-rc.1/` and the original tag. RC.2 copies are in
`audit/acceptance/standalone-20261016-r2/`: native acceptance passed 43 checks,
11 actual final proofs and 48 local transactions (run
`d2172cda-01bc-4b26-8d43-95b1d0e241c3`); fee acceptance passed 22 checks,
four actual final proofs and 73 local transactions (run
`e7cf5b6d-36ec-41cc-9e68-2dcde9f48d3d`). This totals 15 actual proofs and
121 local transactions, with zero public-chain transactions. Native acceptance
keeps deposits paused and caps below existing reserve while exercising the
following actual-proof spends and exits. Fee acceptance uses explicit synthetic
DEX router/liquidity fixtures. Mock-verifier cap/governance tests are
separate contract-accounting evidence and do not prove Groth16 soundness. None
of these reports establishes public mainnet execution, real market liquidity,
production capacity, or a measured anonymity set.

Use the repository's audit verification commands for current checks. Run
acceptance procedures that regenerate reports in an isolated copy: fresh local
transactions and timestamps do not reproduce the bytes of a previously frozen
report.
