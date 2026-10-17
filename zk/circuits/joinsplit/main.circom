// SPDX-License-Identifier: Apache-2.0
pragma circom 2.2.0;
include "./joinsplit.circom";
component main {public [root, publicIn, publicOut, context, scope, inputNullifiers, outputCommitments]} = ASPJoinSplit(20);
