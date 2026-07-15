/**
 * 青花瓷 练习 MIDI 切割器
 * 按周分段 + 左右手分离 + 多速度版本
 * 右手阈值：MIDI >= 60 (C4)；左手：< 60
 */
const fs   = require('fs');
const path = require('path');

const INPUT    = path.resolve(__dirname, '../../qing-hua-ci-zhou-jie-lun-arr-norm4ndy.mid');
const BASE_DIR = path.resolve(__dirname, '../05_qinghuaci');
const TPQ      = 480;
const BAR_TICKS = TPQ * 4;   // 4/4 拍
const ORIG_BPM  = 107;
const RH_MIN    = 60;         // C4，右手最低音

// ─── VLQ 编解码 ────────────────────────────────────────────────────

function readVLQ(buf, pos) {
  let v = 0, len = 0, b;
  do { b = buf[pos + len++]; v = (v << 7) | (b & 0x7F); } while (b & 0x80);
  return { v, len };
}

function writeVLQ(n) {
  if (n === 0) return Buffer.from([0]);
  const out = [];
  out.push(n & 0x7F);
  n >>= 7;
  while (n > 0) { out.push((n & 0x7F) | 0x80); n >>= 7; }
  return Buffer.from(out.reverse());
}

// ─── 解析 track 事件列表（绝对 tick）──────────────────────────────

function parseTrack(buf) {
  const evs = [];
  let pos = 0, absTick = 0, lastStatus = 0;

  while (pos < buf.length) {
    const { v: delta, len: dl } = readVLQ(buf, pos); pos += dl;
    absTick += delta;
    const b = buf[pos];

    if (b === 0xFF) {
      pos++;
      const mt = buf[pos++];
      const { v: ml, len: mll } = readVLQ(buf, pos); pos += mll;
      const data = Buffer.from(buf.slice(pos, pos + ml)); pos += ml;
      evs.push({ tick: absTick, kind: 'meta', mt, data });
    } else if (b === 0xF0 || b === 0xF7) {
      pos++;
      const { v: sl, len: sll } = readVLQ(buf, pos); pos += sll;
      const data = Buffer.from(buf.slice(pos, pos + sl)); pos += sl;
      evs.push({ tick: absTick, kind: 'sysex', b, data });
    } else {
      let st;
      if (b & 0x80) { st = b; lastStatus = b; pos++; } else { st = lastStatus; }
      const type = st & 0xF0;
      if (type === 0x80 || type === 0x90 || type === 0xA0 || type === 0xB0 || type === 0xE0) {
        const d1 = buf[pos++], d2 = buf[pos++];
        evs.push({ tick: absTick, kind: 'midi', st, d1, d2 });
      } else if (type === 0xC0 || type === 0xD0) {
        const d1 = buf[pos++];
        evs.push({ tick: absTick, kind: 'midi', st, d1 });
      } else { pos++; }
    }
  }
  return evs;
}

// ─── 编码事件列表 → MTrk buffer ────────────────────────────────────

function encodeTrack(evs) {
  const chunks = [];
  let last = 0;
  for (const ev of evs) {
    chunks.push(writeVLQ(Math.max(0, ev.tick - last)));
    last = ev.tick;
    if (ev.kind === 'meta') {
      chunks.push(Buffer.from([0xFF, ev.mt]));
      chunks.push(writeVLQ(ev.data.length));
      chunks.push(ev.data);
    } else if (ev.kind === 'sysex') {
      chunks.push(Buffer.from([ev.b]));
      chunks.push(writeVLQ(ev.data.length));
      chunks.push(ev.data);
    } else {
      const bytes = [ev.st, ev.d1];
      if (ev.d2 !== undefined) bytes.push(ev.d2);
      chunks.push(Buffer.from(bytes));
    }
  }
  chunks.push(Buffer.from([0x00, 0xFF, 0x2F, 0x00]));
  const body = Buffer.concat(chunks);
  const hdr  = Buffer.alloc(8);
  hdr.write('MTrk', 0, 'ascii');
  hdr.writeUInt32BE(body.length, 4);
  return Buffer.concat([hdr, body]);
}

// ─── 构建 MIDI 文件 ────────────────────────────────────────────────

