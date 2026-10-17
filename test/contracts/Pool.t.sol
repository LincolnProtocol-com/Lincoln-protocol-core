// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {Base, MockJoinSplitVerifier, MockExitVerifier, MockToken} from './Base.sol';
import {Phase2ASPPool} from '../../contracts/Phase2ASPPool.sol';
import {Phase2ASPRegistry} from '../../contracts/Phase2ASPRegistry.sol';
import {PoseidonT3} from 'poseidon-solidity/PoseidonT3.sol';

contract PoolTest is Base {
    Phase2ASPRegistry internal registry;
    Phase2ASPPool internal pool;
    MockJoinSplitVerifier internal verifier;
    MockExitVerifier internal exitVerifier;
    uint256 internal nonce;

    receive() external payable {}

    function setUp() public {
        registry = deployRegistry();
        verifier = new MockJoinSplitVerifier();
        exitVerifier = new MockExitVerifier();
        pool = new Phase2ASPPool(address(verifier), address(exitVerifier), address(registry), address(0), type(uint128).max, type(uint128).max);
        publish(registry, 1, 7 days);
        vm.deal(address(this), 1_000_000 ether);
    }

    function deposit(uint128 value) internal returns (uint256 commitment) {
        commitment = pool.depositDynamic{value: value}(value, ++nonce, cipher(nonce));
    }

    function withdraw(uint128 amount, bytes[2] memory out) internal returns (uint256[9] memory s) {
        Phase2ASPPool.ExtData memory data = selfData(amount, address(0xCAFE));
        s = signals(pool, pool.hashContext(data, out), ++nonce, ++nonce, 0, 0, amount);
        pool.transact([uint256(0), 0], [[uint256(0), 0], [uint256(0), 0]], [uint256(0), 0], s, data, out);
    }

    // ---------------------------------------------------------------- M2 fix

    /// A proof built against epoch N still lands after the provider publishes
    /// N+1 (previously: ContextMismatch for every in-flight proof).
    function test_M2_inFlightProofSurvivesPolicyUpdate() public {
        deposit(5 ether);
        bytes[2] memory out = outputs(1);
        Phase2ASPPool.ExtData memory data = selfData(1 ether, address(0xCAFE));
        uint256 context = pool.hashContext(data, out);
        skip(60);
        publish(registry, 2, 7 days);
        uint256[9] memory s = signals(pool, context, 101, 102, 0, 0, 1 ether);
        pool.transact([uint256(0), 0], [[uint256(0), 0], [uint256(0), 0]], [uint256(0), 0], s, data, out);
        eq(address(0xCAFE).balance, 1 ether, 'paid');
    }

    function testFuzz_M2_supersededGraceIsBounded(uint256 wait) public {
        deposit(5 ether);
        wait = bound(wait, 0, 3 hours);
        bytes[2] memory out = outputs(2);
        Phase2ASPPool.ExtData memory data = selfData(1 ether, address(0xCAFE));
        uint256 context = pool.hashContext(data, out);
        publish(registry, 2, 7 days);
        skip(wait);
        uint256[9] memory s = signals(pool, context, 201, 202, 0, 0, 1 ether);
        if (wait >= registry.SUPERSEDED_POLICY_GRACE()) vm.expectRevert(Phase2ASPPool.ContextMismatch.selector);
        pool.transact([uint256(0), 0], [[uint256(0), 0], [uint256(0), 0]], [uint256(0), 0], s, data, out);
    }

    function test_M2_windowCapsOlderEpochs() public {
        deposit(5 ether);
        bytes[2] memory out = outputs(3);
        Phase2ASPPool.ExtData memory data = selfData(1 ether, address(0xCAFE));
        uint256 context = pool.hashContext(data, out);
        uint256 window = registry.ACCEPTED_POLICY_WINDOW();
        eq(window, 16, 'release window');
        for (uint256 i = 2; i <= window + 1; i++) publish(registry, i, 7 days);
        uint256[9] memory s = signals(pool, context, 301, 302, 0, 0, 1 ether);
        vm.expectRevert(Phase2ASPPool.ContextMismatch.selector);
        pool.transact([uint256(0), 0], [[uint256(0), 0], [uint256(0), 0]], [uint256(0), 0], s, data, out);
        // With latest=window+1, epoch 2 is the oldest still accepted epoch.
        uint256 epoch2 = pool.hashContextForEpoch(data, out, 2);
        s = signals(pool, epoch2, 303, 304, 0, 0, 1 ether);
        pool.transact([uint256(0), 0], [[uint256(0), 0], [uint256(0), 0]], [uint256(0), 0], s, data, out);
    }

    function test_M1_suspensionHaltsSpendsButNotExits() public {
        uint256 commitment = deposit(3 ether);
        bytes[2] memory out = outputs(4);
        Phase2ASPPool.ExtData memory data = selfData(1 ether, address(0xCAFE));
        uint256 context = pool.hashContext(data, out);
        vm.prank(GUARDIAN);
        registry.suspendProvider();
        uint256[9] memory s = signals(pool, context, 401, 402, 0, 0, 1 ether);
        vm.expectRevert(Phase2ASPPool.UnavailableASPPolicy.selector);
        pool.transact([uint256(0), 0], [[uint256(0), 0], [uint256(0), 0]], [uint256(0), 0], s, data, out);
        vm.expectRevert(Phase2ASPPool.UnavailableASPPolicy.selector);
        pool.hashContext(data, out);

        Phase2ASPPool.HolderExitData memory exitData = Phase2ASPPool.HolderExitData({processor: address(this),
            recipient: address(0xD00D), feeRecipient: address(0), fee: 0});
        uint256[5] memory exitSignals = [commitment, 403, 3 ether, pool.SCOPE(), pool.holderExitContext(exitData)];
        pool.holderExit(exitData, Phase2ASPPool.HolderExitProof([uint256(0), 0], [[uint256(0), 0], [uint256(0), 0]],
            [uint256(0), 0], exitSignals));
        eq(address(0xD00D).balance, 3 ether, 'exit still works');
    }

    function test_expiredPolicyStillReportsExpired() public {
        deposit(1 ether);
        skip(8 days);
        bytes[2] memory out = outputs(5);
        Phase2ASPPool.ExtData memory data = selfData(1 ether, address(0xCAFE));
        vm.expectRevert(Phase2ASPPool.ExpiredASPPolicy.selector);
        pool.hashContext(data, out);
        uint256[9] memory s = signals(pool, 1, 501, 502, 0, 0, 1 ether);
        vm.expectRevert(Phase2ASPPool.ExpiredASPPolicy.selector);
        pool.transact([uint256(0), 0], [[uint256(0), 0], [uint256(0), 0]], [uint256(0), 0], s, data, out);
    }

    /// Provider rotation changes the provider bound in the base context, so
    /// proofs made for the previous provider are rejected.
    function test_M1_rotationRebindsContext() public {
        deposit(2 ether);
        bytes[2] memory out = outputs(6);
        Phase2ASPPool.ExtData memory data = selfData(1 ether, address(0xCAFE));
        uint256 context = pool.hashContext(data, out);
        vm.prank(GUARDIAN);
        registry.proposeProvider(address(0xBEEF));
        skip(3 days);
        vm.prank(address(0xBEEF));
        registry.acceptProvider();
        uint256[9] memory s = signals(pool, context, 601, 602, 0, 0, 1 ether);
        vm.expectRevert(Phase2ASPPool.ContextMismatch.selector);
        pool.transact([uint256(0), 0], [[uint256(0), 0], [uint256(0), 0]], [uint256(0), 0], s, data, out);
    }

    // ------------------------------------------------- deposits & the tree

    function testFuzz_depositBindsMeasuredValue(uint128 value, uint256 pre) public {
        value = uint128(bound(value, 1, 1_000 ether));
        pre = bound(pre, 1, FIELD - 1);
        uint256 before = address(pool).balance;
        uint256 commitment = pool.depositDynamic{value: value}(value, pre, cipher(pre));
        eq(commitment, PoseidonT3.hash([uint256(value), pre]), 'commitment');
        check(pool.commitments(commitment), 'recorded');
        eq(address(pool).balance, before + value, 'custody');
        check(pool.originalDepositor(commitment) == address(this), 'depositor');
    }

    function testFuzz_depositRejectsValueMismatch(uint128 value, uint128 sent) public {
        value = uint128(bound(value, 1, 1_000 ether));
        sent = uint128(bound(sent, 0, 1_000 ether));
        vm.assume(sent != value);
        vm.expectRevert(Phase2ASPPool.AssetAmountMismatch.selector);
        pool.depositDynamic{value: sent}(value, 5, cipher(5));
    }

    function testFuzz_depositRejectsOutOfFieldPrecommitment(uint256 pre) public {
        pre = bound(pre, FIELD, type(uint256).max);
        vm.expectRevert(Phase2ASPPool.InvalidPublicInputs.selector);
        pool.depositDynamic{value: 1}(1, pre, cipher(1));
    }

    /// Incremental insertion equals a from-scratch Merkle root.
    function testFuzz_incrementalTreeMatchesReference(uint256 seed, uint8 count) public {
        count = uint8(bound(count, 1, 33));
        uint256[] memory leaves = new uint256[](count);
        for (uint256 i; i < count; i++) {
            uint128 value = uint128(bound(uint256(keccak256(abi.encode(seed, i))), 1, 1 ether));
            leaves[i] = pool.depositDynamic{value: value}(value, i + 1 + seed % 1e9, cipher(i));
            check(pool.knownRoot(pool.currentRoot()), 'current root known');
        }
        eq(pool.currentRoot(), referenceRoot(leaves), 'root');
        eq(pool.nextLeafIndex(), count, 'leaf count');
    }

    function referenceRoot(uint256[] memory leaves) internal view returns (uint256) {
        uint256 width = leaves.length;
        uint256[] memory level = leaves;
        for (uint256 depth; depth < 20; depth++) {
            uint256 next = (width + 1) / 2;
            uint256[] memory parents = new uint256[](next);
            for (uint256 i; i < next; i++) {
                uint256 left = level[2 * i];
                uint256 right = 2 * i + 1 < width ? level[2 * i + 1] : pool.zeros(depth);
                parents[i] = PoseidonT3.hash([left, right]);
            }
            level = parents;
            width = next;
        }
        return level[0];
    }

    // --------------------------------------------- transact authorization

    function testFuzz_transactRejectsTamperedSignals(uint8 index, uint256 delta) public {
        deposit(5 ether);
        index = uint8(bound(index, 0, 4));
        delta = bound(delta, 1, FIELD - 1);
        bytes[2] memory out = outputs(7);
        Phase2ASPPool.ExtData memory data = selfData(1 ether, address(0xCAFE));
        uint256[9] memory s = signals(pool, pool.hashContext(data, out), 701, 702, 0, 0, 1 ether);
        s[index] = addmod(s[index], delta, FIELD);
        vm.expectRevert();
        pool.transact([uint256(0), 0], [[uint256(0), 0], [uint256(0), 0]], [uint256(0), 0], s, data, out);
    }

    function testFuzz_transactRejectsTamperedExtData(uint8 field, address other) public {
        deposit(5 ether);
        field = uint8(bound(field, 0, 3));
        bytes[2] memory out = outputs(8);
        Phase2ASPPool.ExtData memory data = selfData(1 ether, address(0xCAFE));
        uint256[9] memory s = signals(pool, pool.hashContext(data, out), 801, 802, 0, 0, 1 ether);
        if (field == 0) { vm.assume(other != data.recipient && other != address(0) && other != address(pool)); data.recipient = other; }
        if (field == 1) { data.fee = 1; data.feeRecipient = address(0xFEE); }
        if (field == 2) out[0] = cipher(999);
        if (field == 3) out[1] = cipher(998);
        vm.expectRevert(Phase2ASPPool.ContextMismatch.selector);
        pool.transact([uint256(0), 0], [[uint256(0), 0], [uint256(0), 0]], [uint256(0), 0], s, data, out);
    }

    function testFuzz_signalsMustBeInField(uint8 index, uint256 value) public {
        deposit(5 ether);
        index = uint8(bound(index, 0, 8));
        value = bound(value, FIELD, type(uint256).max);
        bytes[2] memory out = outputs(9);
        Phase2ASPPool.ExtData memory data = selfData(1 ether, address(0xCAFE));
        uint256[9] memory s = signals(pool, pool.hashContext(data, out), 901, 902, 0, 0, 1 ether);
        s[index] = value;
        vm.expectRevert(Phase2ASPPool.InvalidPublicInputs.selector);
        pool.transact([uint256(0), 0], [[uint256(0), 0], [uint256(0), 0]], [uint256(0), 0], s, data, out);
    }

    function test_nullifierCannotBeReused() public {
        deposit(5 ether);
        bytes[2] memory out = outputs(10);
        uint256[9] memory s = withdraw(1 ether, out);
        Phase2ASPPool.ExtData memory data = selfData(1 ether, address(0xCAFE));
        s[3] = pool.hashContext(data, out);
        vm.expectRevert(Phase2ASPPool.AlreadySpent.selector);
        pool.transact([uint256(0), 0], [[uint256(0), 0], [uint256(0), 0]], [uint256(0), 0], s, data, out);
    }

    function testFuzz_onlyProcessorSubmits(address caller) public {
        vm.assume(caller != address(this));
        deposit(5 ether);
        bytes[2] memory out = outputs(11);
        Phase2ASPPool.ExtData memory data = selfData(1 ether, address(0xCAFE));
        uint256[9] memory s = signals(pool, pool.hashContext(data, out), 1101, 1102, 0, 0, 1 ether);
        vm.prank(caller);
        vm.expectRevert(Phase2ASPPool.InvalidProcessor.selector);
        pool.transact([uint256(0), 0], [[uint256(0), 0], [uint256(0), 0]], [uint256(0), 0], s, data, out);
    }

    function testFuzz_feeSplit(uint128 publicOut, uint128 fee) public {
        deposit(100 ether);
        publicOut = uint128(bound(publicOut, 1, 100 ether));
        fee = uint128(bound(fee, 0, publicOut));
        bytes[2] memory out = outputs(12);
        Phase2ASPPool.ExtData memory data = Phase2ASPPool.ExtData({recipient: address(0xCAFE), feeRecipient: address(0xFEE),
            processor: address(this), publicIn: 0, publicOut: publicOut, fee: fee});
        uint256[9] memory s = signals(pool, pool.hashContext(data, out), 1201, 1202, 0, 0, publicOut);
        pool.transact([uint256(0), 0], [[uint256(0), 0], [uint256(0), 0]], [uint256(0), 0], s, data, out);
        eq(address(0xCAFE).balance, publicOut - fee, 'recipient');
        eq(address(0xFEE).balance, fee, 'fee');
    }

    // ------------------------------------------------------------- exits

    function testFuzz_holderExitFee(uint128 value, uint128 fee) public {
        value = uint128(bound(value, 1, 100 ether));
        fee = uint128(bound(fee, 0, type(uint128).max));
        uint256 commitment = deposit(value);
        Phase2ASPPool.HolderExitData memory d = Phase2ASPPool.HolderExitData({processor: address(this),
            recipient: address(0xD00D), feeRecipient: address(0xFEE), fee: fee});
        uint256[5] memory sig = [commitment, 77, uint256(value), pool.SCOPE(), pool.holderExitContext(d)];
        Phase2ASPPool.HolderExitProof memory proof = Phase2ASPPool.HolderExitProof([uint256(0), 0],
            [[uint256(0), 0], [uint256(0), 0]], [uint256(0), 0], sig);
        if (fee > value) vm.expectRevert(Phase2ASPPool.InvalidFee.selector);
        pool.holderExit(d, proof);
        if (fee <= value) {
            eq(address(0xD00D).balance, value - fee, 'payout');
            eq(address(0xFEE).balance, fee, 'fee');
            vm.expectRevert(Phase2ASPPool.AlreadySpent.selector);
            pool.holderExit(d, proof);
        }
    }

    function testFuzz_exitRejectsUnknownCommitment(uint256 commitment) public {
        commitment = bound(commitment, 1, FIELD - 1);
        Phase2ASPPool.HolderExitData memory d = Phase2ASPPool.HolderExitData({processor: address(this),
            recipient: address(0xD00D), feeRecipient: address(0), fee: 0});
        uint256[5] memory sig = [commitment, 78, 1, pool.SCOPE(), pool.holderExitContext(d)];
        vm.expectRevert(Phase2ASPPool.InvalidCommitment.selector);
        pool.holderExit(d, Phase2ASPPool.HolderExitProof([uint256(0), 0], [[uint256(0), 0], [uint256(0), 0]], [uint256(0), 0], sig));
    }

    function testFuzz_ragequitOnlyToDepositor(address recipient) public {
        vm.assume(recipient != address(this) && recipient != address(0) && recipient != address(pool));
        uint256 commitment = deposit(1 ether);
        Phase2ASPPool.HolderExitData memory d = Phase2ASPPool.HolderExitData({processor: address(this),
            recipient: recipient, feeRecipient: address(0), fee: 0});
        uint256[5] memory sig = [commitment, 79, 1 ether, pool.SCOPE(), pool.holderExitContext(d)];
        vm.expectRevert(Phase2ASPPool.InvalidRagequit.selector);
        pool.ragequit(d, Phase2ASPPool.HolderExitProof([uint256(0), 0], [[uint256(0), 0], [uint256(0), 0]], [uint256(0), 0], sig));
    }

    // ---------------------------------------- open finding: M3 (unchanged)

    /// Audit finding M3 (root eviction half, fixed): every historical root stays
    /// valid, so dust deposits past ROOT_HISTORY_SIZE cannot void a pending proof.
    function testFuzz_M3_dustDepositsCannotEvictRoots(uint8 extra) public {
        deposit(5 ether);
        bytes[2] memory out = outputs(13);
        Phase2ASPPool.ExtData memory data = selfData(1 ether, address(0xCAFE));
        uint256[9] memory s = signals(pool, pool.hashContext(data, out), 1301, 1302, 0, 0, 1 ether);
        uint256 dust = pool.ROOT_HISTORY_SIZE() + bound(extra, 0, 50);
        for (uint256 i; i < dust; i++) pool.depositDynamic{value: 1}(1, 10_000 + i, cipher(i));
        check(pool.knownRoot(s[0]), 'old root still known');
        check(!pool.knownRoot(12345), 'arbitrary root unknown');
        pool.transact([uint256(0), 0], [[uint256(0), 0], [uint256(0), 0]], [uint256(0), 0], s, data, out);
    }
}
