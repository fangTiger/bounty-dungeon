// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @title DungeonBounty v3
/// @notice Escrow a USDC wager on any dungeon run seed. Challengers replay the
///         exact same seed; the first to beat the poster's score wins the pot.
///         The daily-seed model is removed: every bounty carries its own bytes32
///         seed chosen freely by the poster.
contract DungeonBounty is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using ECDSA for bytes32;

    // -------------------------------------------------------------------------
    // Types
    // -------------------------------------------------------------------------

    struct RunResult {
        address player;
        bytes32 seed;       // map seed used for this run (was uint32 dayId in v2)
        uint64  score;
        bytes32 replayHash;
        bytes32 runId;
    }

    enum BountyStatus { Open, Claimed, Refunded }

    struct Bounty {
        address poster;
        bytes32 seed;        // seed the poster used (challengers must match)
        uint64  target;      // score to beat
        uint256 amount;      // USDC locked
        uint256 deadline;    // Unix timestamp
        BountyStatus status;
    }

    // -------------------------------------------------------------------------
    // Errors
    // -------------------------------------------------------------------------

    error InvalidSignature();
    error WrongSeed();           // replaces WrongDay — run.seed != bounty.seed
    error ScoreNotHighEnough();
    error BountyExpired();
    error BountyNotOpen();
    error DeadlineNotPassed();
    error SelfClaim();
    error AmountOutOfRange();
    error ZeroAddress();
    error RunIdAlreadyUsed();
    error NoPendingProposal();
    error TimelockNotElapsed();
    error ProposalAlreadyPending();
    error VerifierRotationPending();

    // -------------------------------------------------------------------------
    // Events
    // -------------------------------------------------------------------------

    event BountyPosted(
        uint256 indexed bountyId,
        address indexed poster,
        bytes32 seed,
        uint64  target,
        uint256 amount,
        uint256 deadline
    );
    event BountyClaimed(uint256 indexed bountyId, address indexed claimer, uint64 score);
    event BountyRefunded(uint256 indexed bountyId, address indexed poster, uint256 amount);
    event ScoreAttested(
        uint256 indexed bountyId,
        address indexed player,
        bytes32 seed,
        uint64  score,
        bytes32 runId
    );
    event VerifierUpdated(address indexed oldVerifier, address indexed newVerifier);
    event AmountBoundsUpdated(uint256 minAmount, uint256 maxAmount);
    event VerifierProposed(address indexed proposedVerifier, uint256 activeAt);
    event VerifierProposalCancelled(address indexed cancelledVerifier);

    // -------------------------------------------------------------------------
    // Constants & immutables
    // -------------------------------------------------------------------------

    IERC20 public immutable usdc;
    bytes32 private immutable _CACHED_DOMAIN_SEPARATOR;
    uint256 private immutable _CACHED_CHAIN_ID;

    /// @dev Type hash updated: dayId → seed (bytes32)
    bytes32 public constant RUN_RESULT_TYPEHASH =
        keccak256("RunResult(address player,bytes32 seed,uint64 score,bytes32 replayHash,bytes32 runId)");
    uint256 public constant VERIFIER_TIMELOCK = 25 hours;

    // -------------------------------------------------------------------------
    // State
    // -------------------------------------------------------------------------

    address public verifier;
    address public pendingVerifier;
    uint256 public verifierActiveAt;
    uint256 public minAmount;
    uint256 public maxAmount;
    uint256 public bountyCount;

    mapping(uint256 => Bounty) public bounties;
    mapping(uint256 => mapping(bytes32 => bool)) public runUsed;

    // -------------------------------------------------------------------------
    // Constructor
    // -------------------------------------------------------------------------

    constructor(
        address _usdc,
        address _verifier,
        address _initialOwner,
        uint256 _minAmount,
        uint256 _maxAmount
    ) Ownable(_initialOwner) {
        if (_usdc == address(0) || _verifier == address(0)) revert ZeroAddress();
        if (_minAmount == 0 || _minAmount > _maxAmount) revert AmountOutOfRange();

        usdc = IERC20(_usdc);
        verifier = _verifier;
        minAmount = _minAmount;
        maxAmount = _maxAmount;

        _CACHED_CHAIN_ID = block.chainid;
        _CACHED_DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes("DungeonBounty")),
                keccak256(bytes("1")),
                block.chainid,
                address(this)
            )
        );
    }

    // -------------------------------------------------------------------------
    // Core bounty functions
    // -------------------------------------------------------------------------

    /// @notice Post a bounty using a run you just completed.
    ///         The run's seed is stored; challengers must play the same seed.
    ///         Blocked while a verifier rotation is pending (protects in-flight
    ///         signatures from a compromised key being rotated in).
    function postBounty(RunResult calldata myRun, bytes calldata sig, uint256 amount)
        external nonReentrant
    {
        if (verifierActiveAt != 0) revert VerifierRotationPending();
        if (amount < minAmount || amount > maxAmount) revert AmountOutOfRange();

        _verifyRunResult(myRun, sig);

        if (myRun.player != msg.sender) revert InvalidSignature();

        uint256 bountyId = ++bountyCount;
        uint256 deadline = block.timestamp + 1 days;

        bounties[bountyId] = Bounty({
            poster:   msg.sender,
            seed:     myRun.seed,
            target:   myRun.score,
            amount:   amount,
            deadline: deadline,
            status:   BountyStatus.Open
        });

        runUsed[bountyId][myRun.runId] = true;

        emit BountyPosted(bountyId, msg.sender, myRun.seed, myRun.score, amount, deadline);
        emit ScoreAttested(bountyId, myRun.player, myRun.seed, myRun.score, myRun.runId);

        usdc.safeTransferFrom(msg.sender, address(this), amount);
    }

    /// @notice Claim a bounty with a run that beats the poster's score.
    ///         The run must have been played on the same seed as the bounty.
    function claimBounty(uint256 bountyId, RunResult calldata run, bytes calldata sig)
        external nonReentrant
    {
        Bounty memory bounty = bounties[bountyId];

        if (bounty.status != BountyStatus.Open)  revert BountyNotOpen();
        if (block.timestamp >= bounty.deadline)   revert BountyExpired();
        if (run.player == bounty.poster)          revert SelfClaim();
        if (run.player != msg.sender)             revert InvalidSignature();
        if (run.seed   != bounty.seed)            revert WrongSeed();
        if (run.score  <= bounty.target)          revert ScoreNotHighEnough();
        if (runUsed[bountyId][run.runId])         revert RunIdAlreadyUsed();

        _verifyRunResult(run, sig);

        bounties[bountyId].status = BountyStatus.Claimed;
        runUsed[bountyId][run.runId] = true;

        emit BountyClaimed(bountyId, msg.sender, run.score);
        emit ScoreAttested(bountyId, run.player, run.seed, run.score, run.runId);

        usdc.safeTransfer(msg.sender, bounty.amount);
    }

    /// @notice Refund the poster after the deadline if the bounty is unclaimed.
    function refund(uint256 bountyId) external nonReentrant {
        Bounty memory bounty = bounties[bountyId];
        if (bounty.status != BountyStatus.Open) revert BountyNotOpen();
        if (block.timestamp < bounty.deadline)   revert DeadlineNotPassed();
        bounties[bountyId].status = BountyStatus.Refunded;
        emit BountyRefunded(bountyId, bounty.poster, bounty.amount);
        usdc.safeTransfer(bounty.poster, bounty.amount);
    }

    // -------------------------------------------------------------------------
    // Verifier rotation (25-hour timelock)
    // -------------------------------------------------------------------------

    /// @notice Propose a new verifier. Becomes active only after VERIFIER_TIMELOCK seconds.
    function proposeVerifier(address _proposed) external onlyOwner {
        if (_proposed == address(0)) revert ZeroAddress();
        if (verifierActiveAt != 0)  revert ProposalAlreadyPending();
        pendingVerifier  = _proposed;
        verifierActiveAt = block.timestamp + VERIFIER_TIMELOCK;
        emit VerifierProposed(_proposed, verifierActiveAt);
    }

    /// @notice Activate the pending verifier once the timelock has elapsed.
    ///         Anyone can call this — it only succeeds if the timelock has passed.
    function acceptVerifier() external {
        if (verifierActiveAt == 0)              revert NoPendingProposal();
        if (block.timestamp < verifierActiveAt) revert TimelockNotElapsed();
        address old = verifier;
        verifier        = pendingVerifier;
        pendingVerifier  = address(0);
        verifierActiveAt = 0;
        emit VerifierUpdated(old, verifier);
    }

    /// @notice Cancel a pending verifier proposal. Only owner.
    function cancelVerifierProposal() external onlyOwner {
        if (verifierActiveAt == 0) revert NoPendingProposal();
        address cancelled = pendingVerifier;
        pendingVerifier  = address(0);
        verifierActiveAt = 0;
        emit VerifierProposalCancelled(cancelled);
    }

    // -------------------------------------------------------------------------
    // Admin
    // -------------------------------------------------------------------------

    function setAmountBounds(uint256 _min, uint256 _max) external onlyOwner {
        if (_min == 0 || _min > _max) revert AmountOutOfRange();
        minAmount = _min;
        maxAmount = _max;
        emit AmountBoundsUpdated(_min, _max);
    }

    // -------------------------------------------------------------------------
    // Views
    // -------------------------------------------------------------------------

    function DOMAIN_SEPARATOR() public view returns (bytes32) {
        return _domainSeparator();
    }

    // -------------------------------------------------------------------------
    // Internal helpers
    // -------------------------------------------------------------------------

    function _verifyRunResult(RunResult calldata run, bytes calldata sig) internal view {
        bytes32 structHash = keccak256(
            abi.encode(RUN_RESULT_TYPEHASH, run.player, run.seed, run.score, run.replayHash, run.runId)
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", _domainSeparator(), structHash));
        address signer = ECDSA.recover(digest, sig);
        if (signer != verifier) revert InvalidSignature();
    }

    function _domainSeparator() internal view returns (bytes32) {
        if (block.chainid == _CACHED_CHAIN_ID) return _CACHED_DOMAIN_SEPARATOR;
        return keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes("DungeonBounty")),
                keccak256(bytes("1")),
                block.chainid,
                address(this)
            )
        );
    }
}
