'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createWaitModeSession } = require('../lib/scoring.js');

function ev(index, notes) {
  return { index, notes: notes.map(([note, hand]) => ({ note, hand })) };
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
