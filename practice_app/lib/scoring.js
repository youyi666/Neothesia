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

const api = { createWaitModeSession };
if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
} else {
  root.PracticeScoring = api;
}

})(typeof window !== 'undefined' ? window : globalThis);
