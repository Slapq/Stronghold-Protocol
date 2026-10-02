// tools/assets/zipwrite.mjs — minimal zip writer for the asset pack (tools/pack-assets.mjs). Classic zip (no ZIP64:
// ≤ 65535 entries, < 4 GiB), UTF-8 names, every entry either stored or raw-deflated, sizes and CRC in the local headers
// (no data descriptors), so any unzip tool and the browser importer (public/js/assetpack/zip.js) read it.

import fs from 'node:fs';
import zlib from 'node:zlib';

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** CRC-32 of a buffer (zlib.crc32 when the runtime has it, Node ≥ 22.2). */
export function crc32(buf) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(buf) >>> 0;
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Already-compressed formats: stored as is. */
const STORE_EXT = /\.(png|jpe?g|webp|gif|avif|mp3|ogg|oga|opus|m4a|aac|woff2?|zip)$/i;

function dosTime(d) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (Math.floor(d.getSeconds() / 2));
  const date = ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

/**
 * Write a zip file.
 * @param {string} outPath
 * @param {Iterable<{ name: string, data?: Buffer, file?: string }>} entries `data` or a `file` to read
 * @param {{ onEntry?: (name: string, i: number) => void, level?: number }} [opts]
 * @returns {{ entries: number, bytes: number }}
 */
export function writeZip(outPath, entries, opts = {}) {
  const fd = fs.openSync(outPath, 'w');
  const central = [];
  let offset = 0;
  let count = 0;
  const { time, date } = dosTime(new Date());
  const write = (buf) => { fs.writeSync(fd, buf); offset += buf.length; };
  try {
    for (const e of entries) {
      const data = e.data ?? fs.readFileSync(e.file);
      const name = Buffer.from(e.name, 'utf8');
      const crc = crc32(data);
      let method = 0;
      let body = data;
      if (!STORE_EXT.test(e.name) && data.length > 64) {
        const def = zlib.deflateRawSync(data, { level: opts.level ?? 6 });
        if (def.length < data.length) { method = 8; body = def; }
      }
      if (offset + 30 + name.length + body.length > 0xffffffff) throw new Error('pack exceeds 4 GiB (ZIP64 not supported)');
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(20, 4);
      local.writeUInt16LE(0x0800, 6); // UTF-8 names
      local.writeUInt16LE(method, 8);
      local.writeUInt16LE(time, 10);
      local.writeUInt16LE(date, 12);
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(body.length, 18);
      local.writeUInt32LE(data.length, 22);
      local.writeUInt16LE(name.length, 26);
      local.writeUInt16LE(0, 28);
      const at = offset;
      write(local); write(name); write(body);
      const cen = Buffer.alloc(46);
      cen.writeUInt32LE(0x02014b50, 0);
      cen.writeUInt16LE((3 << 8) | 20, 4); // made by: unix, 2.0
      cen.writeUInt16LE(20, 6);
      cen.writeUInt16LE(0x0800, 8);
      cen.writeUInt16LE(method, 10);
      cen.writeUInt16LE(time, 12);
      cen.writeUInt16LE(date, 14);
      cen.writeUInt32LE(crc, 16);
      cen.writeUInt32LE(body.length, 20);
      cen.writeUInt32LE(data.length, 24);
      cen.writeUInt16LE(name.length, 28);
      cen.writeUInt32LE((0o100644 << 16) >>> 0, 38); // -rw-r--r--
      cen.writeUInt32LE(at, 42);
      central.push(cen, name);
      count++;
      if (count > 0xffff) throw new Error('pack has more than 65535 files (ZIP64 not supported)');
      opts.onEntry?.(e.name, count);
    }
    const cdStart = offset;
    for (const b of central) write(b);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(count, 8);
    eocd.writeUInt16LE(count, 10);
    eocd.writeUInt32LE(offset - cdStart, 12);
    eocd.writeUInt32LE(cdStart, 16);
    write(eocd);
  } finally {
    fs.closeSync(fd);
  }
  return { entries: count, bytes: offset };
}
