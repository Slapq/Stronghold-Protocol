// assetpack/zip.js — minimal random-access zip reader over a Blob/File (stored + deflate, ZIP64), for the asset pack
// importer. Reads the central directory (works for zips written by any tool, data descriptors included) and inflates
// with the platform DecompressionStream('deflate-raw') — the browsers this game supports (Safari 16.4+, Chrome 90+…)
// and Node ≥ 18 all have it, so no zip library is shipped. Encrypted entries and other methods are reported as
// unsupported. Pure: no DOM; Node tests import it directly.
//
//   const zip = await openZip(file);            // { entries: [{ name, method, size, csize, offset, … }] }
//   const blob = await zip.read(entry);         // Blob of the uncompressed data (size-checked)

const SIG_EOCD = 0x06054b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_LOC64 = 0x07064b50;
const SIG_CEN = 0x02014b50;
const SIG_LOC = 0x04034b50;
const MAX_COMMENT = 0xffff;

export class ZipError extends Error {
  constructor(message) { super(message); this.name = 'ZipError'; }
}

async function bytes(blob, start, end) {
  return new Uint8Array(await blob.slice(start, end).arrayBuffer());
}

/** 64-bit little-endian as a Number (exact below 2^53). */
const u64 = (dv, o) => dv.getUint32(o, true) + dv.getUint32(o + 4, true) * 0x100000000;

const utf8 = new TextDecoder('utf-8');

/**
 * Open a zip archive.
 * @param {Blob} blob
 * @returns {Promise<{ entries: Array<{ name: string, method: number, size: number, csize: number, offset: number,
 *   crc: number, encrypted: boolean, dir: boolean }>, read: (entry: object) => Promise<Blob> }>}
 */
export async function openZip(blob) {
  const size = blob.size;
  if (size < 22) throw new ZipError('不是 zip 文件（太小）');
  const tailStart = Math.max(0, size - (22 + MAX_COMMENT));
  const tail = await bytes(blob, tailStart, size);
  const tdv = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tdv.getUint32(i, true) === SIG_EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new ZipError('不是 zip 文件（找不到目录）');
  let count = tdv.getUint16(eocd + 10, true);
  let cdSize = tdv.getUint32(eocd + 12, true);
  let cdOffset = tdv.getUint32(eocd + 16, true);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    // ZIP64: locator sits right before the EOCD
    const loc = eocd - 20;
    if (loc < 0 || tdv.getUint32(loc, true) !== SIG_LOC64) throw new ZipError('ZIP64 目录损坏');
    const recOffset = u64(tdv, loc + 8);
    const rec = await bytes(blob, recOffset, recOffset + 56);
    const rdv = new DataView(rec.buffer, rec.byteOffset, rec.byteLength);
    if (rdv.getUint32(0, true) !== SIG_EOCD64) throw new ZipError('ZIP64 目录损坏');
    count = u64(rdv, 32);
    cdSize = u64(rdv, 40);
    cdOffset = u64(rdv, 48);
  }
  if (cdOffset + cdSize > size) throw new ZipError('zip 文件不完整（可能没有下载完）');
  const cd = await bytes(blob, cdOffset, cdOffset + cdSize);
  const dv = new DataView(cd.buffer, cd.byteOffset, cd.byteLength);
  const entries = [];
  let p = 0;
  for (let n = 0; n < count; n++) {
    if (p + 46 > cd.length || dv.getUint32(p, true) !== SIG_CEN) throw new ZipError('zip 目录损坏');
    const flags = dv.getUint16(p + 8, true);
    const method = dv.getUint16(p + 10, true);
    const crc = dv.getUint32(p + 16, true);
    let csize = dv.getUint32(p + 20, true);
    let usize = dv.getUint32(p + 24, true);
    const nlen = dv.getUint16(p + 28, true);
    const elen = dv.getUint16(p + 30, true);
    const clen = dv.getUint16(p + 32, true);
    let offset = dv.getUint32(p + 42, true);
    const name = utf8.decode(cd.subarray(p + 46, p + 46 + nlen)).replace(/\\/g, '/');
    // ZIP64 extra field (0x0001): the 0xffffffff fields, in order usize, csize, offset
    let e = p + 46 + nlen;
    const eEnd = e + elen;
    while (e + 4 <= eEnd) {
      const id = dv.getUint16(e, true);
      const len = dv.getUint16(e + 2, true);
      if (id === 0x0001) {
        let q = e + 4;
        if (usize === 0xffffffff && q + 8 <= e + 4 + len) { usize = u64(dv, q); q += 8; }
        if (csize === 0xffffffff && q + 8 <= e + 4 + len) { csize = u64(dv, q); q += 8; }
        if (offset === 0xffffffff && q + 8 <= e + 4 + len) { offset = u64(dv, q); q += 8; }
      }
      e += 4 + len;
    }
    entries.push({ name, method, size: usize, csize, offset, crc, encrypted: (flags & 1) === 1, dir: name.endsWith('/') });
    p += 46 + nlen + elen + clen;
  }

  async function read(entry) {
    if (entry.encrypted) throw new ZipError(`${entry.name}: 不支持加密的 zip`);
    const head = await bytes(blob, entry.offset, entry.offset + 30);
    const hdv = new DataView(head.buffer, head.byteOffset, head.byteLength);
    if (head.length < 30 || hdv.getUint32(0, true) !== SIG_LOC) throw new ZipError(`${entry.name}: 文件头损坏`);
    const start = entry.offset + 30 + hdv.getUint16(26, true) + hdv.getUint16(28, true);
    const raw = blob.slice(start, start + entry.csize);
    if (raw.size !== entry.csize) throw new ZipError(`${entry.name}: zip 文件不完整`);
    let out;
    if (entry.method === 0) out = raw;
    else if (entry.method === 8) {
      if (typeof DecompressionStream !== 'function') throw new ZipError('浏览器不支持解压（DecompressionStream），请更新浏览器');
      out = await new Response(raw.stream().pipeThrough(new DecompressionStream('deflate-raw'))).blob();
    } else throw new ZipError(`${entry.name}: 不支持的压缩方式 ${entry.method}（请用「仅存储」或「deflate」重新打包）`);
    if (out.size !== entry.size) throw new ZipError(`${entry.name}: 解压后大小不符（${out.size} ≠ ${entry.size}）`);
    return out;
  }

  return { entries, read };
}
