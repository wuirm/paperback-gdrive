/**
 * Minimal ZIP reader that works over HTTP byte ranges.
 *
 * A CBZ is just a ZIP. Instead of downloading the whole archive we:
 *   1. read the tail of the file to find the End Of Central Directory record,
 *   2. read the central directory (usually already inside that tail),
 *   3. for each page, compute the byte range [local header .. next entry) so a
 *      single Range request returns exactly that page's compressed bytes.
 *
 * Only "stored" (0) and "deflate" (8) entries are supported, which covers
 * virtually every CBZ in the wild.
 */
import { inflateSync } from "fflate";

const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;
const SIG_ZIP64_EOCD = 0x06064b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

export const DEFAULT_TAIL_SIZE = 128 * 1024;

export interface ZipEntry {
  name: string;
  method: number;
  flags: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
  isDirectory: boolean;
}

export interface ZipIndex {
  entries: ZipEntry[];
  centralDirectoryOffset: number;
}

/** Everything needed to pull one entry out of a ranged response. */
export interface EntrySpec {
  start: number;
  end: number; // inclusive
  method: number;
  compressedSize: number;
  uncompressedSize: number;
}

export type RangeReader = (start: number, endInclusive: number) => Promise<Uint8Array>;

function u16(b: Uint8Array, o: number): number {
  return b[o]! | (b[o + 1]! << 8);
}

