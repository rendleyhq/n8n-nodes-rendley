/**
 * XXH64 (classic, seed 0), the hash Rendley keys uploads by. Duplicated from
 * `packages/core/src/xxhash.ts`: verified n8n nodes may not declare runtime
 * dependencies, so this package cannot import core. Keep the two in sync.
 */
const MASK = (1n << 64n) - 1n;

const PRIME1 = 11400714785074694791n;
const PRIME2 = 14029467366897019727n;
const PRIME3 = 1609587929392839161n;
const PRIME4 = 9650029242287828579n;
const PRIME5 = 2870177450012600261n;

function rotl(value: bigint, bits: bigint): bigint {
  return ((value << bits) | (value >> (64n - bits))) & MASK;
}

function round(acc: bigint, input: bigint): bigint {
  let next = (acc + ((input * PRIME2) & MASK)) & MASK;
  next = rotl(next, 31n);
  return (next * PRIME1) & MASK;
}

function mergeRound(acc: bigint, value: bigint): bigint {
  const merged = acc ^ round(0n, value);
  return ((merged * PRIME1) & MASK) + PRIME4;
}

function readU64(view: DataView, offset: number): bigint {
  return view.getBigUint64(offset, true);
}

function readU32(view: DataView, offset: number): bigint {
  return BigInt(view.getUint32(offset, true));
}

/** XXH64 digest as the zero-padded 16-character lowercase hex Rendley expects. */
export function xxhash64Hex(data: Uint8Array): string {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const length = data.byteLength;
  let index = 0;
  let hash: bigint;

  if (length >= 32) {
    let v1 = (PRIME1 + PRIME2) & MASK;
    let v2 = PRIME2;
    let v3 = 0n;
    let v4 = (0n - PRIME1) & MASK;

    const limit = length - 32;
    do {
      v1 = round(v1, readU64(view, index));
      v2 = round(v2, readU64(view, index + 8));
      v3 = round(v3, readU64(view, index + 16));
      v4 = round(v4, readU64(view, index + 24));
      index += 32;
    } while (index <= limit);

    hash = (rotl(v1, 1n) + rotl(v2, 7n) + rotl(v3, 12n) + rotl(v4, 18n)) & MASK;
    hash = mergeRound(hash, v1) & MASK;
    hash = mergeRound(hash, v2) & MASK;
    hash = mergeRound(hash, v3) & MASK;
    hash = mergeRound(hash, v4) & MASK;
  } else {
    hash = PRIME5;
  }

  hash = (hash + BigInt(length)) & MASK;

  while (index + 8 <= length) {
    hash = (hash ^ round(0n, readU64(view, index))) & MASK;
    hash = ((rotl(hash, 27n) * PRIME1) & MASK) + PRIME4;
    hash &= MASK;
    index += 8;
  }

  if (index + 4 <= length) {
    hash = (hash ^ ((readU32(view, index) * PRIME1) & MASK)) & MASK;
    hash = ((rotl(hash, 23n) * PRIME2) & MASK) + PRIME3;
    hash &= MASK;
    index += 4;
  }

  while (index < length) {
    hash = (hash ^ ((BigInt(view.getUint8(index)) * PRIME5) & MASK)) & MASK;
    hash = (rotl(hash, 11n) * PRIME1) & MASK;
    index += 1;
  }

  hash ^= hash >> 33n;
  hash = (hash * PRIME2) & MASK;
  hash ^= hash >> 29n;
  hash = (hash * PRIME3) & MASK;
  hash ^= hash >> 32n;

  return hash.toString(16).padStart(16, "0");
}
