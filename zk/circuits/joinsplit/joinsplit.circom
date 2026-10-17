// SPDX-License-Identifier: Apache-2.0
// Experimental current-note ASP JoinSplit. Development parameters only.
pragma circom 2.2.0;
include "circomlib/circuits/poseidon.circom";
include "circomlib/circuits/comparators.circom";
include "circomlib/circuits/bitify.circom";

template FixedMerklePath(depth) {
    signal input leaf;
    signal input index;
    signal input siblings[depth];
    signal output root;
    component bits = Num2Bits(depth);
    bits.in <== index;
    signal nodes[depth + 1];
    signal left[depth];
    signal right[depth];
    component hashes[depth];
    nodes[0] <== leaf;
    for (var level = 0; level < depth; level++) {
        left[level] <== nodes[level] + bits.out[level] * (siblings[level] - nodes[level]);
        right[level] <== siblings[level] + bits.out[level] * (nodes[level] - siblings[level]);
        hashes[level] = Poseidon(2);
        hashes[level].inputs[0] <== left[level];
        hashes[level].inputs[1] <== right[level];
        nodes[level + 1] <== hashes[level].out;
    }
    root <== nodes[depth];
}

template ASPJoinSplit(depth) {
    // Ordering is ABI: these nine public fields have no inherited deposit label.
    signal input root;
    signal input publicIn;
    signal input publicOut;
    signal input context;
    signal input scope;
    signal input inputNullifiers[2];
    signal input outputCommitments[2];

    // The normal spend is bound to the current registry's policy tuple by the
    // contract. Epoch/expiry freshness is checked by the contract, not a clock
    // inside the circuit. Association membership is scoped to this exact pool.
    signal input contextBase;
    signal input aspRoot;
    signal input aspEpoch;
    signal input aspValidUntil;
    signal input inputASPPathIndices[2];
    signal input inputASPPathElements[2][depth];

    signal input inputValues[2];
    signal input inputSecrets[2];
    signal input inputBlindings[2];
    signal input inputPathIndices[2];
    signal input inputPathElements[2][depth];
    signal input outputValues[2];
    signal input outputPubKeys[2];
    signal input outputBlindings[2];

    // Funding is solely depositDynamic: a normal proof cannot introduce an
    // unreviewed public deposit and spend it in the same operation.
    publicIn === 0;
    component aspRootZero = IsZero();
    aspRootZero.in <== aspRoot;
    aspRootZero.out === 0;
    component aspEpochRange = Num2Bits(64);
    aspEpochRange.in <== aspEpoch;
    component aspValidUntilRange = Num2Bits(64);
    aspValidUntilRange.in <== aspValidUntil;
    component aspEpochZero = IsZero();
    aspEpochZero.in <== aspEpoch;
    aspEpochZero.out === 0;
    component aspValidUntilZero = IsZero();
    aspValidUntilZero.in <== aspValidUntil;
    aspValidUntilZero.out === 0;
    component policyHash = Poseidon(3);
    policyHash.inputs[0] <== aspRoot;
    policyHash.inputs[1] <== aspEpoch;
    policyHash.inputs[2] <== aspValidUntil;
    component policyContext = Poseidon(2);
    policyContext.inputs[0] <== contextBase;
    policyContext.inputs[1] <== policyHash.out;
    policyContext.out === context;

    component publicInRange = Num2Bits(128);
    component publicOutRange = Num2Bits(128);
    publicInRange.in <== publicIn;
    publicOutRange.in <== publicOut;
    component inputRanges[2];
    component outputRanges[2];
    component owners[2];
    component inputPrecommitments[2];
    component inputHashes[2];
    component nullifiers[2];
    component paths[2];
    component aspLeaves[2];
    component aspPaths[2];
    component inputZero[2];
    component secretZero[2];
    component inputBlindZero[2];
    component outputBlindZero[2];
    component outputOwnerZero[2];
    component outputPrecommitments[2];
    component outputHashes[2];
    component commitmentZero[2];
    component outputZero[2];
    component nullifierZero[2];

    for (var i = 0; i < 2; i++) {
        inputRanges[i] = Num2Bits(128);
        inputRanges[i].in <== inputValues[i];
        outputRanges[i] = Num2Bits(128);
        outputRanges[i].in <== outputValues[i];
        secretZero[i] = IsZero();
        secretZero[i].in <== inputSecrets[i];
        secretZero[i].out === 0;
        inputBlindZero[i] = IsZero();
        inputBlindZero[i].in <== inputBlindings[i];
        inputBlindZero[i].out === 0;
        outputBlindZero[i] = IsZero();
        outputBlindZero[i].in <== outputBlindings[i];
        outputBlindZero[i].out === 0;
        outputOwnerZero[i] = IsZero();
        outputOwnerZero[i].in <== outputPubKeys[i];
        outputOwnerZero[i].out === 0;

        owners[i] = Poseidon(1);
        owners[i].inputs[0] <== inputSecrets[i];
        // Factor the note so an atomic DEX adapter can insert its measured
        // output value without learning the receiver's owner key or blinding.
        inputPrecommitments[i] = Poseidon(2);
        inputPrecommitments[i].inputs[0] <== owners[i].out;
        inputPrecommitments[i].inputs[1] <== inputBlindings[i];
        inputHashes[i] = Poseidon(2);
        inputHashes[i].inputs[0] <== inputValues[i];
        inputHashes[i].inputs[1] <== inputPrecommitments[i].out;
        nullifiers[i] = Poseidon(3);
        nullifiers[i].inputs[0] <== inputSecrets[i];
        nullifiers[i].inputs[1] <== inputHashes[i].out;
        nullifiers[i].inputs[2] <== scope;
        nullifiers[i].out === inputNullifiers[i];
        nullifierZero[i] = IsZero();
        nullifierZero[i].in <== inputNullifiers[i];
        nullifierZero[i].out === 0;

        paths[i] = FixedMerklePath(depth);
        paths[i].leaf <== inputHashes[i].out;
        paths[i].index <== inputPathIndices[i];
        paths[i].siblings <== inputPathElements[i];
        // A zero-value padding input needs no deposit. It still has constrained
        // ownership and a fresh nullifier; every positive input proves membership.
        inputZero[i] = IsZero();
        inputZero[i].in <== inputValues[i];
        (paths[i].root - root) * (1 - inputZero[i].out) === 0;

        aspLeaves[i] = Poseidon(2);
        aspLeaves[i].inputs[0] <== inputHashes[i].out;
        aspLeaves[i].inputs[1] <== scope;
        aspPaths[i] = FixedMerklePath(depth);
        aspPaths[i].leaf <== aspLeaves[i].out;
        aspPaths[i].index <== inputASPPathIndices[i];
        aspPaths[i].siblings <== inputASPPathElements[i];
        (aspPaths[i].root - aspRoot) * (1 - inputZero[i].out) === 0;

        outputPrecommitments[i] = Poseidon(2);
        outputPrecommitments[i].inputs[0] <== outputPubKeys[i];
        outputPrecommitments[i].inputs[1] <== outputBlindings[i];
        outputHashes[i] = Poseidon(2);
        outputHashes[i].inputs[0] <== outputValues[i];
        outputHashes[i].inputs[1] <== outputPrecommitments[i].out;
        outputZero[i] = IsZero();
        outputZero[i].in <== outputValues[i];
        // Canonical zero outputs do not occupy tree slots. This exposes the
        // number of positive outputs but allows withdrawals after tree capacity.
        outputCommitments[i] === outputHashes[i].out * (1 - outputZero[i].out);
        commitmentZero[i] = IsZero();
        commitmentZero[i].in <== outputCommitments[i];
        commitmentZero[i].out === outputZero[i].out;
    }

    // Each side is < 3 * 2^128, far below the BN254 scalar field. Therefore
    // equality cannot manufacture value through modular wraparound.
    inputValues[0] + inputValues[1] + publicIn === outputValues[0] + outputValues[1] + publicOut;
    component distinctInputs = IsEqual();
    distinctInputs.in[0] <== inputNullifiers[0];
    distinctInputs.in[1] <== inputNullifiers[1];
    distinctInputs.out === 0;
    component distinctOutputs = IsEqual();
    distinctOutputs.in[0] <== outputCommitments[0];
    distinctOutputs.in[1] <== outputCommitments[1];
    distinctOutputs.out * (1 - outputZero[0].out) === 0;
    // policyContext above binds the existing external-data context together
    // with the registry root, monotonic epoch and validity deadline.
}
