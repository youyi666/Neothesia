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
const {
  predictFingeringForEvents,
  applyExplicitFingering,
  validateFingeringForEvents,
} = require('./fingering-engine.js');

const APP_ROOT = path.join(__dirname, '..');
const COURSES_ROOT = path.join(APP_ROOT, 'courses');
const SETTINGS_PATH = path.join(APP_ROOT, 'data', 'settings.json');
const DEFAULT_COURSE_ID = 'twinkle_both';
const USER_PROGRESS_ROOT = path.join(APP_ROOT, 'data', 'user_progress');
const MIGRATION_DONE_PATH = path.join(APP_ROOT, 'data', '.per_user_migrated');

// Maps course_id → user who owns existing legacy progress (everything else → 罗俊生)
const LEGACY_COURSE_OWNER = { qinghuaci: '李俊' };
const LEGACY_DEFAULT_USER = '罗俊生';

function userProgressPath(user, courseId) {
  return path.join(USER_PROGRESS_ROOT, user, `${courseId}.json`);
}

function loadUserProgress(user, courseId) {
  if (!user) return null;
  try {
    const p = userProgressPath(user, courseId);
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {}
  return null; // null = no per-user file yet (new user on this course)
}

function saveUserProgress(user, courseId, progressMap) {
  ensureDir(path.join(USER_PROGRESS_ROOT, user));
  fs.writeFileSync(userProgressPath(user, courseId), JSON.stringify(progressMap, null, 2), 'utf8');
}

// One-time migration: move progress out of course.json into per-user files.
// Runs at module load if not already done.
function migrateToPerUserProgress() {
  if (fs.existsSync(MIGRATION_DONE_PATH)) return;
  if (!fs.existsSync(COURSES_ROOT)) {
    fs.writeFileSync(MIGRATION_DONE_PATH, new Date().toISOString(), 'utf8');
    return;
  }
  const courseIds = fs.readdirSync(COURSES_ROOT, { withFileTypes: true })
    .filter(e => e.isDirectory() && fs.existsSync(path.join(COURSES_ROOT, e.name, 'course.json')))
    .map(e => e.name);

  for (const courseId of courseIds) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(COURSES_ROOT, courseId, 'course.json'), 'utf8'));
      const lessons = data.lessons || [];
      const owner = LEGACY_COURSE_OWNER[courseId] || LEGACY_DEFAULT_USER;
      const progressMap = {};
      let anyProgress = false;
      for (const lesson of lessons) {
        const hasData = lesson.completed || (lesson.successful_runs || 0) > 0 || lesson.unlocked;
        if (hasData) {
          anyProgress = true;
          progressMap[lesson.lesson_id] = {
            successful_runs: lesson.successful_runs || 0,
            completed: lesson.completed || false,
            best_score: lesson.best_score || null,
            best_star_count: lesson.best_star_count || null,
            unlocked: lesson.unlocked || false,
            sessions: (lesson.sessions || []).slice(-20),
          };
        }
      }
      if (anyProgress) saveUserProgress(owner, courseId, progressMap);
      // Reset course.json: only first lesson stays unlocked, no progress data
      for (let i = 0; i < lessons.length; i++) {
        lessons[i].successful_runs = 0;
        lessons[i].completed = false;
        lessons[i].best_score = null;
        lessons[i].best_star_count = null;
        lessons[i].sessions = [];
        lessons[i].unlocked = (i === 0);
      }
      data.completion_rate = 0;
      fs.writeFileSync(path.join(COURSES_ROOT, courseId, 'course.json'), JSON.stringify(data, null, 2), 'utf8');
    } catch (e) {
      console.error('[Migration] Error on', courseId, e.message);
    }
  }
  fs.writeFileSync(MIGRATION_DONE_PATH, new Date().toISOString(), 'utf8');
  console.log('[Migration] Per-user progress extracted to', USER_PROGRESS_ROOT);
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function courseDir(courseId) {
  return path.join(COURSES_ROOT, courseId);
}

function coursePath(courseId) {
  return path.join(courseDir(courseId), 'course.json');
}

