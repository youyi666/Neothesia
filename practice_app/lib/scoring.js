'use strict';
// Real-time practice scoring — 需求文档第七节 "模式一：等待模式".
//
// Wait mode never blocks on timing: the session simply waits until every
// note of the current chord/event is held down together, then advances.
// What it DOES track, per the doc's acceptance criteria, is which notes
// were wrong/extra along the way, how many events were completed "clean"
// (no mistakes) vs. eventually-correct-but-messy, the longest clean streak,
// and a left/right split.
//
// Rhythm-based judging (模式二 宽松节奏 / 模式三 严格演奏, with the 150-300ms
// chord window) is intentionally out of scope for this round - see README.
//
// UMD-ish export: required via Node in tests/server, and served as a plain
// <script> to the browser (see server.cjs GET /lib/scoring.js) so the
// practice-session UI runs the exact same tested logic, not a copy of it.
// Wrapped in an IIFE so the browser <script> tag (non-module) doesn't leak
// its helper functions onto window.
(function (root) {

function expectedPitches(event) {
  return new Set(event.notes.map(n => n.note));
}

function nearestHand(pitch, event) {
  // Attributes a wrong/extra press to whichever hand's notes in this event
  // are pitch-wise closest, so left/right accuracy stays meaningful even
  // though a real piano doesn't report which hand played a note.
  let best = null;
  let bestDist = Infinity;
  for (const note of event.notes) {
    const dist = Math.abs(note.note - pitch);
    if (dist < bestDist) { bestDist = dist; best = note.hand; }
  }
  return best || null;
}

function createWaitModeSession(events, options = {}) {
  if (!events.length) throw new Error('createWaitModeSession requires at least one event');
  const now = options.now || (() => Date.now());

  let eventIndex = 0;
  let held = new Set();
  let mistakeThisEvent = false;
  let startedAt = null;
  let completedAt = null;

  const stats = {
    totalEvents: events.length,
    correctEvents: 0,
    wrongEvents: 0,
    extraNotes: 0,
    missedNotes: 0, // wait mode never times out, so this always stays 0 - see module doc comment
    maxCombo: 0,
    currentCombo: 0,
    mistakeEventIndexes: [],
    hands: {}, // hand -> { correct, wrong }
  };

  function bumpHand(hand, key) {
    if (!hand) return;
    if (!stats.hands[hand]) stats.hands[hand] = { correct: 0, wrong: 0 };
    stats.hands[hand][key]++;
  }

  function currentEvent() {
    return eventIndex < events.length ? events[eventIndex] : null;
  }

  function advance(tsMs) {
    const event = events[eventIndex];
    for (const note of event.notes) bumpHand(note.hand, 'correct');
    if (mistakeThisEvent) {
      stats.wrongEvents++;
      stats.currentCombo = 0;
      stats.mistakeEventIndexes.push(eventIndex);
    } else {
      stats.correctEvents++;
      stats.currentCombo++;
      stats.maxCombo = Math.max(stats.maxCombo, stats.currentCombo);
    }
    eventIndex++;
    held = new Set();
    mistakeThisEvent = false;
    if (eventIndex >= events.length) completedAt = tsMs;
  }

  return {
    noteOn(pitch, tsMs = now()) {
      if (completedAt != null) return;
      if (startedAt == null) startedAt = tsMs;
      const event = currentEvent();
      const expected = expectedPitches(event);
      if (expected.has(pitch)) {
        held.add(pitch);
        if (held.size === expected.size && [...expected].every(p => held.has(p))) {
          advance(tsMs);
        }
      } else {
        stats.extraNotes++;
        mistakeThisEvent = true;
        bumpHand(nearestHand(pitch, event), 'wrong');
      }
    },

    noteOff(pitch) {
      held.delete(pitch);
    },

    get isComplete() {
      return completedAt != null;
    },

    getCurrentEvent: currentEvent,
    getEventIndex: () => eventIndex,

    getResult() {
      const durationMs = startedAt != null ? (completedAt ?? now()) - startedAt : 0;
      const accuracy = stats.totalEvents ? stats.correctEvents / stats.totalEvents : 0;
      const hands = {};
      for (const [hand, h] of Object.entries(stats.hands)) {
        const total = h.correct + h.wrong;
        hands[hand] = { ...h, accuracy: total ? h.correct / total : 1 };
      }
      return {
        totalEvents: stats.totalEvents,
        correctEvents: stats.correctEvents,
        wrongEvents: stats.wrongEvents,
        extraNotes: stats.extraNotes,
        missedNotes: stats.missedNotes,
        maxCombo: stats.maxCombo,
        currentCombo: stats.currentCombo,
        mistakeEventIndexes: stats.mistakeEventIndexes.slice(),
        hands,
        accuracy,
        score: Math.round(accuracy * 100),
        isComplete: completedAt != null,
        durationMs,
      };
    },
  };
}

// 模式二/三的第一步：连续演奏模式 — 需求文档"从头弹到当前进度"任务的评分引擎。
//
// 和等待模式的根本区别：等待模式会一直等到用户按对当前事件才前进，允许用户停下来
// 思考，这不是真实演奏。连续演奏模式按曲速给每个事件一个到期时间（tick() 由调用方
// 按帧/按 timer 驱动传入），到期后不管弹没弹对都会前进到下一个事件——错一个音不会
// 让整段练习卡住，这是 GitHub Issue #2 "错误恢复能力" 的核心诉求。
//
// 复用与等待模式完全相同的 getResult() 字段形状（correctEvents/wrongEvents/maxCombo/
// mistakeEventIndexes...），这样 course-store.js 的 recordPracticeResult /
// meetsPassCondition / calculateStarCount 不需要为连续模式另写一套判分逻辑：
// maxCombo 在这里就是"最长连续演奏事件数"，mistakeEventIndexes 就是"断点"。
function createContinuousModeSession(events, options = {}) {
  if (!events.length) throw new Error('createContinuousModeSession requires at least one event');
  const now = options.now || (() => Date.now());
  const bpm = Math.max(1, Number(options.bpm) || 120);
  const ticksPerQuarter = Math.max(1, Number(options.ticksPerQuarter) || 480);
  const toleranceMs = Math.max(0, Number(options.toleranceMs) || 350);
  const msPerTick = 60000 / (bpm * ticksPerQuarter);
  const baseTick = events[0].tick;
  const deadlineMs = events.map(event => (event.tick - baseTick) * msPerTick + toleranceMs);

  let eventIndex = 0;
  let held = new Set();
  let startedAt = null;
  let completedAt = null;

  const stats = {
    totalEvents: events.length,
    correctEvents: 0,
    wrongEvents: 0,
    extraNotes: 0,
    missedNotes: 0,
    maxCombo: 0,
    currentCombo: 0,
    mistakeEventIndexes: [],
    hands: {},
  };

  function bumpHand(hand, key) {
    if (!hand) return;
    if (!stats.hands[hand]) stats.hands[hand] = { correct: 0, wrong: 0 };
    stats.hands[hand][key]++;
  }

  function ensureStarted(tsMs) {
    if (startedAt == null) startedAt = tsMs;
  }

  function currentEvent() {
    return eventIndex < events.length ? events[eventIndex] : null;
  }

  function resolveEvent(tsMs, wasHit) {
    const event = events[eventIndex];
    for (const note of event.notes) bumpHand(note.hand, wasHit ? 'correct' : 'wrong');
    if (wasHit) {
      stats.correctEvents++;
      stats.currentCombo++;
      stats.maxCombo = Math.max(stats.maxCombo, stats.currentCombo);
    } else {
      stats.wrongEvents++;
      stats.currentCombo = 0;
      stats.mistakeEventIndexes.push(eventIndex);
    }
    eventIndex++;
    held = new Set();
    if (eventIndex >= events.length) completedAt = tsMs;
  }

  return {
    noteOn(pitch, tsMs = now()) {
      if (completedAt != null) return;
      ensureStarted(tsMs);
      const event = currentEvent();
      if (!event) return;
      const expected = expectedPitches(event);
      if (expected.has(pitch)) {
        held.add(pitch);
        if (held.size === expected.size && [...expected].every(p => held.has(p))) {
          resolveEvent(tsMs, true);
        }
      } else {
        stats.extraNotes++;
        bumpHand(nearestHand(pitch, event), 'wrong');
      }
    },

    noteOff(pitch) {
      held.delete(pitch);
    },

    // 由调用方（浏览器里的 requestAnimationFrame/setInterval，或测试里手动传时间戳）
    // 驱动的"曲速时钟"：过了当前事件的到期时间还没弹对，就判为断点并强制前进，绝不
    // 会像等待模式那样一直卡在原地。
    tick(tsMs = now()) {
      if (completedAt != null) return;
      ensureStarted(tsMs);
      const elapsed = tsMs - startedAt;
      while (eventIndex < events.length && elapsed >= deadlineMs[eventIndex]) {
        resolveEvent(startedAt + deadlineMs[eventIndex], false);
      }
    },

    get isComplete() {
      return completedAt != null;
    },

    getCurrentEvent: currentEvent,
    getEventIndex: () => eventIndex,

    getResult() {
      const durationMs = startedAt != null ? (completedAt ?? now()) - startedAt : 0;
      const accuracy = stats.totalEvents ? stats.correctEvents / stats.totalEvents : 0;
      const hands = {};
      for (const [hand, h] of Object.entries(stats.hands)) {
        const total = h.correct + h.wrong;
        hands[hand] = { ...h, accuracy: total ? h.correct / total : 1 };
      }
      return {
        totalEvents: stats.totalEvents,
        correctEvents: stats.correctEvents,
        wrongEvents: stats.wrongEvents,
        extraNotes: stats.extraNotes,
        missedNotes: stats.missedNotes,
        maxCombo: stats.maxCombo,
        currentCombo: stats.currentCombo,
        mistakeEventIndexes: stats.mistakeEventIndexes.slice(),
        hands,
        accuracy,
        score: Math.round(accuracy * 100),
        isComplete: completedAt != null,
        durationMs,
        longestContinuousRun: stats.maxCombo,
        breakPoints: stats.mistakeEventIndexes.slice(),
      };
    },
  };
}

const api = { createWaitModeSession, createContinuousModeSession };
if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
} else {
  root.PracticeScoring = api;
}

})(typeof window !== 'undefined' ? window : globalThis);
