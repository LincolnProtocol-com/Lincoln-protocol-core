// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {Base, MockJoinSplitVerifier, MockExitVerifier, MockToken} from './Base.sol';
import {Phase2ASPPool} from '../../contracts/Phase2ASPPool.sol';
import {Phase2ASPRegistry} from '../../contracts/Phase2ASPRegistry.sol';

/// @dev Force a donation without calling a pool entry point. Under EIP-6780
/// selfdestruct still transfers this newly created contract's ETH to the pool.
contract ForceEther {
    constructor(address payable recipient) payable { selfdestruct(recipient); }
}

/// @dev Verifier mocks isolate accounting/governance; these are not proof-
/// soundness tests. Real finalized proofs are covered by the release scripts.
contract CapsTest is Base {
    Phase2ASPRegistry internal registry;
    MockJoinSplitVerifier internal verifier;
    MockExitVerifier internal exitVerifier;
    Phase2ASPPool internal pool;
    uint256 internal nonce;

    receive() external payable {}

    function setUp() public {
        registry = deployRegistry();
        verifier = new MockJoinSplitVerifier();
        exitVerifier = new MockExitVerifier();
        pool = deploy(address(0), 2 ether, 5 ether);
        publish(registry, 1, 7 days);
        vm.deal(address(this), 1_000_000 ether);
    }

    function deploy(address asset, uint128 perDeposit, uint128 total) internal returns (Phase2ASPPool) {
        return new Phase2ASPPool(address(verifier), address(exitVerifier), address(registry), asset, perDeposit, total);
    }

    function fund(uint128 value) internal returns (uint256) {
        return pool.depositDynamic{value: value}(value, ++nonce, cipher(nonce));
    }

    function spend(uint128 amount, uint128 fee, uint256 newCommitment) internal {
        bytes[2] memory out = outputs(++nonce);
        Phase2ASPPool.ExtData memory data = Phase2ASPPool.ExtData({recipient: address(0xCAFE),
            feeRecipient: address(0xFEE), processor: address(this), publicIn: 0, publicOut: amount, fee: fee});
        uint256[9] memory sig = signals(pool, pool.hashContext(data, out), ++nonce, ++nonce, newCommitment, 0, amount);
        pool.transact([uint256(0), 0], [[uint256(0), 0], [uint256(0), 0]], [uint256(0), 0], sig, data, out);
    }

    function exit(uint256 commitment, uint128 value, uint128 fee, bool rage) internal {
        Phase2ASPPool.HolderExitData memory data = Phase2ASPPool.HolderExitData({processor: address(this),
            recipient: rage ? address(this) : address(0xD00D), feeRecipient: address(0xFEE), fee: fee});
        Phase2ASPPool.HolderExitProof memory proof = Phase2ASPPool.HolderExitProof([uint256(0), 0],
            [[uint256(0), 0], [uint256(0), 0]], [uint256(0), 0],
            [commitment, ++nonce, uint256(value), pool.SCOPE(), pool.holderExitContext(data)]);
        if (rage) pool.ragequit(data, proof); else pool.holderExit(data, proof);
    }

    function lower(uint128 perDeposit, uint128 total) internal {
        vm.prank(GUARDIAN);
        pool.setCaps(perDeposit, total);
    }

    function propose(uint128 perDeposit, uint128 total) internal {
        vm.prank(GUARDIAN);
        pool.proposeCapIncrease(perDeposit, total);
    }

    function testFuzz_constructorRejectsInvalidCaps(uint128 perDeposit, uint128 total) public {
        vm.assume(perDeposit == 0 || total == 0 || perDeposit > total);
        vm.expectRevert(Phase2ASPPool.InvalidCaps.selector);
        deploy(address(0), perDeposit, total);
    }

    function test_capsBoundariesAndFailedDepositHasNoEffects() public {
        fund(2 ether);
        vm.expectRevert(Phase2ASPPool.DepositCapExceeded.selector);
        fund(2 ether + 1);
        fund(2 ether);
        fund(1 ether);
        eq(pool.accountedBalance(), 5 ether, 'exact total cap');
        uint256 root = pool.currentRoot();
        uint256 leaves = pool.nextLeafIndex();
        vm.expectRevert(Phase2ASPPool.PoolCapExceeded.selector);
        fund(1);
        eq(pool.accountedBalance(), 5 ether, 'failed deposit accounting');
        eq(address(pool).balance, 5 ether, 'failed deposit custody');
        eq(pool.currentRoot(), root, 'failed deposit root');
        eq(pool.nextLeafIndex(), leaves, 'failed deposit leaves');
    }

    function testFuzz_capsEnforceBothDimensions(uint128 perSeed, uint128 totalSeed,
        uint128 firstSeed, uint128 secondSeed) public
    {
        uint128 total = uint128(bound(totalSeed, 1, 100 ether));
        uint128 perDeposit = uint128(bound(perSeed, 1, total));
        pool = deploy(address(0), perDeposit, total);
        uint128 first = uint128(bound(firstSeed, 1, perDeposit));
        fund(first);
        uint128 second = uint128(bound(secondSeed, 1, total + 1));
        if (second > perDeposit) vm.expectRevert(Phase2ASPPool.DepositCapExceeded.selector);
        else if (uint256(first) + second > total) vm.expectRevert(Phase2ASPPool.PoolCapExceeded.selector);
        fund(second);
        uint256 expected = second <= perDeposit && uint256(first) + second <= total ? uint256(first) + second : first;
        eq(pool.accountedBalance(), expected, 'only admitted deposits create liabilities');
        eq(address(pool).balance, expected, 'exact custody');
    }

    function testFuzz_nativeDonationDoesNotConsumeCap(uint128 donation) public {
        donation = uint128(bound(donation, 1, 100 ether));
        new ForceEther{value: donation}(payable(address(pool)));
        eq(pool.accountedBalance(), 0, 'forced ETH not a note liability');
        fund(2 ether);
        fund(2 ether);
        fund(1 ether);
        eq(pool.accountedBalance(), 5 ether, 'full capacity remains');
        eq(address(pool).balance, 5 ether + donation, 'custody includes donation');
    }

    function testFuzz_erc20DonationDoesNotConsumeCap(uint128 donation) public {
        donation = uint128(bound(donation, 1, 100 ether));
        MockToken token = new MockToken('TOKEN');
        Phase2ASPPool erc20 = deploy(address(token), 2 ether, 5 ether);
        token.mint(address(this), donation + 5 ether);
        token.transfer(address(erc20), donation);
        token.approve(address(erc20), 5 ether);
        erc20.depositDynamic(2 ether, 1, cipher(1));
        erc20.depositDynamic(2 ether, 2, cipher(2));
        erc20.depositDynamic(1 ether, 3, cipher(3));
        eq(erc20.accountedBalance(), 5 ether, 'donation not counted');
        eq(token.balanceOf(address(erc20)), 5 ether + donation, 'exact custody');
    }

    function testFuzz_publicOutIncludesFeeAccounting(uint128 amount, uint128 fee) public {
        fund(2 ether);
        amount = uint128(bound(amount, 1, 2 ether));
        fee = uint128(bound(fee, 0, amount));
        spend(amount, fee, 0);
        eq(pool.accountedBalance(), 2 ether - amount, 'fee must not be deducted twice');
        eq(address(pool).balance, pool.accountedBalance(), 'custody equal to liabilities');
        eq(address(0xCAFE).balance, amount - fee, 'net payout');
        eq(address(0xFEE).balance, fee, 'fee payout');
    }

    function test_privateTransferLeavesAccountingUnchanged() public {
        fund(2 ether);
        spend(0, 0, 100_000);
        eq(pool.accountedBalance(), 2 ether, 'private transfer value stays in pool');
    }

    function testFuzz_holderExitDeductsFullValueWithFee(uint128 fee) public {
        uint256 commitment = fund(2 ether);
        fee = uint128(bound(fee, 0, 2 ether));
        exit(commitment, 2 ether, fee, false);
        eq(pool.accountedBalance(), 0, 'full note removed');
        eq(address(pool).balance, 0, 'custody fully exited');
        eq(address(0xD00D).balance + address(0xFEE).balance, 2 ether, 'net plus fee');
    }

    function test_pauseAndLoweredTotalNeverBlockSpendsOrPublicExits() public {
        uint256 holder = fund(2 ether);
        uint256 original = fund(2 ether);
        fund(1 ether);
        lower(1, 1);
        vm.prank(GUARDIAN);
        pool.pauseDeposits();
        vm.expectRevert(Phase2ASPPool.DepositsArePaused.selector);
        fund(1);
        spend(1 ether, 0.003 ether, 0);
        exit(holder, 2 ether, 0.006 ether, false);
        vm.prank(GUARDIAN);
        registry.suspendProvider();
        exit(original, 2 ether, 0, true);
        eq(pool.accountedBalance(), 0, 'all normal/holder/ragequit exits work');
        eq(address(pool).balance, 0, 'no funds locked by caps or pause');
    }

    function test_unpauseRestoresDepositsButKeepsCaps() public {
        vm.prank(GUARDIAN);
        pool.pauseDeposits();
        vm.prank(GUARDIAN);
        pool.unpauseDeposits();
        check(!pool.depositsPaused(), 'unpaused');
        fund(2 ether);
        vm.expectRevert(Phase2ASPPool.DepositCapExceeded.selector);
        fund(2 ether + 1);
    }

    function testFuzz_onlyGuardianMayManageCapsAndPause(address caller, uint8 action) public {
        vm.assume(caller != GUARDIAN);
        action = uint8(bound(action, 0, 6));
        vm.prank(caller);
        vm.expectRevert(Phase2ASPPool.UnauthorizedGuardian.selector);
        if (action == 0) pool.setCaps(1 ether, 3 ether);
        else if (action == 1) pool.proposeCapIncrease(3 ether, 6 ether);
        else if (action == 2) pool.acceptCapIncrease();
        else if (action == 3) pool.cancelCapIncrease();
        else if (action == 4) pool.pauseDeposits();
        else if (action == 5) pool.unpauseDeposits();
        else pool.setCaps(2 ether, 5 ether);
    }

    function testFuzz_increaseWaitsFullDelay(uint256 elapsed) public {
        elapsed = bound(elapsed, 0, 2 days);
        propose(3 ether, 6 ether);
        (uint128 perDeposit, uint128 total, uint64 eta) = pool.pendingCaps();
        eq(perDeposit, 3 ether, 'pending deposit cap');
        eq(total, 6 ether, 'pending total cap');
        eq(eta, START + 1 days, 'full delay');
        skip(elapsed);
        if (elapsed < 1 days) vm.expectRevert(Phase2ASPPool.CapIncreaseNotReady.selector);
        vm.prank(GUARDIAN);
        pool.acceptCapIncrease();
        if (elapsed >= 1 days) {
            eq(pool.maxDeposit(), 3 ether, 'new deposit cap');
            eq(pool.maxTotal(), 6 ether, 'new total cap');
            (,, eta) = pool.pendingCaps();
            eq(eta, 0, 'proposal consumed');
        }
    }

    function test_loweringCapsClearsOldProposalAndNewIncreaseWaitsAgain() public {
        propose(3 ether, 6 ether);
        skip(1 days);
        lower(1 ether, 2 ether);
        vm.prank(GUARDIAN);
        vm.expectRevert(Phase2ASPPool.UnavailableCapProposal.selector);
        pool.acceptCapIncrease();
        propose(3 ether, 6 ether);
        vm.prank(GUARDIAN);
        vm.expectRevert(Phase2ASPPool.CapIncreaseNotReady.selector);
        pool.acceptCapIncrease();
        skip(1 days);
        vm.prank(GUARDIAN);
        pool.acceptCapIncrease();
        eq(pool.maxTotal(), 6 ether, 'accepted fresh proposal');
    }

    function test_replacementProposalResetsDelay() public {
        propose(3 ether, 6 ether);
        skip(1 days - 1);
        propose(4 ether, 8 ether);
        skip(1);
        vm.prank(GUARDIAN);
        vm.expectRevert(Phase2ASPPool.CapIncreaseNotReady.selector);
        pool.acceptCapIncrease();
        skip(1 days - 1);
        vm.prank(GUARDIAN);
        pool.acceptCapIncrease();
        eq(pool.maxTotal(), 8 ether, 'replacement accepted after own delay');
    }

    function test_cancelledProposalCannotBeAccepted() public {
        propose(3 ether, 6 ether);
        vm.prank(GUARDIAN);
        pool.cancelCapIncrease();
        skip(1 days);
        vm.prank(GUARDIAN);
        vm.expectRevert(Phase2ASPPool.UnavailableCapProposal.selector);
        pool.acceptCapIncrease();
    }

    function test_setCapsCannotIncreaseEitherComponent() public {
        vm.prank(GUARDIAN);
        vm.expectRevert(Phase2ASPPool.InvalidCaps.selector);
        pool.setCaps(3 ether, 5 ether);
        vm.prank(GUARDIAN);
        vm.expectRevert(Phase2ASPPool.InvalidCaps.selector);
        pool.setCaps(2 ether, 6 ether);
        vm.prank(GUARDIAN);
        vm.expectRevert(Phase2ASPPool.InvalidCaps.selector);
        pool.proposeCapIncrease(1 ether, 6 ether);
        vm.prank(GUARDIAN);
        vm.expectRevert(Phase2ASPPool.InvalidCaps.selector);
        pool.proposeCapIncrease(2 ether, 5 ether);
    }

    function test_noopSetCapsAlsoClearsProposal() public {
        propose(3 ether, 6 ether);
        lower(2 ether, 5 ether);
        skip(1 days);
        vm.prank(GUARDIAN);
        vm.expectRevert(Phase2ASPPool.UnavailableCapProposal.selector);
        pool.acceptCapIncrease();
    }
}
