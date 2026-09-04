'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { readMidi, writeMidi } = require('../lib/midi-file.js');
const { analyzeSong, extractTrackNotes, groupIntoEvents, computeMeasures, extractPedalEvents } = require('../lib/analyze.js');

const TWINKLE = path.join(__dirname, '..', '..', 'practice_midis', '02_two_hands_easy', '01_twinkle_twinkle_two_hands_easy.mid');

test('analyzeSong reads bpm, time signature, measures and per-track roles', () => {
  const midi = readMidi(fs.readFileSync(TWINKLE));
  const info = analyzeSong(midi, { title: 'twinkle' });

  assert.equal(info.timeSignature.numerator, 4);
  assert.equal(info.timeSignature.denominator, 4);
  assert.ok(info.bpm > 0);
  assert.ok(info.measureCount > 0);

  const right = info.tracks.find(t => t.name === 'Right hand');
  const left = info.tracks.find(t => t.name === 'Left hand');
  assert.equal(right.roleGuess, 'right');
  assert.equal(left.roleGuess, 'left');
  assert.ok(right.noteCount > 0);
  assert.ok(right.minPitch >= left.maxPitch, 'right hand should sit above left hand on average for this song');
});

test('groupIntoEvents merges simultaneous notes into a single chord event, never splitting a chord', () => {
  const ticksPerQuarter = 480;
  const midi = {
    formatType: 1,
    ticksPerQuarter,
    tracks: [
      [
        { tick: 0, type: 'noteOn', channel: 0, note: 60, velocity: 90 },
        { tick: 0, type: 'noteOn', channel: 0, note: 64, velocity: 90 },
        { tick: 0, type: 'noteOn', channel: 0, note: 67, velocity: 90 },
        { tick: ticksPerQuarter, type: 'noteOff', channel: 0, note: 60, velocity: 0 },
        { tick: ticksPerQuarter, type: 'noteOff', channel: 0, note: 64, velocity: 0 },
        { tick: ticksPerQuarter, type: 'noteOff', channel: 0, note: 67, velocity: 0 },
        { tick: ticksPerQuarter, type: 'noteOn', channel: 0, note: 62, velocity: 90 },
        { tick: ticksPerQuarter * 2, type: 'noteOff', channel: 0, note: 62, velocity: 0 },
      ],
    ],
  };
  const buffer = writeMidi(midi);
  const reparsed = readMidi(buffer);
  const notes = extractTrackNotes(reparsed.tracks[0]);
  const events = groupIntoEvents(notes, ticksPerQuarter);

  assert.equal(events.length, 2, 'the 3-note chord and the single note should be 2 events, not 4');
  assert.equal(events[0].notes.length, 3);
  assert.deepEqual(events[0].notes.map(n => n.note).sort((a, b) => a - b), [60, 64, 67]);
  assert.equal(events[1].notes.length, 1);
  assert.equal(events[1].notes[0].note, 62);
});

test('computeMeasures produces contiguous, non-overlapping measures covering the song', () => {
  const midi = readMidi(fs.readFileSync(TWINKLE));
  const measures = computeMeasures(midi, 999999999);
  for (let i = 1; i < measures.length; i++) {
    assert.equal(measures[i].startTick, measures[i - 1].endTick, `measure ${i} should start where ${i - 1} ends`);
  }
});

test('computeMeasures respects a time signature change mid-song', () => {
  const ticksPerQuarter = 480;
  const midi = {
    ticksPerQuarter,
    tracks: [
      [
        { tick: 0, type: 'meta', metaType: 0x58, numerator: 4, denominator: 4 },
        { tick: ticksPerQuarter * 8, type: 'meta', metaType: 0x58, numerator: 3, denominator: 4 },
      ],
    ],
  };
  // 2 measures of 4/4 (4*480=1920 ticks each) then measures of 3/4 (1440 ticks each)
  const measures = computeMeasures(midi, ticksPerQuarter * 8 + ticksPerQuarter * 4 * 3);
  assert.equal(measures[0].numerator, 4);
  assert.equal(measures[0].endTick, 1920);
  const afterChange = measures.find(m => m.startTick === ticksPerQuarter * 8);
  assert.equal(afterChange.numerator, 3);
  assert.equal(afterChange.endTick - afterChange.startTick, ticksPerQuarter * 3);
});

test('extractPedalEvents reads CC64 sustain pedal events and ignores other controllers', () => {
  const midi = {
    ticksPerQuarter: 480,
    tracks: [
      [
        { tick: 0, type: 'controller', channel: 0, controller: 7, value: 100 }, // volume, not pedal
        { tick: 10, type: 'controller', channel: 0, controller: 64, value: 127 }, // down
        { tick: 500, type: 'controller', channel: 0, controller: 64, value: 0 }, // up
      ],
    ],
  };
  const pedal = extractPedalEvents(midi);
  assert.deepEqual(pedal, [
    { tick: 10, down: true },
    { tick: 500, down: false },
  ]);
});

test('extractPedalEvents collapses redundant same-state CC64 resends and merges tracks in tick order', () => {
  const midi = {
    ticksPerQuarter: 480,
    tracks: [
      [
        { tick: 0, type: 'controller', channel: 0, controller: 64, value: 100 }, // down
        { tick: 5, type: 'controller', channel: 0, controller: 64, value: 90 }, // still down, redundant resend
      ],
      [
        { tick: 2, type: 'controller', channel: 1, controller: 64, value: 70 }, // >=64 threshold: still "down"
        { tick: 50, type: 'controller', channel: 1, controller: 64, value: 20 }, // up
      ],
    ],
  };
  const pedal = extractPedalEvents(midi);
  assert.deepEqual(pedal, [
    { tick: 0, down: true },
    { tick: 50, down: false },
  ]);
});

test('extractPedalEvents returns an empty array for a MIDI with no pedal markings (legal input, not an error)', () => {
  const midi = readMidi(fs.readFileSync(TWINKLE));
  assert.deepEqual(extractPedalEvents(midi), []);
});
