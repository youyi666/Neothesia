'use strict';
// Course/lesson generation and JSON-file persistence.
//
// Layout (courses/<course_id>/), matching the structure in the requirements
// doc section 十三, minus the sqlite progress db (round 1 keeps completion
// state directly in course.json - see 十四 note_event_stats/practice_sessions
// are deferred to the real-time scoring phase):
//
//   courses/<course_id>/course.json
//   courses/<course_id>/source/<original file>.mid
//   courses/<course_id>/lessons/<lesson_id>.mid   (generated on demand)

const fs = require('fs');
const path = require('path');
const { readMidi } = require('./midi-file.js');
const { analyzeSong, extractTrackNotes, groupIntoEvents } = require('./analyze.js');
const { exportLessonBuffer } = require('./lesson-export.js');

const APP_ROOT = path.join(__dirname, '..');
const COURSES_ROOT = path.join(APP_ROOT, 'courses');
const SETTINGS_PATH = path.join(APP_ROOT, 'data', 'settings.json');
const DEFAULT_COURSE_ID = 'twinkle_both';

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function courseDir(courseId) {
  return path.join(COURSES_ROOT, courseId);
}

function coursePath(courseId) {
  return path.join(courseDir(courseId), 'course.json');
}

function loadCourse(courseId) {
  const data = fs.readFileSync(coursePath(courseId), 'utf8');
  const course = JSON.parse(data);
  for (const lesson of course.lessons || []) normalizeLessonProgress(lesson);
  return course;
}

function saveCourse(courseId, course) {
  ensureDir(courseDir(courseId));
  fs.writeFileSync(coursePath(courseId), JSON.stringify(course, null, 2), 'utf8');
  return course;
}

function listCourses() {
  if (!fs.existsSync(COURSES_ROOT)) return [];
  const courses = fs
    .readdirSync(COURSES_ROOT, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => e.name)
    .filter(id => fs.existsSync(coursePath(id)))
    .map(id => {
      try {
        return loadCourse(id);
      } catch (error) {
        // A course directory may disappear between existsSync and readFileSync.
        if (error && error.code === 'ENOENT') return null;
        throw error;
      }
    })
    .filter(Boolean);

  // File-system order is not a learning order. Keep the prepared curriculum
  // predictable, with the user's first ready-to-play course at the top.
  return courses.sort((a, b) => {
    const rankA = curriculumRank(a.course_id);
    const rankB = curriculumRank(b.course_id);
    if (rankA !== rankB) return rankA - rankB;
    return String(a.title || a.course_id).localeCompare(String(b.title || b.course_id), 'zh-CN');
  });
}

function readSettings() {
  try {
    const settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
    return settings && typeof settings === 'object' && !Array.isArray(settings) ? settings : {};
  } catch {
    return {};
  }
}

function updateSettings(patch) {
  const settings = { ...readSettings(), ...patch };
  ensureDir(path.dirname(SETTINGS_PATH));
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2), 'utf8');
  return settings;
}

function pad3(n) {
  return String(n).padStart(3, '0');
}

const REQUIRED_RUNS_BY_STAGE = { A: 2, B: 3, C: 4, manual: 3 };

function defaultRequiredRuns(stage) {
  return REQUIRED_RUNS_BY_STAGE[stage] || REQUIRED_RUNS_BY_STAGE.manual;
}

function requiredRunsForLesson(lesson) {
  const configured = Number(lesson?.pass_condition?.required_runs);
  return Number.isInteger(configured) && configured > 0
    ? configured
    : defaultRequiredRuns(lesson?.stage);
}

function successfulRunsForLesson(lesson) {
  const stored = Math.max(0, Number(lesson?.successful_runs) || 0);
  const inferred = (lesson?.sessions || []).filter(session =>
    session.runPassed === true || Number(session.starCount) > 0,
  ).length;
  const successfulRuns = Math.max(stored, inferred);
  return lesson?.completed
    ? Math.max(successfulRuns, requiredRunsForLesson(lesson))
    : successfulRuns;
}