function buildMidi(tpq, tracks) {
  const hdr = Buffer.alloc(14);
  hdr.write('MThd', 0, 'ascii');
  hdr.writeUInt32BE(6, 4);
  hdr.writeUInt16BE(1, 8);
  hdr.writeUInt16BE(tracks.length, 10);
  hdr.writeUInt16BE(tpq, 12);
  return Buffer.concat([hdr, ...tracks]);
}

// ─── 过滤 + 切片 ──────────────────────────────────────────────────

function slice(evs, startBar, endBar, hand) {
  const t0 = (startBar - 1) * BAR_TICKS;
  const t1 = (endBar   - 1) * BAR_TICKS;

  return evs
    .filter(ev => {
      if (ev.tick < t0 || ev.tick >= t1) return false;
      if (ev.kind === 'meta' && ev.mt === 0x2F) return false; // end-of-track（自动添加）
      if (ev.kind !== 'midi') return true;                     // 保留所有控制/meta
      const type = ev.st & 0xF0;
      if (type !== 0x80 && type !== 0x90) return true;        // 非音符事件保留
      if (hand === 'right') return ev.d1 >= RH_MIN;
      if (hand === 'left')  return ev.d1 <  RH_MIN;
      return true;
    })
    .map(ev => ({ ...ev, tick: ev.tick - t0 }));              // 重置为从0开始
}

// ─── 修改 tempo track 速度 ─────────────────────────────────────────

function scaleTempo(evs, targetBpm) {
  const factor = ORIG_BPM / targetBpm;
  return evs
    .filter(ev => !(ev.kind === 'meta' && ev.mt === 0x2F))
    .map(ev => {
      if (ev.kind === 'meta' && ev.mt === 0x51) {
        const orig = (ev.data[0] << 16) | (ev.data[1] << 8) | ev.data[2];
        const next = Math.min(Math.round(orig * factor), 0xFFFFFF);
        return { ...ev, data: Buffer.from([(next>>16)&0xFF,(next>>8)&0xFF,next&0xFF]) };
      }
      return ev;
    });
}

// ─── 主程序 ───────────────────────────────────────────────────────

const src = fs.readFileSync(INPUT);
let pos = 14;
const rawTracks = [];
for (let i = 0; i < src.readUInt16BE(10); i++) {
  const len = src.readUInt32BE(pos + 4);
  rawTracks.push(src.slice(pos + 8, pos + 8 + len));
  pos += 8 + len;
}

const tempoEvs = parseTrack(rawTracks[0]);
const musicEvs = parseTrack(rawTracks[1]);

const WEEKS = [
  { dir: 'week1_前奏_主歌', startBar: 1,  endBar: 27,  desc: '前奏 + 主歌第一段' },
  { dir: 'week2_副歌',      startBar: 27, endBar: 53,  desc: '副歌第一段'         },
  { dir: 'week3_主歌2_副歌2', startBar: 53, endBar: 79, desc: '主歌第二段 + 副歌第二段' },
  { dir: 'week4_尾声',      startBar: 79, endBar: 103, desc: '间奏 + 尾声'         },
];

const SPEEDS = [
  { bpm: 45,  tag: '45bpm_超慢' },
  { bpm: 65,  tag: '65bpm_慢速' },
  { bpm: 85,  tag: '85bpm_中速' },
  { bpm: 107, tag: '107bpm_原速' },
];

const HANDS = [
  { key: 'right', label: '右手' },
  { key: 'left',  label: '左手' },
  { key: 'both',  label: '双手' },
];

let total = 0;

for (const week of WEEKS) {
  const weekDir = path.join(BASE_DIR, week.dir);
  fs.mkdirSync(weekDir, { recursive: true });

  for (const speed of SPEEDS) {
    const tempoTrack = encodeTrack(scaleTempo(tempoEvs, speed.bpm));
    for (const hand of HANDS) {
      const sliced   = slice(musicEvs, week.startBar, week.endBar, hand.key);
      const musTrack = encodeTrack(sliced);
      const midi     = buildMidi(TPQ, [tempoTrack, musTrack]);
      const fname    = `${hand.label}_${speed.tag}.mid`;
      fs.writeFileSync(path.join(weekDir, fname), midi);
      total++;
    }
  }
  console.log(`✓ ${week.dir}（${week.desc}）· bars ${week.startBar}–${week.endBar - 1}`);
}

console.log(`\n共生成 ${total} 个文件 → ${BASE_DIR}`);
