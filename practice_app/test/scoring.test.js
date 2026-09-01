'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createWaitModeSession, createContinuousModeSession } = require('../lib/scoring.js');

function ev(index, notes) {
  return { index, notes: notes.map(([note, hand]) => ({ note, hand })) };
}

// 480 ticks/quarter, 120bpm => 500ms/quarter => 1 tick = 1.041666...ms
function tickEv(index, tick, notes) {
  return { index, tick, notes: notes.map(([note, hand]) => ({ note, hand })) };
}

test('a clean run through single-note events scores 100 with full combo', () => {
  const events = [ev(0, [[60, 'right']]), ev(1, [[62, 'right']]), ev(2, [[64, 'right']])];
  const s = createWaitModeSession(events);
  s.noteOn(60); s.noteOff(60);
  s.noteOn(62); s.noteOff(62);
  s.noteOn(64); s.noteOff(64);
  const r = s.getResult();
  assert.equal(r.isComplete, true);
  assert.equal(r.correctEvents, 3);
  assert.equal(r.wrongEvents, 0);
  assert.equal(r.maxCombo, 3);
  assert.equal(r.score, 100);
});

test('a wrong note before the correct one still advances but breaks the combo and counts as an extra note', () => {
  const events = [ev(0, [[60, 'right']]), ev(1, [[62, 'right']])];
  const s = createWaitModeSession(events);
  s.noteOn(61); s.noteOff(61); // wrong
  s.noteOn(60); s.noteOff(60); // then correct - advances
  s.noteOn(62); s.noteOff(62); // clean
  const r = s.getResult();
  assert.equal(r.correctEvents, 1);
  assert.equal(r.wrongEvents, 1);
  assert.equal(r.extraNotes, 1);
  assert.equal(r.maxCombo, 1, 'combo should have reset after the messy first event');
  assert.deepEqual(r.mistakeEventIndexes, [0]);
});

test('a chord only advances once every note is held down simultaneously', () => {
  const events = [ev(0, [[60, 'right'], [64, 'right'], [67, 'right']])];
  const s = createWaitModeSession(events);
  s.noteOn(60);
  s.noteOn(64);
  assert.equal(s.isComplete, false, 'should not advance with only 2 of 3 chord notes held');
  s.noteOff(60); // released before completing the chord - must be re-pressed
  s.noteOn(67);
  assert.equal(s.isComplete, false, 'note 60 was released, chord is incomplete again');
  s.noteOn(60);
  assert.equal(s.isComplete, true, 'all three notes now held together');
  assert.equal(s.getResult().correctEvents, 1);
});

test('wrong notes are attributed to the nearest hand by pitch', () => {
  const events = [ev(0, [[40, 'left'], [72, 'right']])];
  const s = createWaitModeSession(events);
  s.noteOn(41); // close to the left note (40) -> attributed to left
  s.noteOn(40);
  s.noteOn(72);
  const r = s.getResult();
  assert.equal(r.hands.left.wrong, 1);
  assert.equal(r.hands.right.wrong, 0);
  assert.equal(r.hands.left.correct, 1);
  assert.equal(r.hands.right.correct, 1);
});

test('getResult mid-session reflects partial progress and isComplete=false', () => {
  const events = [ev(0, [[60, 'right']]), ev(1, [[62, 'right']])];
  const s = createWaitModeSession(events);
  s.noteOn(60); s.noteOff(60);
  const r = s.getResult();
  assert.equal(r.isComplete, false);
  assert.equal(r.correctEvents, 1);
  assert.equal(r.totalEvents, 2);
});

test('noteOff on a pitch that was never held is a harmless no-op', () => {
  const events = [ev(0, [[60, 'right']])];
  const s = createWaitModeSession(events);
  assert.doesNotThrow(() => s.noteOff(99));
  s.noteOn(60);
  assert.equal(s.isComplete, true);
});

test('extra input after the session is already complete is ignored', () => {
  const events = [ev(0, [[60, 'right']])];
  const s = createWaitModeSession(events);
  s.noteOn(60);
  assert.equal(s.isComplete, true);
  const before = s.getResult();
  s.noteOn(61); // should be a no-op, not retroactively count as a mistake
  const after = s.getResult();
  assert.deepEqual(before, after);
});

// ── 连续演奏模式（Issue #2 "从头弹到当前进度"任务的评分引擎）────────────────

test('continuous mode advances on schedule even without a tick() call, when notes land in time', () => {
  const events = [
    tickEv(0, 0, [[60, 'right']]),
    tickEv(1, 480, [[62, 'right']]),
    tickEv(2, 960, [[64, 'right']]),
  ];
  const s = createContinuousModeSession(events, { bpm: 120, ticksPerQuarter: 480, toleranceMs: 200, now: () => 0 });
  s.noteOn(60, 0);
  s.noteOn(62, 500);
  s.noteOn(64, 1000);
  const r = s.getResult();
  assert.equal(r.isComplete, true);
  assert.equal(r.correctEvents, 3);
  assert.equal(r.wrongEvents, 0);
  assert.equal(r.maxCombo, 3);
  assert.equal(r.longestContinuousRun, 3);
  assert.deepEqual(r.breakPoints, []);
});

test('continuous mode never blocks: a missed event is force-advanced by tick() past its deadline', () => {
  const events = [
    tickEv(0, 0, [[60, 'right']]),
    tickEv(1, 480, [[62, 'right']]),
    tickEv(2, 960, [[64, 'right']]),
  ];
  const s = createContinuousModeSession(events, { bpm: 120, ticksPerQuarter: 480, toleranceMs: 200 });
  s.noteOn(60, 0); // event 0 hit
  // user never presses the note for event 1 (deadline 500+200=700ms) - the clock moves on anyway
  s.tick(800);
  assert.equal(s.getEventIndex(), 2, 'should have force-advanced past the missed event, not gotten stuck waiting');
  s.noteOn(64, 900); // catches up on event 2 in time
  const r = s.getResult();
  assert.equal(r.isComplete, true);
  assert.equal(r.correctEvents, 2);
  assert.equal(r.wrongEvents, 1);
  assert.deepEqual(r.breakPoints, [1], 'the missed event should be recorded as a break point');
  assert.equal(r.maxCombo, 1, 'combo resets across a break point, so a single miss cannot inflate the streak');
});

test('continuous mode getResult() shares the same field shape as wait mode (course-store reuses the same pass/star logic)', () => {
  const events = [tickEv(0, 0, [[60, 'right']])];
  const s = createContinuousModeSession(events, { bpm: 120, ticksPerQuarter: 480 });
  s.noteOn(60, 0);
  const r = s.getResult();
  for (const key of ['totalEvents', 'correctEvents', 'wrongEvents', 'extraNotes', 'maxCombo', 'mistakeEventIndexes', 'accuracy', 'score', 'isComplete']) {
    assert.ok(key in r, `missing ${key} on continuous mode result`);
  }
});
