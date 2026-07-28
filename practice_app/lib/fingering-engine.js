'use strict';

/**
 * 钢琴指法自动生成引擎。
 *
 * 设计依据：
 * - 左右手必须镜像处理：同一段上行旋律，右手通常向 1→5 展开，
 *   左手通常向 5→1 展开。
 * - 使用 Parncutt 等人提出的“实用跨度 / 舒适跨度”思想约束相邻手指。
 * - 单音、和弦分别计价；和弦之间不再把所有音符两两交叉比较。
 * - 指法先按整首曲子生成，再由课程层截取，保证同一音符在不同课节中一致。
 *
 * 这仍然是面向初学者的规则模型，而不是“唯一正确”的演奏版本。乐句、触键、
 * 速度和手型都会影响专业演奏者的最终选择，因此同时提供校验器供全曲库审计。
 */

const UNPLAYABLE_COST = 100000;

// Parncutt et al. (1997) Table 1 的右手手指对跨度（半音）。
// 左手通过反转音高方向复用同一张表，手指编号本身不反转（两手拇指都叫 1 指）。
const PRACTICAL_SPANS = Object.freeze({
  '1-2': { minPrac: -5, minComf: -3, minRelaxed: 1, maxRelaxed: 5, maxComf: 8, maxPrac: 10 },
  '1-3': { minPrac: -4, minComf: -2, minRelaxed: 3, maxRelaxed: 7, maxComf: 10, maxPrac: 12 },
  '1-4': { minPrac: -3, minComf: -1, minRelaxed: 5, maxRelaxed: 9, maxComf: 12, maxPrac: 14 },
  '1-5': { minPrac: -1, minComf:  1, minRelaxed: 7, maxRelaxed: 10, maxComf: 13, maxPrac: 15 },
  '2-3': { minPrac:  1, minComf:  1, minRelaxed: 1, maxRelaxed: 2, maxComf: 3, maxPrac: 5 },
  '2-4': { minPrac:  1, minComf:  1, minRelaxed: 3, maxRelaxed: 4, maxComf: 5, maxPrac: 7 },
  '2-5': { minPrac:  2, minComf:  2, minRelaxed: 5, maxRelaxed: 6, maxComf: 8, maxPrac: 10 },
  '3-4': { minPrac:  1, minComf:  1, minRelaxed: 1, maxRelaxed: 2, maxComf: 2, maxPrac: 4 },
  '3-5': { minPrac:  1, minComf:  1, minRelaxed: 3, maxRelaxed: 4, maxComf: 5, maxPrac: 7 },
  '4-5': { minPrac:  1, minComf:  1, minRelaxed: 1, maxRelaxed: 2, maxComf: 3, maxPrac: 5 },
});

const WEIGHTS = Object.freeze({
  thumbOnBlack: 500,
  pinkyOnBlack: 24,
  weakFinger4: 0.45,
  weakFinger5: 0.2,
  sameFingerNearbyMove: 800,
  sameFingerReposition: 8,
  thumbPass: 3,
  positionShift: 1.4,
  repeatedPitchFingerChange: 5,
  boundaryStart: 2.5,
  boundaryEnd: 0.5,
  chordOuterFinger: 5,
});

function isBlackKey(pitch) {
  return [1, 3, 6, 8, 10].includes(((Number(pitch) % 12) + 12) % 12);
}

function getPitch(note) {
  const pitch = note?.note ?? note?.midi ?? note?.midiPitch ?? note?.pitch;
  return Number.isFinite(Number(pitch)) ? Number(pitch) : 60;
}

function generateValidStates(noteCount, hand = 'right') {
  const count = Math.max(0, Number(noteCount) || 0);
  if (count === 0) return [[]];
  if (count > 5) return [];
  if (count === 1) return [[1], [2], [3], [4], [5]];

  const results = [];
  function combine(nextFinger, combo) {
    if (combo.length === count) {
      results.push(hand === 'left' ? [...combo].reverse() : [...combo]);
      return;
    }
    for (let finger = nextFinger; finger <= 5; finger++) {
      combine(finger + 1, [...combo, finger]);
    }
  }
  combine(1, []);
  return results;
}