function normalizeLessonProgress(lesson) {
  lesson.required_runs = requiredRunsForLesson(lesson);
  lesson.successful_runs = successfulRunsForLesson(lesson);
  return lesson;
}

// ── Default lesson generation (MVP 功能三: 阶段 A/B/C) ────────────────────
//
// 设计原则：同一 hand_mode 的关卡序列必须单调递增（小节数只增不减），不同 hand_mode
// 之间换手（右手→左手→双手）才允许"从头再来一次"——这是新技能，不是退步。
// 统一用"小节"作单位（不再有"事件数"这种和小节混用、导致进度看起来忽大忽小的单位）。

// 从第 1 小节开始倍增，直到覆盖全曲：1, 2, 4, 8, 16, ... 每一步都比上一步大或持平于全曲。
function progressiveMeasureLessons(handMode, measureCount, speedBase, titlePrefix) {
  const lessons = [];
  let size = 1;
  let step = 0;
  while (true) {
    const clippedEnd = Math.min(size, measureCount);
    const title = clippedEnd === 1 ? `${titlePrefix}第一小节` : `${titlePrefix}前 ${clippedEnd} 小节`;
    lessons.push({
      title,
      hand_mode: handMode,
      range_type: 'measure',
      start_measure: 0,
      end_measure: clippedEnd,
      speed: Math.min(1, Math.round((speedBase + step * 0.05) * 100) / 100),
    });
    if (clippedEnd >= measureCount) break;
    size *= 2;
    step++;
  }
  return lessons;
}

// 阶段 C：不从头开始的选段巩固练习（避免"总是从第一小节开始练，效率较低"），
// 只在曲子够长、能切出一段有意义的、不过小的片段时才生成，片段大小不追求递增，
// 因为这是"巩固某一段"而不是"扩大范围"的延续。
function spotCheckLessons(handMode, measureCount, speed, titlePrefix) {
  if (measureCount <= 4) return [];
  const mid = Math.floor(measureCount / 2);
  const chunk = Math.min(8, Math.max(4, Math.floor(measureCount / 4)));
  const end = Math.min(mid + chunk, measureCount);
  if (end <= mid) return [];
  return [{
    title: `${titlePrefix}第 ${mid + 1} 小节起`,
    hand_mode: handMode,
    range_type: 'measure',
    start_measure: mid,
    end_measure: end,
    speed,
  }];
}

/**
 * @param {object} midi - parsed MIDI (readMidi)
 * @param {object} analysis - analyzeSong(midi) result
 * @param {{left: number|null, right: number}} assignment - leftTrackIndex may
 *   be null for single-hand songs (e.g. 01_single_hand/*), in which case no
 *   left-hand or two-hand lessons are generated; every "both" slot below
 *   degrades to 'right' so the course is still fully playable.
 */