function u32(b: Uint8Array, o: number): number {
  return (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0;
}

function u64(b: Uint8Array, o: number): number {
  return u32(b, o) + u32(b, o + 4) * 0x100000000;
}

/** Tolerant UTF-8 decoder (no TextDecoder dependency). */
export function decodeUtf8(b: Uint8Array): string {
  let out = "";
  let i = 0;
  while (i < b.length) {
    const c = b[i++]!;
    if (c < 0x80) {
      out += String.fromCharCode(c);
    } else if (c >= 0xc0 && c < 0xe0 && i < b.length) {
      out += String.fromCharCode(((c & 0x1f) << 6) | (b[i++]! & 0x3f));
    } else if (c >= 0xe0 && c < 0xf0 && i + 1 < b.length) {
      out += String.fromCharCode(((c & 0x0f) << 12) | ((b[i++]! & 0x3f) << 6) | (b[i++]! & 0x3f));
    } else if (c >= 0xf0 && i + 2 < b.length) {
      const cp =
        (((c & 0x07) << 18) | ((b[i++]! & 0x3f) << 12) | ((b[i++]! & 0x3f) << 6) | (b[i++]! & 0x3f)) -
        0x10000;
      out += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
    } else {
      out += "�";
    }
  }
  return out;
}

export async function readZipIndex(
  size: number,
  read: RangeReader,
  tailSize: number = DEFAULT_TAIL_SIZE,
): Promise<ZipIndex> {
  if (size < 22) throw new Error("File is too small to be a ZIP/CBZ archive");

  const tailStart = Math.max(0, size - tailSize);
  const tail = await read(tailStart, size - 1);

  // Locate the End Of Central Directory record, scanning backwards.
  let eocd = -1;
  const minPos = Math.max(0, tail.length - 22 - 0xffff);
  for (let i = tail.length - 22; i >= minPos; i--) {
    if (u32(tail, i) === SIG_EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) {
    throw new Error("Not a ZIP/CBZ archive (no end-of-central-directory record). RAR-based CBR files are not supported.");
  }

  let entryCount = u16(tail, eocd + 10);
  let cdSize = u32(tail, eocd + 12);
  let cdOffset = u32(tail, eocd + 16);

  if (entryCount === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    const loc = eocd - 20;
    if (loc >= 0 && u32(tail, loc) === SIG_ZIP64_LOCATOR) {
      const z64Offset = u64(tail, loc + 8);
      const rec =
        z64Offset >= tailStart && z64Offset + 56 <= size
          ? tail.subarray(z64Offset - tailStart)
          : await read(z64Offset, z64Offset + 55);
      if (u32(rec, 0) !== SIG_ZIP64_EOCD) throw new Error("Corrupt ZIP64 end-of-central-directory record");
      entryCount = u64(rec, 32);
      cdSize = u64(rec, 40);
      cdOffset = u64(rec, 48);
    }
  }

  if (cdOffset + cdSize > size) throw new Error("Corrupt ZIP: central directory lies outside the file");

  const cd =
    cdOffset >= tailStart
      ? tail.subarray(cdOffset - tailStart, cdOffset - tailStart + cdSize)
      : cdSize === 0
        ? new Uint8Array(0)
        : await read(cdOffset, cdOffset + cdSize - 1);

  const entries: ZipEntry[] = [];
  let p = 0;
  for (let n = 0; n < entryCount && p + 46 <= cd.length; n++) {
    if (u32(cd, p) !== SIG_CENTRAL) break;
    const flags = u16(cd, p + 8);
    const method = u16(cd, p + 10);
    let compressedSize = u32(cd, p + 20);
    let uncompressedSize = u32(cd, p + 24);
    const nameLen = u16(cd, p + 28);
    const extraLen = u16(cd, p + 30);
    const commentLen = u16(cd, p + 32);
    let localHeaderOffset = u32(cd, p + 42);
    const name = decodeUtf8(cd.subarray(p + 46, p + 46 + nameLen)).replace(/\\/g, "/");

    // ZIP64 extended information extra field.
    let x = p + 46 + nameLen;
    const xEnd = x + extraLen;
    while (x + 4 <= xEnd) {
      const id = u16(cd, x);
      const len = u16(cd, x + 2);
      if (id === 0x0001) {
        let q = x + 4;
        if (uncompressedSize === 0xffffffff) { uncompressedSize = u64(cd, q); q += 8; }
        if (compressedSize === 0xffffffff) { compressedSize = u64(cd, q); q += 8; }
        if (localHeaderOffset === 0xffffffff) { localHeaderOffset = u64(cd, q); }
      }
      x += 4 + len;
    }

    entries.push({
      name,
      method,
      flags,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
      isDirectory: name.endsWith("/"),
    });
    p += 46 + nameLen + extraLen + commentLen;
  }

  return { entries, centralDirectoryOffset: cdOffset };
}

/**
 * Byte range that contains an entry's local header + data. The entry ends
 * where the next entry (by offset) begins, or at the central directory.
 */
export function entrySpecs(index: ZipIndex): Map<ZipEntry, EntrySpec> {
  const byOffset = [...index.entries].sort((a, b) => a.localHeaderOffset - b.localHeaderOffset);
  const out = new Map<ZipEntry, EntrySpec>();
  for (let i = 0; i < byOffset.length; i++) {
    const e = byOffset[i]!;
    let next = index.centralDirectoryOffset;
    for (let j = i + 1; j < byOffset.length; j++) {
      if (byOffset[j]!.localHeaderOffset > e.localHeaderOffset) {
        next = byOffset[j]!.localHeaderOffset;
        break;
      }
    }
    out.set(e, {
      start: e.localHeaderOffset,
      // Never ask for less than a bare header + the compressed data.
      end: Math.max(next - 1, e.localHeaderOffset + 29 + e.compressedSize),
      method: e.method,
      compressedSize: e.compressedSize,
      uncompressedSize: e.uncompressedSize,
    });
  }
  return out;
}

/**
 * Given the bytes returned for a Range request (or the full file, if the
 * server ignored the Range header), return the decompressed entry.
 */
export function extractEntry(data: Uint8Array, spec: EntrySpec): Uint8Array {
  // More bytes than we asked for means the server ignored Range and sent the whole file.
  const requested = spec.end - spec.start + 1;
  const base = data.length > requested && data.length >= spec.start + 30 ? spec.start : 0;
  if (data.length < base + 30 || u32(data, base) !== SIG_LOCAL) {
    throw new Error("Response does not contain the expected ZIP entry");
  }
  const flags = u16(data, base + 6);
  if (flags & 0x1) throw new Error("Encrypted ZIP entries are not supported");
  const nameLen = u16(data, base + 26);
  const extraLen = u16(data, base + 28);
  const dataStart = base + 30 + nameLen + extraLen;
  const compressed = data.subarray(dataStart, dataStart + spec.compressedSize);
  if (compressed.length < spec.compressedSize) throw new Error("Truncated ZIP entry");

  switch (spec.method) {
    case 0:
      return compressed;
    case 8:
      return spec.uncompressedSize > 0
        ? inflateSync(compressed, { out: new Uint8Array(spec.uncompressedSize) })
        : inflateSync(compressed);
    default:
      throw new Error(`Unsupported ZIP compression method ${spec.method}`);
  }
}

export function toArrayBuffer(u8: Uint8Array): ArrayBuffer {
  if (u8.byteOffset === 0 && u8.byteLength === u8.buffer.byteLength && u8.buffer instanceof ArrayBuffer) {
    return u8.buffer;
  }
  return u8.slice().buffer as ArrayBuffer;
}

// --- URL fragment encoding for page specs --------------------------------

const SPEC_PREFIX = "pbzip=";

export function encodeSpec(spec: EntrySpec): string {
  return `${SPEC_PREFIX}${spec.start}-${spec.end}-${spec.method}-${spec.compressedSize}-${spec.uncompressedSize}`;
}

export function decodeSpec(fragment: string | undefined): EntrySpec | undefined {
  if (!fragment || !fragment.startsWith(SPEC_PREFIX)) return undefined;
  const parts = fragment.slice(SPEC_PREFIX.length).split("-").map(Number);
  if (parts.length !== 5 || parts.some((n) => !Number.isFinite(n) || n < 0)) return undefined;
  const [start, end, method, compressedSize, uncompressedSize] = parts as [number, number, number, number, number];
  return { start, end, method, compressedSize, uncompressedSize };
}
