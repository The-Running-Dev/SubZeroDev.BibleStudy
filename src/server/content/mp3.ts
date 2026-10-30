// Duration of an MPEG audio file, found by walking its frames. Recordings carry no trusted duration
// of their own, and verse timing is checked against this one (I-13).

const bitrates: Record<string, number[]> = {
  'V1L1': [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  'V1L2': [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  'V1L3': [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  'V2L1': [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  'V2L2': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  'V2L3': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};
const sampleRates: Record<number, number[]> = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

export interface FrameHeader {
  bytes: number;
  samples: number;
  sampleRate: number;
}

export function readFrameHeader(buf: Buffer, at: number): FrameHeader | null {
  if (at + 4 > buf.length || buf[at] !== 0xff || (buf[at + 1] & 0xe0) !== 0xe0) return null;
  const version = (buf[at + 1] >> 3) & 0x3; // 3 = MPEG-1, 2 = MPEG-2, 0 = MPEG-2.5
  const layer = 4 - ((buf[at + 1] >> 1) & 0x3); // 1, 2 or 3; 4 is reserved
  const bitrateIndex = buf[at + 2] >> 4;
  const rateIndex = (buf[at + 2] >> 2) & 0x3;
  const padding = (buf[at + 2] >> 1) & 0x1;
  if (version === 1 || layer === 4 || bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3) return null;
  const kbps = bitrates[`${version === 3 ? 'V1' : 'V2'}L${layer}`][bitrateIndex];
  const sampleRate = sampleRates[version][rateIndex];
  if (layer === 1) return { bytes: (Math.floor((12_000 * kbps) / sampleRate) + padding) * 4, samples: 384, sampleRate };
  const samples = layer === 3 && version !== 3 ? 576 : 1152;
  return { bytes: Math.floor(((samples / 8) * 1000 * kbps) / sampleRate) + padding, samples, sampleRate };
}

function id3v2Length(buf: Buffer): number {
  if (buf.length < 10 || buf.toString('latin1', 0, 3) !== 'ID3') return 0;
  const size = ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f);
  const footer = buf[5] & 0x10 ? 10 : 0;
  return 10 + size + footer;
}

// A Xing or Info frame describes the stream and holds no audio.
function isInfoFrame(buf: Buffer, at: number, frame: FrameHeader): boolean {
  const end = Math.min(at + frame.bytes, buf.length);
  const window = buf.toString('latin1', at + 4, Math.min(at + 4 + 40, end));
  return window.includes('Xing') || window.includes('Info');
}

export function mp3DurationSeconds(buf: Buffer): number {
  let at = id3v2Length(buf);
  let seconds = 0;
  let frames = 0;
  while (at + 4 <= buf.length) {
    const frame = readFrameHeader(buf, at);
    // Only accept a header that is followed by another, or by the end of the file, so stray 0xFF bytes are skipped.
    const next = frame ? at + frame.bytes : 0;
    const confirmed = frame !== null && (next === buf.length || next + 4 > buf.length || readFrameHeader(buf, next) !== null || buf.toString('latin1', next, next + 3) === 'TAG');
    if (!frame || !confirmed) {
      if (frames > 0 && buf.toString('latin1', at, at + 3) === 'TAG') break;
      at++;
      continue;
    }
    if (!(frames === 0 && isInfoFrame(buf, at, frame))) seconds += frame.samples / frame.sampleRate;
    frames++;
    at = next;
  }
  if (frames === 0) throw new Error('no MPEG audio frames found');
  return seconds;
}