function generateDefaultLessons(midi, analysis, assignment) {
  const { left: leftTrackIndex } = assignment;
  const hasLeft = leftTrackIndex != null && !!midi.tracks[leftTrackIndex];
  const bothMode = hasLeft ? 'both' : 'right';
  const measureCount = analysis.measureCount;

  const raw = [];

  if (hasLeft) {
    // 阶段 A：先右手单独，再左手单独，各自从第一小节起倍增到全曲
    raw.push(...progressiveMeasureLessons('right', measureCount, 0.5, '右手：').map(l => ({ ...l, stage: 'A' })));
    raw.push(...progressiveMeasureLessons('left', measureCount, 0.5, '左手：').map(l => ({ ...l, stage: 'A' })));
    // 阶段 B：双手合练，同样从第一小节起倍增到全曲（换手是新技能，允许从头再来一次；
    // 但双手阶段自身内部只会越练越长，不会中途缩小）
    raw.push(...progressiveMeasureLessons('both', measureCount, 0.55, '双手：').map(l => ({ ...l, stage: 'B' })));
    // 阶段 C：选段巩固练习
    raw.push(...spotCheckLessons('both', measureCount, 0.65, '双手：').map(l => ({ ...l, stage: 'C' })));
  } else {
    // 单手曲目：只有一条连续递增的练习线，不再重复"阶段A/阶段B"两遍相同内容
    raw.push(...progressiveMeasureLessons('right', measureCount, 0.5, '右手：').map(l => ({ ...l, stage: 'A' })));
    raw.push(...spotCheckLessons('right', measureCount, 0.65, '右手：').map(l => ({ ...l, stage: 'C' })));
  }

  const seenGlobal = new Set();
  const deduped = raw.filter(lesson => {
    const key = `${lesson.hand_mode}:${lesson.range_type}:${lesson.start_measure}:${lesson.end_measure}`;
    if (seenGlobal.has(key)) return false;
    seenGlobal.add(key);
    return true;
  });

  return deduped.map((lesson, index) => ({
    lesson_id: `lesson_${pad3(index + 1)}`,
    title: lesson.title,
    stage: lesson.stage,
    hand_mode: lesson.hand_mode,
    range_type: lesson.range_type,
    start_event: lesson.start_event,
    end_event: lesson.end_event,
    start_measure: lesson.start_measure,
    end_measure: lesson.end_measure,
    speed: lesson.speed,
    practice_mode: 'wait',
    pass_condition: {
      consecutive_successes: 3,
      minimum_accuracy: 0.9,
      required_runs: defaultRequiredRuns(lesson.stage),
    },
    required_runs: defaultRequiredRuns(lesson.stage),
    successful_runs: 0,
    best_star_count: 0,
    unlocked: index === 0,
    completed: false,
  }));
}

// ── Course lifecycle ──────────────────────────────────────────────────────

function createCourse({ courseId, title, sourceMidiAbsPath, difficulty = 1, leftTrackIndex, rightTrackIndex, category, drillGroup }) {
  const buffer = fs.readFileSync(sourceMidiAbsPath);
  const midi = readMidi(buffer);
  const analysis = analyzeSong(midi, { title });

  const dir = courseDir(courseId);
  ensureDir(path.join(dir, 'source'));
  ensureDir(path.join(dir, 'lessons'));
  const sourceFileName = path.basename(sourceMidiAbsPath);
  fs.copyFileSync(sourceMidiAbsPath, path.join(dir, 'source', sourceFileName));

  const lessons = generateDefaultLessons(midi, analysis, { left: leftTrackIndex, right: rightTrackIndex });

  const course = {
    course_id: courseId,
    title: title || analysis.title,
    source_midi: `source/${sourceFileName}`,
    difficulty,
    bpm: analysis.bpm,
    time_signature: analysis.timeSignature,
    measure_count: analysis.measureCount,
    hand_tracks: { left: leftTrackIndex ?? null, right: rightTrackIndex },
    target_skills: [],
    category: category || 'song',
    drill_group: drillGroup || null,
    lessons,
    created_at: new Date().toISOString(),
  };
  return saveCourse(courseId, course);
}

// 专项特训（指法/基本功）的 MIDI + 指法元数据，由
// practice_midis/tools/generate_drills.cjs 生成到 practice_midis/06_drills/drills_manifest.json。
function loadDrillManifest(midiRoot) {
  const manifestPath = path.join(midiRoot, '06_drills', 'drills_manifest.json');
  if (!fs.existsSync(manifestPath)) return [];
  try {
    return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    return [];
  }
}

