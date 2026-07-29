'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { readMidi, writeMidi } = require('../lib/midi-file.js');
const { analyzeSong } = require('../lib/analyze.js');
const store = require('../lib/course-store.js');

const MIDI_ROOT = path.join(__dirname, '..', '..', 'practice_midis');
const SINGLE_HAND_MIDI = path.join(MIDI_ROOT, '01_single_hand', '04_frere_jacques_right_hand_slow.mid');

function buildLongSongMidi(measureCount, leftStartMeasure = 0) {
  const tpq = 480;
  const measureTicks = tpq * 4;
  const rightEvents = [{ tick: 0, type: 'meta', metaType: 0x51, microsecondsPerQuarter: 500000 }, { tick: 0, type: 'meta', metaType: 0x58, numerator: 4, denominator: 4 }];
  const leftEvents = [];
  for (let m = 0; m < measureCount; m++) {
    const t = m * measureTicks;
    rightEvents.push({ tick: t, type: 'noteOn', channel: 0, note: 64, velocity: 90 });
    rightEvents.push({ tick: t + tpq, type: 'noteOff', channel: 0, note: 64, velocity: 0 });
    if (m >= leftStartMeasure) {
      leftEvents.push({ tick: t, type: 'noteOn', channel: 1, note: 48, velocity: 80 });
      leftEvents.push({ tick: t + tpq, type: 'noteOff', channel: 1, note: 48, velocity: 0 });
    }
  }
  return { formatType: 1, ticksPerQuarter: tpq, tracks: [rightEvents, leftEvents] };
}

test('generateDefaultLessons on a single-hand song (no left track) produces no left/both lessons and does not crash', () => {
  const midi = readMidi(fs.readFileSync(SINGLE_HAND_MIDI));
  const analysis = analyzeSong(midi, { title: 'frere' });
  // Only track 1 has notes (see analyze.test.js); no left-hand track exists at all.
  const rightIndex = analysis.tracks.find(t => t.noteCount > 0).index;
  const lessons = store.generateDefaultLessons(midi, analysis, { left: null, right: rightIndex });

  assert.ok(lessons.length > 0);
  assert.ok(lessons.every(l => l.hand_mode !== 'left' && l.hand_mode !== 'both'), 'a single-hand song must not generate left/both lessons');
  // A single-hand song has just one continuous ramp (stage A) plus an optional
  // spot-check (stage C) - no stage B, since there is no "hands together" step
  // and duplicating the same ramp under a second label would be the exact
  // "restart from a smaller range" confusion this design avoids.
  const stages = new Set(lessons.map(l => l.stage));
  assert.ok(stages.has('A'));
  assert.ok(!stages.has('B'), 'a single-hand song has nothing to combine, so no stage B');
});

test('generateDefaultLessons does not create an empty first-measure hand lesson', () => {
  const midi = buildLongSongMidi(8, 1);
  const analysis = analyzeSong(midi, { title: 'delayed left hand' });
  const lessons = store.generateDefaultLessons(midi, analysis, { left: 1, right: 0 });

  assert.ok(
    !lessons.some(lesson =>
      lesson.hand_mode === 'left' &&
      lesson.start_measure === 0 &&
      lesson.end_measure === 1),
    '左手第一小节没有音符时不应生成空课节',
  );
  assert.ok(
    lessons.some(lesson => lesson.hand_mode === 'left' && lesson.end_measure >= 2),
    '左手真正开始出现后仍应生成课节',
  );
});

