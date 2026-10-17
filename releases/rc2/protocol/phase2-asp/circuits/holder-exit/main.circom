// SPDX-License-Identifier: Apache-2.0
pragma circom 2.2.0;
include "circomlib/circuits/poseidon.circom";
include "circomlib/circuits/comparators.circom";
include "circomlib/circuits/bitify.circom";

// Public holder exit intentionally reveals the exact commitment and value.
// It uses the same nullifier as JoinSplit, so a contract's shared spent set
// prevents a note from being withdrawn twice through different entry points.
template HolderExit() {
    signal input commitment;
    signal input nullifier;
    signal input value;
    signal input scope;
    signal input context;
    signal input secret;
    signal input blinding;

    component range = Num2Bits(128);
    range.in <== value;
    component valueZero = IsZero();
    valueZero.in <== value;
    valueZero.out === 0;
    component secretZero = IsZero();
    secretZero.in <== secret;
    secretZero.out === 0;
    component blindZero = IsZero();
    blindZero.in <== blinding;
    blindZero.out === 0;
    component commitmentZero = IsZero();
    commitmentZero.in <== commitment;
    commitmentZero.out === 0;
    component nullifierZero = IsZero();
    nullifierZero.in <== nullifier;
    nullifierZero.out === 0;

    component owner = Poseidon(1);
    owner.inputs[0] <== secret;
    component precommitment = Poseidon(2);
    precommitment.inputs[0] <== owner.out;
    precommitment.inputs[1] <== blinding;
    component note = Poseidon(2);
    note.inputs[0] <== value;
    note.inputs[1] <== precommitment.out;
    note.out === commitment;
    component spent = Poseidon(3);
    spent.inputs[0] <== secret;
    spent.inputs[1] <== commitment;
    spent.inputs[2] <== scope;
    spent.out === nullifier;

    // Retain a nonlinear occurrence after O2; a linear unused mirror can be
    // eliminated by optimization. Public-input mutation tests verify binding.
    component externalBinding = Poseidon(2);
    externalBinding.inputs[0] <== context;
    externalBinding.inputs[1] <== secret;
    signal contextBindingSquared <== externalBinding.out * externalBinding.out;
}

component main {public [commitment, nullifier, value, scope, context]} = HolderExit();
