#!/usr/bin/env node
/**
 * fetch-data.mjs — Contourlines elevation data pipeline
 *
 * Downloads a 5-arc-minute subset of NOAA's ETOPO1 global relief model
 * (land topography + ocean bathymetry) from the NOAA CoastWatch ERDDAP
 * server, parses the NetCDF-3 response, and packs the elevations into
 * PNG files the web app can decode losslessly in the browser:
 *
 *   data/elev-4320.png  4320 x 2160  (5 arc-min, ~9 km/cell)  main dataset
 *   data/elev-1080.png  1080 x  540  quick-loading preview
 *
 * Encoding: v = elevation_m + 11000  (0..19850, fits 16 bits)
 *           R = v >> 8, G = v & 255, B = 0   (8-bit RGB PNG)
 *
 * Grid registration: texel (x, y) is the elevation at
 *           lon = -180 + x * (360 / width)
 *           lat =   90 - y * (180 / height)
 * so x wraps seamlessly (the duplicate +180 column is dropped).
 *
 * Usage: node tools/fetch-data.mjs
 * No dependencies — uses only Node built-ins (fetch, zlib).
 */

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const HOSTS = [
  'https://coastwatch.pfeg.noaa.gov',
  'https://upwell.pfeg.noaa.gov',
];
const QUERY = '/erddap/griddap/etopo180.nc?altitude%5B(-90):5:(90)%5D%5B(-180):5:(180)%5D';

// ---------------------------------------------------------------- download

async function download() {
  for (const host of HOSTS) {
    const url = host + QUERY;
    console.log(`Downloading ${url}`);
    try {
      const res = await fetch(url);
      if (!res.ok) {
        console.warn(`  HTTP ${res.status} from ${host}`);
        continue;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      console.log(`  got ${(buf.length / 1e6).toFixed(1)} MB`);
      return buf;
    } catch (err) {
      console.warn(`  failed: ${err.message}`);
    }
  }
  throw new Error('all ERDDAP hosts failed');
}

// ------------------------------------------------------- NetCDF-3 parsing

const NC_SIZES = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 4, 6: 8 };

function parseNetCDF3(buf) {
  if (buf.toString('latin1', 0, 3) !== 'CDF') throw new Error('not a NetCDF file');
  const version = buf[3]; // 1 = classic (32-bit offsets), 2 = 64-bit offsets
  let off = 8; // skip magic + numrecs

  const u32 = () => { const v = buf.readUInt32BE(off); off += 4; return v; };
  const name = () => {
    const len = u32();
    const s = buf.toString('utf8', off, off + len);
    off += Math.ceil(len / 4) * 4;
    return s;
  };
  const skipAttrs = () => {
    const tag = u32();
    const count = u32();
    if (tag === 0 && count === 0) return;
    if (tag !== 0x0c) throw new Error('bad attr list tag');
    for (let i = 0; i < count; i++) {
      name();
      const type = u32();
      const n = u32();
      off += Math.ceil((n * NC_SIZES[type]) / 4) * 4;
    }
  };

  // dimensions
  const dimTag = u32(), dimCount = u32();
  const dims = [];
  if (dimTag === 0x0a) {
    for (let i = 0; i < dimCount; i++) dims.push({ name: name(), size: u32() });
  }
  skipAttrs(); // global attributes

  // variables
  const varTag = u32(), varCount = u32();
  const vars = {};
  if (varTag === 0x0b) {
    for (let i = 0; i < varCount; i++) {
      const vname = name();
      const ndims = u32();
      const shape = [];
      for (let d = 0; d < ndims; d++) shape.push(dims[u32()].size);
      skipAttrs();
      const type = u32();
      u32(); // vsize
      let begin;
      if (version === 1) begin = u32();
      else { begin = buf.readUInt32BE(off) * 2 ** 32 + buf.readUInt32BE(off + 4); off += 8; }
      vars[vname] = { type, shape, begin };
    }
  }
  return vars;
}

function readInt16Var(buf, v) {
  const n = v.shape.reduce((a, b) => a * b, 1);
  const slice = Buffer.from(buf.subarray(v.begin, v.begin + n * 2)); // copy
  slice.swap16(); // big-endian -> little-endian in place
  return new Int16Array(slice.buffer, slice.byteOffset, n);
}

function readFloat64Var(buf, v) {
  const n = v.shape.reduce((a, b) => a * b, 1);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = buf.readDoubleBE(v.begin + i * 8);
  return out;
}

// ------------------------------------------------------------ PNG encoder

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(...bufs) {
  let c = 0xffffffff;
  for (const b of bufs) for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(head.subarray(4), data), 0);
  return Buffer.concat([head, data, crc]);
}