function addManualLesson(courseId, lessonSpec) {
  const course = loadCourse(courseId);
  const index = course.lessons.length;
  const lesson = {
    lesson_id: lessonSpec.lesson_id || `lesson_${pad3(index + 1)}`,
    title: lessonSpec.title || `自定义关卡 ${index + 1}`,
    stage: 'manual',
    hand_mode: lessonSpec.hand_mode || 'both',
    range_type: lessonSpec.range_type || 'measure',
    start_event: lessonSpec.start_event,
    end_event: lessonSpec.end_event,
    start_measure: lessonSpec.start_measure,
    end_measure: lessonSpec.end_measure,
    speed: lessonSpec.speed ?? 0.5,
    practice_mode: lessonSpec.practice_mode || 'wait',
    pass_condition: lessonSpec.pass_condition || {
      consecutive_successes: 3,
      minimum_accuracy: 0.9,
      required_runs: defaultRequiredRuns('manual'),
    },
    required_runs: Number(lessonSpec.pass_condition?.required_runs) || defaultRequiredRuns('manual'),
    successful_runs: 0,
    best_star_count: 0,
    unlocked: lessonSpec.unlocked ?? false,
    completed: false,
  };
  course.lessons.push(lesson);
  saveCourse(courseId, course);
  return lesson;
}

function setLessonCompleted(courseId, lessonId, completed = true) {
  const course = loadCourse(courseId);
  const index = course.lessons.findIndex(l => l.lesson_id === lessonId);
  if (index === -1) throw new Error(`Unknown lesson_id: ${lessonId}`);
  const lesson = normalizeLessonProgress(course.lessons[index]);
  lesson.completed = completed;
  if (completed) lesson.successful_runs = Math.max(lesson.successful_runs, lesson.required_runs);
  if (completed && course.lessons[index + 1]) {
    course.lessons[index + 1].unlocked = true;
  }
  const completedCount = course.lessons.filter(l => l.completed).length;
  course.completion_rate = course.lessons.length ? completedCount / course.lessons.length : 0;
  saveCourse(courseId, course);
  return course.lessons[index];
}

// Saves a real-time scoring result (lib/scoring.js WaitModeSession#getResult())
// against a lesson, and auto-completes it once the lesson's own
// pass_condition is met - matching 需求文档 course.json 的 pass_condition
// schema (consecutive_successes / minimum_accuracy). A short lesson cannot
// possibly meet a combo threshold higher than its own event count.
function requiredComboFor(result, passCondition) {
  const totalEvents = Math.max(0, Number(result.totalEvents) || 0);
  const configuredCombo = Math.max(0, Number(passCondition.consecutive_successes) || 0);
  return totalEvents > 0 ? Math.min(configuredCombo, totalEvents) : configuredCombo;
}

function meetsPassCondition(result, passCondition) {
  const totalEvents = Number(result.totalEvents) || 0;
  const accuracy = Number(result.accuracy) || 0;
  const combo = Number(result.maxCombo) || 0;
  const requiredAccuracy = Number(passCondition.minimum_accuracy) || 0;
  return totalEvents > 0 && accuracy >= requiredAccuracy && combo >= requiredComboFor(result, passCondition);
}

function calculateStarCount(result, passCondition) {
  const accuracy = Number(result.accuracy) || 0;
  const combo = Number(result.maxCombo) || 0;
  const totalEvents = Number(result.totalEvents) || 0;
  const passed = meetsPassCondition(result, passCondition);

  if (!passed) return 0;
  const isPerfect = totalEvents > 0 &&
    Number(result.correctEvents) === totalEvents &&
    Number(result.wrongEvents) === 0 &&
    Number(result.extraNotes) === 0 &&
    combo >= totalEvents;
  if (isPerfect) return 3;
  if (accuracy >= 0.95) return 2;
  return 1;
}

