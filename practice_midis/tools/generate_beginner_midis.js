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

const Q = 1;
const H = 2;
const E = 0.5;

const twinkle = [
  ["C4", Q], ["C4", Q], ["G4", Q], ["G4", Q], ["A4", Q], ["A4", Q], ["G4", H],
  ["F4", Q], ["F4", Q], ["E4", Q], ["E4", Q], ["D4", Q], ["D4", Q], ["C4", H],
  ["G4", Q], ["G4", Q], ["F4", Q], ["F4", Q], ["E4", Q], ["E4", Q], ["D4", H],
  ["G4", Q], ["G4", Q], ["F4", Q], ["F4", Q], ["E4", Q], ["E4", Q], ["D4", H],
  ["C4", Q], ["C4", Q], ["G4", Q], ["G4", Q], ["A4", Q], ["A4", Q], ["G4", H],
  ["F4", Q], ["F4", Q], ["E4", Q], ["E4", Q], ["D4", Q], ["D4", Q], ["C4", H],
].map(([n, d]) => ({ n, d }));

const ode = [
  ["E4", Q], ["E4", Q], ["F4", Q], ["G4", Q], ["G4", Q], ["F4", Q], ["E4", Q], ["D4", Q],
  ["C4", Q], ["C4", Q], ["D4", Q], ["E4", Q], ["E4", 1.5], ["D4", E], ["D4", H],
  ["E4", Q], ["E4", Q], ["F4", Q], ["G4", Q], ["G4", Q], ["F4", Q], ["E4", Q], ["D4", Q],
  ["C4", Q], ["C4", Q], ["D4", Q], ["E4", Q], ["D4", 1.5], ["C4", E], ["C4", H],
].map(([n, d]) => ({ n, d }));

const mary = [
  ["E4", Q], ["D4", Q], ["C4", Q], ["D4", Q], ["E4", Q], ["E4", Q], ["E4", H],
  ["D4", Q], ["D4", Q], ["D4", H], ["E4", Q], ["G4", Q], ["G4", H],
  ["E4", Q], ["D4", Q], ["C4", Q], ["D4", Q], ["E4", Q], ["E4", Q], ["E4", Q], ["E4", Q],
  ["D4", Q], ["D4", Q], ["E4", Q], ["D4", Q], ["C4", H],
].map(([n, d]) => ({ n, d }));

const frere = [
  ["C4", Q], ["D4", Q], ["E4", Q], ["C4", Q], ["C4", Q], ["D4", Q], ["E4", Q], ["C4", Q],
  ["E4", Q], ["F4", Q], ["G4", H], ["E4", Q], ["F4", Q], ["G4", H],
  ["G4", E], ["A4", E], ["G4", E], ["F4", E], ["E4", Q], ["C4", Q],
  ["G4", E], ["A4", E], ["G4", E], ["F4", E], ["E4", Q], ["C4", Q],
  ["C4", Q], ["G3", Q], ["C4", H], ["C4", Q], ["G3", Q], ["C4", H],
].map(([n, d]) => ({ n, d }));

const auClair = [
  ["C4", Q], ["C4", Q], ["C4", Q], ["D4", Q], ["E4", H], ["D4", H],
  ["C4", Q], ["E4", Q], ["D4", Q], ["D4", Q], ["C4", H], null,
  ["C4", Q], ["C4", Q], ["C4", Q], ["D4", Q], ["E4", H], ["D4", H],
  ["C4", Q], ["E4", Q], ["D4", Q], ["D4", Q], ["C4", H],
].map((x) => x ? { n: x[0], d: x[1] } : { n: null, d: Q });

const amazing = [
  ["G3", Q], ["C4", H], ["E4", Q], ["C4", Q], ["E4", H], ["D4", Q],
  ["C4", H], ["A3", Q], ["G3", H], null,
  ["G3", Q], ["C4", H], ["E4", Q], ["C4", Q], ["E4", H], ["D4", Q],
  ["E4", H], ["G4", Q], ["G4", H],
].map((x) => x ? { n: x[0], d: x[1] } : { n: null, d: Q });

const greensleeves = [
  ["A3", Q], ["C4", Q], ["D4", 1.5], ["E4", E], ["F4", Q], ["E4", Q], ["D4", Q], ["B3", Q],
  ["G3", Q], ["A3", Q], ["B3", 1.5], ["C4", E], ["D4", Q], ["C4", Q], ["A3", H],
  ["A3", Q], ["C4", Q], ["D4", 1.5], ["E4", E], ["F4", Q], ["E4", Q], ["D4", Q], ["B3", Q],
  ["G3", Q], ["A3", Q], ["B3", Q], ["C4", Q], ["A3", H],
].map(([n, d]) => ({ n, d }));

const scarborough = [
  ["D4", Q], ["D4", Q], ["A4", Q], ["A4", Q], ["E4", Q], ["F4", Q], ["E4", H],
  ["D4", Q], ["E4", Q], ["F4", Q], ["G4", Q], ["A4", H], ["G4", Q], ["F4", Q],
  ["E4", Q], ["D4", Q], ["C4", Q], ["D4", Q], ["E4", H], null,
  ["D4", Q], ["D4", Q], ["A4", Q], ["A4", Q], ["G4", Q], ["F4", Q], ["E4", H],
].map((x) => x ? { n: x[0], d: x[1] } : { n: null, d: Q });

const satieTheme = [
  ["G4", H], ["F#4", H], ["E4", H], ["D4", H],
  ["B3", H], ["C4", H], ["D4", H], ["E4", H],
  ["G4", H], ["F#4", H], ["E4", H], ["D4", H],
  ["C4", H], ["B3", H], ["A3", H], null,
].map((x) => x ? { n: x[0], d: x[1] } : { n: null, d: H });

