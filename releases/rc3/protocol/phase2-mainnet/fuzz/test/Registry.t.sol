// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {Base} from './Base.sol';
import {Phase2ASPRegistry} from '../../contracts/Phase2ASPRegistry.sol';

contract RegistryTest is Base {
    Phase2ASPRegistry internal registry;

    function setUp() public {
        registry = deployRegistry();
    }

    function test_releasePolicyBounds() public {
        eq(registry.ACCEPTED_POLICY_WINDOW(), 16, 'release window');
        eq(registry.SUPERSEDED_POLICY_GRACE(), 1 hours, 'superseded grace');
        eq(registry.PROVIDER_ROTATION_DELAY(), 3 days, 'provider delay');
    }

    function test_constructorRejectsMissingOrSharedGuardian() public {
        vm.expectRevert(Phase2ASPRegistry.InvalidGuardian.selector);
        new Phase2ASPRegistry(PROVIDER, address(0));
        vm.expectRevert(Phase2ASPRegistry.InvalidGuardian.selector);
        new Phase2ASPRegistry(PROVIDER, PROVIDER);
        vm.expectRevert(Phase2ASPRegistry.InvalidProvider.selector);
        new Phase2ASPRegistry(address(0), GUARDIAN);
        vm.chainId(46630);
        vm.expectRevert(Phase2ASPRegistry.UnsupportedChainId.selector);
        new Phase2ASPRegistry(PROVIDER, GUARDIAN);
    }

    function testFuzz_onlyProviderPublishes(address caller, uint256 root) public {
        vm.assume(caller != PROVIDER);
        root = bound(root, 1, FIELD - 1);
        vm.prank(caller);
        vm.expectRevert(Phase2ASPRegistry.OnlyProvider.selector);
        registry.updateRoot(root, bytes32(uint256(1)), uint64(now_() + 1 days));
    }

    function testFuzz_lifetimeBounds(uint64 validUntil) public {
        bool ok = validUntil > now_() && validUntil <= now_() + 30 days;
        vm.prank(PROVIDER);
        if (!ok) vm.expectRevert(Phase2ASPRegistry.InvalidPolicyLifetime.selector);
        registry.updateRoot(7, bytes32(uint256(1)), validUntil);
    }

    function testFuzz_onlyGuardianControlsRotation(address caller, address next) public {
        vm.assume(caller != GUARDIAN);
        vm.startPrank(caller);
        vm.expectRevert(Phase2ASPRegistry.OnlyGuardian.selector);
        registry.proposeProvider(next);
        vm.expectRevert(Phase2ASPRegistry.OnlyGuardian.selector);
        registry.cancelProviderRotation();
        vm.expectRevert(Phase2ASPRegistry.OnlyGuardian.selector);
        registry.suspendProvider();
        vm.expectRevert(Phase2ASPRegistry.OnlyGuardian.selector);
        registry.resumeProvider();
        vm.stopPrank();
    }

    function testFuzz_rotationRequiresFullDelay(uint256 wait, address next) public {
        vm.assume(next != address(0) && next != PROVIDER && next != GUARDIAN);
        wait = bound(wait, 0, 10 days);
        vm.prank(GUARDIAN);
        registry.proposeProvider(next);
        skip(wait);
        bool ready = wait >= registry.PROVIDER_ROTATION_DELAY();
        vm.prank(next);
        if (!ready) vm.expectRevert(Phase2ASPRegistry.RotationNotReady.selector);
        registry.acceptProvider();
        if (ready) {
            check(registry.PROVIDER() == next, 'rotated');
            check(registry.pendingProvider() == address(0), 'pending cleared');
            publishAs(next, 11);
            vm.prank(PROVIDER);
            vm.expectRevert(Phase2ASPRegistry.OnlyProvider.selector);
            registry.updateRoot(12, bytes32(uint256(1)), uint64(now_() + 1 days));
        }
    }

    function testFuzz_onlyPendingProviderAccepts(address caller) public {
        address next = address(0xBEEF);
        vm.assume(caller != next);
        vm.prank(GUARDIAN);
        registry.proposeProvider(next);
        skip(3 days);
        vm.prank(caller);
        vm.expectRevert(Phase2ASPRegistry.OnlyPendingProvider.selector);
        registry.acceptProvider();
    }

    function test_cancelledRotationCannotBeAccepted() public {
        address next = address(0xBEEF);
        vm.startPrank(GUARDIAN);
        registry.proposeProvider(next);
        registry.cancelProviderRotation();
        vm.expectRevert(Phase2ASPRegistry.NoPendingRotation.selector);
        registry.cancelProviderRotation();
        vm.stopPrank();
        skip(4 days);
        vm.prank(next);
        vm.expectRevert(Phase2ASPRegistry.OnlyPendingProvider.selector);
        registry.acceptProvider();
    }

    function test_proposalRejectsSelfOrGuardian() public {
        vm.startPrank(GUARDIAN);
        vm.expectRevert(Phase2ASPRegistry.InvalidProvider.selector);
        registry.proposeProvider(address(0));
        vm.expectRevert(Phase2ASPRegistry.InvalidProvider.selector);
        registry.proposeProvider(PROVIDER);
        vm.expectRevert(Phase2ASPRegistry.InvalidProvider.selector);
        registry.proposeProvider(GUARDIAN);
        vm.stopPrank();
    }

    /// Compromise response: suspension revokes every published policy at once,
    /// blocks the old key, and a rotated provider restores service.
    function test_suspendRevokesAllAndRotationRestores() public {
        publish(registry, 1, 7 days);
        publish(registry, 2, 7 days);
        vm.prank(GUARDIAN);
        registry.suspendProvider();
        (uint256 root,) = registry.acceptedPolicy(1);
        eq(root, 0, 'epoch 1 revoked');
        (root,) = registry.acceptedPolicy(2);
        eq(root, 0, 'epoch 2 revoked');
        vm.prank(PROVIDER);
        vm.expectRevert(Phase2ASPRegistry.ProviderIsSuspended.selector);
        registry.updateRoot(3, bytes32(uint256(1)), uint64(now_() + 1 days));

        address next = address(0xBEEF);
        vm.prank(GUARDIAN);
        registry.proposeProvider(next);
        skip(3 days);
        vm.prank(next);
        registry.acceptProvider();
        check(!registry.providerSuspended(), 'unsuspended by rotation');
        publishAs(next, 3);
        (root,) = registry.acceptedPolicy(3);
        eq(root, 3, 'new provider policy accepted');
        (root,) = registry.acceptedPolicy(2);
        eq(root, 0, 'revocation persists');
    }

    function test_resumeKeepsRevocation() public {
        publish(registry, 1, 7 days);
        vm.startPrank(GUARDIAN);
        registry.suspendProvider();
        registry.resumeProvider();
        vm.stopPrank();
        (uint256 root,) = registry.acceptedPolicy(1);
        eq(root, 0, 'still revoked');
        publish(registry, 2, 7 days);
        (root,) = registry.acceptedPolicy(2);
        eq(root, 2, 'fresh policy accepted');
    }

    /// Model-based fuzz of the acceptance rule across random update cadences.
    function testFuzz_acceptedPolicyMatchesModel(uint256 seed, uint8 count, uint32 probeGap) public {
        count = uint8(bound(count, 1, 40));
        uint256 window = registry.ACCEPTED_POLICY_WINDOW();
        uint256[] memory publishedAt = new uint256[](count + 1);
        uint256[] memory validUntil = new uint256[](count + 1);
        for (uint256 e = 1; e <= count; e++) {
            uint256 lifetime = bound(uint256(keccak256(abi.encode(seed, e, 'life'))), 1, 30 days);
            skip(bound(uint256(keccak256(abi.encode(seed, e, 'gap'))), 0, 3 hours));
            publishedAt[e] = now_();
            validUntil[e] = now_() + lifetime;
            publish(registry, 1000 + e, uint64(lifetime));
        }
        skip(bound(probeGap, 0, 2 hours));
        for (uint256 e = 0; e <= count + 1; e++) {
            bool expected = e >= 1 && e <= count && count - e < window && validUntil[e] > now_()
                && (e == count || now_() < publishedAt[e + 1] + 1 hours);
            (uint256 root, uint64 until) = registry.acceptedPolicy(uint64(e));
            check((root != 0) == expected, 'acceptance rule');
            if (expected) {
                eq(root, 1000 + e, 'root');
                eq(until, validUntil[e], 'validUntil');
            }
        }
    }

    function publishAs(address who, uint256 root) internal {
        vm.prank(who);
        registry.updateRoot(root, bytes32(uint256(1)), uint64(now_() + 1 days));
    }
}