function recordPracticeResult(courseId, lessonId, result) {
  const course = loadCourse(courseId);
  const index = course.lessons.findIndex(l => l.lesson_id === lessonId);
  if (index === -1) throw new Error(`Unknown lesson_id: ${lessonId}`);
  const lesson = normalizeLessonProgress(course.lessons[index]);

  const passCondition = lesson.pass_condition || { consecutive_successes: 3, minimum_accuracy: 0.9 };
  const starCount = calculateStarCount(result, passCondition);
  const runPassed = meetsPassCondition(result, passCondition);
  if (!lesson.sessions) lesson.sessions = [];
  lesson.sessions.push({
    score: result.score,
    accuracy: result.accuracy,
    correctEvents: result.correctEvents,
    wrongEvents: result.wrongEvents,
    extraNotes: result.extraNotes,
    missedNotes: result.missedNotes,
    maxCombo: result.maxCombo,
    durationMs: result.durationMs,
    hands: result.hands,
    starCount,
    runPassed,
    recordedAt: new Date().toISOString(),
  });
  if (lesson.sessions.length > 20) lesson.sessions = lesson.sessions.slice(-20);
  lesson.best_score = Math.max(lesson.best_score || 0, result.score || 0);
  lesson.best_star_count = Math.max(lesson.best_star_count || 0, starCount);

  if (runPassed) lesson.successful_runs++;
  lesson.required_runs = requiredRunsForLesson(lesson);
  const wasCompleted = lesson.completed;
  const completed = lesson.successful_runs >= lesson.required_runs;
  let justUnlocked = null;
  if (completed && !lesson.completed) {
    lesson.completed = true;
    if (course.lessons[index + 1] && !course.lessons[index + 1].unlocked) {
      course.lessons[index + 1].unlocked = true;
      justUnlocked = course.lessons[index + 1].lesson_id;
    }
  }
  const nextLesson = runPassed && completed && course.lessons[index + 1]?.unlocked
    ? course.lessons[index + 1]
    : null;
  course.completion_rate = course.lessons.length ? course.lessons.filter(l => l.completed).length / course.lessons.length : 0;
  saveCourse(courseId, course);
  return {
    lesson,
    runPassed,
    completed,
    passed: completed,
    justCompleted: !wasCompleted && completed,
    justUnlocked,
    nextLesson,
    starCount,
    successfulRuns: lesson.successful_runs,
    requiredRuns: lesson.required_runs,
  };
}

// ── Lesson export bridge ──────────────────────────────────────────────────

function handTaggedNotes(midi, handMode, assignment) {
  const { left: leftTrackIndex, right: rightTrackIndex } = assignment;
  if (handMode !== 'right' && leftTrackIndex == null) {
    throw new Error('This lesson needs a left-hand track, but the course has none assigned');
  }
  const tag = (notes, hand) => notes.map(n => ({ ...n, hand }));
  if (handMode === 'left') return tag(extractTrackNotes(midi.tracks[leftTrackIndex]), 'left');
  if (handMode === 'right') return tag(extractTrackNotes(midi.tracks[rightTrackIndex]), 'right');
  return [
    ...tag(extractTrackNotes(midi.tracks[rightTrackIndex]), 'right'),
    ...tag(extractTrackNotes(midi.tracks[leftTrackIndex]), 'left'),
  ];
}

function resolveLessonRange(midi, lesson, assignment) {
  const tpq = midi.ticksPerQuarter;
  const { left: leftTrackIndex, right: rightTrackIndex } = assignment;
  if (lesson.hand_mode !== 'right' && leftTrackIndex == null) {
    throw new Error(`Lesson "${lesson.lesson_id}" needs a left-hand track, but this course has none assigned`);
  }
  const trackIndexes =
    lesson.hand_mode === 'left' ? [leftTrackIndex] : lesson.hand_mode === 'right' ? [rightTrackIndex] : [rightTrackIndex, leftTrackIndex];

  if (lesson.range_type === 'event') {
    const notes = handTaggedNotes(midi, lesson.hand_mode, assignment);
    const events = groupIntoEvents(notes, tpq);
    if (!events.length) throw new Error('No note events found for this hand/track selection');
    const startEvent = Math.max(0, lesson.start_event ?? 0);
    const endEvent = Math.min(events.length, lesson.end_event ?? events.length);
    const startTick = events[startEvent].tick;
    const endTick = endEvent >= events.length ? events[events.length - 1].endTick : events[endEvent].tick;
    return { trackIndexes, startTick, endTick };
  }

  // measure-based
  const analysis = analyzeSong(midi);
  const measures = analysis.measures;
  const startMeasure = Math.max(0, lesson.start_measure ?? 0);
  const endMeasure = Math.min(measures.length, lesson.end_measure ?? measures.length);
  if (!measures.length || startMeasure >= measures.length) throw new Error('Measure range out of bounds');
  const startTick = measures[startMeasure].startTick;
  const endTick = endMeasure > 0 ? measures[endMeasure - 1].endTick : measures[0].endTick;
  return { trackIndexes, startTick, endTick };
}

