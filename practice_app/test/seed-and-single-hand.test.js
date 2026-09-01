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

// GitHub Issue #2 重构：双手曲目不再先把右手/左手各自练到全曲再第一次合双手，
// 改成每 2 小节一组，当场走完"右手 -> 左手 -> 双手"闭环。下面三个用例替换了
// 旧的"倍增关卡"断言（旧版本本身就是这次重构要移除的行为）。

test('two-hand songs form a closed loop per measure group: right -> left -> both, not "all right hand first"', () => {
  const midi = buildLongSongMidi(20);
  const analysis = analyzeSong(midi, { title: 'closed loop song' });
  const lessons = store.generateDefaultLessons(midi, analysis, { left: 1, right: 0 });

  // 第 1-2 小节的双手关必须紧跟在同一组的右手/左手关之后出现，而不是排在
  // "全曲右手都练完"之后 —— 这正是旧算法被投诉的地方。
  const firstBothIndex = lessons.findIndex(l => l.hand_mode === 'both' && l.start_measure === 0 && l.end_measure === 2);
  const lastFullSongRightIndex = lessons.findLastIndex(l =>
    l.hand_mode === 'right' && l.start_measure === 0 && l.end_measure === analysis.measureCount);
  assert.ok(firstBothIndex >= 0, 'expected an early both-hands lesson for measures 1-2');
  assert.ok(
    lastFullSongRightIndex === -1 || firstBothIndex < lastFullSongRightIndex,
    '双手第 1-2 小节关必须在"右手弹完全曲"之前就出现，不能等右手全部学完才第一次合双手',
  );

  // 每一组内部顺序：右手 -> 左手 -> 双手（都在同一个小节范围上）。
  const firstGroupRight = lessons.findIndex(l => l.hand_mode === 'right' && l.start_measure === 0 && l.end_measure === 2);
  const firstGroupLeft = lessons.findIndex(l => l.hand_mode === 'left' && l.start_measure === 0 && l.end_measure === 2);
  assert.ok(firstGroupRight >= 0 && firstGroupLeft >= 0 && firstBothIndex >= 0);
  assert.ok(firstGroupRight < firstGroupLeft, '同一组内应先右手后左手');
  assert.ok(firstGroupLeft < firstBothIndex, '同一组内左手应在双手之前');
});

test('connection lessons stitch adjacent measure groups together', () => {
  const midi = buildLongSongMidi(20);
  const analysis = analyzeSong(midi, { title: 'connection song' });
  const lessons = store.generateDefaultLessons(midi, analysis, { left: 1, right: 0 });

  const connections = lessons.filter(l => l.is_connection);
  assert.ok(connections.length > 0, 'adjacent 2-measure groups should generate at least one connection lesson');
  for (const lesson of connections) {
    assert.equal(lesson.hand_mode, 'both');
    assert.ok(lesson.end_measure - lesson.start_measure >= 2, '衔接关必须跨过组边界，不能只有一个小节');
  }
  // 第一组和第二组之间应该有一条衔接关（第2小节末尾接第3小节开头）。
  assert.ok(
    connections.some(l => l.start_measure <= 1 && l.end_measure >= 3),
    'expected a connection lesson spanning the boundary between the first two groups',
  );
});

test('continuous-replay lessons cover from the start of the song and use practice_mode "continuous"', () => {
  const midi = buildLongSongMidi(20);
  const analysis = analyzeSong(midi, { title: 'continuous song' });
  const lessons = store.generateDefaultLessons(midi, analysis, { left: 1, right: 0 });

  const continuousLessons = lessons.filter(l => l.is_continuous);
  assert.ok(continuousLessons.length > 0, 'expected at least one continuous-replay lesson');
  for (const lesson of continuousLessons) {
    assert.equal(lesson.hand_mode, 'both');
    assert.equal(lesson.practice_mode, 'continuous');
    assert.equal(lesson.start_measure, 0, '连续演奏关必须从第一小节开始，不能是片段');
    // 不追求"完全不错"，允许放宽准确率/连击门槛，否则永远通不过。
    assert.ok(lesson.pass_condition.minimum_accuracy < 0.9);
  }
  // 全曲结尾必须有一个连续演奏关，验收标准里"从头连续演奏到当前进度"才有终点。
  assert.ok(
    continuousLessons.some(l => l.end_measure === analysis.measureCount),
    'expected a continuous-replay lesson covering the full song',
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
