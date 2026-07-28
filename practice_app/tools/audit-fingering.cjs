'use strict';

const path = require('path');
const store = require('../lib/course-store.js');

const MIDI_ROOT = path.join(__dirname, '..', '..', 'practice_midis');
const explicitByCourse = new Map(
  store.loadDrillManifest(MIDI_ROOT).map(drill => [drill.id, drill.fingering]),
);

function increment(map, key, amount = 1) {
  map.set(key, (map.get(key) || 0) + amount);
}

function auditCourse(course) {
  const explicitFingering = explicitByCourse.get(course.course_id);
  const fingerByPosition = new Map();
  const inconsistentPositions = new Set();
  const issueCodes = new Map();
  const samples = [];
  let lessonErrors = 0;
  let noteOccurrences = 0;
  let missingFingers = 0;
  let scoreGuideMismatches = 0;
  let validationErrors = 0;
  let validationWarnings = 0;
  let generatedNotes = 0;
  let curatedNotes = 0;
  let firstDiagnostics = null;

  for (const lesson of course.lessons || []) {
    let data;
    try {
      data = store.getLessonPracticeData(course.course_id, lesson.lesson_id, {
        explicitFingering,
      });
    } catch (error) {
      lessonErrors++;
      if (samples.length < 5) {
        samples.push({
          lessonId: lesson.lesson_id,
          lessonTitle: lesson.title,
          error: error.message,
        });
      }
      continue;
    }

    if (!firstDiagnostics) firstDiagnostics = data.fingeringDiagnostics;
    const scoreNotes = data.sheet.score.tracks.flatMap(track =>
      track.notes.map(note => ({ ...note, hand: track.role })));

    for (let localIndex = 0; localIndex < data.events.length; localIndex++) {
      const event = data.events[localIndex];
      const globalEventIndex = data.sheet.targetEventIndexes[localIndex];
      for (const note of event.notes) {
        noteOccurrences++;
        if (!Number.isInteger(note.finger)) missingFingers++;
        if (note.fingerSource === 'curated') curatedNotes++;
        else if (note.fingerSource === 'generated') generatedNotes++;

        const positionKey = `${note.hand}:${event.tick}:${note.note}`;
        if (fingerByPosition.has(positionKey) &&
            fingerByPosition.get(positionKey) !== note.finger) {
          inconsistentPositions.add(positionKey);
        } else {
          fingerByPosition.set(positionKey, note.finger);
        }

        const scoreNote = scoreNotes.find(candidate =>
          candidate.eventIndex === globalEventIndex &&
          candidate.hand === note.hand &&
          candidate.midi === note.note);
        if (!scoreNote || scoreNote.finger !== note.finger) {
          scoreGuideMismatches++;
          if (samples.length < 5) {
            samples.push({
              lessonId: lesson.lesson_id,
              tick: event.tick,
              hand: note.hand,
              pitch: note.note,
              eventFinger: note.finger,
              scoreFinger: scoreNote?.finger ?? null,
            });
          }
        }
      }
    }
  }

  for (const diagnostic of Object.values(firstDiagnostics || {})) {
    validationErrors += diagnostic.errors.length;
    validationWarnings += diagnostic.warnings.length;
    for (const issue of [...diagnostic.errors, ...diagnostic.warnings]) {
      increment(issueCodes, issue.code);
    }
  }

  return {
    courseId: course.course_id,
    title: course.title,
    lessonCount: (course.lessons || []).length,
    lessonErrors,
    noteOccurrences,
    missingFingers,
    scoreGuideMismatches,
    inconsistentPositions: inconsistentPositions.size,
    validationErrors,
    validationWarnings,
    generatedNotes,
    curatedNotes,
    issueCodes: Object.fromEntries([...issueCodes.entries()].sort()),
    samples,
  };
}

const courses = store.listCourses();
const courseResults = courses.map(auditCourse);
const totals = courseResults.reduce((summary, result) => {
  for (const key of [
    'lessonCount',
    'lessonErrors',
    'noteOccurrences',
    'missingFingers',
    'scoreGuideMismatches',
    'inconsistentPositions',
    'validationErrors',
    'validationWarnings',
    'generatedNotes',
    'curatedNotes',
  ]) {
    summary[key] += result[key];
  }
  for (const [code, count] of Object.entries(result.issueCodes)) {
    summary.issueCodes[code] = (summary.issueCodes[code] || 0) + count;
  }
  return summary;
}, {
  courseCount: courses.length,
  lessonCount: 0,
  lessonErrors: 0,
  noteOccurrences: 0,
  missingFingers: 0,
  scoreGuideMismatches: 0,
  inconsistentPositions: 0,
  validationErrors: 0,
  validationWarnings: 0,
  generatedNotes: 0,
  curatedNotes: 0,
  issueCodes: {},
});

const failedCourses = courseResults.filter(result =>
  result.lessonErrors ||
  result.missingFingers ||
  result.scoreGuideMismatches ||
  result.inconsistentPositions ||
  result.validationErrors);

const report = {
  generatedAt: new Date().toISOString(),
  totals,
  failedCourseCount: failedCourses.length,
  failedCourses,
  warningCourses: courseResults
    .filter(result => result.validationWarnings)
    .map(result => ({
      courseId: result.courseId,
      title: result.title,
      validationWarnings: result.validationWarnings,
      issueCodes: result.issueCodes,
    })),
};

if (process.argv.includes('--json')) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  console.log('钢琴指法全曲库审计');
  console.table([totals]);
  if (failedCourses.length) {
    console.log('硬失败课程：');
    console.table(failedCourses.map(result => ({
      courseId: result.courseId,
      lessonErrors: result.lessonErrors,
      missing: result.missingFingers,
      displayMismatch: result.scoreGuideMismatches,
      inconsistent: result.inconsistentPositions,
      validationErrors: result.validationErrors,
    })));
  }
  if (report.warningCourses.length) {
    console.log('需要人工复核的软警告：');
    console.table(report.warningCourses);
  }
}

if (failedCourses.length) process.exitCode = 1;
