'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createWaitModeSession } = require('../lib/scoring.js');
const store = require('../lib/course-store.js');

const TEST_COURSE_ID = '__test_events_twinkle__';
const SOURCE_MIDI = path.join(__dirname, '..', '..', 'practice_midis', '02_two_hands_easy', '01_twinkle_twinkle_two_hands_easy.mid');

function cleanup() {
  fs.rmSync(path.join(store.COURSES_ROOT, TEST_COURSE_ID), { recursive: true, force: true });
}
test.after(cleanup);

test('getLessonEvents returns hand-tagged notes matching the lesson range (event-based)', () => {
  cleanup();
  store.createCourse({
    courseId: TEST_COURSE_ID,
    title: '事件测试',
    sourceMidiAbsPath: SOURCE_MIDI,
    leftTrackIndex: 2,
    rightTrackIndex: 1,
  });
  // generateDefaultLessons() no longer produces event-range lessons by default
  // (it's all measure-based now, see course-store.js), but range_type:'event'
  // is still a supported lesson shape (e.g. for manually-added lessons), so
  // these fixtures exercise that path directly instead of relying on defaults.
  store.addManualLesson(TEST_COURSE_ID, {
    title: '事件测试：前 4 个事件', hand_mode: 'right', range_type: 'event', start_event: 0, end_event: 4, unlocked: true,
    pass_condition: { consecutive_successes: 3, minimum_accuracy: 0.9, required_runs: 2 },
  });
  store.addManualLesson(TEST_COURSE_ID, {
    title: '事件测试：紧接着的关卡', hand_mode: 'right', range_type: 'event', start_event: 0, end_event: 6, unlocked: false,
  });
  store.addManualLesson(TEST_COURSE_ID, {
    title: '事件测试：双手', hand_mode: 'both', range_type: 'event', start_event: 0, end_event: 4, unlocked: true,
  });
  store.addManualLesson(TEST_COURSE_ID, {
    title: '事件测试：前 8 个事件', hand_mode: 'right', range_type: 'event', start_event: 0, end_event: 8, unlocked: true,
  });

  const course = store.loadCourse(TEST_COURSE_ID);
  const lesson = course.lessons.find(l => l.hand_mode === 'right' && l.range_type === 'event' && l.end_event === 4);
  assert.ok(lesson, 'expected the seeded "右手：前 4 个事件" lesson');

  const events = store.getLessonEvents(TEST_COURSE_ID, lesson.lesson_id);
  assert.equal(events.length, 4);
  for (const e of events) {
    assert.ok(e.notes.length > 0);
    for (const n of e.notes) assert.equal(n.hand, 'right');
  }
});

test('getLessonEvents for a "both" lesson tags notes with their correct hand', () => {
  const course = store.loadCourse(TEST_COURSE_ID);
  const lesson = course.lessons.find(l => l.hand_mode === 'both' && l.range_type === 'event');
  assert.ok(lesson);
  const events = store.getLessonEvents(TEST_COURSE_ID, lesson.lesson_id);
  const hands = new Set(events.flatMap(e => e.notes.map(n => n.hand)));
  assert.ok(hands.has('right') || hands.has('left'));
  for (const e of events) {
    for (const n of e.notes) assert.ok(n.hand === 'left' || n.hand === 'right');
  }
});

test('getLessonEvents for a measure-based lesson only includes events inside that measure range', () => {
  const course = store.loadCourse(TEST_COURSE_ID);
  const lesson = course.lessons.find(l => l.range_type === 'measure' && l.hand_mode === 'right' && l.end_measure === 1);
  assert.ok(lesson, 'expected "右手：第一小节"');
  const events = store.getLessonEvents(TEST_COURSE_ID, lesson.lesson_id);
  assert.ok(events.length > 0);
});

test('getLessonPracticeData returns the full score and marks the active lesson events', () => {
  const course = store.loadCourse(TEST_COURSE_ID);
  const lesson = course.lessons.find(l => l.hand_mode === 'right' && l.range_type === 'event' && l.end_event === 4);
  const data = store.getLessonPracticeData(TEST_COURSE_ID, lesson.lesson_id);

  assert.equal(data.events.length, 4);
  assert.equal(data.sheet.targetEventIndexes.length, 4);
  assert.ok(data.sheet.score.tracks.some(track => track.role === 'right'));
  assert.ok(data.sheet.score.tracks.some(track => track.role === 'left'));
  const markedIndexes = data.sheet.score.tracks.flatMap(track => track.notes.map(note => note.eventIndex)).filter(Number.isInteger);
  assert.ok(markedIndexes.length > 0);
  assert.ok(markedIndexes.every(index => data.sheet.targetEventIndexes.includes(index)));
});

