'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { readMidi, writeMidi } = require('../lib/midi-file.js');

const FIXTURE = path.join(__dirname, '..', '..', 'practice_midis', '02_two_hands_easy', '01_twinkle_twinkle_two_hands_easy.mid');

test('readMidi parses a real practice MIDI file', () => {
  const buffer = fs.readFileSync(FIXTURE);
  const midi = readMidi(buffer);
  assert.ok(midi.ticksPerQuarter > 0);
  assert.ok(midi.tracks.length >= 1);
  const noteOns = midi.tracks.flat().filter(e => e.type === 'noteOn');
  assert.ok(noteOns.length > 0, 'expected at least one noteOn event');
  for (const note of noteOns) {
    assert.ok(note.note >= 0 && note.note <= 127);
    assert.ok(note.velocity > 0);
  }
});

test('writeMidi(readMidi(x)) round-trips to an equivalent event stream', () => {
  const original = fs.readFileSync(FIXTURE);
  const parsed = readMidi(original);
  const rewritten = writeMidi(parsed);
  const reparsed = readMidi(rewritten);

  assert.equal(reparsed.ticksPerQuarter, parsed.ticksPerQuarter);
  assert.equal(reparsed.tracks.length, parsed.tracks.length);

  for (let i = 0; i < parsed.tracks.length; i++) {
    const a = parsed.tracks[i].filter(e => e.type !== 'meta' || e.metaType !== 0x2f);
    const b = reparsed.tracks[i].filter(e => e.type !== 'meta' || e.metaType !== 0x2f);
    assert.equal(b.length, a.length, `track ${i} event count mismatch`);
    for (let j = 0; j < a.length; j++) {
      assert.equal(b[j].tick, a[j].tick, `track ${i} event ${j} tick mismatch`);
      assert.equal(b[j].type, a[j].type, `track ${i} event ${j} type mismatch`);
    }
  }
});

test('writeMidi output is a well-formed SMF (parseable, has header)', () => {
  const midi = {
    formatType: 1,
    ticksPerQuarter: 480,
    tracks: [
      [
        { tick: 0, type: 'meta', metaType: 0x51, microsecondsPerQuarter: 500000 },
        { tick: 0, type: 'meta', metaType: 0x58, numerator: 4, denominator: 4 },
      ],
      [
        { tick: 0, type: 'noteOn', channel: 0, note: 60, velocity: 90 },
        { tick: 480, type: 'noteOff', channel: 0, note: 60, velocity: 0 },
      ],
    ],
  };
  const buffer = writeMidi(midi);
  assert.equal(buffer.toString('ascii', 0, 4), 'MThd');
  const reparsed = readMidi(buffer);
  assert.equal(reparsed.ticksPerQuarter, 480);
  assert.equal(reparsed.tracks.length, 2);
  const tempo = reparsed.tracks[0].find(e => e.metaType === 0x51);
  assert.equal(tempo.microsecondsPerQuarter, 500000);
});

test('readVarLength/writeVarLength round-trip', () => {
  const { readVarLength, writeVarLength } = require('../lib/midi-file.js');
  for (const value of [0, 1, 127, 128, 16383, 16384, 2097151, 268435455]) {
    const encoded = writeVarLength(value);
    const { value: decoded, offset } = readVarLength(encoded, 0);
    assert.equal(decoded, value);
    assert.equal(offset, encoded.length);
  }
});
