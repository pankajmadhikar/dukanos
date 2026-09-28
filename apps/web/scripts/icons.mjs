import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";

function png(size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    const row = y * (size * 4 + 1);
    raw[row] = 0;
    for (let x = 0; x < size; x += 1) {
      const pixel = row + 1 + x * 4;
      const margin = size * 0.18;
      const inside = x > margin && x < size - margin && y > margin && y < size - margin;
      raw[pixel] = inside ? 194 : 28;
      raw[pixel + 1] = inside ? 65 : 25;
      raw[pixel + 2] = inside ? 12 : 23;
      raw[pixel + 3] = 255;
    }
  }
  const compressed = deflateSync(raw);
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([signature, chunk("IHDR", ihdr(size)), chunk("IDAT", compressed), chunk("IEND", Buffer.alloc(0))]);
}

function ihdr(size) {
  const body = Buffer.alloc(13);
  body.writeUInt32BE(size, 0);
  body.writeUInt32BE(size, 4);
  body[8] = 8;
  body[9] = 6;
  return body;
}

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type), data]);
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc(body), 8 + data.length);
  return out;
}

function crc(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
  }
  return (value ^ 0xffffffff) >>> 0;
}

mkdirSync(new URL("../public/icons/", import.meta.url), { recursive: true });
writeFileSync(new URL("../public/icons/icon-192.png", import.meta.url), png(192));
writeFileSync(new URL("../public/icons/icon-512.png", import.meta.url), png(512));
