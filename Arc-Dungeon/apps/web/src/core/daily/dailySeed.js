/**
 * dailySeed — compute the daily dungeon seed exactly as the DungeonBounty
 * contract's seedOf(uint32 dayId) function does:
 *
 *   keccak256(abi.encode("arc-dungeon", uint32 dayId))
 *
 * abi.encode(string, uint32) layout (128 bytes):
 *   bytes  0-31:  string offset = 64 (uint256, big-endian)
 *   bytes 32-63:  uint32 dayId padded to 32 bytes (right-aligned)
 *   bytes 64-95:  string length = 11 (uint256, big-endian)
 *   bytes 96-127: "arc-dungeon" (11 bytes), left-aligned, zero-padded to 32
 *
 * The result is a 0x-prefixed lowercase hex string, matching the contract's
 * bytes32 return value.
 *
 * Uses @noble/hashes keccak_256 vendored under apps/web/vendor/noble-hashes/.
 * Import path is relative — works in the browser static server and in Node.
 *
 * Test vectors (from deployed Arc Testnet contract
 *   0x084422ce04bf2b60889ebbc6fba444e9441a507b):
 *   seedOf(0)     = 0x1c173254703fbfc7e5d7b67cb5d0e517a55002938f0e87377e7f4ecc5d537963
 *   seedOf(20000) = 0x3515db9cf9b0d6786c6e122af06722028e0612e2dca18bb14f57000eb17e2aaa
 *   seedOf(20744) = 0x4be1cc855dfeacd0e7778c8d8d83fc826b6942ea35f872eebf01c8da0e3945ef
 */

// ---------------------------------------------------------------------------
// Resolve vendor path relative to this file.
// In a browser static-serve context the import is relative to the module URL;
// in Node tests it resolves from the file system path.
// ---------------------------------------------------------------------------
import { keccak_256 } from "../../../vendor/noble-hashes/sha3.js";
import { bytesToHex } from "../../../vendor/noble-hashes/utils.js";

// Pre-encode the ASCII bytes for "arc-dungeon" once.
const ARC_DUNGEON_BYTES = new TextEncoder().encode("arc-dungeon"); // 11 bytes
const ARC_DUNGEON_LEN = ARC_DUNGEON_BYTES.length; // 11

/**
 * Compute keccak256(abi.encode("arc-dungeon", uint32(dayId))).
 *
 * @param {number} dayId - uint32 day index (Math.floor(Date.now() / 86_400_000))
 * @returns {string} 0x-prefixed lowercase hex string (32 bytes)
 */
export function computeDailySeed(dayId) {
  const buf = new Uint8Array(128);
  const view = new DataView(buf.buffer);

  // Slot 0 (bytes 0-31): offset to string data = 64 (0x40)
  view.setUint32(28, 64);

  // Slot 1 (bytes 32-63): uint32 dayId, right-aligned in 32 bytes
  view.setUint32(60, dayId >>> 0); // >>> 0 ensures unsigned 32-bit

  // Slot 2 (bytes 64-95): string length = 11, right-aligned
  view.setUint32(92, ARC_DUNGEON_LEN);

  // Slot 3 (bytes 96-127): "arc-dungeon" left-aligned, zero-padded
  buf.set(ARC_DUNGEON_BYTES, 96);

  return "0x" + bytesToHex(keccak_256(buf));
}

/**
 * Return the current dayId: Math.floor(Date.now() / 86_400_000).
 * Call this once in the UI layer; never call it inside core/simulation.
 *
 * @returns {number}
 */
export function currentDayId() {
  return Math.floor(Date.now() / 86_400_000);
}
