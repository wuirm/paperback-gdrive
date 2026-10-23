// Adversarial tests for the ZIP reader: hostile archives that try to make the
// extension allocate huge buffers, request huge ranges, hang, or crash.
// Run: node --experimental-strip-types test/adversarial.ts
import { deflateSync } from "fflate";
import {
  readZipIndex,
  entrySpecs,
  extractEntry,
  decodeSpec,
  type RangeReader,
  type EntrySpec,
} from "../src/GoogleDrive/zip.ts";

let pass = 0;
let fail = 0;
function ok(cond: boolean, label: string, extra = "") {
  if (cond) {
    pass++;
    console.log(`  ✔ ${label}`);
  } else {
    fail++;
    console.log(`  ✘ ${label} ${extra}`);
  }
}

// ---- tiny ZIP builder so we control every field ----
function u16(n: number) {
  return [n & 0xff, (n >> 8) & 0xff];
}
function u32(n: number) {
  return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
}

interface EntryOpt {
  name: string;
  data: Uint8Array; // already-compressed (or stored) bytes to place
  method: number;
  compressedSize: number; // value written into headers (may lie)
  uncompressedSize: number; // value written into headers (may lie)
  flags?: number;
}

function buildZip(entries: EntryOpt[]): Uint8Array {
  const parts: number[] = [];
  const central: number[] = [];
  const offsets: number[] = [];
  for (const e of entries) {
    const name = [...new TextEncoder().encode(e.name)];
    offsets.push(parts.length);
    // local file header
    parts.push(...u32(0x04034b50), ...u16(20), ...u16(e.flags ?? 0), ...u16(e.method));
    parts.push(...u16(0), ...u16(0)); // time/date
    parts.push(...u32(0)); // crc
    parts.push(...u32(e.compressedSize), ...u32(e.uncompressedSize));
    parts.push(...u16(name.length), ...u16(0));
    parts.push(...name);
    parts.push(...e.data);
  }
  const cdStart = parts.length;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    const name = [...new TextEncoder().encode(e.name)];
    central.push(...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(e.flags ?? 0), ...u16(e.method));
    central.push(...u16(0), ...u16(0), ...u32(0));
    central.push(...u32(e.compressedSize), ...u32(e.uncompressedSize));
    central.push(...u16(name.length), ...u16(0), ...u16(0));
    central.push(...u16(0), ...u16(0), ...u32(0));
    central.push(...u32(offsets[i]!));
    central.push(...name);
  }
  const cdSize = central.length;
  const eocd: number[] = [];
  eocd.push(...u32(0x06054b50), ...u16(0), ...u16(0));
  eocd.push(...u16(entries.length), ...u16(entries.length));
  eocd.push(...u32(cdSize), ...u32(cdStart), ...u16(0));
  return new Uint8Array([...parts, ...central, ...eocd]);
}

const readerFor = (buf: Uint8Array): RangeReader => async (s, e) => buf.subarray(s, e + 1);

function peakHeapMB(fn: () => void): { threw: boolean; mb: number; ms: number } {
  const before = process.memoryUsage().heapUsed;
  let threw = false;
  const t = Date.now();
  try {
    fn();
  } catch {
    threw = true;
  }
  const mb = (process.memoryUsage().heapUsed - before) / 1e6;
  return { threw, mb, ms: Date.now() - t };
}

async function main() {
  const realDeflate = deflateSync(new TextEncoder().encode("hello world".repeat(10)));

  console.log("Allocation bomb: honest small file, but uncompressedSize lies as 2 GB");
  {
    const zip = buildZip([
      { name: "a.jpg", data: realDeflate, method: 8, compressedSize: realDeflate.length, uncompressedSize: 2_000_000_000 },
    ]);
    const index = await readZipIndex(zip.length, readerFor(zip));
    const spec = [...entrySpecs(index).values()][0]!;
    let threw = false;
    try {
      extractEntry(zip, spec);
    } catch {
      threw = true;
    }
    // A safe parser must refuse rather than allocate ~2 GB from a header claim.
    ok(threw, "extractEntry refuses a 2 GB uncompressedSize claim");
  }

  console.log("Bandwidth bomb: compressedSize lies as 3 GB → range request size");
  {
    const zip = buildZip([
      { name: "a.jpg", data: realDeflate, method: 8, compressedSize: 3_000_000_000, uncompressedSize: 100 },
    ]);
    const index = await readZipIndex(zip.length, readerFor(zip));
    const spec = [...entrySpecs(index).values()][0]!;
    const rangeBytes = spec.end - spec.start + 1;
    ok(rangeBytes < 300_000_000, `range request is bounded (would fetch ${(rangeBytes / 1e6).toFixed(0)} MB)`);
  }

  console.log("decodeSpec from a hostile URL fragment cannot smuggle a giant size");
  {
    const spec = decodeSpec("pbzip=0-50-8-40-9999999999");
    const bounded = spec === undefined || spec.uncompressedSize < 300_000_000;
    ok(bounded, `decodeSpec rejects or caps huge uncompressedSize (got ${spec ? spec.uncompressedSize : "undefined"})`);
  }

  console.log("O(n²) hang: many central-directory entries all at offset 0");
  {
    const many: EntryOpt[] = [];
    for (let i = 0; i < 8000; i++) many.push({ name: `${i}.jpg`, data: new Uint8Array(0), method: 0, compressedSize: 0, uncompressedSize: 0 });
    const zip = buildZip(many);
    const index = await readZipIndex(zip.length, readerFor(zip));
    const t = Date.now();
    entrySpecs(index);
    const ms = Date.now() - t;
    ok(ms < 1500, `entrySpecs stayed fast with 8000 entries (${ms} ms)`);
  }

  console.log("Truncated file (Drive returns fewer bytes than the entry needs) is rejected");
  {
    const zip = buildZip([
      { name: "a.jpg", data: realDeflate, method: 8, compressedSize: realDeflate.length, uncompressedSize: 110 },
    ]);
    const index = await readZipIndex(zip.length, readerFor(zip));
    const spec = [...entrySpecs(index).values()][0]!;
    // Simulate the archive being cut off on the server: hand extractEntry a buffer
    // that stops a few bytes into the compressed data.
    const truncated = zip.subarray(0, spec.start + 30 + 5 + 2);
    let threw = false;
    try {
      extractEntry(truncated, spec);
    } catch {
      threw = true;
    }
    ok(threw, "a short read throws 'Truncated ZIP entry' rather than returning garbage");
  }

  console.log("Garbage deflate stream of honest size does not crash the process");
  {
    const junk = new Uint8Array(200).fill(0x7f);
    const zip = buildZip([{ name: "a.jpg", data: junk, method: 8, compressedSize: junk.length, uncompressedSize: 500 }]);
    const index = await readZipIndex(zip.length, readerFor(zip));
    const spec = [...entrySpecs(index).values()][0]!;
    let handled = false;
    try {
      extractEntry(zip, spec);
    } catch {
      handled = true;
    }
    ok(handled, "corrupt deflate throws a catchable error");
  }

  console.log("Not-a-zip input is rejected cleanly");
  {
    let threw = false;
    try {
      await readZipIndex(1000, async () => new Uint8Array(1000).fill(0x41));
    } catch {
      threw = true;
    }
    ok(threw, "random bytes rejected with an error");
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main();
