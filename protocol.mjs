export const UUID = Object.freeze({
  service: 'f06f0001-6e91-4f6c-946d-5dc7ab714001',
  state: 'f06f0002-6e91-4f6c-946d-5dc7ab714001',
  stream: 'f06f0003-6e91-4f6c-946d-5dc7ab714001',
  command: 'f06f0004-6e91-4f6c-946d-5dc7ab714001',
});
export const STATE_LABELS = ['보정 대기', '모래 이동 중', '기울기로 일시 정지', '완료', '센서 연결 오류'];
export const RESULT_LABELS = ['적용 완료', '지원하지 않는 명령입니다.', '모래시계를 세운 뒤 다시 적용하세요.', '센서 연결과 보정을 먼저 확인하세요.'];
const bytesOf = value => value instanceof DataView
  ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  : new Uint8Array(value.buffer ?? value, value.byteOffset ?? 0, value.byteLength);

export function decodeSnapshot(value) {
  const bytes = bytesOf(value);
  if (bytes.length !== 48) throw new Error('상태 데이터 길이가 맞지 않습니다.');
  const d = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (d.getUint8(0) !== 1) throw new Error('펌웨어와 웹의 통신 버전이 다릅니다.');
  const state = d.getUint8(1), duration = d.getUint16(2, true);
  if (state > 4 || duration < 60 || duration > 600 || duration % 60 !== 0) throw new Error('잘못된 상태 값입니다.');
  const grid = Array.from({length: 2}, (_, m) => Array.from({length: 8}, (_, r) =>
    Array.from({length: 8}, (_, c) => Boolean(bytes[28 + m * 8 + r] & (1 << c)))));
  const counts = grid.map(module => module.flat().filter(Boolean).length);
  if (counts[1] !== bytes[46] || counts[0] !== bytes[47] ||
      ([1, 2, 3].includes(state) && counts[0] + counts[1] !== 64)) {
    throw new Error('모래 상태 검증에 실패했습니다.');
  }
  const gx = d.getInt16(4, true) / 10000, gy = d.getInt16(6, true) / 10000;
  const plane = d.getUint16(44, true) / 10000;
  if (Math.abs(gx) > 1.01 || Math.abs(gy) > 1.01 || plane > 1.01) throw new Error('기울기 범위를 벗어났습니다.');
  return {state, duration, gx, gy, plane, grid, upper: counts[1], lower: counts[0],
    elapsed: d.getUint32(8, true), completionId: d.getUint32(12, true),
    runId: d.getUint32(16, true), boot: d.getUint32(20, true),
    ack: d.getUint16(24, true), result: bytes[26]};
}

// Four <=20-byte notifications form a single immutable 48-byte snapshot.
export class FrameAssembler {
  reset() { this.sequence = undefined; this.parts = new Map(); this.done = false; }
  constructor() { this.reset(); }
  push(value) {
    const bytes = bytesOf(value);
    if (bytes.length < 6 || bytes[0] !== 0x48 || bytes[1] !== 1 || bytes[5] !== 4 || bytes[4] > 3) return null;
    const sequence = bytes[2] | (bytes[3] << 8), part = bytes[4];
    if (bytes.length !== (part === 3 ? 12 : 20)) return null;
    if (this.sequence !== undefined && sequence !== this.sequence) {
      const delta = (sequence - this.sequence) & 0xffff;
      if (delta >= 0x8000) return null; // late frame, including wrap-around
    }
    if (sequence !== this.sequence) {this.sequence = sequence; this.parts.clear(); this.done = false;}
    if (this.done) return null;
    this.parts.set(part, bytes.slice(6));
    if (this.parts.size !== 4) return null;
    const frame = new Uint8Array(48);
    for (let i = 0; i < 4; i++) frame.set(this.parts.get(i), i * 14);
    this.done = true;
    return decodeSnapshot(frame);
  }
}

export class CompletionTracker {
  reset() { this.boot = undefined; this.completion = undefined; }
  constructor() { this.reset(); }
  accept(state) {
    const delta = (state.completionId - this.completion) >>> 0;
    const sound = this.boot === state.boot && this.completion !== undefined && delta > 0 && delta < 0x80000000 && state.state === 3;
    this.boot = state.boot; this.completion = state.completionId;
    return sound;
  }
}
export function restartCommand(id, minutes) {
  if (!Number.isInteger(id) || id < 1 || id > 65535 || !Number.isInteger(minutes) || minutes < 1 || minutes > 10) throw new Error('명령 값이 잘못되었습니다.');
  return new Uint8Array([1, id & 255, id >> 8, 1, minutes, 0]);
}
