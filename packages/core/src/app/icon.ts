import zlib from 'node:zlib';

const SIZE = 256;

function pngChunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const chunk = Buffer.alloc(body.length + 8);
  chunk.writeUInt32BE(data.length, 0);
  body.copy(chunk, 4);
  chunk.writeUInt32BE(zlib.crc32(body) >>> 0, body.length + 4);
  return chunk;
}

/** Distance from point (px, py) to the segment (ax, ay)-(bx, by). */
function distanceToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** The letter "M" as four strokes, on the 256-pixel design grid. */
const STROKES: Array<[number, number, number, number]> = [
  [70, 186, 70, 74],
  [70, 74, 128, 150],
  [128, 150, 186, 74],
  [186, 74, 186, 186],
];

/**
 * The app icon as PNG: a rounded tile with a white "M". Drawn in code so no image file is needed.
 * `size` scales the 256-pixel design. A `maskable` icon (Android home screen, which cuts its own
 * shape) fills the whole square and keeps the letter inside the middle 80% that is always shown.
 */
export function renderIconPng(size: number = SIZE, options: { maskable?: boolean } = {}): Buffer {
  const scale = size / SIZE;
  const glyph = options.maskable ? 0.72 : 1;
  const radius = options.maskable ? 0 : 56 * scale;
  const stroke = 15 * scale * glyph;
  const place = (value: number) => (SIZE / 2 + (value - SIZE / 2) * glyph) * scale;
  const strokes = STROKES.map(([ax, ay, bx, by]) => [place(ax), place(ay), place(bx), place(by)] as [number, number, number, number]);
  const mix = (from: number, to: number, amount: number) => Math.round(from + (to - from) * amount);
  const raw = Buffer.alloc((size * 4 + 1) * size);

  for (let y = 0; y < size; y++) {
    const row = y * (size * 4 + 1);
    raw[row] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      // Rounded-rectangle coverage, anti-aliased over one pixel (a maskable icon is square and opaque).
      const cx = Math.max(radius - x, x - (size - 1 - radius), 0);
      const cy = Math.max(radius - y, y - (size - 1 - radius), 0);
      const alpha = radius === 0 ? 1 : Math.max(0, Math.min(1, radius - Math.hypot(cx, cy) + 0.5));

      const shade = y / size; // top-to-bottom gradient
      let red = mix(236, 196, shade);
      let green = mix(140, 84, shade);
      let blue = mix(98, 62, shade);

      const distance = Math.min(...strokes.map((line) => distanceToSegment(x, y, ...line)));
      const ink = Math.max(0, Math.min(1, stroke - distance + 0.5));
      red = mix(red, 255, ink);
      green = mix(green, 255, ink);
      blue = mix(blue, 255, ink);

      raw.set([red, green, blue, Math.round(alpha * 255)], row + 1 + x * 4);
    }
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Wraps the PNG in a Windows .ico container (Vista and later read PNG-in-ICO). */
export function renderIconIco(): Buffer {
  const png = renderIconPng();
  const header = Buffer.alloc(22);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(1, 4); // one image
  header.writeUInt16LE(1, 10); // colour planes (width/height bytes stay 0 = 256)
  header.writeUInt16LE(32, 12); // bits per pixel
  header.writeUInt32LE(png.length, 14);
  header.writeUInt32LE(22, 18); // offset of the image data
  return Buffer.concat([header, png]);
}
