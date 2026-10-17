// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {ReentrancyGuard} from '@openzeppelin/contracts/utils/ReentrancyGuard.sol';
import {IERC20, SafeERC20} from '@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol';
import {PoseidonT3} from 'poseidon-solidity/PoseidonT3.sol';
import {PoseidonT4} from 'poseidon-solidity/PoseidonT4.sol';

interface IPhase2ASPJoinSplitVerifier {
    function verifyProof(uint256[2] calldata, uint256[2][2] calldata, uint256[2] calldata, uint256[9] calldata)
        external view returns (bool);
}

interface IPhase2ASPHolderExitVerifier {
    function verifyProof(uint256[2] calldata, uint256[2][2] calldata, uint256[2] calldata, uint256[5] calldata)
        external view returns (bool);
}

interface IPhase2ASPPolicyRegistry {
    function PROVIDER() external view returns (address);
    function GUARDIAN() external view returns (address);
    function ACCEPTED_POLICY_WINDOW() external view returns (uint64);
    function latestPolicy() external view returns (uint256 root, uint64 epoch, uint64 validUntil);
    function acceptedPolicy(uint64 epoch) external view returns (uint256 root, uint64 validUntil);
}

/// @notice Immutable factorized-note pool with a current-note association set.
/// @dev Normal spending requires ASP approval of H(commitment,SCOPE). Deposits
/// and public exits remain available without any association-set approval.
/// The ASP policy does not establish historical deposit-lineage revocation.
/// Mainnet release candidate with finalized verifier bindings; exact-transfer assets only.
contract Phase2ASPPool is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    uint256 public constant TREE_DEPTH = 20;
    uint256 public constant ROOT_HISTORY_SIZE = 100;
    uint256 public constant CIPHERTEXT_BYTES = 256;
    uint64 public constant CAP_INCREASE_DELAY = 24 hours;
    bytes32 public constant DOMAIN = keccak256('CHENG_PHASE2_ASP_V1');
    bytes32 public constant EXIT_DOMAIN = keccak256('CHENG_PHASE2_ASP_EXIT_V1');
    address public immutable ASSET;
    IPhase2ASPJoinSplitVerifier public immutable VERIFIER;
    uint256 public immutable SCOPE;
    IPhase2ASPHolderExitVerifier public immutable HOLDER_EXIT_VERIFIER;
    IPhase2ASPPolicyRegistry public immutable ASP_REGISTRY;

    struct CapProposal {
        uint128 maxDeposit;
        uint128 maxTotal;
        uint64 eta;
    }

    uint128 public maxDeposit;
    uint128 public maxTotal;
    // Only note-backed liabilities count. Unsolicited ETH/ERC20 donations must
    // not consume deposit capacity, and publicOut already includes its fee.
    uint256 public accountedBalance;
    CapProposal public pendingCaps;
    bool public depositsPaused;

    struct ExtData {
        address recipient;
        address feeRecipient;
        address processor;
        uint128 publicIn;
        uint128 publicOut;
        uint128 fee;
    }

    struct HolderExitData {
        address processor;
        address recipient;
        address feeRecipient;
        uint128 fee;
    }

    struct HolderExitProof {
        uint256[2] pA;
        uint256[2][2] pB;
        uint256[2] pC;
        uint256[5] pubSignals;
    }

    uint256 public currentRoot;
    uint256 public nextLeafIndex;
    uint256 public currentRootIndex;
    uint256[TREE_DEPTH] public zeros;
    uint256[TREE_DEPTH] public filledSubtrees;
    uint256[ROOT_HISTORY_SIZE] public roots;
    // Every root the tree has had stays valid (append-only tree; nullifiers stop
    // double spends), so dust deposits cannot evict an in-flight proof's root.
    mapping(uint256 => bool) private _knownRoots;
    mapping(uint256 => bool) public spentNullifiers;
    mapping(uint256 => bool) public commitments;
    mapping(uint256 => address) public originalDepositor;

    error InvalidVerifier();
    error InvalidAsset();
    error UnsupportedChainId();
    error InvalidProcessor();
    error InvalidRecipient();
    error InvalidFee();
    error InvalidCiphertextLength();
    error InvalidPublicInputs();
    error UnknownRoot();
    error ContextMismatch();
    error InvalidProof();
    error AlreadySpent();
    error DuplicateCommitment();
    error TreeFull();
    error AssetAmountMismatch();
    error NativeTransferFailed();
    error InvalidASPRegistry();
    error UnavailableASPPolicy();
    error ExpiredASPPolicy();
    error PublicFundingRequiresDynamicDeposit();
    error InvalidCommitment();
    error InvalidRagequit();
    error UnauthorizedGuardian();
    error InvalidCaps();
    error DepositCapExceeded();
    error PoolCapExceeded();
    error DepositsArePaused();
    error UnavailableCapProposal();
    error CapIncreaseNotReady();

    event NewCommitment(uint256 indexed commitment, uint256 indexed index, bytes encryptedOutput);
    event NewNullifier(uint256 indexed nullifier);
    event Transacted(address indexed processor, uint256 publicIn, uint256 publicOut, uint256 fee, uint256 root);
    event PublicFlow(address indexed processor, address indexed recipient, address indexed feeRecipient,
        uint256 publicIn, uint256 publicOut, uint256 fee);

    event DynamicDeposited(address indexed processor, uint256 value, uint256 precommitment,
        uint256 commitment, bytes encryptedTemplate);
    event HolderExited(address indexed processor, address indexed recipient, uint256 indexed commitment,
        uint256 nullifier, uint256 value, uint256 fee, address feeRecipient);
    event Ragequit(address indexed depositor, uint256 indexed commitment, uint256 nullifier, uint256 value);

    event CapsUpdated(uint128 maxDeposit, uint128 maxTotal);
    event CapIncreaseProposed(uint128 maxDeposit, uint128 maxTotal, uint64 eta);
    event CapIncreaseCancelled();
    event DepositsPaused(bool paused);

    constructor(address verifier, address holderExitVerifier, address aspRegistry, address asset,
        uint128 initialMaxDeposit, uint128 initialMaxTotal)
    {
        if (verifier.code.length == 0 || holderExitVerifier.code.length == 0) revert InvalidVerifier();
        if (aspRegistry.code.length == 0) revert InvalidASPRegistry();
        ASP_REGISTRY = IPhase2ASPPolicyRegistry(aspRegistry);
        if (ASP_REGISTRY.PROVIDER() == address(0) || ASP_REGISTRY.GUARDIAN() == address(0)
            || ASP_REGISTRY.ACCEPTED_POLICY_WINDOW() == 0) revert InvalidASPRegistry();
        HOLDER_EXIT_VERIFIER = IPhase2ASPHolderExitVerifier(holderExitVerifier);
        if (asset != address(0) && asset.code.length == 0) revert InvalidAsset();
        // This mainnet build binds separately finalized Groth16 verifiers. A chain
        // allowlist in the bytecode restricts this candidate to Robinhood mainnet.
        if (block.chainid != 4663) revert UnsupportedChainId();
        ASSET = asset;
        VERIFIER = IPhase2ASPJoinSplitVerifier(verifier);
        _validateCaps(initialMaxDeposit, initialMaxTotal);
        maxDeposit = initialMaxDeposit;
        maxTotal = initialMaxTotal;
        emit CapsUpdated(initialMaxDeposit, initialMaxTotal);
        SCOPE = uint256(keccak256(abi.encode(DOMAIN, block.chainid, address(this)))) % FIELD;
        uint256 zero;
        for (uint256 level; level < TREE_DEPTH; level++) {
            zeros[level] = zero;
            filledSubtrees[level] = zero;
            zero = PoseidonT3.hash([zero, zero]);
        }
        currentRoot = zero;
        roots[0] = zero;
        _knownRoots[zero] = true;
    }

    modifier onlyGuardian() {
        if (msg.sender != ASP_REGISTRY.GUARDIAN()) revert UnauthorizedGuardian();
        _;
    }

    function _validateCaps(uint128 depositCap, uint128 totalCap) internal pure {
        if (depositCap == 0 || totalCap == 0 || depositCap > totalCap) revert InvalidCaps();
    }

    /// @notice Lower either cap immediately; never restricts a holder's exit.
    /// @dev A total cap below current liabilities only prevents new deposits.
    /// Every change clears an older proposal, so it cannot bypass a fresh delay.
    function setCaps(uint128 depositCap, uint128 totalCap) external onlyGuardian {
        _validateCaps(depositCap, totalCap);
        if (depositCap > maxDeposit || totalCap > maxTotal) revert InvalidCaps();
        _setCaps(depositCap, totalCap);
    }

    /// @notice Queue a non-decreasing cap change with a new 24-hour delay.
    /// @dev Apply reductions with setCaps first; mixed changes are not accepted.
    function proposeCapIncrease(uint128 depositCap, uint128 totalCap) external onlyGuardian {
        _validateCaps(depositCap, totalCap);
        if (depositCap < maxDeposit || totalCap < maxTotal
            || (depositCap == maxDeposit && totalCap == maxTotal)) revert InvalidCaps();
        if (block.timestamp > type(uint64).max - CAP_INCREASE_DELAY) revert InvalidCaps();
        uint64 eta = uint64(block.timestamp + CAP_INCREASE_DELAY);
        pendingCaps = CapProposal(depositCap, totalCap, eta);
        emit CapIncreaseProposed(depositCap, totalCap, eta);
    }

    function acceptCapIncrease() external onlyGuardian {
        CapProposal memory proposal = pendingCaps;
        if (proposal.eta == 0) revert UnavailableCapProposal();
        if (block.timestamp < proposal.eta) revert CapIncreaseNotReady();
        _setCaps(proposal.maxDeposit, proposal.maxTotal);
    }

    function cancelCapIncrease() external onlyGuardian {
        if (pendingCaps.eta == 0) revert UnavailableCapProposal();
        delete pendingCaps;
        emit CapIncreaseCancelled();
    }

    function _setCaps(uint128 depositCap, uint128 totalCap) internal {
        delete pendingCaps;
        maxDeposit = depositCap;
        maxTotal = totalCap;
        emit CapsUpdated(depositCap, totalCap);
    }

    function pauseDeposits() external onlyGuardian {
        depositsPaused = true;
        emit DepositsPaused(true);
    }

    function unpauseDeposits() external onlyGuardian {
        depositsPaused = false;
        emit DepositsPaused(false);
    }

    function knownRoot(uint256 root) external view returns (bool) {
        return _knownRoots[root];
    }

    /// @notice Publish a public deposit without waiting for ASP approval.
    /// @dev The exact measured value creates C=H(value,precommitment). An opaque
    /// precommitment/template cannot be spent without the matching owner secret.
    function depositDynamic(uint128 value, uint256 precommitment, bytes calldata encryptedTemplate)
        external payable nonReentrant returns (uint256 commitment)
    {
        if (depositsPaused) revert DepositsArePaused();
        if (value == 0 || precommitment == 0 || precommitment >= FIELD) revert InvalidPublicInputs();
        if (value > maxDeposit) revert DepositCapExceeded();
        uint256 nextBalance = accountedBalance + value;
        if (nextBalance > maxTotal) revert PoolCapExceeded();
        if (encryptedTemplate.length != CIPHERTEXT_BYTES) revert InvalidCiphertextLength();
        if (nextLeafIndex >= 1 << TREE_DEPTH) revert TreeFull();
        commitment = PoseidonT3.hash([uint256(value), precommitment]);
        if (commitment == 0) revert InvalidPublicInputs();
        if (commitments[commitment]) revert DuplicateCommitment();
        _pull(value);
        accountedBalance = nextBalance;
        originalDepositor[commitment] = msg.sender;
        _insert(commitment, encryptedTemplate);
        emit DynamicDeposited(msg.sender, value, precommitment, commitment, encryptedTemplate);
    }

    /// @notice The base external authorization data, independently of ASP policy.
    function baseExternalHash(ExtData calldata data, bytes[2] calldata encryptedOutputs) public view returns (uint256) {
        return uint256(keccak256(abi.encode(DOMAIN, block.chainid, address(this), SCOPE,
            address(ASP_REGISTRY), ASP_REGISTRY.PROVIDER(), data.processor, data.recipient, data.feeRecipient,
            data.publicIn, data.publicOut, data.fee, keccak256(encryptedOutputs[0]), keccak256(encryptedOutputs[1])))) % FIELD;
    }

    /// @notice Bind latest root, epoch and expiry while retaining nine signals.
    /// @dev The circuit recomputes this binding and checks both input note ASP
    /// paths against the same root, with H(inputCommitment,SCOPE) as each leaf.
    function hashContext(ExtData calldata data, bytes[2] calldata encryptedOutputs) public view returns (uint256) {
        (, uint64 epoch, uint64 validUntil) = ASP_REGISTRY.latestPolicy();
        if (epoch == 0) revert UnavailableASPPolicy();
        if (uint256(validUntil) <= block.timestamp) revert ExpiredASPPolicy();
        return hashContextForEpoch(data, encryptedOutputs, epoch);
    }

    /// @notice Context for a specific, currently accepted registry epoch.
    function hashContextForEpoch(ExtData calldata data, bytes[2] calldata encryptedOutputs, uint64 epoch)
        public view returns (uint256)
    {
        (uint256 context, bool accepted) = _policyContext(baseExternalHash(data, encryptedOutputs), epoch);
        if (!accepted) revert UnavailableASPPolicy();
        return context;
    }

    function _policyContext(uint256 base, uint64 epoch) internal view returns (uint256 context, bool accepted) {
        (uint256 root, uint64 validUntil) = ASP_REGISTRY.acceptedPolicy(epoch);
        if (root == 0 || root >= FIELD) return (0, false);
        uint256 policyHash = PoseidonT4.hash([root, uint256(epoch), uint256(validUntil)]);
        return (PoseidonT3.hash([base, policyHash]), true);
    }

    /// @dev Accepts the newest policy or a recently superseded one, so a policy
    /// update does not invalidate every proof already generated or in flight.
    function _checkContext(uint256 context, ExtData calldata data, bytes[2] calldata encryptedOutputs) internal view {
        (, uint64 latest, uint64 latestValidUntil) = ASP_REGISTRY.latestPolicy();
        if (latest == 0) revert UnavailableASPPolicy();
        uint256 base = baseExternalHash(data, encryptedOutputs);
        uint64 window = ASP_REGISTRY.ACCEPTED_POLICY_WINDOW();
        bool anyAccepted;
        for (uint64 offset; offset < window && offset < latest; offset++) {
            (uint256 candidate, bool accepted) = _policyContext(base, latest - offset);
            if (!accepted) continue;
            if (candidate == context) return;
            anyAccepted = true;
        }
        if (anyAccepted) revert ContextMismatch();
        if (uint256(latestValidUntil) <= block.timestamp) revert ExpiredASPPolicy();
        revert UnavailableASPPolicy();
    }

    function holderExitContext(HolderExitData calldata data) public view returns (uint256) {
        return uint256(keccak256(abi.encode(EXIT_DOMAIN, block.chainid, address(this), SCOPE,
            data.processor, data.recipient, data.feeRecipient, data.fee))) % FIELD;
    }

    /// @notice Public full-note exit by the current cryptographic holder.
    /// @dev No ASP calls or historical-root requirement. Shares normal spending
    /// nullifiers, so neither a sender nor a holder can claim a spent note twice.
    function holderExit(HolderExitData calldata data, HolderExitProof calldata proof) external nonReentrant {
        _exit(data, proof);
    }

    /// @notice Original-public-deposit refund, still requiring note ownership.
    /// @dev A public mapping alone never grants refund rights. A transferred old
    /// note is spent, and a new recipient's secrets are not known to its sender.
    /// Dynamic DEX deposits record the adapter; recipients should use holderExit.
    function ragequit(HolderExitData calldata data, HolderExitProof calldata proof) external nonReentrant {
        address depositor = originalDepositor[proof.pubSignals[0]];
        if (depositor == address(0) || data.recipient != depositor || data.fee != 0) revert InvalidRagequit();
        _exit(data, proof);
        emit Ragequit(depositor, proof.pubSignals[0], proof.pubSignals[1], proof.pubSignals[2]);
    }

    function _exit(HolderExitData calldata data, HolderExitProof calldata proof) internal {
        if (data.processor == address(0) || msg.sender != data.processor) revert InvalidProcessor();
        if (data.recipient == address(0) || data.recipient == address(this)) revert InvalidRecipient();
        for (uint256 i; i < proof.pubSignals.length; i++) if (proof.pubSignals[i] >= FIELD) revert InvalidPublicInputs();
        uint256 commitment = proof.pubSignals[0];
        uint256 nullifier = proof.pubSignals[1];
        uint256 value = proof.pubSignals[2];
        if (commitment == 0 || !commitments[commitment]) revert InvalidCommitment();
        if (nullifier == 0 || spentNullifiers[nullifier]) revert AlreadySpent();
        if (value == 0 || value > type(uint128).max || proof.pubSignals[3] != SCOPE) revert InvalidPublicInputs();
        if (data.fee > value) revert InvalidFee();
        if (data.fee != 0 && (data.feeRecipient == address(0) || data.feeRecipient == address(this))) revert InvalidRecipient();
        if (proof.pubSignals[4] != holderExitContext(data)) revert ContextMismatch();
        if (!HOLDER_EXIT_VERIFIER.verifyProof(proof.pA, proof.pB, proof.pC, proof.pubSignals)) revert InvalidProof();
        spentNullifiers[nullifier] = true;
        accountedBalance -= value;
        emit NewNullifier(nullifier);
        uint256 payout = value - data.fee;
        if (payout != 0) _push(data.recipient, payout);
        if (data.fee != 0) _push(data.feeRecipient, data.fee);
        emit HolderExited(data.processor, data.recipient, commitment, nullifier, value, data.fee, data.feeRecipient);
    }

    /// @notice Any user can submit an ASP-approved transfer or withdrawal proof.
    /// @dev publicOut includes fee; recipient receives publicOut minus fee.
    function transact(uint256[2] calldata pA, uint256[2][2] calldata pB, uint256[2] calldata pC,
        uint256[9] calldata signals, ExtData calldata data, bytes[2] calldata encryptedOutputs)
        external payable nonReentrant
    {
        if (data.processor == address(0) || msg.sender != data.processor) revert InvalidProcessor();
        if (data.publicIn != 0) revert PublicFundingRequiresDynamicDeposit();
        if (data.fee > data.publicOut) revert InvalidFee();
        uint256 payout = uint256(data.publicOut) - data.fee;
        if (payout != 0 && (data.recipient == address(0) || data.recipient == address(this))) revert InvalidRecipient();
        if (data.fee != 0 && (data.feeRecipient == address(0) || data.feeRecipient == address(this))) revert InvalidRecipient();
        if (encryptedOutputs[0].length != CIPHERTEXT_BYTES || encryptedOutputs[1].length != CIPHERTEXT_BYTES) {
            revert InvalidCiphertextLength();
        }
        for (uint256 i; i < signals.length; i++) if (signals[i] >= FIELD) revert InvalidPublicInputs();
        if (signals[1] != data.publicIn || signals[2] != data.publicOut || signals[4] != SCOPE) revert InvalidPublicInputs();
        if (!_knownRoots[signals[0]]) revert UnknownRoot();
        _checkContext(signals[3], data, encryptedOutputs);
        if (signals[5] == 0 || signals[6] == 0 || signals[5] == signals[6]
            || spentNullifiers[signals[5]] || spentNullifiers[signals[6]]) revert AlreadySpent();
        if ((signals[7] != 0 && (signals[7] == signals[8] || commitments[signals[7]]))
            || (signals[8] != 0 && commitments[signals[8]])) revert DuplicateCommitment();
        uint256 insertCount = (signals[7] == 0 ? 0 : 1) + (signals[8] == 0 ? 0 : 1);
        if (data.publicIn == 0 && data.publicOut == 0 && insertCount == 0) revert InvalidPublicInputs();
        if (nextLeafIndex + insertCount > 1 << TREE_DEPTH) revert TreeFull();
        if (!VERIFIER.verifyProof(pA, pB, pC, signals)) revert InvalidProof();

        spentNullifiers[signals[5]] = true;
        spentNullifiers[signals[6]] = true;
        emit NewNullifier(signals[5]);
        emit NewNullifier(signals[6]);
        if (signals[7] != 0) _insert(signals[7], encryptedOutputs[0]);
        if (signals[8] != 0) _insert(signals[8], encryptedOutputs[1]);
        _pull(data.publicIn);
        accountedBalance -= data.publicOut;
        if (payout != 0) _push(data.recipient, payout);
        if (data.fee != 0) _push(data.feeRecipient, data.fee);
        emit Transacted(data.processor, data.publicIn, data.publicOut, data.fee, currentRoot);
        emit PublicFlow(data.processor, data.recipient, data.feeRecipient, data.publicIn, data.publicOut, data.fee);
    }

    function _insert(uint256 commitment, bytes calldata encryptedOutput) internal {
        uint256 index = nextLeafIndex;
        uint256 node = commitment;
        uint256 cursor = index;
        commitments[commitment] = true;
        nextLeafIndex = index + 1;
        for (uint256 level; level < TREE_DEPTH; level++) {
            if (cursor & 1 == 0) {
                filledSubtrees[level] = node;
                node = PoseidonT3.hash([node, zeros[level]]);
            } else {
                node = PoseidonT3.hash([filledSubtrees[level], node]);
            }
            cursor >>= 1;
        }
        // roots is only a public window of recent roots; acceptance uses _knownRoots.
        uint256 nextRootIndex = (currentRootIndex + 1) % ROOT_HISTORY_SIZE;
        roots[nextRootIndex] = node;
        _knownRoots[node] = true;
        currentRoot = node;
        currentRootIndex = nextRootIndex;
        emit NewCommitment(commitment, index, encryptedOutput);
    }

    function _pull(uint256 amount) internal {
        if (ASSET == address(0)) {
            if (msg.value != amount) revert AssetAmountMismatch();
        } else {
            if (msg.value != 0) revert AssetAmountMismatch();
            if (amount != 0) {
                IERC20 token = IERC20(ASSET);
                uint256 beforeBalance = token.balanceOf(address(this));
                token.safeTransferFrom(msg.sender, address(this), amount);
                if (token.balanceOf(address(this)) != beforeBalance + amount) revert AssetAmountMismatch();
            }
        }
    }

    function _push(address recipient, uint256 amount) internal {
        if (ASSET == address(0)) {
            (bool success,) = recipient.call{value: amount}('');
            if (!success) revert NativeTransferFailed();
        } else {
            IERC20 token = IERC20(ASSET);
            uint256 beforeBalance = token.balanceOf(address(this));
            uint256 recipientBefore = token.balanceOf(recipient);
            token.safeTransfer(recipient, amount);
            if (token.balanceOf(address(this)) + amount != beforeBalance
                || token.balanceOf(recipient) != recipientBefore + amount) revert AssetAmountMismatch();
        }
    }
}
