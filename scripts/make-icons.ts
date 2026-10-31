// Writes the home-screen icons in src/client/public/icons: a light cross on the theme colour.
// Run with `node scripts/make-icons.ts` after changing the design; the PNGs are committed.
import { mkdirSync, writeFileSync } from 'node:fs';
import { crc32, deflateSync } from 'node:zlib';

const background = [0x1f, 0x29, 0x37];
const foreground = [0xf9, 0xfa, 0xfb];

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

// `scale` is the cross's height as a share of the icon; maskable icons keep it inside the safe zone.
function icon(size: number, scale: number): Buffer {
  const height = size * scale;
  const bar = height * 0.16;
  const top = (size - height) / 2;
  const beam = top + height * 0.28;
  const rows: Buffer[] = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 3);
    for (let x = 0; x < size; x++) {
      const upright = Math.abs(x + 0.5 - size / 2) < bar / 2 && y >= top && y < top + height;
      const crossbar = Math.abs(y + 0.5 - beam) < bar / 2 && Math.abs(x + 0.5 - size / 2) < height * 0.33;
      const [r, g, b] = upright || crossbar ? foreground : background;
      row.set([r, g, b], 1 + x * 3);
    }
    rows.push(row);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([signature, chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}

const dir = 'src/client/public/icons';
mkdirSync(dir, { recursive: true });
writeFileSync(`${dir}/icon-192.png`, icon(192, 0.7));
writeFileSync(`${dir}/icon-512.png`, icon(512, 0.7));
writeFileSync(`${dir}/icon-maskable-512.png`, icon(512, 0.5));
writeFileSync(`${dir}/apple-touch-icon.png`, icon(180, 0.6));