function loadCourse(courseId, user = null) {
  const data = fs.readFileSync(coursePath(courseId), 'utf8');
  const course = JSON.parse(data);
  if (user) {
    const up = loadUserProgress(user, courseId); // { lessonId: {...} } or null
    course.lessons = (course.lessons || []).map(lesson => {
      const p = up ? (up[lesson.lesson_id] || null) : null;
      return normalizeLessonProgress({
        ...lesson,
        successful_runs: p ? (p.successful_runs ?? 0) : 0,
        completed:        p ? (p.completed ?? false) : false,
        best_score:       p ? (p.best_score ?? null) : null,
        best_star_count:  p ? (p.best_star_count ?? null) : null,
        unlocked:         p ? (p.unlocked ?? lesson.unlocked) : lesson.unlocked,
        sessions:         p ? (p.sessions || []) : [],
      });
    });
    normalizeCourseUnlocks(course);
  } else {
    normalizeCourseUnlocks(course);
  }
  return course;
}

function saveCourse(courseId, course) {
  ensureDir(courseDir(courseId));
  fs.writeFileSync(coursePath(courseId), JSON.stringify(course, null, 2), 'utf8');
  return course;
}

function listCourses(user = null) {
  if (!fs.existsSync(COURSES_ROOT)) return [];
  const courses = fs
    .readdirSync(COURSES_ROOT, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => e.name)
    .filter(id => fs.existsSync(coursePath(id)))
    .map(id => {
      try {
        return loadCourse(id, user);
      } catch (error) {
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
  if (!lesson.completed && lesson.successful_runs >= lesson.required_runs) {
    lesson.completed = true;
  }
  return lesson;
}

function normalizeCourseUnlocks(course) {
  if (!course || !Array.isArray(course.lessons) || !course.lessons.length) return course;
  course.lessons.forEach(normalizeLessonProgress);
  course.lessons[0].unlocked = true;
  for (let i = 0; i < course.lessons.length - 1; i++) {
    if (course.lessons[i].completed) {
      course.lessons[i + 1].unlocked = true;
    }
  }
  course.completion_rate = course.lessons.length
    ? course.lessons.filter(l => l.completed).length / course.lessons.length
    : 0;
  return course;
}

// ── 真实演奏能力摘要（GitHub Issue #2 首页反馈）───────────────────────────
//
// 把"完成了多少关"翻译成用户真正关心的问题："我现在真能连续双手弹到哪、
// 多快、卡在哪"。只读派生数据，不落盘，每次 loadCourse 之后算一遍即可。
function computeMasterySummary(course) {
  const lessons = Array.isArray(course?.lessons) ? course.lessons : [];
  const bothCompleted = lessons.filter(l => l.hand_mode === 'both' && l.completed && !l.is_continuous);
  const continuousCompleted = lessons.filter(l => l.is_continuous && l.completed);

  // "已稳定双手"：从第 0 小节开始、已完成的 both 关卡里能连续覆盖到的最远小节
  // （中间不能有缺口，缺口之后的进度不算"稳定"，只能算"零星练过"）。
  const masteredEndMeasure = furthestContiguousCoverage(bothCompleted);
  // "当前可连续演奏"：同理，用连续演奏关（is_continuous）的完成情况。
  const continuousEndMeasure = furthestContiguousCoverage(continuousCompleted);

  const latestSpeedLesson = [...bothCompleted].sort((a, b) => (b.end_measure ?? 0) - (a.end_measure ?? 0))[0];
  const currentSpeedRatio = latestSpeedLesson ? Number(latestSpeedLesson.speed) || null : null;

  let longestContinuousRun = 0;
  const breakPointCounts = new Map(); // measure range key -> 失败次数，标出最卡的点
  for (const lesson of lessons) {
    if (!lesson.is_continuous) continue;
    for (const session of lesson.sessions || []) {
      if (Number.isFinite(session.maxCombo)) longestContinuousRun = Math.max(longestContinuousRun, session.maxCombo);
    }
  }
  for (const lesson of lessons) {
    if (!lesson.is_continuous || lesson.completed) continue;
    const fails = (lesson.sessions || []).filter(s => s.runPassed === false).length;
    if (fails >= 2) {
      breakPointCounts.set(`${lesson.start_measure}-${lesson.end_measure}`, fails);
    }
  }
  const biggestBreakPoint = [...breakPointCounts.entries()].sort((a, b) => b[1] - a[1])[0] || null;

  const nextUnlocked = lessons.find(l => l.unlocked && !l.completed) || null;

  return {
    masteredRange: masteredEndMeasure > 0 ? { startMeasure: 0, endMeasure: masteredEndMeasure } : null,
    continuousRange: continuousEndMeasure > 0 ? { startMeasure: 0, endMeasure: continuousEndMeasure } : null,
    currentSpeedRatio,
    longestContinuousRun,
    biggestBreakPoint: biggestBreakPoint ? { range: biggestBreakPoint[0], failCount: biggestBreakPoint[1] } : null,
    nextTask: nextUnlocked ? { lessonId: nextUnlocked.lesson_id, title: nextUnlocked.title } : null,
  };
}

// both/continuous 关卡按小节起点排序后，从第 0 小节起找最远的"无缺口"覆盖终点。
function furthestContiguousCoverage(lessons) {
  const ranges = lessons
    .filter(l => l.range_type === 'measure' && (l.start_measure ?? 0) === 0)
    .map(l => Number(l.end_measure) || 0)
    .filter(end => end > 0);
  return ranges.length ? Math.max(...ranges) : 0;
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
    const lessonSpeed = Math.min(1, Math.round((speedBase + step * 0.05) * 100) / 100);
    const title = clippedEnd === 1 ? `${titlePrefix}第一小节` : `${titlePrefix}前 ${clippedEnd} 小节`;
    lessons.push({
      title,
      hand_mode: handMode,
      range_type: 'measure',
      start_measure: 0,
      end_measure: clippedEnd,
      speed: lessonSpeed,
    });
    if (clippedEnd === 8 && measureCount > 8) {
      lessons.push(...focusedEightMeasureLessons(
        handMode,
        measureCount,
        lessonSpeed,
        titlePrefix,
      ));
    }
    if (clippedEnd === 16 && measureCount > 16) {
      lessons.push(...focusedSixteenMeasureLessons(
        handMode,
        measureCount,
        lessonSpeed,
        titlePrefix,
      ));
    }
    if (clippedEnd >= measureCount) break;
    size *= 2;
    step++;
  }
  return lessons;
}

// 阶段 C：不从头开始的选段巩固练习（避免"总是从第一小节开始练，效率较低"），
// 只在曲子够长、能切出一段有意义的、不过小的片段时才生成，片段大小不追求递增，
// 因为这是"巩固某一段"而不是"扩大范围"的延续。
function focusedEightMeasureLessons(handMode, measureCount, speed, titlePrefix) {
  return focusedMeasureWindowLessons(handMode, measureCount, speed, titlePrefix, 8);
}

function focusedSixteenMeasureLessons(handMode, measureCount, speed, titlePrefix) {
  return focusedMeasureWindowLessons(handMode, measureCount, speed, titlePrefix, 16);
}

function focusedMeasureWindowLessons(handMode, measureCount, speed, titlePrefix, windowSize) {
  const minWindowSize = Math.max(4, Math.floor(windowSize / 2));
  const lessons = [];
  const seen = new Set();
  const addWindow = start => {
    const end = Math.min(start + windowSize, measureCount);
    if (end - start < minWindowSize) return;
    const key = `${start}:${end}`;
    if (seen.has(key)) return;
    seen.add(key);
    lessons.push({
      title: `${titlePrefix}第 ${start + 1}-${end} 小节`,
      hand_mode: handMode,
      range_type: 'measure',
      start_measure: start,
      end_measure: end,
      speed,
    });
  };

  for (let start = windowSize; start + windowSize <= measureCount; start += windowSize) addWindow(start);
  if (measureCount > windowSize * 2) addWindow(Math.max(windowSize, measureCount - windowSize));
  return lessons;
}

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

// ── 小节闭环课程（GitHub Issue #2）───────────────────────────────────────
//
// 根问题：旧算法先把右手练到全曲、再把左手练到全曲，最后才进双手，用户在
// "双手协调、片段连接、连续演奏"这些真正困难也真正重要的能力上被系统性地
// 拖后。新算法把曲子切成很多 1～2 小节的小组，每一组当场走完
// "右手 → 左手 → 双手" 的闭环，双手能力从第一组开始就在练，而不是全曲单手
// 都会了才第一次双手合练。
//
// 每处理完一组，还会做两件旧算法完全没有的事：
//   1. 生成"连接关"：专门练上一组结尾接这一组开头的那几个音，解决
//      "每段都会、一连起来就断"的问题；
//   2. 生成"连续演奏关"：从第一小节不停顿地弹到当前已学到的位置，
//      practice_mode 用新的 continuous（见 lib/scoring.js），到点不管弹没弹对
//      都会往下走，不会像 wait 模式一样允许用户停下来想。
//
// 单手曲目（无左手轨道）没有"双手协调"这个根问题，继续用旧的倍增关卡序列。
const MEASURE_GROUP_SIZE = 2;

function measureGroups(measureCount, groupSize = MEASURE_GROUP_SIZE) {
  const groups = [];
  for (let start = 0; start < measureCount; start += groupSize) {
    groups.push({ start, end: Math.min(start + groupSize, measureCount) });
  }
  return groups;
}

function bothHandsSpeedForGroup(groupIndex) {
  return Math.min(0.85, Math.round((0.55 + groupIndex * 0.02) * 100) / 100);
}

// 连续演奏关的检查点用倍增间隔（第1、2、4、8...组之后各插一次），既保证练习
// 早期就有密集的"从头弹一遍"反馈，又不会让很长的曲子（比如103小节的青花瓷）
// 生成几十个几乎重复的连续演奏关。
function isContinuousCheckpoint(groupIndex, groupCount) {
  const oneIndexed = groupIndex + 1;
  if (oneIndexed === groupCount) return true; // 全曲总是有一个连续演奏关
  let checkpoint = 1;
  while (checkpoint < groupCount) {
    if (checkpoint === oneIndexed) return true;
    checkpoint *= 2;
  }
  return false;
}

function measureLoopLessons(measureCount) {
  const groups = measureGroups(measureCount);
  const lessons = [];
  let previousGroup = null;

  groups.forEach((group, groupIndex) => {
    const label = `第 ${group.start + 1}-${group.end} 小节`;
    const speed = bothHandsSpeedForGroup(groupIndex);

    // 1) 右手 → 2) 左手 → 3) 双手：同一小组当场闭环，不再把整首曲子的单手
    // 练完才第一次合双手。
    lessons.push({
      title: `右手：${label}`, hand_mode: 'right', range_type: 'measure',
      start_measure: group.start, end_measure: group.end, speed: 0.5, stage: 'A',
    });
    lessons.push({
      title: `左手：${label}`, hand_mode: 'left', range_type: 'measure',
      start_measure: group.start, end_measure: group.end, speed: 0.5, stage: 'A',
    });
    lessons.push({
      title: `双手：${label}`, hand_mode: 'both', range_type: 'measure',
      start_measure: group.start, end_measure: group.end, speed, stage: 'B',
    });

    // 4) 连接关：只练上一组结尾接这一组开头的那一小段，专门解决"分段会、连起来断"。
    if (previousGroup) {
      const connStart = Math.max(0, previousGroup.end - 1);
      const connEnd = Math.min(measureCount, group.start + 1);
      if (connEnd - connStart >= 2) {
        lessons.push({
          title: `衔接：第 ${connStart + 1}-${connEnd} 小节`, hand_mode: 'both', range_type: 'measure',
          start_measure: connStart, end_measure: connEnd, speed, stage: 'C', is_connection: true,
        });
      }
    }

    // 5) 连续演奏关：从头不停顿弹到当前学到的位置，练"连续演奏 + 错误恢复"。
    if (isContinuousCheckpoint(groupIndex, groups.length)) {
      lessons.push({
        title: `连续演奏：第 1-${group.end} 小节`, hand_mode: 'both', range_type: 'measure',
        start_measure: 0, end_measure: group.end, speed, stage: 'C',
        is_continuous: true, practice_mode: 'continuous',
      });
    }

    previousGroup = group;
  });

  return lessons;
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
  const { left: leftTrackIndex, right: rightTrackIndex } = assignment;
  const hasLeft = leftTrackIndex != null && !!midi.tracks[leftTrackIndex];
  const bothMode = hasLeft ? 'both' : 'right';
  const measureCount = analysis.measureCount;

  const raw = [];

  if (hasLeft) {
    raw.push(...measureLoopLessons(measureCount));
  } else {
    // 单手曲目：没有"双手协调"这个根问题，继续用旧的倍增关卡序列。
    raw.push(...progressiveMeasureLessons('right', measureCount, 0.5, '右手：').map(l => ({ ...l, stage: 'A' })));
    raw.push(...spotCheckLessons('right', measureCount, 0.65, '右手：').map(l => ({ ...l, stage: 'C' })));
  }

  const notesByHand = {
    right: rightTrackIndex == null ? [] : extractTrackNotes(midi.tracks[rightTrackIndex] || []),
    left: leftTrackIndex == null ? [] : extractTrackNotes(midi.tracks[leftTrackIndex] || []),
  };
  const lessonHasNotes = lesson => {
    const startMeasure = Math.max(0, lesson.start_measure ?? 0);
    const endMeasure = Math.min(analysis.measures.length, lesson.end_measure ?? analysis.measures.length);
    if (startMeasure >= endMeasure || !analysis.measures[startMeasure]) return false;
    const startTick = analysis.measures[startMeasure].startTick;
    const endTick = analysis.measures[endMeasure - 1].endTick;
    const hands = lesson.hand_mode === 'both' ? ['right', 'left'] : [lesson.hand_mode];
    return hands.some(hand =>
      notesByHand[hand].some(note => note.tick >= startTick && note.tick < endTick));
  };

  const seenGlobal = new Set();
  const deduped = raw.filter(lesson => {
    if (!lessonHasNotes(lesson)) return false;
    const kind = lesson.is_continuous ? 'continuous' : lesson.is_connection ? 'connection' : 'plain';
    const key = `${lesson.hand_mode}:${lesson.range_type}:${lesson.start_measure}:${lesson.end_measure}:${kind}`;
    if (seenGlobal.has(key)) return false;
    seenGlobal.add(key);
    return true;
  });

  return deduped.map((lesson, index) => {
    const requiredRuns = defaultRequiredRuns(lesson.stage);
    // 连续演奏关不追求"完全不错"，追求"弹到底、错了也能接着弹"：连击门槛按
    // 事件数打七折（短片段至少要求 1），达标线也放宽到 75% 准确率，否则等待
    // 模式那套"3 连击 + 90% 准确率"会让连续演奏关几乎永远通不过。
    const passCondition = lesson.is_continuous
      ? {
        consecutive_successes: 1,
        minimum_accuracy: 0.75,
        required_runs: requiredRuns,
      }
      : {
        consecutive_successes: 3,
        minimum_accuracy: 0.9,
        required_runs: requiredRuns,
      };
    return {
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
      practice_mode: lesson.practice_mode || 'wait',
      practice_phase: lesson.practice_mode === 'continuous' ? 'continuous' : 'wait',
      is_connection: !!lesson.is_connection,
      is_continuous: !!lesson.is_continuous,
      pass_condition: passCondition,
      required_runs: requiredRuns,
      successful_runs: 0,
      best_star_count: 0,
      unlocked: index === 0,
      completed: false,
    };
  });
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

function setLessonCompleted(courseId, lessonId, completed = true, user = null) {
  const course = loadCourse(courseId, user);
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
  if (user) {
    const progressMap = {};
    for (const l of course.lessons) {
      progressMap[l.lesson_id] = {
        successful_runs: l.successful_runs || 0,
        completed: l.completed || false,
        best_score: l.best_score || null,
        best_star_count: l.best_star_count || null,
        unlocked: l.unlocked || false,
        sessions: (l.sessions || []).slice(-20),
      };
    }
    saveUserProgress(user, courseId, progressMap);
  } else {
    saveCourse(courseId, course);
  }
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

function recordPracticeResult(courseId, lessonId, result, user = null) {
  const course = loadCourse(courseId, user);
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
  if (user) {
    const progressMap = {};
    for (const l of course.lessons) {
      progressMap[l.lesson_id] = {
        successful_runs: l.successful_runs || 0,
        completed: l.completed || false,
        best_score: l.best_score || null,
        best_star_count: l.best_star_count || null,
        unlocked: l.unlocked || false,
        sessions: (l.sessions || []).slice(-20),
      };
    }
    saveUserProgress(user, courseId, progressMap);
  } else {
    saveCourse(courseId, course);
  }
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
  if (handMode === 'left' && leftTrackIndex == null) {
    throw new Error('This lesson needs a left-hand track, but the course has none assigned');
  }
  const tag = (notes, hand) => notes.map(n => ({ ...n, hand }));
  if (handMode === 'left') return tag(extractTrackNotes(midi.tracks[leftTrackIndex]), 'left');
  if (handMode === 'right') return tag(extractTrackNotes(midi.tracks[rightTrackIndex]), 'right');
  return [
    ...tag(extractTrackNotes(midi.tracks[rightTrackIndex]), 'right'),
    ...(leftTrackIndex == null ? [] : tag(extractTrackNotes(midi.tracks[leftTrackIndex]), 'left')),
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
  // 全曲事件轴必须与课节的 hand_mode 无关，否则同一音符会因为“单手课/双手课”
  // 的跨轨合并结果不同而得到不同的事件位置和指法。
  const notes = handTaggedNotes(midi, 'both', course.hand_tracks);
  const allEvents = groupIntoEvents(notes, midi.ticksPerQuarter);
  const lessonEvents = allEvents
    .map(event => ({
      ...event,
      notes: lesson.hand_mode === 'both'
        ? event.notes
        : event.notes.filter(note => note.hand === lesson.hand_mode),
    }))
    .filter(event => event.notes.length);

  let slice;
  if (lesson.range_type === 'event') {
    const startEvent = Math.max(0, lesson.start_event ?? 0);
    const endEvent = Math.min(lessonEvents.length, lesson.end_event ?? lessonEvents.length);
    slice = lessonEvents.slice(startEvent, endEvent);
  } else {
    const analysis = analyzeSong(midi);
    const measures = analysis.measures;
    const startMeasure = Math.max(0, lesson.start_measure ?? 0);
    const endMeasure = Math.min(measures.length, lesson.end_measure ?? measures.length);
    if (!measures.length || startMeasure >= measures.length) throw new Error('Measure range out of bounds');
    const startTick = measures[startMeasure].startTick;
    const endTick = endMeasure > 0 ? measures[endMeasure - 1].endTick : measures[0].endTick;
    slice = lessonEvents.filter(e => e.tick >= startTick && e.tick < endTick);
  }

  if (!slice.length) throw new Error('This lesson has no note events in range');
  return { course, lesson, midi, allEvents, slice };
}

function serializeLessonEvents(events) {
  return events.map((event, index) => ({
    index,
    tick: event.tick,
    // finger 字段由 predictFingeringForEvents 在序列化前注入，透传给前端
    notes: event.notes.map(n => ({
      note: n.note,
      hand: n.hand,
      velocity: n.velocity,
      ...(n.finger != null ? { finger: n.finger } : {}),
      ...(n.fingerSource ? { fingerSource: n.fingerSource } : {}),
    })),
  }));
}

// Returns the lesson's target note events (each with hand-tagged pitches),
// for the browser-side real-time scoring session - see lib/scoring.js. This
// intentionally mirrors resolveLessonRange's boundaries but returns the
// actual notes to press rather than a tick range to export.
function getLessonEvents(courseId, lessonId, options = {}) {
  const { midi, allEvents, slice } = getLessonEventSelection(courseId, lessonId);
  applyCourseFingering(allEvents, midi.ticksPerQuarter, options.explicitFingering);
  return serializeLessonEvents(slice);
}

function noteIdentity(note, hand) {
  return `${hand}:${note.channel}:${note.tick}:${note.note}`;
}

// 从混合手的 slice 事件中，提取单手的独立事件序列（每个元素 = 该手某 tick 的所有音符）。
// 音符已按 tick+note 升序排好（analyze.js extractTrackNotes 保证），这里只需按 tick 聚合。
function buildHandEvents(slice, hand) {
  const byTick = new Map();
  for (const event of slice) {
    const notes = event.notes.filter(n => n.hand === hand);
    if (!notes.length) continue;
    if (!byTick.has(event.tick)) {
      byTick.set(event.tick, { tick: event.tick, endTick: event.endTick, notes: [] });
    }
    const handEvent = byTick.get(event.tick);
    handEvent.endTick = Math.max(handEvent.endTick, event.endTick);
    handEvent.notes.push(...notes);
  }
  // 返回按 tick 排序的事件数组（每项 notes 按音高升序，与 extractTrackNotes 保持一致）
  return [...byTick.values()]
    .sort((a, b) => a.tick - b.tick)
    .map(event => ({
      ...event,
      notes: event.notes.sort((a, b) => a.note - b.note),
    }));
}

function applyCourseFingering(allEvents, ticksPerQuarter, explicitFingering = null) {
  const diagnostics = {};
  for (const hand of ['right', 'left']) {
    const handEvents = buildHandEvents(allEvents, hand);
    if (!handEvents.length) continue;
    const explicit = explicitFingering?.[hand];
    if (Array.isArray(explicit)) {
      applyExplicitFingering(handEvents, explicit, 'curated');
    } else {
      predictFingeringForEvents(handEvents, hand, {
        ticksPerQuarter,
        source: 'generated',
      });
    }
    diagnostics[hand] = validateFingeringForEvents(handEvents, hand);
  }
  return diagnostics;
}

// The practice page needs the entire course score as well as the playable
// event slice. Notes from the active lesson carry their global event index;
// every other score note is intentionally left unmarked for grey rendering.
function getLessonPracticeData(courseId, lessonId, options = {}) {
  const { course, lesson, midi, allEvents, slice } = getLessonEventSelection(courseId, lessonId);
  const fingeringDiagnostics = applyCourseFingering(
    allEvents,
    midi.ticksPerQuarter,
    options.explicitFingering,
  );
  const targetEventByNote = new Map();
  const fingeringByNote = new Map();
  for (const event of allEvents) {
    for (const note of event.notes) {
      fingeringByNote.set(noteIdentity(note, note.hand), {
        finger: note.finger,
        source: note.fingerSource,
      });
    }
  }
  for (const event of slice) {
    for (const note of event.notes) targetEventByNote.set(noteIdentity(note, note.hand), event.index);
  }

  const makeTrack = (trackIndex, hand) => {
    if (trackIndex == null || !midi.tracks[trackIndex]) return null;
    return {
      role: hand,
      notes: extractTrackNotes(midi.tracks[trackIndex]).map(note => {
        const fingering = fingeringByNote.get(noteIdentity(note, hand));
        return {
          midi: note.note,
          start: note.tick / midi.ticksPerQuarter,
          duration: Math.max(0.05, (note.endTick - note.tick) / midi.ticksPerQuarter),
          eventIndex: targetEventByNote.get(noteIdentity(note, hand)) ?? null,
          ...(fingering?.finger != null ? { finger: fingering.finger } : {}),
          ...(fingering?.source ? { fingerSource: fingering.source } : {}),
        };
      }),
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
    fingeringDiagnostics,
    // 连续演奏模式（lib/scoring.js createContinuousModeSession）需要按曲速给
    // 每个事件算到期时间，前端拿不到 midi.ticksPerQuarter，所以在这里透传。
    // effectiveBpm 已经乘上课节自己的 speed（慢速练习），不是曲谱原速。
    practiceMode: lesson.practice_mode || 'wait',
    ticksPerQuarter: midi.ticksPerQuarter,
    effectiveBpm: Math.max(1, Math.round(analysis.bpm * (Number(lesson.speed) || 1))),
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

  // Mutopia 公版精选：保留原曲完整结构，适合作为入门后的分段挑战。
  { id: 'bach_prelude_c', title: '巴赫：C大调前奏曲 BWV 846', midi: '07_public_domain_classics/bach_prelude_c_bwv846.mid' },
  { id: 'fur_elise', title: '贝多芬：致爱丽丝', midi: '07_public_domain_classics/beethoven_fur_elise.mid' },
  { id: 'chopin_prelude_28_20', title: '肖邦：前奏曲 Op. 28 No. 20', midi: '07_public_domain_classics/chopin_prelude_op28_no20.mid' },
  { id: 'schubert_ungarische', title: '舒伯特：匈牙利旋律 D.817', midi: '07_public_domain_classics/schubert_ungarische_melodie.mid' },
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

function focusedLessonId(handMode, startMeasure, endMeasure) {
  return `lesson_${handMode}_${pad3(startMeasure + 1)}_${pad3(endMeasure)}`;
}

function handTitlePrefix(handMode) {
  if (handMode === 'left') return '左手：';
  if (handMode === 'both') return '双手：';
  return '右手：';
}

function makeFocusedLesson(handMode, stage, startMeasure, endMeasure, speed) {
  const runs = defaultRequiredRuns(stage);
  return {
    lesson_id: focusedLessonId(handMode, startMeasure, endMeasure),
    title: `${handTitlePrefix(handMode)}第 ${startMeasure + 1}-${endMeasure} 小节`,
    stage,
    hand_mode: handMode,
    range_type: 'measure',
    start_measure: startMeasure,
    end_measure: endMeasure,
    speed,
    practice_mode: 'wait',
    pass_condition: {
      consecutive_successes: 3,
      minimum_accuracy: 0.9,
      required_runs: runs,
    },
    required_runs: runs,
    successful_runs: 0,
    best_star_count: 0,
    unlocked: false,
    completed: false,
  };
}

function backfillFocusedWindowLessons(course) {
  if (!course || course.measure_count <= 8 || !Array.isArray(course.lessons)) return 0;
  let added = 0;
  for (const anchor of [...course.lessons]) {
    if (
      anchor.range_type !== 'measure' ||
      anchor.start_measure !== 0 ||
      ![8, 16].includes(anchor.end_measure) ||
      !['right', 'left', 'both'].includes(anchor.hand_mode)
    ) continue;

    const windows = anchor.end_measure === 8
      ? focusedEightMeasureLessons(
        anchor.hand_mode,
        course.measure_count,
        anchor.speed,
        handTitlePrefix(anchor.hand_mode),
      )
      : focusedSixteenMeasureLessons(
        anchor.hand_mode,
        course.measure_count,
        anchor.speed,
        handTitlePrefix(anchor.hand_mode),
      );
    const existingRanges = new Set(course.lessons.map(lesson =>
      `${lesson.hand_mode}:${lesson.range_type}:${lesson.start_measure}:${lesson.end_measure}`));
    const additions = windows
      .filter(window => !existingRanges.has(`${anchor.hand_mode}:measure:${window.start_measure}:${window.end_measure}`))
      .map(window => makeFocusedLesson(anchor.hand_mode, anchor.stage, window.start_measure, window.end_measure, anchor.speed));
    if (!additions.length) continue;
    const index = course.lessons.indexOf(anchor);
    course.lessons.splice(index + 1, 0, ...additions);
    added += additions.length;
  }
  return added;
}

function seedDefaultCourses(midiRoot) {
  const results = [];
  for (const song of SEED_SONGS) {
    if (fs.existsSync(coursePath(song.id))) {
      try {
        const course = loadCourse(song.id);
        const added = backfillFocusedWindowLessons(course);
        if (added) {
          saveCourse(song.id, course);
          results.push({ id: song.id, status: 'updated', addedLessons: added });
        } else {
          results.push({ id: song.id, status: 'exists' });
        }
      } catch (e) {
        results.push({ id: song.id, status: 'error', error: e.message });
      }
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

// Run migration once at module load so all API calls see per-user progress
migrateToPerUserProgress();

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
  buildHandEvents,
  applyCourseFingering,
  SEED_SONGS,
  DEFAULT_COURSE_ID,
  calculateStarCount,
  requiredComboFor,
  meetsPassCondition,
  requiredRunsForLesson,
  successfulRunsForLesson,
  computeMasterySummary,
};