function getLessonEventSelection(courseId, lessonId) {
  const course = loadCourse(courseId);
  const lesson = course.lessons.find(l => l.lesson_id === lessonId);
  if (!lesson) throw new Error(`Unknown lesson_id: ${lessonId}`);

  const sourcePath = path.join(courseDir(courseId), course.source_midi);
  const midi = readMidi(fs.readFileSync(sourcePath));
  const notes = handTaggedNotes(midi, lesson.hand_mode, course.hand_tracks);
  const allEvents = groupIntoEvents(notes, midi.ticksPerQuarter);

  let slice;
  if (lesson.range_type === 'event') {
    const startEvent = Math.max(0, lesson.start_event ?? 0);
    const endEvent = Math.min(allEvents.length, lesson.end_event ?? allEvents.length);
    slice = allEvents.slice(startEvent, endEvent);
  } else {
    const analysis = analyzeSong(midi);
    const measures = analysis.measures;
    const startMeasure = Math.max(0, lesson.start_measure ?? 0);
    const endMeasure = Math.min(measures.length, lesson.end_measure ?? measures.length);
    if (!measures.length || startMeasure >= measures.length) throw new Error('Measure range out of bounds');
    const startTick = measures[startMeasure].startTick;
    const endTick = endMeasure > 0 ? measures[endMeasure - 1].endTick : measures[0].endTick;
    slice = allEvents.filter(e => e.tick >= startTick && e.tick < endTick);
  }

  if (!slice.length) throw new Error('This lesson has no note events in range');
  return { course, lesson, midi, allEvents, slice };
}

function serializeLessonEvents(events) {
  return events.map((event, index) => ({
    index,
    tick: event.tick,
    notes: event.notes.map(n => ({ note: n.note, hand: n.hand, velocity: n.velocity })),
  }));
}

// Returns the lesson's target note events (each with hand-tagged pitches),
// for the browser-side real-time scoring session - see lib/scoring.js. This
// intentionally mirrors resolveLessonRange's boundaries but returns the
// actual notes to press rather than a tick range to export.
function getLessonEvents(courseId, lessonId) {
  const { slice } = getLessonEventSelection(courseId, lessonId);
  return serializeLessonEvents(slice);
}

function noteIdentity(note, hand) {
  return `${hand}:${note.channel}:${note.tick}:${note.note}`;
}

// The practice page needs the entire course score as well as the playable
// event slice. Notes from the active lesson carry their global event index;
// every other score note is intentionally left unmarked for grey rendering.
function getLessonPracticeData(courseId, lessonId) {
  const { course, lesson, midi, allEvents, slice } = getLessonEventSelection(courseId, lessonId);
  const targetEventByNote = new Map();
  for (const event of slice) {
    for (const note of event.notes) targetEventByNote.set(noteIdentity(note, note.hand), event.index);
  }

  const makeTrack = (trackIndex, hand) => {
    if (trackIndex == null || !midi.tracks[trackIndex]) return null;
    return {
      role: hand,
      notes: extractTrackNotes(midi.tracks[trackIndex]).map(note => ({
        midi: note.note,
        start: note.tick / midi.ticksPerQuarter,
        duration: Math.max(0.05, (note.endTick - note.tick) / midi.ticksPerQuarter),
        eventIndex: targetEventByNote.get(noteIdentity(note, hand)) ?? null,
      })),
    };
  };

  const analysis = analyzeSong(midi, { title: course.title });
  const tracks = [
    makeTrack(course.hand_tracks.right, 'right'),
    makeTrack(course.hand_tracks.left, 'left'),
  ].filter(Boolean);
  const totalBeats = Math.max(1, analysis.durationTicks / midi.ticksPerQuarter);

  return {
    events: serializeLessonEvents(slice),
    sheet: {
      targetEventIndexes: slice.map(event => event.index),
      score: {
        title: course.title,
        bpm: analysis.bpm,
        numerator: analysis.timeSignature.numerator,
        denominator: analysis.timeSignature.denominator,
        totalBeats,
        tracks,
      },
    },
  };
}

