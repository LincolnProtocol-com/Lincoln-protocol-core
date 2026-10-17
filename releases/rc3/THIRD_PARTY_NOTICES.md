# License and third-party notices

This audit repository contains files with different licenses. There is no single
license grant for the entire repository. Preserve each source file's SPDX header
and any upstream notices when copying or redistributing it. The texts in
`LICENSES/` document the licenses identified below; they do not replace the
individual file notices or relicense dependencies.

## Lincoln source files

The first-party Solidity contracts, Circom source files, and JavaScript files that
carry `SPDX-License-Identifier: Apache-2.0` identify Apache License 2.0 as their
license. See [Apache-2.0.txt](LICENSES/Apache-2.0.txt). This notice does not assign
invented contributor names or copyright years, and it does not infer a license
for an unmarked file.

The generated verification contracts in
`protocol/phase2-mainnet/generated/Phase2ASPJoinSplitVerifier.sol` and
`protocol/phase2-mainnet/generated/Phase2ASPExitVerifier.sol` retain the
`GPL-3.0` SPDX identifier from the SnarkJS Groth16 Solidity template. Their
deterministic Solidity pragma and contract-name transformations do not remove
that notice. See the preserved [SnarkJS COPYING](LICENSES/snarkjs-GPL-3.0-COPYING.txt).
The circuit source, generated verifier, public parameter data, and build tooling
must not all be described as Apache-2.0 merely because some first-party files use
that identifier.

## Contract and circuit dependencies

| Component | Exact version | Identification and provenance | License text |
| --- | --- | --- | --- |
| OpenZeppelin Contracts | 5.0.2 | MIT in package metadata and imported Solidity headers; upstream notice retained verbatim from tag `v5.0.2` | [OpenZeppelin-MIT.txt](LICENSES/OpenZeppelin-MIT.txt) |
| poseidon-solidity | 0.0.5 | MIT in package metadata and `PoseidonT3.sol` / `PoseidonT4.sol`; npm release identifies upstream commit `8205c97ec4a35a9adb854b70b2c9ba92668d1304` | [MIT reference text](LICENSES/MIT-template.txt) |
| SnarkJS | 0.7.5 | GPL-3.0 in package metadata; includes the Groth16 verifier template | [Package COPYING, verbatim](LICENSES/snarkjs-GPL-3.0-COPYING.txt) |
| circom2 npm compiler package | 0.2.22 | GPL-3.0 in package metadata; package embeds Circom compiler 2.2.2; npm release identifies upstream commit `402f7a05bc089e6f583ff0f61a4e987d66af07a4` | [Upstream COPYING, verbatim](LICENSES/circom2-GPL-3.0.txt) |
| Circomlib | 2.0.5 | GPL-3.0 in package metadata; npm release identifies upstream commit `cff5ab6288b55ef23602221694a6a38a0239dcc0` | [GPL v3 reference text](LICENSES/circom2-GPL-3.0.txt) |

The published `poseidon-solidity@0.0.5` and `circomlib@2.0.5` packages do not
contain a standalone license file, and neither corresponding upstream commit
contains a `LICENSE`, `COPYING`, or `NOTICE` file. Their package declarations and
source notices have been retained rather than inventing upstream copyright
notices. `MIT-template.txt` is the SPDX reference text with its original
placeholders; those placeholders are not a claim about the authorship of
Poseidon Solidity. The Circom2 GPL text is a reference to the same GPL version
declared by Circomlib, not a claim that Circomlib distributed that particular
file.

OpenZeppelin's exact upstream notice states: `Copyright (c) 2016-2023 zOS Global
Limited and contributors`. It is reproduced in its license file without
substituting Lincoln as the copyright holder.

## License text sources

| Local file | Source | SHA256 |
| --- | --- | --- |
| `LICENSES/Apache-2.0.txt` | <https://www.apache.org/licenses/LICENSE-2.0.txt> | `cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30` |
| `LICENSES/OpenZeppelin-MIT.txt` | <https://raw.githubusercontent.com/OpenZeppelin/openzeppelin-contracts/v5.0.2/LICENSE> | `0e05b4f45c8769ece14ba2d202bf6f5ed7132600b642c981266f7255e0187ea3` |
| `LICENSES/MIT-template.txt` | <https://raw.githubusercontent.com/spdx/license-list-data/v3.27.0/text/MIT.txt> | `b05785f9f18e6716bab63424b11454513b9943a222595b70411009202fc592b5` |
| `LICENSES/circom2-GPL-3.0.txt` | <https://raw.githubusercontent.com/antimatter15/circom/402f7a05bc089e6f583ff0f61a4e987d66af07a4/COPYING> | `0fc5a3443bee9d6062c38372c5cd07c35fb58e536940057835107fbe9354e48b` |
| `LICENSES/snarkjs-GPL-3.0-COPYING.txt` | Exact `COPYING` bytes from the installed npm release `snarkjs@0.7.5`, distributed at <https://registry.npmjs.org/snarkjs/-/snarkjs-0.7.5.tgz> | `d95c74a62d14f13ebfbc8c1783c315e2ed2389e80048b264bdeddb8114dee945` |

Release metadata sources:

- <https://registry.npmjs.org/poseidon-solidity/0.0.5>
- <https://registry.npmjs.org/circomlib/2.0.5>
- <https://registry.npmjs.org/circom2/0.2.22>
- <https://github.com/vimwitch/poseidon-solidity/tree/8205c97ec4a35a9adb854b70b2c9ba92668d1304>
- <https://github.com/iden3/circomlib/tree/cff5ab6288b55ef23602221694a6a38a0239dcc0>
- <https://github.com/antimatter15/circom/tree/402f7a05bc089e6f583ff0f61a4e987d66af07a4>

The lockfiles also install runtime and transitive tooling dependencies. Those
packages retain their own license terms and notices in their npm distributions;
this list is focused on the contract imports, circuit library, compiler, and
proof/verifier tooling in the core audit scope. It is not an assertion that every
transitive package has the same license or a legal conclusion about the licensing
of a combined binary.

Public proving parameters are described separately in
[Parameter provenance](docs/PARAMETER_PROVENANCE.md). No license is inferred for
their data bytes from the historical directory name used to store the ptau file.
