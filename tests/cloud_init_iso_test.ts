import { assert, assertEquals, assertGreater } from "jsr:@std/assert";
import { makeCloudInitIso } from "../extensions/models/cloud_init_iso.ts";

const SECTOR = 2048;
const dec = new TextDecoder();

// --- ISO 9660 parsing helpers ---

function u32le(buf: Uint8Array, off: number): number {
  return (buf[off] | buf[off + 1] << 8 | buf[off + 2] << 16 | buf[off + 3] << 24) >>> 0;
}

function u16le(buf: Uint8Array, off: number): number {
  return buf[off] | buf[off + 1] << 8;
}

function u16be(buf: Uint8Array, off: number): number {
  return buf[off] << 8 | buf[off + 1];
}

function str(buf: Uint8Array, off: number, len: number): string {
  return dec.decode(buf.subarray(off, off + len));
}

interface DirEntry {
  name: string;
  extentLba: number;
  dataLen: number;
  isDir: boolean;
}

function parseRootDir(iso: Uint8Array, lba: number): DirEntry[] {
  const sector = iso.subarray(lba * SECTOR, (lba + 1) * SECTOR);
  const entries: DirEntry[] = [];
  let off = 0;
  while (off < SECTOR) {
    const recLen = sector[off];
    if (recLen === 0) break;
    const extentLba = u32le(sector, off + 2);
    const dataLen = u32le(sector, off + 10);
    const flags = sector[off + 25];
    const nameLen = sector[off + 32];
    const name = str(sector, off + 33, nameLen);
    entries.push({ name, extentLba, dataLen, isDir: (flags & 2) !== 0 });
    off += recLen;
  }
  return entries;
}

function fileContent(iso: Uint8Array, entry: DirEntry): string {
  return dec.decode(iso.subarray(entry.extentLba * SECTOR, entry.extentLba * SECTOR + entry.dataLen));
}

// --- Tests ---

Deno.test("output length is a multiple of the sector size", () => {
  const iso = makeCloudInitIso("test", "test");
  assertEquals(iso.length % SECTOR, 0);
});

Deno.test("system area (LBA 0-15) is all zeros", () => {
  const iso = makeCloudInitIso("test", "test");
  for (let i = 0; i < 16 * SECTOR; i++) {
    assertEquals(iso[i], 0, `byte ${i} should be 0`);
  }
});

Deno.test("PVD (LBA 16) has correct type, identifier, and version", () => {
  const pvd = makeCloudInitIso("test", "test").subarray(16 * SECTOR);
  assertEquals(pvd[0], 1, "type must be 1 (Primary Volume Descriptor)");
  assertEquals(str(pvd, 1, 5), "CD001", "standard identifier");
  assertEquals(pvd[6], 1, "version");
});

Deno.test("PVD volume identifier is CIDATA", () => {
  const pvd = makeCloudInitIso("test", "test").subarray(16 * SECTOR);
  assertEquals(str(pvd, 40, 32).trimEnd(), "CIDATA");
});

Deno.test("PVD logical block size is 2048 (both-endian)", () => {
  const pvd = makeCloudInitIso("test", "test").subarray(16 * SECTOR);
  assertEquals(u16le(pvd, 128), SECTOR, "little-endian");
  assertEquals(u16be(pvd, 130), SECTOR, "big-endian");
});

Deno.test("PVD volume space size matches ISO byte length", () => {
  const iso = makeCloudInitIso("test", "test");
  const pvd = iso.subarray(16 * SECTOR);
  assertEquals(u32le(pvd, 80) * SECTOR, iso.length);
});

Deno.test("PVD root directory record points to LBA 18", () => {
  const pvd = makeCloudInitIso("test", "test").subarray(16 * SECTOR);
  assertEquals(u32le(pvd, 156 + 2), 18, "root dir extent LBA");
});

Deno.test("VDST (LBA 17) has correct type, identifier, and version", () => {
  const vdst = makeCloudInitIso("test", "test").subarray(17 * SECTOR);
  assertEquals(vdst[0], 255, "type must be 255 (VDST)");
  assertEquals(str(vdst, 1, 5), "CD001", "standard identifier");
  assertEquals(vdst[6], 1, "version");
});

Deno.test("root directory (LBA 18) contains USER-DATA and META-DATA", () => {
  const iso = makeCloudInitIso("userdata", "metadata");
  const names = parseRootDir(iso, 18).filter((e) => !e.isDir).map((e) => e.name);
  assert(names.includes("USER-DATA"), "USER-DATA missing");
  assert(names.includes("META-DATA"), "META-DATA missing");
});

Deno.test("root directory dot/dotdot entries are present", () => {
  const iso = makeCloudInitIso("test", "test");
  const entries = parseRootDir(iso, 18);
  assert(entries.some((e) => e.isDir && e.name === "\x00"), "dot entry missing");
  assert(entries.some((e) => e.isDir && e.name === "\x01"), "dotdot entry missing");
});

Deno.test("file extents start at LBA 19 or later", () => {
  const iso = makeCloudInitIso("test", "test");
  const files = parseRootDir(iso, 18).filter((e) => !e.isDir);
  for (const f of files) {
    assertGreater(f.extentLba, 18, `${f.name} must start at LBA 19+`);
  }
});

Deno.test("USER-DATA content round-trips correctly", () => {
  const userData = "#cloud-config\nhostname: myvm\npackage_update: true\n";
  const iso = makeCloudInitIso(userData, "instance-id: myvm\n");
  const entry = parseRootDir(iso, 18).find((e) => e.name === "USER-DATA")!;
  assertEquals(fileContent(iso, entry), userData);
});

Deno.test("META-DATA content round-trips correctly", () => {
  const metaData = "instance-id: myvm\nlocal-hostname: myvm\n";
  const iso = makeCloudInitIso("#cloud-config\n", metaData);
  const entry = parseRootDir(iso, 18).find((e) => e.name === "META-DATA")!;
  assertEquals(fileContent(iso, entry), metaData);
});

Deno.test("META-DATA is placed before USER-DATA (sorted)", () => {
  const iso = makeCloudInitIso("user", "meta");
  const files = parseRootDir(iso, 18).filter((e) => !e.isDir);
  assertEquals(files[0].name, "META-DATA");
  assertEquals(files[1].name, "USER-DATA");
});

Deno.test("content larger than one sector spans multiple sectors", () => {
  const bigContent = "x".repeat(3000);
  const iso = makeCloudInitIso(bigContent, "instance-id: test\n");
  assertEquals(iso.length % SECTOR, 0);
  const entry = parseRootDir(iso, 18).find((e) => e.name === "USER-DATA")!;
  assertEquals(entry.dataLen, bigContent.length);
  assertEquals(fileContent(iso, entry), bigContent);
});

Deno.test("reported dataLen matches actual file content length", () => {
  const userData = "short";
  const metaData = "also short";
  const iso = makeCloudInitIso(userData, metaData);
  const entries = parseRootDir(iso, 18).filter((e) => !e.isDir);
  const ud = entries.find((e) => e.name === "USER-DATA")!;
  const md = entries.find((e) => e.name === "META-DATA")!;
  assertEquals(ud.dataLen, new TextEncoder().encode(userData).length);
  assertEquals(md.dataLen, new TextEncoder().encode(metaData).length);
});

Deno.test("empty strings produce a valid minimal ISO", () => {
  const iso = makeCloudInitIso("", "");
  assertEquals(iso.length % SECTOR, 0);
  assertGreater(iso.length, 16 * SECTOR);
  assertEquals(iso.subarray(16 * SECTOR)[0], 1, "PVD type");
});
