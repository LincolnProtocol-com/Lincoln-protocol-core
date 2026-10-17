// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

/// @notice A single provider publishes expiring association-set commitments.
/// @dev No asset custody or upgrade mechanism. The provider may refuse normal
/// spending; it cannot authorize holder exits. An immutable guardian may only
/// suspend the provider (revoking every published policy) and rotate it after
/// a public delay; it can never publish a policy itself.
contract Phase2ASPRegistry {
    uint256 public constant FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    uint256 public constant MAX_POLICY_LIFETIME = 30 days;
    /// @dev A superseded policy stays acceptable briefly so proofs generated
    /// before an update can still land. This also bounds how long a note
    /// removed from the newest set remains spendable under an older one.
    uint256 public constant SUPERSEDED_POLICY_GRACE = 1 hours;
    /// @dev Includes the latest epoch and at most fifteen predecessors. Pools
    /// try at most this many contexts, bounding gas while tolerating faster
    /// publications. Superseded grace and expiry still cap acceptance by time.
    uint64 public constant ACCEPTED_POLICY_WINDOW = 16;
    uint256 public constant PROVIDER_ROTATION_DELAY = 3 days;
    address public immutable GUARDIAN;

    struct Policy {
        uint256 root;
        uint64 validUntil;
        uint64 supersededAt;
    }

    address private _provider;
    address public pendingProvider;
    uint64 public providerRotationReadyAt;
    bool public providerSuspended;
    /// @dev Every epoch at or below this value was revoked by the guardian.
    uint64 public revokedThroughEpoch;
    uint64 private _epoch;
    bytes32 public cidDigest;
    mapping(uint64 => Policy) private _policies;

    error InvalidProvider();
    error InvalidGuardian();
    error OnlyProvider();
    error OnlyGuardian();
    error OnlyPendingProvider();
    error ProviderIsSuspended();
    error NoPendingRotation();
    error RotationNotReady();
    error InvalidRoot();
    error InvalidPolicyLifetime();
    error InvalidCIDDigest();
    error EpochExhausted();
    error UnsupportedChainId();

    event PolicyUpdated(uint64 indexed epoch, uint256 indexed root, bytes32 cidDigest, uint64 validUntil);
    event ProviderRotationProposed(address indexed currentProvider, address indexed nextProvider, uint64 readyAt);
    event ProviderRotationCancelled(address indexed nextProvider);
    event ProviderRotated(address indexed previousProvider, address indexed nextProvider);
    event ProviderSuspended(address indexed provider, uint64 revokedThroughEpoch);
    event ProviderResumed(address indexed provider);

    modifier onlyGuardian() {
        if (msg.sender != GUARDIAN) revert OnlyGuardian();
        _;
    }

    constructor(address provider, address guardian) {
        if (provider == address(0)) revert InvalidProvider();
        if (guardian == address(0) || guardian == provider) revert InvalidGuardian();
        if (block.chainid != 4663) revert UnsupportedChainId();
        _provider = provider;
        GUARDIAN = guardian;
    }

    function PROVIDER() external view returns (address) {
        return _provider;
    }

    function updateRoot(uint256 root, bytes32 digest, uint64 validUntil) external {
        if (msg.sender != _provider) revert OnlyProvider();
        if (providerSuspended) revert ProviderIsSuspended();
        if (root == 0 || root >= FIELD) revert InvalidRoot();
        if (digest == bytes32(0)) revert InvalidCIDDigest();
        if (validUntil <= block.timestamp || validUntil > block.timestamp + MAX_POLICY_LIFETIME) {
            revert InvalidPolicyLifetime();
        }
        if (_epoch == type(uint64).max) revert EpochExhausted();
        if (_epoch != 0) _policies[_epoch].supersededAt = uint64(block.timestamp);
        uint64 epoch = _epoch + 1;
        _epoch = epoch;
        _policies[epoch] = Policy({root: root, validUntil: validUntil, supersededAt: 0});
        cidDigest = digest;
        emit PolicyUpdated(epoch, root, digest, validUntil);
    }

    /// @dev The zero epoch indicates that no policy has ever been published.
    /// Returns the newest stored policy even when revoked or expired; pools
    /// decide acceptability through acceptedPolicy.
    function latestPolicy() external view returns (uint256 root, uint64 epoch, uint64 validUntil) {
        Policy storage policy = _policies[_epoch];
        return (policy.root, _epoch, policy.validUntil);
    }

    function policyAt(uint64 epoch) external view returns (uint256 root, uint64 validUntil, uint64 supersededAt) {
        Policy storage policy = _policies[epoch];
        return (policy.root, policy.validUntil, policy.supersededAt);
    }

    /// @notice A policy a pool may bind a normal spend to now; (0, 0) otherwise.
    function acceptedPolicy(uint64 epoch) external view returns (uint256 root, uint64 validUntil) {
        uint64 latest = _epoch;
        if (epoch == 0 || epoch > latest || epoch <= revokedThroughEpoch) return (0, 0);
        if (latest - epoch >= ACCEPTED_POLICY_WINDOW) return (0, 0);
        Policy storage policy = _policies[epoch];
        if (policy.validUntil <= block.timestamp) return (0, 0);
        if (policy.supersededAt != 0 && block.timestamp >= uint256(policy.supersededAt) + SUPERSEDED_POLICY_GRACE) {
            return (0, 0);
        }
        return (policy.root, policy.validUntil);
    }

    /// @notice Start a delayed provider rotation; replaces any pending one.
    function proposeProvider(address nextProvider) external onlyGuardian {
        if (nextProvider == address(0) || nextProvider == _provider || nextProvider == GUARDIAN) revert InvalidProvider();
        uint64 readyAt = uint64(block.timestamp + PROVIDER_ROTATION_DELAY);
        pendingProvider = nextProvider;
        providerRotationReadyAt = readyAt;
        emit ProviderRotationProposed(_provider, nextProvider, readyAt);
    }

    function cancelProviderRotation() external onlyGuardian {
        address next = pendingProvider;
        if (next == address(0)) revert NoPendingRotation();
        delete pendingProvider;
        delete providerRotationReadyAt;
        emit ProviderRotationCancelled(next);
    }

    /// @notice The proposed provider claims the role after the public delay.
    function acceptProvider() external {
        address next = pendingProvider;
        if (next == address(0) || msg.sender != next) revert OnlyPendingProvider();
        if (block.timestamp < providerRotationReadyAt) revert RotationNotReady();
        emit ProviderRotated(_provider, next);
        _provider = next;
        delete pendingProvider;
        delete providerRotationReadyAt;
        providerSuspended = false;
    }

    /// @notice Emergency stop for a compromised provider: blocks new policies
    /// and revokes every published one. Normal spending halts until a new
    /// policy is published; holder exits are unaffected.
    function suspendProvider() external onlyGuardian {
        uint64 revoked = _epoch;
        providerSuspended = true;
        revokedThroughEpoch = revoked;
        emit ProviderSuspended(_provider, revoked);
    }

    /// @notice Lift a suspension without rotating. Revoked epochs stay revoked.
    function resumeProvider() external onlyGuardian {
        providerSuspended = false;
        emit ProviderResumed(_provider);
    }
}