test('lesson ranges never shrink within the same hand_mode phase (no "8 then back to 2" regressions)', () => {
  const midi = buildLongSongMidi(100);
  const analysis = analyzeSong(midi, { title: 'long song' });
  const lessons = store.generateDefaultLessons(midi, analysis, { left: 1, right: 0 });

  // Within each stage+hand_mode group (a single continuous ramp), the practiced
  // span (end_measure - start_measure) must be non-decreasing from lesson to
  // lesson - that is the property the user complained was violated (jumping
  // from 8 notes down to 2-3 notes with no explanation).
  for (const stage of ['A', 'B']) {
    for (const hand of ['right', 'left', 'both']) {
      const spans = lessons
        .filter(l => l.stage === stage && l.hand_mode === hand)
        .map(l => l.end_measure - l.start_measure);
      for (let i = 1; i < spans.length; i++) {
        assert.ok(spans[i] >= spans[i - 1],
          `${stage}/${hand} span shrank: ${spans[i - 1]} -> ${spans[i]}`);
      }
    }
  }

  // Each phase (right alone, left alone, both together) should still ramp all
  // the way up to the full song, not stall partway.
  for (const hand of ['right', 'left', 'both']) {
    const phaseLessons = lessons.filter(l => l.hand_mode === hand && (l.stage === 'A' || l.stage === 'B'));
    const full = phaseLessons.find(l => l.start_measure === 0 && l.end_measure === analysis.measureCount);
    assert.ok(full, `${hand} phase should end with a full-song lesson`);
  }
});

test('long songs add 16-measure focus windows after the first 16 measures', () => {
  const midi = buildLongSongMidi(105);
  const analysis = analyzeSong(midi, { title: 'long song with tail' });
  const lessons = store.generateDefaultLessons(midi, analysis, { left: 1, right: 0 });
  const right = lessons.filter(l => l.stage === 'A' && l.hand_mode === 'right');
  const ranges = right.map(l => [l.start_measure, l.end_measure]);
  const indexOfRange = (start, end) => ranges.findIndex(([s, e]) => s === start && e === end);

  assert.ok(indexOfRange(16, 32) >= 0, 'right hand should practice measures 17-32 before expanding');
  assert.ok(indexOfRange(32, 48) >= 0, 'right hand should practice measures 33-48 before expanding');
  assert.ok(indexOfRange(89, 105) >= 0, 'right hand should practice the final 16 measures');
  assert.ok(
    indexOfRange(16, 32) < indexOfRange(0, 32),
    'the 17-32 focus window should come before the cumulative 1-32 lesson',
  );
});

test('long songs add 8-measure phrase windows before larger integration lessons', () => {
  const midi = buildLongSongMidi(103);
  const analysis = analyzeSong(midi, { title: 'long song phrase practice' });
  const lessons = store.generateDefaultLessons(midi, analysis, { left: 1, right: 0 });
  const right = lessons.filter(l => l.stage === 'A' && l.hand_mode === 'right');
  const ranges = right.map(l => [l.start_measure, l.end_measure]);
  const indexOfRange = (start, end) => ranges.findIndex(([s, e]) => s === start && e === end);

  assert.ok(indexOfRange(8, 16) >= 0, 'right hand should practice measures 9-16 as a phrase');
  assert.ok(indexOfRange(16, 24) >= 0, 'right hand should practice measures 17-24 as a phrase');
  assert.ok(indexOfRange(95, 103) >= 0, 'right hand should practice the final 8-measure phrase');
  assert.ok(
    indexOfRange(8, 16) < indexOfRange(0, 16),
    'the 9-16 phrase window should come before the cumulative 1-16 lesson',
  );
});

test('seedDefaultCourses creates a course per curated song and is idempotent', () => {
  const firstRun = store.seedDefaultCourses(MIDI_ROOT);
  assert.equal(firstRun.length, store.SEED_SONGS.length + store.loadDrillManifest(MIDI_ROOT).length);
  for (const r of firstRun) {
    assert.notEqual(r.status, 'error', `${r.id} failed: ${r.error}`);
    assert.notEqual(r.status, 'missing_source', `${r.id} source file missing: ${r.path}`);
    assert.notEqual(r.status, 'no_playable_track', `${r.id} has no playable track`);
  }

  const secondRun = store.seedDefaultCourses(MIDI_ROOT);
  assert.ok(secondRun.every(r => r.status === 'exists'), 'second run should not recreate or duplicate anything');

  const all = store.listCourses();
  for (const song of store.SEED_SONGS) {
    assert.ok(all.some(c => c.course_id === song.id), `expected seeded course ${song.id} to be listed`);
  }

  const qinghuaci = store.loadCourse('qinghuaci');
  assert.ok(qinghuaci.lessons.length > 10, 'a 100+ measure song should generate a substantial lesson plan');
  assert.equal(qinghuaci.lessons[0].unlocked, true);
});
