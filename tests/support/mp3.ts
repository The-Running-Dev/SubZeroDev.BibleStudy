// A synthetic MPEG-1 Layer III stream: 128 kbit/s, 44.1 kHz, silent frames of 417 bytes, 1152 samples each.
// Enough for the duration parser and the media routes; not meant to be decoded.
export const frameSeconds = 1152 / 44100;

export function synthMp3(frames: number, options: { id3?: boolean; xing?: boolean } = {}): Buffer {
  const frame = () => {
    const bytes = Buffer.alloc(417);
    bytes.set([0xff, 0xfb, 0x90, 0x00]);
    return bytes;
  };
  const parts: Buffer[] = [];
  if (options.id3) {
    const body = Buffer.alloc(20, 0x41);
    parts.push(Buffer.from([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, body.length]), body);
  }
  if (options.xing) {
    const info = frame();
    info.write('Xing', 36, 'latin1');
    parts.push(info);
  }
  for (let i = 0; i < frames; i++) parts.push(frame());
  return Buffer.concat(parts);
}
