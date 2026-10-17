// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {Base, MockJoinSplitVerifier, MockExitVerifier} from './Base.sol';
import {Phase2ASPPool} from '../../contracts/Phase2ASPPool.sol';
import {Phase2ASPRegistry} from '../../contracts/Phase2ASPRegistry.sol';

/// @dev Drives the pool like honest provers would, with a ghost note model.
/// The verifier mock accepts everything, so the handler only builds signals a
/// sound circuit could produce (value conservation, one nullifier per note).
/// Attack actions try what a sound circuit would still allow an adversary to
/// submit (replays, cross-entry double spends) and record any success.
contract PoolHandler is Base {
    struct Note {
        uint256 commitment;
        uint128 value;
        bool spent;
    }

    Phase2ASPPool public immutable pool;
    Phase2ASPRegistry public immutable registry;
    Note[] internal notes;
    uint256 public ghostBalance;
    uint256 public ghostDonations;
    uint256 public ghostLeaves;
    uint256 public violations;
    uint256 public calls;
    uint256 internal counter;
    uint256 internal rootCounter = 100;
    address internal constant DEPOSITOR = address(0xD3905);
    mapping(uint256 => bool) internal spentNullifier;

    receive() external payable {}

    constructor(Phase2ASPPool pool_, Phase2ASPRegistry registry_) {
        pool = pool_;
        registry = registry_;
    }

    function noteCount() external view returns (uint256) { return notes.length; }

    function nullifierOf(uint256 commitment) internal pure returns (uint256) {
        return uint256(keccak256(abi.encode('nullifier', commitment))) % (FIELD - 1) + 1;
    }

    function fresh() internal returns (uint256) {
        return uint256(keccak256(abi.encode('fresh', ++counter))) % (FIELD - 1) + 1;
    }

    function pick(uint256 seed) internal view returns (bool found, uint256 index) {
        uint256 n = notes.length;
        for (uint256 k; k < n; k++) {
            index = (seed % n + k) % n;
            if (!notes[index].spent) return (true, index);
        }
        return (false, 0);
    }

    function keepPolicyLive() internal {
        (, uint64 epoch, uint64 validUntil) = registry.latestPolicy();
        if (epoch == 0 || validUntil <= now_() + 1 hours) publish(registry, ++rootCounter, 7 days);
    }

    function _add(uint256 commitment, uint128 value) internal {
        notes.push(Note(commitment, value, false));
        ghostLeaves++;
    }

    function _spend(uint256 index) internal returns (uint256 nullifier) {
        notes[index].spent = true;
        nullifier = nullifierOf(notes[index].commitment);
        spentNullifier[nullifier] = true;
        ghostBalance -= notes[index].value;
    }

    // ------------------------------------------------------------- actions

    function deposit(uint256 valueSeed) external {
        calls++;
        if (pool.depositsPaused() || pool.accountedBalance() >= pool.maxTotal()) return;
        uint256 capacity = uint256(pool.maxTotal()) - pool.accountedBalance();
        if (capacity > pool.maxDeposit()) capacity = pool.maxDeposit();
        if (capacity > 10 ether) capacity = 10 ether;
        uint128 value = uint128(bound(valueSeed, 1, capacity));
        // An EOA depositor: ragequit refuses contract depositors (audit L1).
        vm.deal(DEPOSITOR, value);
        uint256 precommitment = fresh();
        vm.prank(DEPOSITOR);
        uint256 commitment = pool.depositDynamic{value: value}(value, precommitment, cipher(counter));
        _add(commitment, value);
        ghostBalance += value;
    }

    /// Two-in/two-out private transfer (second input may be zero padding).
    function transfer(uint256 seedA, uint256 seedB, uint256 splitSeed, bool delayed) external {
        calls++;
        (bool foundA, uint256 a) = pick(seedA);
        if (!foundA) return;
        keepPolicyLive();
        (bool foundB, uint256 b) = pick(seedB);
        bool two = foundB && b != a;
        uint128 total = notes[a].value + (two ? notes[b].value : 0);
        uint128 out0 = uint128(bound(splitSeed, 0, total));
        uint128 out1 = total - out0;
        bytes[2] memory out = outputs(++counter);
        Phase2ASPPool.ExtData memory data = selfData(0, address(0));
        if (out0 == 0 && out1 == 0) return;
        uint256 context = pool.hashContext(data, out);
        // Proof generated, then a policy update lands before submission.
        if (delayed) { skip(30); publish(registry, ++rootCounter, 7 days); }
        uint256 c0 = out0 == 0 ? 0 : fresh();
        uint256 c1 = out1 == 0 ? 0 : fresh();
        uint256 nf0 = nullifierOf(notes[a].commitment);
        uint256 nf1 = two ? nullifierOf(notes[b].commitment) : fresh();
        uint256[9] memory s = signals(pool, context, nf0, nf1, c0, c1, 0);
        pool.transact([uint256(0), 0], [[uint256(0), 0], [uint256(0), 0]], [uint256(0), 0], s, data, out);
        _spend(a);
        if (two) _spend(b); else spentNullifier[nf1] = true;
        if (c0 != 0) _add(c0, out0);
        if (c1 != 0) _add(c1, out1);
        ghostBalance += total;
    }

    function withdraw(uint256 seed, uint256 amountSeed, uint256 feeSeed) external {
        calls++;
        (bool found, uint256 a) = pick(seed);
        if (!found) return;
        keepPolicyLive();
        uint128 value = notes[a].value;
        uint128 publicOut = uint128(bound(amountSeed, 1, value));
        uint128 fee = uint128(bound(feeSeed, 0, publicOut));
        uint128 change = value - publicOut;
        bytes[2] memory out = outputs(++counter);
        Phase2ASPPool.ExtData memory data = Phase2ASPPool.ExtData({recipient: address(0xCAFE), feeRecipient: address(0xFEE),
            processor: address(this), publicIn: 0, publicOut: publicOut, fee: fee});
        uint256 c0 = change == 0 ? 0 : fresh();
        uint256 pad = fresh();
        uint256[9] memory s = signals(pool, pool.hashContext(data, out), nullifierOf(notes[a].commitment), pad, c0, 0, publicOut);
        pool.transact([uint256(0), 0], [[uint256(0), 0], [uint256(0), 0]], [uint256(0), 0], s, data, out);
        _spend(a);
        spentNullifier[pad] = true;
        if (c0 != 0) { _add(c0, change); ghostBalance += change; }
    }

    function exit(uint256 seed, uint256 feeSeed, bool asRagequit) external {
        calls++;
        (bool found, uint256 a) = pick(seed);
        if (!found) return;
        Note memory note = notes[a];
        bool deposited = pool.originalDepositor(note.commitment) == DEPOSITOR;
        asRagequit = asRagequit && deposited;
        uint128 fee = asRagequit ? 0 : uint128(bound(feeSeed, 0, note.value));
        Phase2ASPPool.HolderExitData memory d = Phase2ASPPool.HolderExitData({processor: address(this),
            recipient: asRagequit ? DEPOSITOR : address(0xD00D), feeRecipient: address(0xFEE), fee: fee});
        Phase2ASPPool.HolderExitProof memory proof = Phase2ASPPool.HolderExitProof([uint256(0), 0],
            [[uint256(0), 0], [uint256(0), 0]], [uint256(0), 0],
            [note.commitment, nullifierOf(note.commitment), uint256(note.value), pool.SCOPE(), pool.holderExitContext(d)]);
        if (asRagequit) pool.ragequit(d, proof); else pool.holderExit(d, proof);
        _spend(a);
    }

    function publishPolicy(uint256 gap) external {
        calls++;
        skip(bound(gap, 0, 2 hours));
        publish(registry, ++rootCounter, 7 days);
    }

    function warp(uint256 gap) external {
        calls++;
        skip(bound(gap, 0, 1 days));
    }

    /// Donations must not consume capacity or become note-backed liabilities.
    function donate(uint256 valueSeed) external {
        calls++;
        uint256 value = bound(valueSeed, 1, 10 ether);
        vm.deal(address(pool), address(pool).balance + value);
        ghostDonations += value;
    }

    /// Model immediate emergency reductions, including below current TVL, and
    /// delayed increases. Spends/exits continue through the same action set.
    function manageCaps(uint256 perSeed, uint256 totalSeed, bool paused, bool increase) external {
        calls++;
        vm.prank(GUARDIAN);
        if (paused) pool.pauseDeposits(); else pool.unpauseDeposits();
        if (increase) {
            uint128 nextDeposit = pool.maxDeposit() + uint128(bound(perSeed, 1, 10 ether));
            uint128 nextTotal = pool.maxTotal() + uint128(bound(totalSeed, 1, 100 ether));
            if (nextDeposit > nextTotal) nextTotal = nextDeposit;
            vm.prank(GUARDIAN);
            pool.proposeCapIncrease(nextDeposit, nextTotal);
            skip(1 days);
            vm.prank(GUARDIAN);
            pool.acceptCapIncrease();
        } else {
            uint128 nextTotal = uint128(bound(totalSeed, 1, pool.maxTotal()));
            uint128 depositLimit = pool.maxDeposit() < nextTotal ? pool.maxDeposit() : nextTotal;
            uint128 nextDeposit = uint128(bound(perSeed, 1, depositLimit));
            vm.prank(GUARDIAN);
            pool.setCaps(nextDeposit, nextTotal);
        }
    }

    /// Adversarial: replay a spent note through transact or holderExit.
    function replaySpent(uint256 seed, bool viaExit) external {
        calls++;
        uint256 n = notes.length;
        for (uint256 k; k < n; k++) {
            Note memory note = notes[(seed % n + k) % n];
            if (!note.spent) continue;
            uint256 nf = nullifierOf(note.commitment);
            bool succeeded;
            if (viaExit) {
                Phase2ASPPool.HolderExitData memory d = Phase2ASPPool.HolderExitData({processor: address(this),
                    recipient: address(0xBAD), feeRecipient: address(0), fee: 0});
                try pool.holderExit(d, Phase2ASPPool.HolderExitProof([uint256(0), 0], [[uint256(0), 0], [uint256(0), 0]],
                    [uint256(0), 0], [note.commitment, nf, uint256(note.value), pool.SCOPE(), pool.holderExitContext(d)])) {
                    succeeded = true;
                } catch {}
            } else {
                keepPolicyLive();
                bytes[2] memory out = outputs(++counter);
                Phase2ASPPool.ExtData memory data = Phase2ASPPool.ExtData({recipient: address(0xBAD), feeRecipient: address(0),
                    processor: address(this), publicIn: 0, publicOut: note.value, fee: 0});
                uint256[9] memory s = signals(pool, pool.hashContext(data, out), nf, fresh(), 0, 0, note.value);
                try pool.transact([uint256(0), 0], [[uint256(0), 0], [uint256(0), 0]], [uint256(0), 0], s, data, out) {
                    succeeded = true;
                } catch {}
            }
            if (succeeded) violations++;
            return;
        }
    }
}

contract PoolInvariantTest is Base {
    Phase2ASPPool internal pool;
    Phase2ASPRegistry internal registry;
    PoolHandler internal handler;

    function setUp() public {
        registry = deployRegistry();
        pool = new Phase2ASPPool(address(new MockJoinSplitVerifier()), address(new MockExitVerifier()), address(registry), address(0), 10 ether, 100 ether);
        handler = new PoolHandler(pool, registry);
        publish(registry, 1, 7 days);
    }

    function targetContracts() public view returns (address[] memory targets) {
        targets = new address[](1);
        targets[0] = address(handler);
    }

    function invariant_custodyEqualsUnspentNotes() public view {
        eq(pool.accountedBalance(), handler.ghostBalance(), 'liabilities != sum of unspent notes');
        eq(address(pool).balance, handler.ghostBalance() + handler.ghostDonations(), 'custody != notes plus donations');
    }

    function invariant_noDoubleSpend() public view {
        eq(handler.violations(), 0, 'a spent note was paid out again');
    }

    function invariant_treeAccounting() public view {
        eq(pool.nextLeafIndex(), handler.ghostLeaves(), 'leaf count');
        check(pool.knownRoot(pool.currentRoot()), 'current root must be known');
    }
}
