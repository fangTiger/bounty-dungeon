// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {console} from "forge-std/console.sol";
import {DungeonBounty} from "../DungeonBounty.sol";
import {MockERC20} from "../test-helpers/MockERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

contract DungeonBountyTest is Test {
    // ─── signing keys ──────────────────────────────────────────────────────────
    uint256 private constant VERIFIER_KEY     = 0xDEADBEEFCAFEBABE0001020304050607DEADBEEFCAFEBABE0001020304050607;
    uint256 private constant NEW_VERIFIER_KEY = 0xFEEDFACECAFEBABE0001020304050607FEEDFACECAFEBABE0001020304050607;
    uint256 private constant ATTACKER_KEY     = 0xBAD0000000000000000000000000000000000000000000000000000000000001;

    uint256 private constant POSTER_KEY  = 0xA110C0DE0000000000000000000000000000000000000000000000000000BEEF;
    uint256 private constant CLAIMER_KEY = 0xC1A10000E000000000000000000000000000000000000000000000000000DEAD;

    // ─── amounts (6-decimal USDC) ──────────────────────────────────────────────
    uint256 internal constant MIN_AMOUNT  = 100_000;
    uint256 internal constant MAX_AMOUNT  = 10_000_000;
    uint256 internal constant POST_AMOUNT = 1_000_000;

    // v3 EIP-712 struct typehash (seed replaces dayId)
    bytes32 private constant RUN_RESULT_TYPEHASH =
        keccak256("RunResult(address player,bytes32 seed,uint64 score,bytes32 replayHash,bytes32 runId)");

    // A canonical seed used across most tests (arbitrary bytes32)
    bytes32 internal constant BOUNTY_SEED = keccak256("arc-dungeon-test-seed-v3");

    // ─── actors ────────────────────────────────────────────────────────────────
    address internal owner;
    address internal verifier;
    address internal newVerifier;
    address internal attacker;
    address internal poster;
    address internal claimer;

    // ─── contracts ─────────────────────────────────────────────────────────────
    DungeonBounty internal board;
    MockERC20     internal usdc;

    // ═══════════════════════════════════════════════════════════════════════════
    //  setUp
    // ═══════════════════════════════════════════════════════════════════════════

    function setUp() public {
        verifier    = vm.addr(VERIFIER_KEY);
        newVerifier = vm.addr(NEW_VERIFIER_KEY);
        attacker    = vm.addr(ATTACKER_KEY);
        poster      = vm.addr(POSTER_KEY);
        claimer     = vm.addr(CLAIMER_KEY);
        owner       = makeAddr("owner");

        usdc = new MockERC20("Mock USDC", "mUSDC", 6);

        board = new DungeonBounty(
            address(usdc),
            verifier,
            owner,
            MIN_AMOUNT,
            MAX_AMOUNT
        );

        usdc.mint(poster,  100 * POST_AMOUNT);
        usdc.mint(claimer, 100 * POST_AMOUNT);

        vm.prank(poster);  usdc.approve(address(board), type(uint256).max);
        vm.prank(claimer); usdc.approve(address(board), type(uint256).max);

        vm.warp(2 days);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  Internal helpers
    // ═══════════════════════════════════════════════════════════════════════════

    function _domainSeparator() internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes("DungeonBounty")),
                keccak256(bytes("1")),
                block.chainid,
                address(board)
            )
        );
    }

    function _domainSeparatorFor(address contractAddr) internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes("DungeonBounty")),
                keccak256(bytes("1")),
                block.chainid,
                contractAddr
            )
        );
    }

    function _sign(uint256 signerKey, DungeonBounty.RunResult memory run)
        internal view returns (bytes memory)
    {
        bytes32 structHash = keccak256(
            abi.encode(RUN_RESULT_TYPEHASH, run.player, run.seed, run.score, run.replayHash, run.runId)
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", _domainSeparator(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKey, digest);
        return abi.encodePacked(r, s, v);
    }

    function _signForContract(
        uint256 signerKey,
        address contractAddr,
        DungeonBounty.RunResult memory run
    ) internal view returns (bytes memory) {
        bytes32 sep = _domainSeparatorFor(contractAddr);
        bytes32 structHash = keccak256(
            abi.encode(RUN_RESULT_TYPEHASH, run.player, run.seed, run.score, run.replayHash, run.runId)
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", sep, structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKey, digest);
        return abi.encodePacked(r, s, v);
    }

    /// @dev Post a bounty from `poster` with given score and BOUNTY_SEED; returns bountyId.
    function _postBounty(uint64 score) internal returns (uint256 bountyId) {
        return _postBountyWithSeed(score, BOUNTY_SEED, keccak256("runid-poster"));
    }

    function _postBountyWithSeed(uint64 score, bytes32 seed, bytes32 runId)
        internal returns (uint256 bountyId)
    {
        DungeonBounty.RunResult memory run = DungeonBounty.RunResult({
            player:     poster,
            seed:       seed,
            score:      score,
            replayHash: keccak256(abi.encode("replay-poster", seed)),
            runId:      runId
        });
        bytes memory sig = _sign(VERIFIER_KEY, run);
        vm.prank(poster);
        board.postBounty(run, sig, POST_AMOUNT);
        bountyId = board.bountyCount();
    }

    /// @dev Post a bounty signed by an arbitrary key (for rotation tests).
    function _postBountyWith(uint64 score, uint256 signerKey, bytes32 runId)
        internal returns (uint256 bountyId)
    {
        DungeonBounty.RunResult memory run = DungeonBounty.RunResult({
            player:     poster,
            seed:       BOUNTY_SEED,
            score:      score,
            replayHash: keccak256(abi.encode("replay", runId)),
            runId:      runId
        });
        bytes memory sig = _sign(signerKey, run);
        vm.prank(poster);
        board.postBounty(run, sig, POST_AMOUNT);
        bountyId = board.bountyCount();
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  Deployment & initialization
    // ═══════════════════════════════════════════════════════════════════════════

    function test_constructor_setsState() public view {
        assertEq(address(board.usdc()),    address(usdc));
        assertEq(board.verifier(),         verifier);
        assertEq(board.minAmount(),        MIN_AMOUNT);
        assertEq(board.maxAmount(),        MAX_AMOUNT);
        assertEq(board.bountyCount(),      0);
        assertEq(board.owner(),            owner);
        assertEq(board.pendingVerifier(),  address(0));
        assertEq(board.verifierActiveAt(), 0);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  1. Happy path – postBounty
    // ═══════════════════════════════════════════════════════════════════════════

    function test_postBounty_success() public {
        uint64  score = 500;
        bytes32 seed  = BOUNTY_SEED;

        DungeonBounty.RunResult memory run = DungeonBounty.RunResult({
            player:     poster,
            seed:       seed,
            score:      score,
            replayHash: keccak256("replay1"),
            runId:      keccak256("runid1")
        });
        bytes memory sig = _sign(VERIFIER_KEY, run);

        uint256 posterBefore   = usdc.balanceOf(poster);
        uint256 contractBefore = usdc.balanceOf(address(board));

        vm.expectEmit(true, true, false, true, address(board));
        emit DungeonBounty.BountyPosted(1, poster, seed, score, POST_AMOUNT, block.timestamp + 1 days);

        vm.expectEmit(true, true, false, true, address(board));
        emit DungeonBounty.ScoreAttested(1, poster, seed, score, run.runId);

        vm.prank(poster);
        board.postBounty(run, sig, POST_AMOUNT);

        assertEq(usdc.balanceOf(poster),         posterBefore   - POST_AMOUNT);
        assertEq(usdc.balanceOf(address(board)), contractBefore + POST_AMOUNT);

        // Check stored bounty seed, target, amount
        (address storedPoster, bytes32 storedSeed, uint64 storedTarget, uint256 storedAmount,,) = board.bounties(1);
        assertEq(storedPoster, poster);
        assertEq(storedSeed,   seed);
        assertEq(storedTarget, score);
        assertEq(storedAmount, POST_AMOUNT);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  2. Happy path – claimBounty
    // ═══════════════════════════════════════════════════════════════════════════

    function test_claimBounty_success() public {
        uint64 postScore  = 500;
        uint64 claimScore = 600;

        uint256 bountyId = _postBounty(postScore);

        DungeonBounty.RunResult memory claimRun = DungeonBounty.RunResult({
            player:     claimer,
            seed:       BOUNTY_SEED,
            score:      claimScore,
            replayHash: keccak256("replay-claimer"),
            runId:      keccak256("runid-claimer")
        });
        bytes memory sig = _sign(VERIFIER_KEY, claimRun);

        uint256 claimerBefore  = usdc.balanceOf(claimer);
        uint256 contractBefore = usdc.balanceOf(address(board));

        vm.expectEmit(true, true, false, true, address(board));
        emit DungeonBounty.BountyClaimed(bountyId, claimer, claimScore);

        vm.expectEmit(true, true, false, true, address(board));
        emit DungeonBounty.ScoreAttested(bountyId, claimer, BOUNTY_SEED, claimScore, claimRun.runId);

        vm.prank(claimer);
        board.claimBounty(bountyId, claimRun, sig);

        assertEq(usdc.balanceOf(claimer),        claimerBefore  + POST_AMOUNT);
        assertEq(usdc.balanceOf(address(board)), contractBefore - POST_AMOUNT);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  3. Happy path – refund
    // ═══════════════════════════════════════════════════════════════════════════

    function test_refund_success() public {
        uint256 bountyId = _postBounty(400);

        vm.warp(block.timestamp + 1 days + 1);

        uint256 posterBefore   = usdc.balanceOf(poster);
        uint256 contractBefore = usdc.balanceOf(address(board));

        vm.expectEmit(true, true, false, true, address(board));
        emit DungeonBounty.BountyRefunded(bountyId, poster, POST_AMOUNT);

        board.refund(bountyId);

        assertEq(usdc.balanceOf(poster),         posterBefore   + POST_AMOUNT);
        assertEq(usdc.balanceOf(address(board)), contractBefore - POST_AMOUNT);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  4. Happy path – proposeVerifier
    // ═══════════════════════════════════════════════════════════════════════════

    function test_proposeVerifier_success() public {
        uint256 expectedActiveAt = block.timestamp + board.VERIFIER_TIMELOCK();

        vm.expectEmit(true, false, false, true, address(board));
        emit DungeonBounty.VerifierProposed(newVerifier, expectedActiveAt);

        vm.prank(owner);
        board.proposeVerifier(newVerifier);

        assertEq(board.pendingVerifier(),  newVerifier);
        assertEq(board.verifierActiveAt(), expectedActiveAt);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  5. Happy path – acceptVerifier
    // ═══════════════════════════════════════════════════════════════════════════

    function test_acceptVerifier_success() public {
        vm.prank(owner);
        board.proposeVerifier(newVerifier);

        vm.warp(block.timestamp + 25 hours + 1);

        vm.expectEmit(true, true, false, false, address(board));
        emit DungeonBounty.VerifierUpdated(verifier, newVerifier);

        board.acceptVerifier();

        assertEq(board.verifier(),         newVerifier);
        assertEq(board.pendingVerifier(),  address(0));
        assertEq(board.verifierActiveAt(), 0);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  6. Happy path – cancelVerifierProposal
    // ═══════════════════════════════════════════════════════════════════════════

    function test_cancelVerifierProposal_success() public {
        vm.prank(owner);
        board.proposeVerifier(newVerifier);

        vm.expectEmit(true, false, false, false, address(board));
        emit DungeonBounty.VerifierProposalCancelled(newVerifier);

        vm.prank(owner);
        board.cancelVerifierProposal();

        assertEq(board.pendingVerifier(),  address(0));
        assertEq(board.verifierActiveAt(), 0);
        assertEq(board.verifier(), verifier);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  7. Happy path – postBounty after completed rotation
    // ═══════════════════════════════════════════════════════════════════════════

    function test_postBounty_after_verifier_rotation() public {
        vm.prank(owner);
        board.proposeVerifier(newVerifier);
        vm.warp(block.timestamp + 25 hours + 1);
        board.acceptVerifier();
        assertEq(board.verifier(), newVerifier);

        DungeonBounty.RunResult memory run = DungeonBounty.RunResult({
            player:     poster,
            seed:       BOUNTY_SEED,
            score:      300,
            replayHash: keccak256("rotation-replay"),
            runId:      keccak256("rotation-runid")
        });
        bytes memory sig = _sign(NEW_VERIFIER_KEY, run);

        vm.prank(poster);
        board.postBounty(run, sig, POST_AMOUNT);

        assertEq(board.bountyCount(), 1);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  8. Revert – claimBounty equal score
    // ═══════════════════════════════════════════════════════════════════════════

    function test_claimBounty_equalScore_reverts() public {
        uint64 score = 500;
        uint256 bountyId = _postBounty(score);

        DungeonBounty.RunResult memory claimRun = DungeonBounty.RunResult({
            player:     claimer,
            seed:       BOUNTY_SEED,
            score:      score,
            replayHash: keccak256("r2"),
            runId:      keccak256("run2")
        });
        bytes memory sig = _sign(VERIFIER_KEY, claimRun);

        vm.expectRevert(DungeonBounty.ScoreNotHighEnough.selector);
        vm.prank(claimer);
        board.claimBounty(bountyId, claimRun, sig);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  9. Revert – claimBounty lower score
    // ═══════════════════════════════════════════════════════════════════════════

    function test_claimBounty_lowerScore_reverts() public {
        uint256 bountyId = _postBounty(500);

        DungeonBounty.RunResult memory claimRun = DungeonBounty.RunResult({
            player:     claimer,
            seed:       BOUNTY_SEED,
            score:      499,
            replayHash: keccak256("r3"),
            runId:      keccak256("run3")
        });
        bytes memory sig = _sign(VERIFIER_KEY, claimRun);

        vm.expectRevert(DungeonBounty.ScoreNotHighEnough.selector);
        vm.prank(claimer);
        board.claimBounty(bountyId, claimRun, sig);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  10. Revert – claimBounty self-claim
    // ═══════════════════════════════════════════════════════════════════════════

    function test_claimBounty_posterSelf_reverts() public {
        uint256 bountyId = _postBounty(400);

        DungeonBounty.RunResult memory selfRun = DungeonBounty.RunResult({
            player:     poster,
            seed:       BOUNTY_SEED,
            score:      999,
            replayHash: keccak256("r-self"),
            runId:      keccak256("run-self")
        });
        bytes memory sig = _sign(VERIFIER_KEY, selfRun);

        vm.expectRevert(DungeonBounty.SelfClaim.selector);
        vm.prank(poster);
        board.claimBounty(bountyId, selfRun, sig);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  11. Revert – claimBounty wrong seed → WrongSeed (replaces WrongDay)
    // ═══════════════════════════════════════════════════════════════════════════

    /// @dev v3: run.seed != bounty.seed → WrongSeed.
    function test_claimBounty_wrongSeed_reverts() public {
        uint256 bountyId = _postBounty(400);
        bytes32 wrongSeed = keccak256("totally-different-seed");

        DungeonBounty.RunResult memory claimRun = DungeonBounty.RunResult({
            player:     claimer,
            seed:       wrongSeed,
            score:      999,
            replayHash: keccak256("r4"),
            runId:      keccak256("run4")
        });
        bytes memory sig = _sign(VERIFIER_KEY, claimRun);

        vm.expectRevert(DungeonBounty.WrongSeed.selector);
        vm.prank(claimer);
        board.claimBounty(bountyId, claimRun, sig);
    }

    /// @dev v3: zero seed in claim when bounty has non-zero seed → WrongSeed.
    function test_claimBounty_zeroSeed_reverts() public {
        uint256 bountyId = _postBounty(400);

        DungeonBounty.RunResult memory claimRun = DungeonBounty.RunResult({
            player:     claimer,
            seed:       bytes32(0),
            score:      999,
            replayHash: keccak256("r4b"),
            runId:      keccak256("run4b")
        });
        bytes memory sig = _sign(VERIFIER_KEY, claimRun);

        vm.expectRevert(DungeonBounty.WrongSeed.selector);
        vm.prank(claimer);
        board.claimBounty(bountyId, claimRun, sig);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  12. Revert – claimBounty expired
    // ═══════════════════════════════════════════════════════════════════════════

    function test_claimBounty_expired_reverts() public {
        uint256 bountyId = _postBounty(400);

        vm.warp(block.timestamp + 1 days + 1);

        (, bytes32 bSeed,,,,) = board.bounties(bountyId);

        DungeonBounty.RunResult memory claimRun = DungeonBounty.RunResult({
            player:     claimer,
            seed:       bSeed,
            score:      999,
            replayHash: keccak256("r5"),
            runId:      keccak256("run5")
        });
        bytes memory sig = _sign(VERIFIER_KEY, claimRun);

        vm.expectRevert(DungeonBounty.BountyExpired.selector);
        vm.prank(claimer);
        board.claimBounty(bountyId, claimRun, sig);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  13. Revert – claimBounty already claimed
    // ═══════════════════════════════════════════════════════════════════════════

    function test_claimBounty_alreadyClaimed_reverts() public {
        uint256 bountyId = _postBounty(400);

        DungeonBounty.RunResult memory run1 = DungeonBounty.RunResult({
            player:     claimer,
            seed:       BOUNTY_SEED,
            score:      999,
            replayHash: keccak256("r6a"),
            runId:      keccak256("run6a")
        });
        bytes memory sig1 = _sign(VERIFIER_KEY, run1);
        vm.prank(claimer);
        board.claimBounty(bountyId, run1, sig1);

        DungeonBounty.RunResult memory run2 = DungeonBounty.RunResult({
            player:     claimer,
            seed:       BOUNTY_SEED,
            score:      999,
            replayHash: keccak256("r6b"),
            runId:      keccak256("run6b")
        });
        bytes memory sig2 = _sign(VERIFIER_KEY, run2);

        vm.expectRevert(DungeonBounty.BountyNotOpen.selector);
        vm.prank(claimer);
        board.claimBounty(bountyId, run2, sig2);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  14. Revert – refund before deadline
    // ═══════════════════════════════════════════════════════════════════════════

    function test_refund_beforeDeadline_reverts() public {
        uint256 bountyId = _postBounty(400);

        vm.expectRevert(DungeonBounty.DeadlineNotPassed.selector);
        board.refund(bountyId);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  15. Revert – refund on claimed bounty
    // ═══════════════════════════════════════════════════════════════════════════

    function test_refund_alreadyClaimed_reverts() public {
        uint256 bountyId = _postBounty(400);

        DungeonBounty.RunResult memory claimRun = DungeonBounty.RunResult({
            player:     claimer,
            seed:       BOUNTY_SEED,
            score:      999,
            replayHash: keccak256("r7"),
            runId:      keccak256("run7")
        });
        bytes memory sig = _sign(VERIFIER_KEY, claimRun);
        vm.prank(claimer);
        board.claimBounty(bountyId, claimRun, sig);

        vm.warp(block.timestamp + 1 days + 1);

        vm.expectRevert(DungeonBounty.BountyNotOpen.selector);
        board.refund(bountyId);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  16. Revert – postBounty amount too low
    // ═══════════════════════════════════════════════════════════════════════════

    function test_postBounty_amountTooLow_reverts() public {
        DungeonBounty.RunResult memory run = DungeonBounty.RunResult({
            player:     poster,
            seed:       BOUNTY_SEED,
            score:      400,
            replayHash: keccak256("r9"),
            runId:      keccak256("run9")
        });
        bytes memory sig = _sign(VERIFIER_KEY, run);

        vm.expectRevert(DungeonBounty.AmountOutOfRange.selector);
        vm.prank(poster);
        board.postBounty(run, sig, MIN_AMOUNT - 1);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  17. Revert – postBounty amount too high
    // ═══════════════════════════════════════════════════════════════════════════

    function test_postBounty_amountTooHigh_reverts() public {
        DungeonBounty.RunResult memory run = DungeonBounty.RunResult({
            player:     poster,
            seed:       BOUNTY_SEED,
            score:      400,
            replayHash: keccak256("r10"),
            runId:      keccak256("run10")
        });
        bytes memory sig = _sign(VERIFIER_KEY, run);

        vm.expectRevert(DungeonBounty.AmountOutOfRange.selector);
        vm.prank(poster);
        board.postBounty(run, sig, MAX_AMOUNT + 1);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  18. Revert – forged signature
    // ═══════════════════════════════════════════════════════════════════════════

    function test_forged_signature_reverts() public {
        DungeonBounty.RunResult memory run = DungeonBounty.RunResult({
            player:     poster,
            seed:       BOUNTY_SEED,
            score:      400,
            replayHash: keccak256("r11"),
            runId:      keccak256("run11")
        });
        bytes memory sig = _sign(ATTACKER_KEY, run);

        vm.expectRevert(DungeonBounty.InvalidSignature.selector);
        vm.prank(poster);
        board.postBounty(run, sig, POST_AMOUNT);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  19. Revert – domain separation: wrong verifyingContract
    // ═══════════════════════════════════════════════════════════════════════════

    function test_domain_separation_wrong_contract() public {
        DungeonBounty board2 = new DungeonBounty(
            address(usdc), verifier, owner, MIN_AMOUNT, MAX_AMOUNT
        );

        DungeonBounty.RunResult memory run = DungeonBounty.RunResult({
            player:     poster,
            seed:       BOUNTY_SEED,
            score:      400,
            replayHash: keccak256("r13"),
            runId:      keccak256("run13")
        });
        bytes memory sig = _signForContract(VERIFIER_KEY, address(board2), run);

        vm.expectRevert(DungeonBounty.InvalidSignature.selector);
        vm.prank(poster);
        board.postBounty(run, sig, POST_AMOUNT);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  20. Revert – runId replay
    // ═══════════════════════════════════════════════════════════════════════════

    function test_runId_replay_reverts() public {
        uint256 bountyId = _postBounty(400);

        bytes32 posterRunId = keccak256("runid-poster");

        DungeonBounty.RunResult memory replayRun = DungeonBounty.RunResult({
            player:     claimer,
            seed:       BOUNTY_SEED,
            score:      999,
            replayHash: keccak256("rr2"),
            runId:      posterRunId
        });
        bytes memory sig = _sign(VERIFIER_KEY, replayRun);

        vm.expectRevert(DungeonBounty.RunIdAlreadyUsed.selector);
        vm.prank(claimer);
        board.claimBounty(bountyId, replayRun, sig);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  21. Revert – constructor zero address usdc
    // ═══════════════════════════════════════════════════════════════════════════

    function test_constructor_zeroAddress_usdc_reverts() public {
        vm.expectRevert(DungeonBounty.ZeroAddress.selector);
        new DungeonBounty(address(0), verifier, owner, MIN_AMOUNT, MAX_AMOUNT);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  22. Revert – constructor zero address verifier
    // ═══════════════════════════════════════════════════════════════════════════

    function test_constructor_zeroAddress_verifier_reverts() public {
        vm.expectRevert(DungeonBounty.ZeroAddress.selector);
        new DungeonBounty(address(usdc), address(0), owner, MIN_AMOUNT, MAX_AMOUNT);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  23. Revert – constructor minAmount == 0
    // ═══════════════════════════════════════════════════════════════════════════

    function test_constructor_minAmountZero_reverts() public {
        vm.expectRevert(DungeonBounty.AmountOutOfRange.selector);
        new DungeonBounty(address(usdc), verifier, owner, 0, MAX_AMOUNT);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  24. Revert – constructor min > max
    // ═══════════════════════════════════════════════════════════════════════════

    function test_constructor_minGtMax_reverts() public {
        vm.expectRevert(DungeonBounty.AmountOutOfRange.selector);
        new DungeonBounty(address(usdc), verifier, owner, MAX_AMOUNT + 1, MAX_AMOUNT);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  25. Revert – setAmountBounds min > max
    // ═══════════════════════════════════════════════════════════════════════════

    function test_setAmountBounds_minGtMax_reverts() public {
        vm.prank(owner);
        vm.expectRevert(DungeonBounty.AmountOutOfRange.selector);
        board.setAmountBounds(MAX_AMOUNT + 1, MAX_AMOUNT);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  26. Revert – non-owner proposeVerifier
    // ═══════════════════════════════════════════════════════════════════════════

    function test_nonOwner_proposeVerifier_reverts() public {
        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, attacker));
        board.proposeVerifier(newVerifier);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  27. Revert – non-owner cancelVerifierProposal
    // ═══════════════════════════════════════════════════════════════════════════

    function test_nonOwner_cancelVerifierProposal_reverts() public {
        vm.prank(owner);
        board.proposeVerifier(newVerifier);

        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, attacker));
        board.cancelVerifierProposal();
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  28. Revert – non-owner setAmountBounds
    // ═══════════════════════════════════════════════════════════════════════════

    function test_nonOwner_setAmountBounds_reverts() public {
        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, attacker));
        board.setAmountBounds(MIN_AMOUNT, MAX_AMOUNT);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  29. Revert – acceptVerifier before timelock elapsed
    // ═══════════════════════════════════════════════════════════════════════════

    function test_acceptVerifier_before25h_reverts() public {
        vm.prank(owner);
        board.proposeVerifier(newVerifier);

        vm.warp(block.timestamp + 25 hours - 1);

        vm.expectRevert(DungeonBounty.TimelockNotElapsed.selector);
        board.acceptVerifier();
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  30. Revert – acceptVerifier with no pending proposal
    // ═══════════════════════════════════════════════════════════════════════════

    function test_acceptVerifier_noPending_reverts() public {
        vm.expectRevert(DungeonBounty.NoPendingProposal.selector);
        board.acceptVerifier();
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  31. Revert – cancelVerifierProposal with no pending proposal
    // ═══════════════════════════════════════════════════════════════════════════

    function test_cancelVerifierProposal_noPending_reverts() public {
        vm.prank(owner);
        vm.expectRevert(DungeonBounty.NoPendingProposal.selector);
        board.cancelVerifierProposal();
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  32. Revert – proposeVerifier when already pending
    // ═══════════════════════════════════════════════════════════════════════════

    function test_proposeVerifier_alreadyPending_reverts() public {
        vm.prank(owner);
        board.proposeVerifier(newVerifier);

        address anotherVerifier = makeAddr("anotherVerifier");
        vm.prank(owner);
        vm.expectRevert(DungeonBounty.ProposalAlreadyPending.selector);
        board.proposeVerifier(anotherVerifier);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  33. Revert – postBounty while rotation pending
    // ═══════════════════════════════════════════════════════════════════════════

    function test_postBounty_verifierRotationPending_reverts() public {
        vm.prank(owner);
        board.proposeVerifier(newVerifier);

        DungeonBounty.RunResult memory run = DungeonBounty.RunResult({
            player:     poster,
            seed:       BOUNTY_SEED,
            score:      400,
            replayHash: keccak256("pend-replay"),
            runId:      keccak256("pend-runid")
        });
        bytes memory sig = _sign(VERIFIER_KEY, run);

        vm.expectRevert(DungeonBounty.VerifierRotationPending.selector);
        vm.prank(poster);
        board.postBounty(run, sig, POST_AMOUNT);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  34. Revert – proposeVerifier zero address
    // ═══════════════════════════════════════════════════════════════════════════

    function test_proposeVerifier_zeroAddress_reverts() public {
        vm.prank(owner);
        vm.expectRevert(DungeonBounty.ZeroAddress.selector);
        board.proposeVerifier(address(0));
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  35. Security – owner cannot drain escrow
    // ═══════════════════════════════════════════════════════════════════════════

    function test_owner_cannot_move_escrow() public {
        uint256 bountyId = _postBounty(400);
        uint256 escrow   = usdc.balanceOf(address(board));
        assertEq(escrow, POST_AMOUNT);

        vm.startPrank(owner);
        board.proposeVerifier(newVerifier);
        board.cancelVerifierProposal();
        board.setAmountBounds(MIN_AMOUNT, MAX_AMOUNT);
        vm.stopPrank();

        assertEq(usdc.balanceOf(address(board)), escrow);
        assertTrue(bountyId == 1);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  36. Security – post-rotation claim must use NEW verifier sig
    // ═══════════════════════════════════════════════════════════════════════════

    function test_postRotationBounty_requiresNewVerifierSig() public {
        vm.prank(owner);
        board.proposeVerifier(newVerifier);
        vm.warp(block.timestamp + 25 hours + 1);
        board.acceptVerifier();
        assertEq(board.verifier(), newVerifier);

        uint256 bountyId = _postBountyWith(400, NEW_VERIFIER_KEY, keccak256("post-after-rotation"));

        // 36a: claim with OLD verifier sig → InvalidSignature
        DungeonBounty.RunResult memory claimRunOld = DungeonBounty.RunResult({
            player:     claimer,
            seed:       BOUNTY_SEED,
            score:      999,
            replayHash: keccak256("r38a"),
            runId:      keccak256("run38a")
        });
        bytes memory sigOld = _sign(VERIFIER_KEY, claimRunOld);

        vm.expectRevert(DungeonBounty.InvalidSignature.selector);
        vm.prank(claimer);
        board.claimBounty(bountyId, claimRunOld, sigOld);

        // 36b: claim with NEW verifier sig → success
        DungeonBounty.RunResult memory claimRunNew = DungeonBounty.RunResult({
            player:     claimer,
            seed:       BOUNTY_SEED,
            score:      999,
            replayHash: keccak256("r38b"),
            runId:      keccak256("run38b")
        });
        bytes memory sigNew = _sign(NEW_VERIFIER_KEY, claimRunNew);

        uint256 claimerBefore = usdc.balanceOf(claimer);
        vm.prank(claimer);
        board.claimBounty(bountyId, claimRunNew, sigNew);
        assertEq(usdc.balanceOf(claimer), claimerBefore + POST_AMOUNT);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  37. Fuzz – scores
    // ═══════════════════════════════════════════════════════════════════════════

    function testFuzz_score(uint64 challengerScore, uint64 posterScore) public {
        vm.assume(posterScore > 0);

        uint256 bountyId;
        {
            DungeonBounty.RunResult memory postRun = DungeonBounty.RunResult({
                player:     poster,
                seed:       BOUNTY_SEED,
                score:      posterScore,
                replayHash: keccak256(abi.encode("fuzz-replay-post", posterScore)),
                runId:      keccak256(abi.encode("fuzz-runid-post",  posterScore))
            });
            bytes memory postSig = _sign(VERIFIER_KEY, postRun);
            vm.prank(poster);
            board.postBounty(postRun, postSig, POST_AMOUNT);
            bountyId = board.bountyCount();
        }

        DungeonBounty.RunResult memory claimRun = DungeonBounty.RunResult({
            player:     claimer,
            seed:       BOUNTY_SEED,
            score:      challengerScore,
            replayHash: keccak256(abi.encode("fuzz-replay-claim", challengerScore)),
            runId:      keccak256(abi.encode("fuzz-runid-claim",  challengerScore))
        });
        bytes memory claimSig = _sign(VERIFIER_KEY, claimRun);

        if (challengerScore > posterScore) {
            vm.prank(claimer);
            board.claimBounty(bountyId, claimRun, claimSig);
        } else {
            vm.expectRevert(DungeonBounty.ScoreNotHighEnough.selector);
            vm.prank(claimer);
            board.claimBounty(bountyId, claimRun, claimSig);
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  38. Fuzz – amounts
    // ═══════════════════════════════════════════════════════════════════════════

    function testFuzz_amount(uint256 amount) public {
        vm.assume(amount > 0 && amount <= type(uint128).max);

        DungeonBounty.RunResult memory run = DungeonBounty.RunResult({
            player:     poster,
            seed:       BOUNTY_SEED,
            score:      400,
            replayHash: keccak256(abi.encode("fuzz-amt-replay", amount)),
            runId:      keccak256(abi.encode("fuzz-amt-runid",  amount))
        });
        bytes memory sig = _sign(VERIFIER_KEY, run);

        usdc.mint(poster, amount);

        if (amount >= MIN_AMOUNT && amount <= MAX_AMOUNT) {
            vm.prank(poster);
            board.postBounty(run, sig, amount);
        } else {
            vm.expectRevert(DungeonBounty.AmountOutOfRange.selector);
            vm.prank(poster);
            board.postBounty(run, sig, amount);
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  Admin happy paths (setAmountBounds)
    // ═══════════════════════════════════════════════════════════════════════════

    function test_setAmountBounds_success() public {
        uint256 newMin = 200_000;
        uint256 newMax = 5_000_000;

        vm.expectEmit(false, false, false, true, address(board));
        emit DungeonBounty.AmountBoundsUpdated(newMin, newMax);

        vm.prank(owner);
        board.setAmountBounds(newMin, newMax);

        assertEq(board.minAmount(), newMin);
        assertEq(board.maxAmount(), newMax);
    }

    function test_setAmountBounds_minEqualsMax_success() public {
        vm.prank(owner);
        board.setAmountBounds(500_000, 500_000);
        assertEq(board.minAmount(), 500_000);
        assertEq(board.maxAmount(), 500_000);
    }

    function test_domainSeparator_matchesComputed() public view {
        assertEq(board.DOMAIN_SEPARATOR(), _domainSeparator());
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  39. Multiple bounties with DIFFERENT seeds
    // ═══════════════════════════════════════════════════════════════════════════

    /// @dev v3: two bounties on different seeds are independent; cross-seed claim fails.
    function test_twoBounties_differentSeeds_crossSeedClaimFails() public {
        bytes32 seedA = keccak256("seed-A");
        bytes32 seedB = keccak256("seed-B");

        uint256 idA = _postBountyWithSeed(500, seedA, keccak256("rid-a"));
        uint256 idB = _postBountyWithSeed(500, seedB, keccak256("rid-b"));

        // Claim bounty A with seed B → WrongSeed
        DungeonBounty.RunResult memory run = DungeonBounty.RunResult({
            player:     claimer,
            seed:       seedB,
            score:      999,
            replayHash: keccak256("rh"),
            runId:      keccak256("rid-c")
        });
        bytes memory sig = _sign(VERIFIER_KEY, run);

        vm.expectRevert(DungeonBounty.WrongSeed.selector);
        vm.prank(claimer);
        board.claimBounty(idA, run, sig);

        // Same run with seedB can correctly claim bounty B
        vm.prank(claimer);
        board.claimBounty(idB, run, sig);

        (, , , , , DungeonBounty.BountyStatus statusB) = board.bounties(idB);
        assertEq(uint256(statusB), uint256(DungeonBounty.BountyStatus.Claimed));
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  40. Security – pre-rotation bounty expires before new verifier is active
    // ═══════════════════════════════════════════════════════════════════════════

    function test_preRotationBounty_expiresBeforeNewVerifierActive() public {
        uint256 bountyId = _postBounty(300);

        (,,,, uint256 deadline,) = board.bounties(bountyId);

        vm.prank(owner);
        board.proposeVerifier(newVerifier);

        vm.warp(block.timestamp + 25 hours + 1);
        board.acceptVerifier();
        assertEq(board.verifier(), newVerifier);

        assertTrue(block.timestamp > deadline, "block.timestamp should exceed bounty deadline");

        (, bytes32 bSeed,,,,) = board.bounties(bountyId);

        // Old key → BountyExpired
        DungeonBounty.RunResult memory claimOld = DungeonBounty.RunResult({
            player:     claimer,
            seed:       bSeed,
            score:      999,
            replayHash: keccak256("pre-rot-old"),
            runId:      keccak256("run-pre-rot-old")
        });
        bytes memory sigOld = _sign(VERIFIER_KEY, claimOld);
        vm.expectRevert(DungeonBounty.BountyExpired.selector);
        vm.prank(claimer);
        board.claimBounty(bountyId, claimOld, sigOld);

        // New key → also BountyExpired
        DungeonBounty.RunResult memory claimNew = DungeonBounty.RunResult({
            player:     claimer,
            seed:       bSeed,
            score:      999,
            replayHash: keccak256("pre-rot-new"),
            runId:      keccak256("run-pre-rot-new")
        });
        bytes memory sigNew = _sign(NEW_VERIFIER_KEY, claimNew);
        vm.expectRevert(DungeonBounty.BountyExpired.selector);
        vm.prank(claimer);
        board.claimBounty(bountyId, claimNew, sigNew);

        // refund() succeeds
        uint256 posterBefore   = usdc.balanceOf(poster);
        uint256 contractBefore = usdc.balanceOf(address(board));

        vm.expectEmit(true, true, false, true, address(board));
        emit DungeonBounty.BountyRefunded(bountyId, poster, POST_AMOUNT);
        board.refund(bountyId);

        assertEq(usdc.balanceOf(poster),         posterBefore   + POST_AMOUNT);
        assertEq(usdc.balanceOf(address(board)), contractBefore - POST_AMOUNT);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  41. postBounty blocked during pending rotation; unblocked after cancel
    // ═══════════════════════════════════════════════════════════════════════════

    function test_postBounty_blockedByPendingRotation_thenUnblockedByCancel() public {
        vm.prank(owner);
        board.proposeVerifier(newVerifier);

        DungeonBounty.RunResult memory run = DungeonBounty.RunResult({
            player:     poster,
            seed:       BOUNTY_SEED,
            score:      400,
            replayHash: keccak256("cancel-test-replay"),
            runId:      keccak256("cancel-test-runid")
        });
        bytes memory sig = _sign(VERIFIER_KEY, run);

        vm.expectRevert(DungeonBounty.VerifierRotationPending.selector);
        vm.prank(poster);
        board.postBounty(run, sig, POST_AMOUNT);

        vm.prank(owner);
        board.cancelVerifierProposal();
        assertEq(board.verifierActiveAt(), 0);

        vm.prank(poster);
        board.postBounty(run, sig, POST_AMOUNT);
        assertEq(board.bountyCount(), 1);
    }
}
