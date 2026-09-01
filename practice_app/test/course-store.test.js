'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { readMidi } = require('../lib/midi-file.js');

const store = require('../lib/course-store.js');

const TEST_COURSE_ID = '__test_twinkle__';
const SOURCE_MIDI = path.join(__dirname, '..', '..', 'practice_midis', '02_two_hands_easy', '01_twinkle_twinkle_two_hands_easy.mid');

function cleanup() {
  const dir = path.join(store.COURSES_ROOT, TEST_COURSE_ID);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(path.join(__dirname, '..', 'data', 'user_progress', '__test_unlock_user__'), { recursive: true, force: true });
}

test.after(cleanup);

test('createCourse analyzes the MIDI and generates a default lesson plan', () => {
  cleanup();
  // right hand track index 1, left hand track index 2 (see analyze.test.js fixture)
  const course = store.createCourse({
    courseId: TEST_COURSE_ID,
    title: '小星星测试课程',
    sourceMidiAbsPath: SOURCE_MIDI,
    leftTrackIndex: 2,
    rightTrackIndex: 1,
  });

  assert.equal(course.course_id, TEST_COURSE_ID);
  assert.ok(course.lessons.length > 0, 'should generate at least one default lesson');
  assert.ok(fs.existsSync(path.join(store.COURSES_ROOT, TEST_COURSE_ID, 'source', '01_twinkle_twinkle_two_hands_easy.mid')));

  const stages = new Set(course.lessons.map(l => l.stage));
  assert.ok(stages.has('A') && stages.has('B') && stages.has('C'), 'should cover all three default stages');

  assert.equal(course.lessons[0].unlocked, true, 'first lesson should start unlocked');
  assert.ok(course.lessons.slice(1).every(l => l.unlocked === false), 'later lessons should start locked');
  assert.ok(course.lessons.every(l => l.best_star_count === 0), 'new lessons should start without stars');

  // 同一个小节范围现在可能既是"双手合练"关又是"连续演奏"关（Issue #2 的连续
  // 演奏关卡就是刻意叠加在已练范围上的，不是新的音符范围），所以唯一性要按
  // "范围 + 练习目的"判断，而不是只看范围。
  const seen = new Set();
  for (const lesson of course.lessons) {
    const kind = lesson.is_continuous ? 'continuous' : lesson.is_connection ? 'connection' : 'plain';
    const key = `${lesson.hand_mode}:${lesson.range_type}:${lesson.start_event ?? lesson.start_measure}:${lesson.end_event ?? lesson.end_measure}:${kind}`;
    assert.ok(!seen.has(key), `duplicate lesson range generated: ${key}`);
    seen.add(key);
  }
});

test('listCourses / loadCourse round-trip what createCourse wrote', () => {
  const all = store.listCourses();
  assert.ok(all.some(c => c.course_id === TEST_COURSE_ID));
  assert.equal(all[0].course_id, store.DEFAULT_COURSE_ID, 'the prepared first course should stay at the top');
  const loaded = store.loadCourse(TEST_COURSE_ID);
  assert.equal(loaded.title, '小星星测试课程');
});

test('setLessonCompleted marks a lesson done and unlocks the next one', () => {
  const before = store.loadCourse(TEST_COURSE_ID);
  const firstId = before.lessons[0].lesson_id;
  const secondId = before.lessons[1].lesson_id;
  assert.equal(before.lessons[1].unlocked, false);

  store.setLessonCompleted(TEST_COURSE_ID, firstId, true);

  const after = store.loadCourse(TEST_COURSE_ID);
  assert.equal(after.lessons.find(l => l.lesson_id === firstId).completed, true);
  assert.equal(after.lessons.find(l => l.lesson_id === secondId).unlocked, true);
  assert.ok(after.completion_rate > 0);
});