function exportLessonFile(courseId, lessonId, opts = {}) {
  const course = loadCourse(courseId);
  const lesson = course.lessons.find(l => l.lesson_id === lessonId);
  if (!lesson) throw new Error(`Unknown lesson_id: ${lessonId}`);

  const sourcePath = path.join(courseDir(courseId), course.source_midi);
  const midi = readMidi(fs.readFileSync(sourcePath));
  const selection = resolveLessonRange(midi, lesson, course.hand_tracks);
  const buffer = exportLessonBuffer(midi, selection, { countIn: opts.countIn !== false });

  const lessonsDir = path.join(courseDir(courseId), 'lessons');
  ensureDir(lessonsDir);
  const outPath = path.join(lessonsDir, `${lessonId}.mid`);
  fs.writeFileSync(outPath, buffer);
  return outPath;
}

// ── Seed courses (so the course tab isn't empty on first launch) ──────────
//
// Auto-generates a course per curated song in practice_midis/ the first time
// the server starts, so there's something to open without the user ever
// having to import/analyze/assign-tracks themselves. Idempotent: skips any
// course_id whose directory already exists, so it's safe to call on every
// startup and never clobbers progress.

const SEED_SONGS = [
  { id: 'twinkle_solo', title: '小星星（右手）', midi: '01_single_hand/01_twinkle_twinkle_right_hand_slow.mid' },
  { id: 'ode_solo', title: '欢乐颂（右手）', midi: '01_single_hand/02_ode_to_joy_right_hand_slow.mid' },
  { id: 'mary_solo', title: '玛丽有只小羊羔', midi: '01_single_hand/03_mary_had_a_little_lamb_right_hand_slow.mid' },
  { id: 'frere_solo', title: '两只老虎', midi: '01_single_hand/04_frere_jacques_right_hand_slow.mid' },
  { id: 'auclair_solo', title: 'Au Clair de la Lune', midi: '01_single_hand/05_au_clair_de_la_lune_right_hand_slow.mid' },

  { id: 'twinkle_both', title: '小星星（双手）', midi: '02_two_hands_easy/01_twinkle_twinkle_two_hands_easy.mid' },
  { id: 'ode_both', title: '欢乐颂（双手）', midi: '02_two_hands_easy/02_ode_to_joy_two_hands_easy.mid' },
  { id: 'amazing_grace', title: '奇异恩典', midi: '02_two_hands_easy/03_amazing_grace_two_hands_easy.mid' },
  { id: 'canon_easy', title: '卡农片段', midi: '02_two_hands_easy/04_pachelbel_canon_easy_loop.mid' },

  { id: 'greensleeves', title: '绿袖子', midi: '03_beautiful_slow/01_greensleeves_melody_slow.mid' },
  { id: 'gymnopedie', title: 'Gymnopedie No.1', midi: '03_beautiful_slow/02_satie_gymnopedie_theme_easy.mid' },
  { id: 'scarborough', title: '斯卡布罗集市', midi: '03_beautiful_slow/03_scarborough_fair_melody_slow.mid' },
  { id: 'schumann', title: '舒曼小旋律', midi: '03_beautiful_slow/04_schumann_melodie_theme_easy.mid' },

  { id: 'minuet_g', title: 'G大调小步舞曲', midi: '04_challenge/01_bach_minuet_g_opening_easy.mid' },
  { id: 'canon_slow', title: '卡农（双手慢速）', midi: '04_challenge/02_canon_in_d_slow_two_hands.mid' },

  // 用户实际在练的曲子：从原速全曲自动切出渐进关卡（阶段C会随小节数自动扩展）。
  { id: 'qinghuaci', title: '青花瓷', midi: '05_qinghuaci/04_原速_107bpm.mid' },
];

