'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { readMidi, writeMidi } = require('../lib/midi-file.js');
const { analyzeSong, extractTrackNotes, groupIntoEvents } = require('../lib/analyze.js');
const { sliceMidi, exportLessonBuffer } = require('../lib/lesson-export.js');

const TPQ = 480;

function buildFixture() {
  // One track: sustain pedal down before the range, a note that starts
  // before the range and releases inside it, two notes fully inside the
  // range, and a note that starts inside the range but releases after it.
  return {
    formatType: 1,
    ticksPerQuarter: TPQ,
    tracks: [
      [
        { tick: 0, type: 'meta', metaType: 0x51, microsecondsPerQuarter: 500000 }, // 120 bpm
        { tick: 0, type: 'meta', metaType: 0x58, numerator: 4, denominator: 4 },
      ],
      [
        { tick: 0, type: 'programChange', channel: 0, program: 4 },
        { tick: 0, type: 'controller', channel: 0, controller: 64, value: 127 }, // pedal down
        // note starting before range (tick 1000), releasing inside range (tick 2200)
        { tick: 1000, type: 'noteOn', channel: 0, note: 60, velocity: 90 },
        { tick: 2200, type: 'noteOff', channel: 0, note: 60, velocity: 0 },
        // fully inside range [2000, 4000)
        { tick: 2400, type: 'noteOn', channel: 0, note: 64, velocity: 91 },
        { tick: 2800, type: 'noteOff', channel: 0, note: 64, velocity: 0 },
        // starts inside range, releases after range end (4000)
        { tick: 3800, type: 'noteOn', channel: 0, note: 67, velocity: 92 },
        { tick: 4500, type: 'noteOff', channel: 0, note: 67, velocity: 0 },
        // fully after range - must be excluded
        { tick: 5000, type: 'noteOn', channel: 0, note: 71, velocity: 93 },
        { tick: 5200, type: 'noteOff', channel: 0, note: 71, velocity: 0 },
      ],
    ],
  };
}

test('sliceMidi carries a note that started before the range and releases inside it', () => {
  const midi = buildFixture();
  const sliced = sliceMidi(midi, { trackIndexes: [1], startTick: 2000, endTick: 4000 }, { countIn: false });
  const notes = extractTrackNotes(sliced.tracks[1]);
  const carried = notes.find(n => n.note === 60);
  assert.ok(carried, 'note 60 should be present even though it started before the range');
  assert.equal(carried.tick, 0, 'carried note should re-trigger at the start of the slice');
  assert.equal(carried.endTick, 200, 'carried note should release at its original relative time');
});

test('sliceMidi clips a note that starts inside the range but releases after it', () => {
  const midi = buildFixture();
  const sliced = sliceMidi(midi, { trackIndexes: [1], startTick: 2000, endTick: 4000 }, { countIn: false });
  const notes = extractTrackNotes(sliced.tracks[1]);
  const clipped = notes.find(n => n.note === 67);
  assert.ok(clipped);
  assert.equal(clipped.endTick, 2000, 'note should be clipped to the end of the slice (4000-2000)');
});

test('sliceMidi excludes notes fully outside the range', () => {
  const midi = buildFixture();
  const sliced = sliceMidi(midi, { trackIndexes: [1], startTick: 2000, endTick: 4000 }, { countIn: false });
  const notes = extractTrackNotes(sliced.tracks[1]);
  assert.equal(notes.find(n => n.note === 71), undefined);
  assert.equal(notes.length, 3);
});

test('sliceMidi re-asserts sustain pedal and program change that were active before the range', () => {
  const midi = buildFixture();
  const sliced = sliceMidi(midi, { trackIndexes: [1], startTick: 2000, endTick: 4000 }, { countIn: false });
  const events = sliced.tracks[1];
  const pedal = events.find(e => e.type === 'controller' && e.controller === 64);
  const program = events.find(e => e.type === 'programChange');
  assert.ok(pedal, 'sustain pedal state should be carried into the slice');
  assert.equal(pedal.value, 127);
  assert.equal(pedal.tick, 0);
  assert.ok(program, 'program change should be carried into the slice');
  assert.equal(program.program, 4);
});

test('sliceMidi preserves tempo and time signature', () => {
  const midi = buildFixture();
  const sliced = sliceMidi(midi, { trackIndexes: [1], startTick: 2000, endTick: 4000 }, { countIn: false });
  const tempo = sliced.tracks[0].find(e => e.metaType === 0x51);
  const sig = sliced.tracks[0].find(e => e.metaType === 0x58);
  assert.equal(tempo.microsecondsPerQuarter, 500000);
  assert.equal(sig.numerator, 4);
  assert.equal(sig.denominator, 4);
});

test('sliceMidi with countIn shifts all content by one measure and adds click notes', () => {
  const midi = buildFixture();
  const sliced = sliceMidi(midi, { trackIndexes: [1], startTick: 2000, endTick: 4000 }, { countIn: true });
  const oneMeasure = TPQ * 4; // 4/4
  const notes = extractTrackNotes(sliced.tracks[1]);
  const carried = notes.find(n => n.note === 60);
  assert.equal(carried.tick, oneMeasure, 'content should start after the count-in measure');

  const clicks = extractTrackNotes(sliced.tracks[0]).filter(n => n.channel === 9);
  assert.equal(clicks.length, 4, 'expected 4 metronome clicks for a 4/4 count-in measure');
  assert.ok(clicks.every(c => c.tick < oneMeasure), 'clicks must all land inside the count-in measure');
});

test('exportLessonBuffer produces a valid, parseable MIDI file', () => {
  const midi = buildFixture();
  const buffer = exportLessonBuffer(midi, { trackIndexes: [1], startTick: 2000, endTick: 4000 });
  assert.equal(buffer.toString('ascii', 0, 4), 'MThd');
  const reparsed = readMidi(buffer);
  assert.equal(reparsed.ticksPerQuarter, TPQ);
  assert.ok(reparsed.tracks.length >= 2);
});

test('event-index based export never splits a chord across the boundary', () => {
  // Real-world integration: slice the right hand of a practice file by
  // event index and verify chord grouping still holds inside the export.
  const file = path.join(__dirname, '..', '..', 'practice_midis', '02_two_hands_easy', '01_twinkle_twinkle_two_hands_easy.mid');
  const midi = readMidi(fs.readFileSync(file));
  const info = analyzeSong(midi);
  const rightTrackIndex = info.tracks.find(t => t.roleGuess === 'right').index;
  const notes = extractTrackNotes(midi.tracks[rightTrackIndex]);
  const events = groupIntoEvents(notes, midi.ticksPerQuarter);

  const startEvent = events[0];
  const endEvent = events[3]; // exclusive boundary: first 3 events
  const buffer = exportLessonBuffer(
    midi,
    { trackIndexes: [rightTrackIndex], startTick: startEvent.tick, endTick: endEvent.tick },
    { countIn: false },
  );
  const reparsed = readMidi(buffer);
  const outNotes = extractTrackNotes(reparsed.tracks[1]);
  const outEvents = groupIntoEvents(outNotes, midi.ticksPerQuarter);
  assert.equal(outEvents.length, 3, 'exported slice should contain exactly the first 3 note events');
  for (let i = 0; i < 3; i++) {
    assert.equal(outEvents[i].notes.length, events[i].notes.length, `event ${i} chord size should be preserved`);
  }
});