function reverseSpan(span) {
  return {
    minPrac: -span.maxPrac,
    minComf: -span.maxComf,
    minRelaxed: -span.maxRelaxed,
    maxRelaxed: -span.minRelaxed,
    maxComf: -span.minComf,
    maxPrac: -span.minPrac,
  };
}

function spanForFingerPair(previousFinger, currentFinger) {
  if (previousFinger === currentFinger) return null;
  const low = Math.min(previousFinger, currentFinger);
  const high = Math.max(previousFinger, currentFinger);
  const base = PRACTICAL_SPANS[`${low}-${high}`];
  if (!base) return null;
  return previousFinger < currentFinger ? base : reverseSpan(base);
}

function normalizedPitchDelta(previousPitch, currentPitch, hand) {
  const delta = currentPitch - previousPitch;
  return hand === 'left' ? -delta : delta;
}

function spanDifficulty(previousPitch, previousFinger, currentPitch, currentFinger, hand = 'right') {
  const delta = normalizedPitchDelta(previousPitch, currentPitch, hand);
  const absoluteKeyboardDistance = Math.abs(currentPitch - previousPitch);

  if (previousFinger === currentFinger) {
    if (delta === 0) return 0;
    const distance = Math.abs(delta);
    return distance <= 5
      ? WEIGHTS.sameFingerNearbyMove + (6 - distance) * 2
      : WEIGHTS.sameFingerReposition + distance * 0.15;
  }

  // 超过八度的旋律跳进依靠前臂带动整只手重新落位，不应按“手指拉伸”
  // 判断为不可弹；保留适度移动成本，让落点指法仍参与后续路径优化。
  if (absoluteKeyboardDistance > 12) {
    return 10 + absoluteKeyboardDistance * 0.4;
  }

  const span = spanForFingerPair(previousFinger, currentFinger);
  if (!span) return UNPLAYABLE_COST;
  const includesThumb = previousFinger === 1 || currentFinger === 1;
  const passesThumb = includesThumb && (
    (previousFinger < currentFinger && delta < 0) ||
    (previousFinger > currentFinger && delta > 0)
  );
  // 三指跨拇指弹分解和弦时，常见 C-E-G-C 的 G→C 会比纯手指连奏模型
  // 多出一个半音；这里把它视为需要手臂配合的高代价动作，而不是“不可能”。
  const armAssistedThumbPass =
    passesThumb &&
    (delta >= span.minPrac - 1 && delta <= span.maxPrac + 1);
  if (delta < span.minPrac && !armAssistedThumbPass) {
    return UNPLAYABLE_COST + (span.minPrac - delta) * 100;
  }
  if (delta > span.maxPrac && !armAssistedThumbPass) {
    return UNPLAYABLE_COST + (delta - span.maxPrac) * 100;
  }

  let cost = 0;
  if (armAssistedThumbPass) cost += 42;
  if (delta < span.minComf) cost += (span.minComf - delta) * 18;
  else if (delta > span.maxComf) cost += (delta - span.maxComf) * 18;

  if (delta < span.minRelaxed) {
    cost += (span.minRelaxed - delta) * (includesThumb ? 1.2 : 2.2);
  } else if (delta > span.maxRelaxed) {
    cost += (delta - span.maxRelaxed) * (includesThumb ? 1.2 : 2.2);
  }

  if (passesThumb) cost += WEIGHTS.thumbPass;
  if (previousFinger === 3 && currentFinger === 4) cost += 1;
  return cost;
}

function noteStateCost(note, finger) {
  let cost = 0;
  if (isBlackKey(getPitch(note))) {
    if (finger === 1) cost += WEIGHTS.thumbOnBlack;
    if (finger === 5) cost += WEIGHTS.pinkyOnBlack;
  }
  if (finger === 4) cost += WEIGHTS.weakFinger4;
  if (finger === 5) cost += WEIGHTS.weakFinger5;
  return cost;
}

