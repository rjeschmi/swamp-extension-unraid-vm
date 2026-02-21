import { z } from "npm:zod@4";

// Build a minimal ISO 9660 cloud-init seed image locally — no remote tools required.
// Uses uppercase filenames (USER-DATA, META-DATA); Linux isofs lowercases them on
// mount via map=normal, which is what cloud-init's NoCloud datasource expects.
export function makeCloudInitIso(userData, metaData) {
  const S = 2048;
  const enc = new TextEncoder();
  // Sorted alphabetically so META-DATA comes before USER-DATA
  const files = [
    ["META-DATA", enc.encode(metaData)],
    ["USER-DATA", enc.encode(userData)],
  ];

  // LBA layout: 0-15 system area, 16 PVD, 17 VDST, 18 root dir, 19+ file data
  let lba = 19;
  const extents = [];
  for (const [, data] of files) {
    extents.push(lba);
    lba += Math.ceil(data.length / S) || 1;
  }
  const totalSectors = lba;

  const u32b = (v) => new Uint8Array([
    v & 0xFF, (v >> 8) & 0xFF, (v >> 16) & 0xFF, (v >> 24) & 0xFF,
    (v >> 24) & 0xFF, (v >> 16) & 0xFF, (v >> 8) & 0xFF, v & 0xFF,
  ]);
  const u16b = (v) => new Uint8Array([v & 0xFF, (v >> 8) & 0xFF, (v >> 8) & 0xFF, v & 0xFF]);

  const dirRecord = (nameBytes, isDir, extentLba, dataLen) => {
    const nl = nameBytes.length;
    const rec = new Uint8Array(33 + nl + (nl % 2 === 0 ? 1 : 0));
    let i = 0;
    rec[i++] = rec.length; rec[i++] = 0;
    rec.set(u32b(extentLba), i); i += 8;
    rec.set(u32b(dataLen), i); i += 8;
    rec[i++] = 126; rec[i++] = 2; rec[i++] = 21; // date 2026-02-21
    rec[i++] = 0; rec[i++] = 0; rec[i++] = 0; rec[i++] = 0;
    rec[i++] = isDir ? 2 : 0;
    rec[i++] = 0; rec[i++] = 0;
    rec.set(u16b(1), i); i += 4;
    rec[i++] = nl;
    rec.set(nameBytes, i);
    return rec;
  };

  const dotRec = dirRecord(new Uint8Array([0x00]), true, 18, S);
  const dotdotRec = dirRecord(new Uint8Array([0x01]), true, 18, S);

  const rootDir = new Uint8Array(S);
  let doff = 0;
  rootDir.set(dotRec, doff); doff += dotRec.length;
  rootDir.set(dotdotRec, doff); doff += dotdotRec.length;
  for (let i = 0; i < files.length; i++) {
    const rec = dirRecord(enc.encode(files[i][0]), false, extents[i], files[i][1].length);
    rootDir.set(rec, doff); doff += rec.length;
  }

  const pvd = new Uint8Array(S);
  pvd[0] = 1; pvd.set(enc.encode("CD001"), 1); pvd[6] = 1;
  pvd.fill(0x20, 8, 40);
  pvd.set(enc.encode("CIDATA"), 40); pvd.fill(0x20, 46, 72);
  pvd.set(u32b(totalSectors), 80);
  pvd.set(u16b(1), 120); pvd.set(u16b(1), 124); pvd.set(u16b(S), 128);
  pvd.set(u32b(0), 132);
  pvd.set(dotRec, 156);
  pvd.fill(0x20, 190, 813);
  const d16 = enc.encode("0000000000000000");
  for (const off of [813, 830, 847, 864]) { pvd.set(d16, off); pvd[off + 16] = 0; }
  pvd[881] = 1;

  const vdst = new Uint8Array(S);
  vdst[0] = 255; vdst.set(enc.encode("CD001"), 1); vdst[6] = 1;

  const iso = new Uint8Array(totalSectors * S);
  iso.set(pvd, 16 * S); iso.set(vdst, 17 * S); iso.set(rootDir, 18 * S);
  for (let i = 0; i < files.length; i++) iso.set(files[i][1], extents[i] * S);
  return iso;
}

export const model = {
  type: "@user/cloud-init-iso",
  version: "2026.02.21.1",
  globalArguments: z.object({}),
  files: {
    iso: {
      description: "cloud-init NoCloud seed ISO (ISO 9660)",
      contentType: "application/octet-stream",
      lifetime: "7d",
      garbageCollection: 5,
    },
  },
  methods: {
    generate: {
      description: "Generate a cloud-init NoCloud seed ISO from user-data and meta-data",
      arguments: z.object({
        userData: z.string().describe("cloud-config user-data content"),
        metaData: z.string().describe("cloud-init meta-data content"),
      }),
      execute: async (args, context) => {
        const isoBytes = makeCloudInitIso(args.userData, args.metaData);
        context.logger.info(`Generated cloud-init seed ISO: ${isoBytes.length} bytes`);
        const writer = await context.createFileWriter("iso", "seed");
        const handle = await writer.writeAll(isoBytes);
        return { dataHandles: [handle] };
      },
    },
  },
};