test('playing a lesson perfectly twice records cumulative success before it unlocks the next lesson', () => {
  const course = store.loadCourse(TEST_COURSE_ID);
  const lesson = course.lessons.find(l => l.hand_mode === 'right' && l.range_type === 'event' && l.end_event === 4);
  const events = store.getLessonEvents(TEST_COURSE_ID, lesson.lesson_id);

  const session = createWaitModeSession(events);
  for (const event of events) {
    for (const note of event.notes) session.noteOn(note.note);
    for (const note of event.notes) session.noteOff(note.note);
  }
  const result = session.getResult();
  assert.equal(result.isComplete, true);
  assert.equal(result.score, 100);

  const firstRun = store.recordPracticeResult(TEST_COURSE_ID, lesson.lesson_id, result);
  assert.equal(firstRun.runPassed, true);
  assert.equal(firstRun.completed, false);
  assert.equal(firstRun.successfulRuns, 1);
  assert.equal(firstRun.requiredRuns, 2);
  assert.equal(firstRun.nextLesson, null);
  assert.equal(firstRun.starCount, 3);

  const { lesson: updated, passed, completed, nextLesson, starCount, successfulRuns, requiredRuns } =
    store.recordPracticeResult(TEST_COURSE_ID, lesson.lesson_id, result);
  assert.equal(passed, true);
  assert.equal(completed, true);
  assert.equal(successfulRuns, 2);
  assert.equal(requiredRuns, 2);
  assert.equal(starCount, 3);
  assert.equal(updated.completed, true);
  assert.equal(updated.sessions.length, 2);
  assert.equal(updated.best_score, 100);
  assert.equal(updated.best_star_count, 3);
  assert.equal(updated.sessions[0].starCount, 3);

  const nextLessonIndex = course.lessons.findIndex(l => l.lesson_id === lesson.lesson_id) + 1;
  const reloaded = store.loadCourse(TEST_COURSE_ID);
  if (course.lessons[nextLessonIndex]) {
    assert.equal(reloaded.lessons[nextLessonIndex].unlocked, true, 'next lesson should auto-unlock on pass');
    assert.equal(nextLesson.lesson_id, course.lessons[nextLessonIndex].lesson_id, 'passed session should return the playable next lesson');
  }
});

test('a short two-event lesson caps its combo requirement while still requiring its repeat count', () => {
  const course = store.loadCourse(TEST_COURSE_ID);
  const lesson = course.lessons.find(l => l.hand_mode === 'left' && l.range_type === 'measure' && l.end_measure === 1);
  assert.ok(lesson, 'expected the seeded "左手：第一小节" lesson');
  const events = store.getLessonEvents(TEST_COURSE_ID, lesson.lesson_id);
  assert.equal(events.length, 2, 'fixture must stay a two-event lesson');

  const session = createWaitModeSession(events);
  for (const event of events) {
    for (const note of event.notes) session.noteOn(note.note);
    for (const note of event.notes) session.noteOff(note.note);
  }
  const result = session.getResult();
  assert.equal(result.score, 100);
  assert.equal(result.maxCombo, 2);

  const firstRun = store.recordPracticeResult(TEST_COURSE_ID, lesson.lesson_id, result);
  assert.equal(firstRun.runPassed, true, 'a perfect two-event lesson should not require a third combo');
  assert.equal(firstRun.completed, false);
  assert.equal(firstRun.starCount, 3);

  const secondRun = store.recordPracticeResult(TEST_COURSE_ID, lesson.lesson_id, result);
  assert.equal(secondRun.completed, true);
  assert.equal(secondRun.successfulRuns, 2);
  assert.equal(secondRun.lesson.completed, true);
});

test('a messy run that fails pass_condition records the session but does not mark the lesson complete', () => {
  const course = store.loadCourse(TEST_COURSE_ID);
  const lesson = course.lessons.find(l => l.hand_mode === 'right' && l.range_type === 'event' && l.end_event === 8);
  const events = store.getLessonEvents(TEST_COURSE_ID, lesson.lesson_id);

  const session = createWaitModeSession(events);
  for (const event of events) {
    session.noteOn(999); // always wrong first, breaking every combo
    for (const note of event.notes) session.noteOn(note.note);
    for (const note of event.notes) session.noteOff(note.note);
  }
  const result = session.getResult();
  assert.equal(result.maxCombo, 0);

  const { passed, lesson: updated, starCount } = store.recordPracticeResult(TEST_COURSE_ID, lesson.lesson_id, result);
  assert.equal(passed, false);
  assert.equal(starCount, 0);
  assert.equal(updated.completed, false);
  assert.equal(updated.sessions.length, 1);
});