function eventPosition(notes, fingers, hand) {
  if (!notes.length) return 0;
  const estimates = notes.map((note, index) => {
    const fingerOffset = fingers[index] - 1;
    return hand === 'left'
      ? getPitch(note) + fingerOffset * 2
      : getPitch(note) - fingerOffset * 2;
  }).sort((a, b) => a - b);
  return estimates[Math.floor(estimates.length / 2)];
}

function eventStateCost(notes, fingers, hand) {
  if (!notes.length || notes.length !== fingers.length) return UNPLAYABLE_COST;
  let cost = 0;
  for (let index = 0; index < notes.length; index++) {
    cost += noteStateCost(notes[index], fingers[index]);
  }

  for (let leftIndex = 0; leftIndex < notes.length; leftIndex++) {
    for (let rightIndex = leftIndex + 1; rightIndex < notes.length; rightIndex++) {
      const pairCost = spanDifficulty(
        getPitch(notes[leftIndex]),
        fingers[leftIndex],
        getPitch(notes[rightIndex]),
        fingers[rightIndex],
        hand,
      );
      cost += pairCost >= UNPLAYABLE_COST ? pairCost : pairCost * 1.2;
    }
  }

  if (notes.length >= 3 && getPitch(notes.at(-1)) - getPitch(notes[0]) >= 7) {
    const expectedLow = hand === 'left' ? 5 : 1;
    const expectedHigh = hand === 'left' ? 1 : 5;
    if (fingers[0] !== expectedLow) cost += WEIGHTS.chordOuterFinger;
    if (fingers.at(-1) !== expectedHigh) cost += WEIGHTS.chordOuterFinger;
  }
  return cost;
}

function representativePitch(event) {
  const notes = event?.notes || [event];
  if (!notes.length) return 60;
  return notes.reduce((sum, note) => sum + getPitch(note), 0) / notes.length;
}

function contourDirection(events, fromStart, hand) {
  if (events.length < 2) return 0;
  const indexes = fromStart
    ? [...events.keys()]
    : [...events.keys()].reverse();
  const anchor = representativePitch(events[indexes[0]]);
  for (const index of indexes.slice(1)) {
    const pitch = representativePitch(events[index]);
    if (pitch === anchor) continue;
    const direction = Math.sign(fromStart ? pitch - anchor : anchor - pitch);
    return hand === 'left' ? -direction : direction;
  }
  return 0;
}

function boundaryCost(state, direction, kind) {
  if (state.length !== 1) return 0;
  const finger = state[0];
  if (direction === 0) return Math.abs(finger - 3) * 0.25;
  const ideal = kind === 'start'
    ? (direction > 0 ? 1 : 5)
    : (direction > 0 ? 5 : 1);
  const weight = kind === 'start' ? WEIGHTS.boundaryStart : WEIGHTS.boundaryEnd;
  return Math.abs(finger - ideal) * weight;
}

function matchedVoicePairs(previousNotes, previousFingers, currentNotes, currentFingers) {
  const pairs = [];
  const usedPrevious = new Set();
  const usedCurrent = new Set();

  for (let currentIndex = 0; currentIndex < currentNotes.length; currentIndex++) {
    const pitch = getPitch(currentNotes[currentIndex]);
    const previousIndex = previousNotes.findIndex((note, index) =>
      !usedPrevious.has(index) && getPitch(note) === pitch);
    if (previousIndex >= 0) {
      pairs.push([previousIndex, currentIndex, true]);
      usedPrevious.add(previousIndex);
      usedCurrent.add(currentIndex);
    }
  }

  const remainingPrevious = previousNotes
    .map((_, index) => index)
    .filter(index => !usedPrevious.has(index));
  const remainingCurrent = currentNotes
    .map((_, index) => index)
    .filter(index => !usedCurrent.has(index));
  const pairCount = Math.min(remainingPrevious.length, remainingCurrent.length);
  for (let index = 0; index < pairCount; index++) {
    const previousIndex = remainingPrevious.length === 1
      ? remainingPrevious[0]
      : remainingPrevious[Math.round(index * (remainingPrevious.length - 1) / Math.max(1, pairCount - 1))];
    const currentIndex = remainingCurrent.length === 1
      ? remainingCurrent[0]
      : remainingCurrent[Math.round(index * (remainingCurrent.length - 1) / Math.max(1, pairCount - 1))];
    pairs.push([previousIndex, currentIndex, false]);
  }

  return pairs;
}