const schumannTheme = [
  ["C4", Q], ["D4", Q], ["E4", H], ["G4", Q], ["F4", Q], ["E4", H],
  ["D4", Q], ["E4", Q], ["F4", H], ["A4", Q], ["G4", Q], ["F4", H],
  ["E4", Q], ["F4", Q], ["G4", H], ["C5", H], ["B4", Q], ["A4", Q], ["G4", H],
].map(([n, d]) => ({ n, d }));

const canon = [
  ["F#4", Q], ["E4", Q], ["D4", Q], ["C#4", Q], ["B3", Q], ["A3", Q], ["B3", Q], ["C#4", Q],
  ["D4", Q], ["C#4", Q], ["B3", Q], ["A3", Q], ["G3", Q], ["F#3", Q], ["G3", Q], ["A3", Q],
  ["D4", Q], ["E4", Q], ["F#4", Q], ["A4", Q], ["B4", H], ["A4", H],
].map(([n, d]) => ({ n, d }));

const minuet = [
  ["D4", Q], ["G3", E], ["A3", E], ["B3", E], ["C4", E], ["D4", Q], ["G3", Q], ["G3", Q],
  ["E4", Q], ["C4", E], ["D4", E], ["E4", E], ["F#4", E], ["G4", Q], ["G3", Q], ["G3", Q],
  ["C4", Q], ["D4", E], ["C4", E], ["B3", E], ["A3", E], ["B3", Q], ["C4", E], ["B3", E], ["A3", E], ["G3", E],
  ["F#3", Q], ["G3", Q], ["A3", H],
].map(([n, d]) => ({ n, d }));

function bassRoots(pattern, dur = H) {
  return pattern.map((n) => ({ n, d: dur, v: 58 }));
}

writeMidi("01_single_hand/01_twinkle_twinkle_right_hand_slow.mid", {
  title: "Twinkle Twinkle - RH slow",
  bpm: 58,
  right: twinkle,
});

writeMidi("01_single_hand/02_ode_to_joy_right_hand_slow.mid", {
  title: "Ode to Joy - RH slow",
  bpm: 60,
  right: ode,
});

writeMidi("01_single_hand/03_mary_had_a_little_lamb_right_hand_slow.mid", {
  title: "Mary Had a Little Lamb - RH slow",
  bpm: 62,
  right: mary,
});

writeMidi("01_single_hand/04_frere_jacques_right_hand_slow.mid", {
  title: "Frere Jacques - RH slow",
  bpm: 62,
  right: frere,
});

writeMidi("01_single_hand/05_au_clair_de_la_lune_right_hand_slow.mid", {
  title: "Au Clair de la Lune - RH slow",
  bpm: 56,
  right: auClair,
});

writeMidi("02_two_hands_easy/01_twinkle_twinkle_two_hands_easy.mid", {
  title: "Twinkle Twinkle - two hands easy",
  bpm: 54,
  right: twinkle,
  left: bassRoots(["C3", "G2", "C3", "G2", "C3", "G2", "C3", "G2", "C3", "G2", "C3", "G2"]),
});

writeMidi("02_two_hands_easy/02_ode_to_joy_two_hands_easy.mid", {
  title: "Ode to Joy - two hands easy",
  bpm: 56,
  right: ode,
  left: bassRoots(["C3", "G2", "C3", "G2", "C3", "G2", "C3", "G2"]),
});

writeMidi("02_two_hands_easy/03_amazing_grace_two_hands_easy.mid", {
  title: "Amazing Grace - two hands easy",
  bpm: 50,
  right: amazing,
  left: bassRoots(["C3", "F2", "C3", "G2", "C3", "F2", "C3", "G2"]),
});

writeMidi("02_two_hands_easy/04_pachelbel_canon_easy_loop.mid", {
  title: "Canon in D - easy loop",
  bpm: 52,
  right: canon,
  left: bassRoots(["D3", "A2", "B2", "F#2", "G2", "D2", "G2", "A2"], Q),
});

writeMidi("03_beautiful_slow/01_greensleeves_melody_slow.mid", {
  title: "Greensleeves - melody slow",
  bpm: 50,
  right: greensleeves,
});

writeMidi("03_beautiful_slow/02_satie_gymnopedie_theme_easy.mid", {
  title: "Gymnopedie No.1 - theme easy",
  bpm: 44,
  right: satieTheme,
  left: bassRoots(["G2", "D2", "G2", "D2", "C2", "G2", "C2", "D2"], H),
});

writeMidi("03_beautiful_slow/03_scarborough_fair_melody_slow.mid", {
  title: "Scarborough Fair - melody slow",
  bpm: 50,
  right: scarborough,
});

writeMidi("03_beautiful_slow/04_schumann_melodie_theme_easy.mid", {
  title: "Schumann Melodie - theme easy",
  bpm: 54,
  right: schumannTheme,
  left: bassRoots(["C3", "G2", "F2", "C3", "G2", "C3"], H),
});

writeMidi("04_challenge/01_bach_minuet_g_opening_easy.mid", {
  title: "Minuet in G - opening easy",
  bpm: 58,
  right: minuet,
});

writeMidi("04_challenge/02_canon_in_d_slow_two_hands.mid", {
  title: "Canon in D - slow two hands",
  bpm: 58,
  right: canon.concat(canon),
  left: bassRoots(["D3", "A2", "B2", "F#2", "G2", "D2", "G2", "A2", "D3", "A2", "B2", "F#2", "G2", "D2", "G2", "A2"], Q),
});
