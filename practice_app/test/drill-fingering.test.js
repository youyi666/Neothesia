'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const store = require('../lib/course-store.js');

const MIDI_ROOT = path.join(__dirname, '..', '..', 'practice_midis');

test('全部专项训练显式指法都通过人体工学校验', () => {
  const drills = store.loadDrillManifest(MIDI_ROOT);
  assert.equal(drills.length, 16);

  for (const drill of drills) {
    const course = store.loadCourse(drill.id);
    const lesson = course.lessons[0];
    const data = store.getLessonPracticeData(drill.id, lesson.lesson_id, {
      explicitFingering: drill.fingering,
    });
    for (const [hand, diagnostic] of Object.entries(data.fingeringDiagnostics)) {
      assert.equal(
        diagnostic.errors.length,
        0,
        `${drill.id} ${hand} 有硬性指法错误：${JSON.stringify(diagnostic.errors)}`,
      );
      assert.equal(
        diagnostic.warnings.length,
        0,
        `${drill.id} ${hand} 有需要复核的指法：${JSON.stringify(diagnostic.warnings)}`,
      );
    }
    assert.ok(data.events.every(event =>
      event.notes.every(note => note.fingerSource === 'curated')));
  }
});

test('专项训练课程副本与当前生成脚本产物保持一致', () => {
  for (const drill of store.loadDrillManifest(MIDI_ROOT)) {
    const generated = fs.readFileSync(path.join(MIDI_ROOT, drill.midi));
    const course = store.loadCourse(drill.id);
    const courseCopy = fs.readFileSync(
      path.join(store.COURSES_ROOT, drill.id, course.source_midi),
    );
    assert.deepEqual(courseCopy, generated, `${drill.id} 的课程 MIDI 副本已过期`);
  }
});