function calculateTransitionCost(
  previousNotes,
  previousFingers,
  currentNotes,
  currentFingers,
  hand = 'right',
) {
  let cost = eventStateCost(currentNotes, currentFingers, hand);
  if (!previousNotes.length) return cost;

  if (previousNotes.length === 1 && currentNotes.length === 1) {
    cost += spanDifficulty(
      getPitch(previousNotes[0]),
      previousFingers[0],
      getPitch(currentNotes[0]),
      currentFingers[0],
      hand,
    );
    return cost;
  }

  const previousPosition = eventPosition(previousNotes, previousFingers, hand);
  const currentPosition = eventPosition(currentNotes, currentFingers, hand);
  const positionDistance = Math.abs(currentPosition - previousPosition);
  cost += Math.min(16, positionDistance * WEIGHTS.positionShift);

  for (const [previousIndex, currentIndex, samePitch] of matchedVoicePairs(
    previousNotes,
    previousFingers,
    currentNotes,
    currentFingers,
  )) {
    if (samePitch) {
      if (previousFingers[previousIndex] !== currentFingers[currentIndex]) {
        cost += WEIGHTS.repeatedPitchFingerChange;
      }
      continue;
    }
    const voiceCost = spanDifficulty(
      getPitch(previousNotes[previousIndex]),
      previousFingers[previousIndex],
      getPitch(currentNotes[currentIndex]),
      currentFingers[currentIndex],
      hand,
    );
    cost += voiceCost >= UNPLAYABLE_COST ? voiceCost * 0.2 : voiceCost * 0.25;
  }
  return cost;
}

function splitAtPhraseGaps(events, ticksPerQuarter) {
  if (!Number.isFinite(ticksPerQuarter) || ticksPerQuarter <= 0) return [events];
  const segments = [];
  let current = [];
  for (const event of events) {
    const previous = current.at(-1);
    const previousEnd = previous?.endTick ??
      Math.max(...(previous?.notes || []).map(note => note.endTick ?? previous?.tick ?? 0));
    if (previous && Number.isFinite(event.tick) &&
        event.tick - previousEnd >= ticksPerQuarter * 1.5) {
      segments.push(current);
      current = [];
    }
    current.push(event);
  }
  if (current.length) segments.push(current);
  return segments;
}

function predictSegment(events, hand, source) {
  if (!events.length) return;
  const statesByEvent = events.map(event =>
    generateValidStates((event.notes || [event]).length, hand));
  if (statesByEvent.some(states => states.length === 0)) {
    throw new Error('单手同一时刻超过 5 个音符，无法生成可弹指法');
  }

  const startDirection = contourDirection(events, true, hand);
  const endDirection = contourDirection(events, false, hand);
  const dp = [];
  const backtrace = [];

  const firstNotes = events[0].notes || [events[0]];
  dp[0] = statesByEvent[0].map(state => ({
    cost: eventStateCost(firstNotes, state, hand) +
      boundaryCost(state, startDirection, 'start'),
    state,
  }));
  backtrace[0] = statesByEvent[0].map(() => -1);

  for (let eventIndex = 1; eventIndex < events.length; eventIndex++) {
    const previousNotes = events[eventIndex - 1].notes || [events[eventIndex - 1]];
    const currentNotes = events[eventIndex].notes || [events[eventIndex]];
    dp[eventIndex] = [];
    backtrace[eventIndex] = [];

    for (let currentIndex = 0; currentIndex < statesByEvent[eventIndex].length; currentIndex++) {
      const currentState = statesByEvent[eventIndex][currentIndex];
      let bestCost = Infinity;
      let bestPrevious = -1;
      for (let previousIndex = 0; previousIndex < dp[eventIndex - 1].length; previousIndex++) {
        const total = dp[eventIndex - 1][previousIndex].cost +
          calculateTransitionCost(
            previousNotes,
            dp[eventIndex - 1][previousIndex].state,
            currentNotes,
            currentState,
            hand,
          );
        if (total < bestCost) {
          bestCost = total;
          bestPrevious = previousIndex;
        }
      }
      dp[eventIndex][currentIndex] = { cost: bestCost, state: currentState };
      backtrace[eventIndex][currentIndex] = bestPrevious;
    }
  }

  const lastIndex = events.length - 1;
  let bestLastIndex = 0;
  let bestFinalCost = Infinity;
  for (let stateIndex = 0; stateIndex < dp[lastIndex].length; stateIndex++) {
    const total = dp[lastIndex][stateIndex].cost +
      boundaryCost(dp[lastIndex][stateIndex].state, endDirection, 'end');
    if (total < bestFinalCost) {
      bestFinalCost = total;
      bestLastIndex = stateIndex;
    }
  }

  const optimalStates = new Array(events.length);
  let stateIndex = bestLastIndex;
  for (let eventIndex = lastIndex; eventIndex >= 0; eventIndex--) {
    optimalStates[eventIndex] = dp[eventIndex][stateIndex].state;
    stateIndex = backtrace[eventIndex][stateIndex];
  }

  for (let eventIndex = 0; eventIndex < events.length; eventIndex++) {
    const notes = events[eventIndex].notes || [events[eventIndex]];
    for (let noteIndex = 0; noteIndex < notes.length; noteIndex++) {
      notes[noteIndex].finger = optimalStates[eventIndex][noteIndex];
      notes[noteIndex].fingerSource = source;
    }
  }
}