/** Encode an 8-bit RGB PNG with per-row adaptive filtering (filters 0/1/2/4). */
function encodePNG(width, height, rgb) {
  const bpp = 3, stride = width * bpp;
  const filtered = Buffer.alloc(height * (stride + 1));
  const zero = new Uint8Array(stride);
  const rowBuf = [new Uint8Array(stride), new Uint8Array(stride), new Uint8Array(stride)];

  for (let y = 0; y < height; y++) {
    const row = rgb.subarray(y * stride, (y + 1) * stride);
    const prev = y ? rgb.subarray((y - 1) * stride, y * stride) : zero;
    const [sub, up, paeth] = rowBuf;
    let sSub = 0, sUp = 0, sPaeth = 0, sNone = 0;
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? row[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      sub[i] = (row[i] - a) & 255;
      up[i] = (row[i] - b) & 255;
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      const pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      paeth[i] = (row[i] - pred) & 255;
      sNone += row[i] < 128 ? row[i] : 256 - row[i];
      sSub += sub[i] < 128 ? sub[i] : 256 - sub[i];
      sUp += up[i] < 128 ? up[i] : 256 - up[i];
      sPaeth += paeth[i] < 128 ? paeth[i] : 256 - paeth[i];
    }
    const best = Math.min(sNone, sSub, sUp, sPaeth);
    const [ftype, fdata] =
      best === sPaeth ? [4, paeth] : best === sUp ? [2, up] : best === sSub ? [1, sub] : [0, row];
    filtered[y * (stride + 1)] = ftype;
    filtered.set(fdata, y * (stride + 1) + 1);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 2;  // color type: truecolor RGB
  const idat = deflateSync(filtered, { level: 9, memLevel: 9 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------- process

function elevToRGB(elev, width, height) {
  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0; i < elev.length; i++) {
    const v = Math.min(19850, Math.max(0, elev[i] + 11000));
    rgb[i * 3] = v >> 8;
    rgb[i * 3 + 1] = v & 255;
  }
  return rgb;
}

function sampleAt(elev, W, H, lon, lat) {
  const x = Math.round(((lon + 180) / 360) * W) % W;
  const y = Math.min(H - 1, Math.max(0, Math.round(((90 - lat) / 180) * H)));
  return elev[y * W + x];
}

async function main() {
  const nc = await download();
  console.log('Parsing NetCDF...');
  const vars = parseNetCDF3(nc);
  const alt = vars.altitude;
  if (!alt || alt.type !== 3) throw new Error('altitude Int16 variable not found');
  const [nLat, nLon] = alt.shape; // expect 2161 x 4321
  console.log(`  altitude grid: ${nLat} x ${nLon}`);

  const lat = readFloat64Var(nc, vars.latitude);
  const raw = readInt16Var(nc, alt);
  const northFirst = lat[0] > lat[lat.length - 1];

  // Build 4320 x 2160 north-first grid: drop duplicate +180 column, drop one pole row.
  const W = nLon - 1, H = nLat - 1;
  const elev = new Int16Array(W * H);
  let fills = 0;
  for (let y = 0; y < H; y++) {
    const srcRow = northFirst ? y : nLat - 1 - y;
    for (let x = 0; x < W; x++) {
      let v = raw[srcRow * nLon + x];
      if (v === 32767) { v = 0; fills++; }
      elev[y * W + x] = v;
    }
  }
  if (fills) console.warn(`  replaced ${fills} fill values with 0`);

  // Stats + sanity checks.
  let min = 32767, max = -32768;
  for (let i = 0; i < elev.length; i++) {
    if (elev[i] < min) min = elev[i];
    if (elev[i] > max) max = elev[i];
  }
  console.log(`  elevation range: ${min} .. ${max} m`);
  console.log(`  Everest  (27.99N  86.93E): ${sampleAt(elev, W, H, 86.925, 27.988)} m`);
  console.log(`  Mariana  (11.35N 142.20E): ${sampleAt(elev, W, H, 142.2, 11.35)} m`);
  console.log(`  Shanghai (31.23N 121.47E): ${sampleAt(elev, W, H, 121.47, 31.23)} m`);
  if (min < -11500 || max > 9000 || max < 7000 || min > -9000) {
    throw new Error('elevation range looks wrong — aborting');
  }

  mkdirSync(join(ROOT, 'data'), { recursive: true });

  console.log('Encoding data/elev-4320.png ...');
  const png = encodePNG(W, H, elevToRGB(elev, W, H));
  writeFileSync(join(ROOT, 'data', 'elev-4320.png'), png);
  console.log(`  ${(png.length / 1e6).toFixed(2)} MB`);

  // 4x box-downsample for the quick-loading preview.
  const w2 = W / 4, h2 = H / 4;
  const small = new Int16Array(w2 * h2);
  for (let y = 0; y < h2; y++) {
    for (let x = 0; x < w2; x++) {
      let sum = 0;
      for (let dy = 0; dy < 4; dy++)
        for (let dx = 0; dx < 4; dx++) sum += elev[(y * 4 + dy) * W + x * 4 + dx];
      small[y * w2 + x] = Math.round(sum / 16);
    }
  }
  console.log('Encoding data/elev-1080.png ...');
  const png2 = encodePNG(w2, h2, elevToRGB(small, w2, h2));
  writeFileSync(join(ROOT, 'data', 'elev-1080.png'), png2);
  console.log(`  ${(png2.length / 1e6).toFixed(2)} MB`);

  console.log('Done.');
}

main().catch((err) => { console.error(err); process.exit(1); });