test('loadCourse repairs unlock chain after new lessons are inserted behind completed progress', () => {
  const user = '__test_unlock_user__';
  const course = store.loadCourse(TEST_COURSE_ID);
  const firstId = course.lessons[0].lesson_id;
  store.setLessonCompleted(TEST_COURSE_ID, firstId, true, user);

  const coursePath = path.join(store.COURSES_ROOT, TEST_COURSE_ID, 'course.json');
  const diskCourse = JSON.parse(fs.readFileSync(coursePath, 'utf8'));
  const insertedLesson = {
    ...diskCourse.lessons[1],
    lesson_id: 'lesson_inserted_after_completed',
    title: 'Inserted phrase after completed lesson',
    unlocked: false,
    completed: false,
    successful_runs: 0,
    sessions: [],
  };
  diskCourse.lessons.splice(1, 0, insertedLesson);
  fs.writeFileSync(coursePath, JSON.stringify(diskCourse, null, 2), 'utf8');

  const repaired = store.loadCourse(TEST_COURSE_ID, user);
  assert.equal(repaired.lessons[0].completed, true);
  assert.equal(
    repaired.lessons.find(l => l.lesson_id === insertedLesson.lesson_id).unlocked,
    true,
    'a newly inserted lesson after a completed lesson should not stay locked',
  );
});

test('addManualLesson appends a user-defined lesson (MVP 功能四)', () => {
  const lesson = store.addManualLesson(TEST_COURSE_ID, {
    title: '手动关卡：第2到第3小节',
    hand_mode: 'both',
    range_type: 'measure',
    start_measure: 1,
    end_measure: 3,
    speed: 0.4,
  });
  assert.equal(lesson.stage, 'manual');
  const course = store.loadCourse(TEST_COURSE_ID);
  assert.ok(course.lessons.some(l => l.lesson_id === lesson.lesson_id));
});

test('exportLessonFile writes a standalone, parseable MIDI with a count-in', () => {
  const course = store.loadCourse(TEST_COURSE_ID);
  const lesson = course.lessons.find(l => l.range_type === 'event') || course.lessons[0];
  const outPath = store.exportLessonFile(TEST_COURSE_ID, lesson.lesson_id);
  assert.ok(fs.existsSync(outPath));

  const midi = readMidi(fs.readFileSync(outPath));
  assert.ok(midi.tracks.length >= 2);
  const noteOns = midi.tracks.flat().filter(e => e.type === 'noteOn' && e.channel !== 9);
  assert.ok(noteOns.length > 0);
  assert.ok(noteOns.every(n => n.tick > 0), 'notes should be shifted after the count-in measure');
});

test('exportLessonFile without count-in starts content at tick 0', () => {
  const course = store.loadCourse(TEST_COURSE_ID);
  const lesson = course.lessons[0];
  const outPath = store.exportLessonFile(TEST_COURSE_ID, lesson.lesson_id, { countIn: false });
  const midi = readMidi(fs.readFileSync(outPath));
  const noteOns = midi.tracks.flat().filter(e => e.type === 'noteOn');
  const minTick = Math.min(...noteOns.map(n => n.tick));
  assert.equal(minTick, 0);
});

test('readSettings/updateSettings persist the last opened MIDI and practice resume point', () => {
  const original = store.readSettings();
  try {
    store.updateSettings({
      lastOpenedMidi: SOURCE_MIDI,
      lastCourseId: TEST_COURSE_ID,
      lastLessonId: 'lesson_001',
    });
    const restored = store.readSettings();
    assert.equal(restored.lastOpenedMidi, SOURCE_MIDI);
    assert.equal(restored.lastCourseId, TEST_COURSE_ID);
    assert.equal(restored.lastLessonId, 'lesson_001');
  } finally {
    store.updateSettings({
      lastOpenedMidi: original.lastOpenedMidi ?? null,
      lastCourseId: original.lastCourseId,
      lastLessonId: original.lastLessonId,
    });
  }
});

test('calculateStarCount distinguishes a pass, a stable run, and a perfect run', () => {
  const condition = { consecutive_successes: 3, minimum_accuracy: 0.9 };
  assert.equal(store.calculateStarCount({ accuracy: 0.89, maxCombo: 3, totalEvents: 10 }, condition), 0);
  assert.equal(store.calculateStarCount({ accuracy: 0.9, maxCombo: 3, totalEvents: 10, correctEvents: 9 }, condition), 1);
  assert.equal(store.calculateStarCount({ accuracy: 0.95, maxCombo: 5, totalEvents: 20, correctEvents: 19 }, condition), 2);
  assert.equal(store.calculateStarCount({ accuracy: 1, maxCombo: 4, totalEvents: 4, correctEvents: 4, wrongEvents: 0, extraNotes: 0 }, condition), 3);
});