function predictFingeringForEvents(events, hand = 'right', options = {}) {
  if (!events || events.length === 0) return events;
  const normalizedHand = hand === 'left' ? 'left' : 'right';
  const source = options.source || 'generated';
  for (const segment of splitAtPhraseGaps(events, options.ticksPerQuarter)) {
    predictSegment(segment, normalizedHand, source);
  }
  if (options.log === true) {
    console.log(`[FingeringEngine] 为 ${events.length} 个事件生成 ${normalizedHand} 手指法`);
  }
  return events;
}

function applyExplicitFingering(events, fingers, source = 'curated') {
  if (!Array.isArray(fingers)) return false;
  const notes = events.flatMap(event => event.notes || [event]);
  if (notes.length !== fingers.length) {
    throw new Error(`显式指法长度 ${fingers.length} 与音符数 ${notes.length} 不一致`);
  }
  for (let index = 0; index < notes.length; index++) {
    const finger = Number(fingers[index]);
    if (!Number.isInteger(finger) || finger < 1 || finger > 5) {
      throw new Error(`第 ${index + 1} 个显式指法不是 1-5：${fingers[index]}`);
    }
    notes[index].finger = finger;
    notes[index].fingerSource = source;
  }
  return true;
}

function validationIssue(code, message, eventIndex, noteIndex, details = {}) {
  return { code, message, eventIndex, noteIndex, ...details };
}

function hasThumbFreePlayableState(notes, hand) {
  return generateValidStates(notes.length, hand).some(state =>
    eventStateCost(notes, state, hand) < UNPLAYABLE_COST &&
    !state.some((finger, index) => finger === 1 && isBlackKey(getPitch(notes[index]))));
}