function curriculumRank(courseId) {
  if (courseId === DEFAULT_COURSE_ID) return -1;
  const index = SEED_SONGS.findIndex(song => song.id === courseId);
  return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}

function pickHandTracks(analysis) {
  const playable = analysis.tracks.filter(t => t.noteCount > 0);
  const right = playable.find(t => t.roleGuess === 'right') || playable[0] || null;
  const left = playable.find(t => t.roleGuess === 'left' && t !== right) || null;
  return { right: right ? right.index : null, left: left ? left.index : null };
}

function seedDefaultCourses(midiRoot) {
  const results = [];
  for (const song of SEED_SONGS) {
    if (fs.existsSync(coursePath(song.id))) {
      results.push({ id: song.id, status: 'exists' });
      continue;
    }
    const absPath = path.join(midiRoot, song.midi);
    if (!fs.existsSync(absPath)) {
      results.push({ id: song.id, status: 'missing_source', path: absPath });
      continue;
    }
    try {
      const midi = readMidi(fs.readFileSync(absPath));
      const analysis = analyzeSong(midi, { title: song.title });
      const { left, right } = pickHandTracks(analysis);
      if (right == null) {
        results.push({ id: song.id, status: 'no_playable_track' });
        continue;
      }
      createCourse({
        courseId: song.id,
        title: song.title,
        sourceMidiAbsPath: absPath,
        leftTrackIndex: left,
        rightTrackIndex: right,
      });
      results.push({ id: song.id, status: 'created' });
    } catch (e) {
      results.push({ id: song.id, status: 'error', error: e.message });
    }
  }

  for (const drill of loadDrillManifest(midiRoot)) {
    if (fs.existsSync(coursePath(drill.id))) {
      results.push({ id: drill.id, status: 'exists' });
      continue;
    }
    const absPath = path.join(midiRoot, drill.midi);
    if (!fs.existsSync(absPath)) {
      results.push({ id: drill.id, status: 'missing_source', path: absPath });
      continue;
    }
    try {
      const midi = readMidi(fs.readFileSync(absPath));
      const analysis = analyzeSong(midi, { title: drill.title });
      const { left, right } = pickHandTracks(analysis);
      if (right == null) {
        results.push({ id: drill.id, status: 'no_playable_track' });
        continue;
      }
      createCourse({
        courseId: drill.id,
        title: drill.title,
        sourceMidiAbsPath: absPath,
        leftTrackIndex: left,
        rightTrackIndex: right,
        category: drill.category,
        drillGroup: drill.drillGroup,
      });
      results.push({ id: drill.id, status: 'created' });
    } catch (e) {
      results.push({ id: drill.id, status: 'error', error: e.message });
    }
  }

  return results;
}

module.exports = {
  COURSES_ROOT,
  listCourses,
  loadCourse,
  saveCourse,
  createCourse,
  addManualLesson,
  setLessonCompleted,
  recordPracticeResult,
  generateDefaultLessons,
  resolveLessonRange,
  getLessonEvents,
  getLessonPracticeData,
  exportLessonFile,
  readSettings,
  updateSettings,
  seedDefaultCourses,
  loadDrillManifest,
  SEED_SONGS,
  DEFAULT_COURSE_ID,
  calculateStarCount,
  requiredComboFor,
  meetsPassCondition,
  requiredRunsForLesson,
  successfulRunsForLesson,
};
