const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const TPQ = 480;

const pitchBase = {
  C: 0,
  D: 2,
  E: 4,
  F: 5,
  G: 7,
  A: 9,
  B: 11,
};

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function noteNumber(name) {
  const match = /^([A-G])([#b]?)(-?\d)$/.exec(name);
  if (!match) throw new Error(`Bad note name: ${name}`);
  const [, letter, accidental, octaveText] = match;
  let pitch = pitchBase[letter];
  if (accidental === "#") pitch += 1;
  if (accidental === "b") pitch -= 1;
  return (Number(octaveText) + 1) * 12 + pitch;
}

function u32(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
}

function u16(n) {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n);
  return b;
}

function varLen(value) {
  let buffer = value & 0x7f;
  const out = [];
  while ((value >>= 7)) {
    buffer <<= 8;
    buffer |= (value & 0x7f) | 0x80;
  }
  while (true) {
    out.push(buffer & 0xff);
    if (buffer & 0x80) buffer >>= 8;
    else break;
  }
  return Buffer.from(out);
}

function asciiBytes(text) {
  return Buffer.from(text.replace(/[^\x20-\x7e]/g, ""), "ascii");
}

function metaTrackName(name) {
  const bytes = asciiBytes(name);
  return Buffer.concat([Buffer.from([0x00, 0xff, 0x03]), varLen(bytes.length), bytes]);
}

function tempoEvent(bpm) {
  const usPerQuarter = Math.round(60000000 / bpm);
  return Buffer.from([
    0x00,
    0xff,
    0x51,
    0x03,
    (usPerQuarter >> 16) & 0xff,
    (usPerQuarter >> 8) & 0xff,
    usPerQuarter & 0xff,
  ]);
}

function timeSignatureEvent(numerator = 4, denominator = 4) {
  const power = Math.log2(denominator);
  return Buffer.from([0x00, 0xff, 0x58, 0x04, numerator, power, 24, 8]);
}

function endTrack() {
  return Buffer.from([0x00, 0xff, 0x2f, 0x00]);
}

function wrapTrack(chunks) {
  const body = Buffer.concat(chunks);
  return Buffer.concat([Buffer.from("MTrk", "ascii"), u32(body.length), body]);
}

function noteEvents(sequence, channel, velocity = 74) {
  const events = [];
  let tick = 0;

  for (const item of sequence) {
    const duration = Math.round((item.d ?? 1) * TPQ);
    if (!item.n) {
      tick += duration;
      continue;
    }

    const notes = Array.isArray(item.n) ? item.n : [item.n];
    for (const note of notes) {
      const number = noteNumber(note);
      events.push({
        tick,
        order: 1,
        data: Buffer.from([0x90 | channel, number, item.v ?? velocity]),
      });
      events.push({
        tick: tick + duration,
        order: 0,
        data: Buffer.from([0x80 | channel, number, 0]),
      });
    }
    tick += duration;
  }

  return events;
}

function renderEvents(events) {
  events.sort((a, b) => a.tick - b.tick || a.order - b.order);
  let last = 0;
  const chunks = [];
  for (const event of events) {
    chunks.push(varLen(event.tick - last), event.data);
    last = event.tick;
  }
  chunks.push(endTrack());
  return chunks;
}

function musicTrack(name, sequence, channel) {
  const chunks = [
    metaTrackName(name),
    Buffer.from([0x00, 0xc0 | channel, 0x00]), // acoustic grand piano
    ...renderEvents(noteEvents(sequence, channel)),
  ];
  return wrapTrack(chunks);
}

function writeMidi(relativePath, { title, bpm = 72, right, left }) {
  const tracks = [
    wrapTrack([metaTrackName(title), tempoEvent(bpm), timeSignatureEvent(), endTrack()]),
    musicTrack("Right hand", right, 0),
  ];
  if (left?.length) tracks.push(musicTrack("Left hand", left, 1));

  const header = Buffer.concat([
    Buffer.from("MThd", "ascii"),
    u32(6),
    u16(1),
    u16(tracks.length),
    u16(TPQ),
  ]);

  const file = path.join(ROOT, relativePath);
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, Buffer.concat([header, ...tracks]));
  console.log(file);
}

module.exports = {
  ROOT,
  TPQ,
  noteNumber,
  writeMidi,
  ensureDir,
};