function validateFingeringForEvents(events, hand = 'right', options = {}) {
  const errors = [];
  const warnings = [];
  const normalizedHand = hand === 'left' ? 'left' : 'right';

  for (let eventIndex = 0; eventIndex < (events || []).length; eventIndex++) {
    const notes = events[eventIndex].notes || [events[eventIndex]];
    if (notes.length > 5) {
      errors.push(validationIssue(
        'too_many_simultaneous_notes',
        '单手同一时刻超过 5 个音符',
        eventIndex,
        null,
        { noteCount: notes.length },
      ));
    }

    const fingers = notes.map(note => Number(note.finger));
    for (let noteIndex = 0; noteIndex < notes.length; noteIndex++) {
      const finger = fingers[noteIndex];
      if (!Number.isInteger(finger) || finger < 1 || finger > 5) {
        errors.push(validationIssue(
          'invalid_finger',
          '指法必须是 1-5',
          eventIndex,
          noteIndex,
          { finger: notes[noteIndex].finger },
        ));
      } else if (finger === 1 && isBlackKey(getPitch(notes[noteIndex])) &&
                 options.allowThumbOnBlack !== true) {
        const avoidable = hasThumbFreePlayableState(notes, normalizedHand);
        warnings.push(validationIssue(
          avoidable ? 'thumb_on_black' : 'required_thumb_on_black',
          avoidable
            ? '存在不让拇指按黑键的可弹和弦手型，建议人工复核'
            : '曲目本身的音程或和弦形状迫使拇指落在黑键',
          eventIndex,
          noteIndex,
          { pitch: getPitch(notes[noteIndex]), avoidable },
        ));
      }
    }

    if (fingers.every(Number.isInteger)) {
      for (let noteIndex = 1; noteIndex < notes.length; noteIndex++) {
        const ordered = normalizedHand === 'left'
          ? fingers[noteIndex - 1] > fingers[noteIndex]
          : fingers[noteIndex - 1] < fingers[noteIndex];
        if (!ordered) {
          errors.push(validationIssue(
            'crossed_chord_fingers',
            '和弦内手指顺序发生交叉或重复',
            eventIndex,
            noteIndex,
            { fingers },
          ));
          break;
        }
        const pairCost = spanDifficulty(
          getPitch(notes[noteIndex - 1]),
          fingers[noteIndex - 1],
          getPitch(notes[noteIndex]),
          fingers[noteIndex],
          normalizedHand,
        );
        if (pairCost >= UNPLAYABLE_COST) {
          warnings.push(validationIssue(
            'impractical_chord_span',
            '和弦本身要求超出初学者舒适范围的跨度',
            eventIndex,
            noteIndex,
            { fingers, pitches: notes.map(getPitch) },
          ));
        }
      }
    }
  }

  for (let eventIndex = 1; eventIndex < (events || []).length; eventIndex++) {
    const previousNotes = events[eventIndex - 1].notes || [events[eventIndex - 1]];
    const currentNotes = events[eventIndex].notes || [events[eventIndex]];
    if (previousNotes.length !== 1 || currentNotes.length !== 1) continue;
    const previousFinger = Number(previousNotes[0].finger);
    const currentFinger = Number(currentNotes[0].finger);
    if (![previousFinger, currentFinger].every(Number.isInteger)) continue;
    const previousPitch = getPitch(previousNotes[0]);
    const currentPitch = getPitch(currentNotes[0]);
    const interval = Math.abs(currentPitch - previousPitch);

    // 轮指训练会在同一个琴键上主动换指；这是合法技巧，不按“手指连奏跨度”判错。
    if (previousPitch === currentPitch) continue;

    if (previousFinger === currentFinger && interval <= 5) {
      warnings.push(validationIssue(
        'same_finger_nearby_notes',
        '邻近异音连续使用同一手指',
        eventIndex,
        0,
        { previousPitch, currentPitch, finger: currentFinger },
      ));
    }

    const pairCost = spanDifficulty(
      previousPitch,
      previousFinger,
      currentPitch,
      currentFinger,
      normalizedHand,
    );
    if (pairCost >= UNPLAYABLE_COST) {
      errors.push(validationIssue(
        'impractical_melodic_span',
        '相邻旋律音的手指跨度超出实用范围',
        eventIndex,
        0,
        { previousPitch, currentPitch, previousFinger, currentFinger },
      ));
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    summary: {
      eventCount: (events || []).length,
      noteCount: (events || []).reduce(
        (sum, event) => sum + (event.notes || [event]).length,
        0,
      ),
      errorCount: errors.length,
      warningCount: warnings.length,
    },
  };
}

module.exports = {
  PRACTICAL_SPANS,
  UNPLAYABLE_COST,
  isBlackKey,
  generateValidStates,
  spanDifficulty,
  calculateTransitionCost,
  predictFingeringForEvents,
  applyExplicitFingering,
  validateFingeringForEvents,
};
