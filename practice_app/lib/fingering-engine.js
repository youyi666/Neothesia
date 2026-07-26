'use strict';
/**
 * lib/fingering-engine.js
 * 钢琴指法自动生成引擎（基于 Viterbi 动态规划，支持单音与多音/和弦事件）
 * 遵循增量模块开发原则，零外部依赖，输出带 finger 字段的 Note 序列。
 *
 * 调用方只需：
 *   const { predictFingeringForEvents } = require('./fingering-engine.js');
 *   predictFingeringForEvents(rightEvents, 'right');  // 直接修改 note.finger
 */

// ── 基础物理与代价权重配置 ────────────────────────────────────────────────
const WEIGHTS = {
  blackKeyThumb:    50,    // 大拇指(1指)按黑键惩罚
  blackKeyPinky:    30,    // 小拇指(5指)按黑键惩罚
  sameFingerRepeat: 800,   // 异音同指连续弹奏惩罚
  stretchLimit:     12,    // 正常手部最大跨度（半音数，默认八度）
  thumbCrossing:    15,    // 穿/跨指时的代价
  chordStretch:     60,    // 和弦内单组相邻手指间距超限惩罚（每半音）
  chordStretchMax:  5,     // 和弦内相邻手指正常跨度上限（半音）
  invalidCross:     10000, // 严重违背物理习惯的非法交叉死锁
};

/**
 * 判断指定 MIDI 音高是否为黑键
 * @param {number} pitch - MIDI 音高 (0-127)
 * @returns {boolean}
 */
function isBlackKey(pitch) {
  return [1, 3, 6, 8, 10].includes(pitch % 12);
}

/**
 * 为不同音符数量生成合法的手指组合状态。
 * 右手：低音→高音，手指编号递增（1=拇指在最低音）。
 * 左手：低音→高音，手指编号递减（1=拇指在最高音），
 *       因此 combo 升序后 reverse，变为 [5…1]。
 *
 * @param {number} noteCount - 当前事件包含的音符数（按音高升序已排好）
 * @param {string} hand - 'right' | 'left'
 * @returns {Array<Array<number>>} 合法的手指排布组合列表
 */
function generateValidStates(noteCount, hand = 'right') {
  const allFingers = [1, 2, 3, 4, 5];
  if (noteCount === 1) return allFingers.map(f => [f]);

  const results = [];
  // 递归生成 C(5, noteCount) 个升序组合
  function combine(start, combo) {
    if (combo.length === noteCount) {
      // 右手升序，左手降序（拇指在最高音）
      results.push(hand === 'right' ? [...combo] : [...combo].reverse());
      return;
    }
    for (let i = start; i < allFingers.length; i++) {
      combine(i + 1, [...combo, allFingers[i]]);
    }
  }
  combine(0, []);
  return results.length > 0 ? results : [allFingers.slice(0, noteCount)];
}

/**
 * 获取音符对象中的 MIDI 音高（兼容多种字段命名）
 * @param {object} note
 * @returns {number}
 */
function getPitch(note) {
  return note.note ?? note.midiPitch ?? note.pitch ?? 60;
}

/**
 * 计算两组指法状态转移的综合代价。
 * prevNotes/prevFingers 可以为空数组（用于初始化第一步）。
 *
 * @param {object[]} prevNotes    - 上一时刻的音符数组（已按音高升序）
 * @param {number[]} prevFingers  - 上一时刻对应的手指编号
 * @param {object[]} currNotes    - 当前时刻的音符数组（已按音高升序）
 * @param {number[]} currFingers  - 当前时刻对应的手指编号
 * @returns {number} 代价值（越小越好）
 */
function calculateTransitionCost(prevNotes, prevFingers, currNotes, currFingers) {
  let cost = 0;

  // ① 黑键惩罚：拇指/小拇指尽量不按黑键
  for (let idx = 0; idx < currNotes.length; idx++) {
    const finger = currFingers[idx];
    const pitch  = getPitch(currNotes[idx]);
    if (isBlackKey(pitch)) {
      if (finger === 1) cost += WEIGHTS.blackKeyThumb;
      if (finger === 5) cost += WEIGHTS.blackKeyPinky;
    }
  }

  // ② 和弦内部相邻手指跨度惩罚（防止"劈叉"式不自然和弦）
  for (let idx = 0; idx + 1 < currNotes.length; idx++) {
    const pitchSpan  = Math.abs(getPitch(currNotes[idx + 1]) - getPitch(currNotes[idx]));
    const fingerSpan = Math.abs(currFingers[idx + 1] - currFingers[idx]);
    // 每个手指间距的平均音程；超过上限则按超出量惩罚
    if (fingerSpan > 0) {
      const avgSemitones = pitchSpan / fingerSpan;
      if (avgSemitones > WEIGHTS.chordStretchMax) {
        cost += (avgSemitones - WEIGHTS.chordStretchMax) * WEIGHTS.chordStretch;
      }
    }
  }

  // ③ 事件间转移代价：同指异音惩罚 + 跨度惩罚 + 方向一致性惩罚
  for (let i = 0; i < prevNotes.length; i++) {
    const pPitch  = getPitch(prevNotes[i]);
    const pFinger = prevFingers[i];

    for (let j = 0; j < currNotes.length; j++) {
      const cPitch  = getPitch(currNotes[j]);
      const cFinger = currFingers[j];

      // 异音同指连续（除非音高相同，即保持不动）
      if (pPitch !== cPitch && pFinger === cFinger) {
        cost += WEIGHTS.sameFingerRepeat;
      }

      // 手位移动幅度 vs 手指编号变化不匹配时的跨度惩罚
      const pitchDiff  = Math.abs(cPitch - pPitch);
      const fingerDiff = Math.abs(cFinger - pFinger);
      if (pitchDiff > WEIGHTS.stretchLimit && fingerDiff < 3) {
        cost += (pitchDiff - WEIGHTS.stretchLimit) * 20;
      }

      // 音程方向与手指方向一致性：上行曲调应用上升手指，下行曲调应用下降手指；
      // 方向相反时（即需要穿指或跨指）加惩罚，惩罚随音程跨度线性增加。
      const pitchDelta  = cPitch - pPitch;
      const fingerDelta = cFinger - pFinger;
      if (pitchDelta !== 0 && fingerDelta !== 0 &&
          Math.sign(pitchDelta) !== Math.sign(fingerDelta)) {
        cost += WEIGHTS.thumbCrossing + Math.abs(pitchDelta) * 2;
      }
    }
  }

  return cost;
}

/**
 * 核心对外方法：为单手音符事件列表推断最优指法并写入 note.finger。
 * 直接修改传入的事件对象（增量注入，不破坏已有属性）。
 *
 * @param {Array<{notes: object[]}>} events - 单手事件列表，每条 notes 已按音高升序排好
 * @param {string} hand - 'right' | 'left'
 * @returns {Array} 同一事件数组（已注入 finger）
 */
function predictFingeringForEvents(events, hand = 'right') {
  try {
    if (!events || events.length === 0) return events;

    // ── Viterbi 前向 DP ──────────────────────────────────────────────────
    const dp        = [];   // dp[t][stateIdx] = { cost, state }
    const backtrace = [];   // backtrace[t][stateIdx] = prevStateIdx

    // 初始化：第一个事件的各状态初始代价
    const firstNotes  = events[0].notes || [events[0]];
    const firstStates = generateValidStates(firstNotes.length, hand);
    dp[0] = firstStates.map(state => ({
      cost:  calculateTransitionCost([], [], firstNotes, state),
      state,
    }));
    backtrace[0] = firstStates.map(() => -1);

    // 前向递推
    for (let t = 1; t < events.length; t++) {
      const currNotes  = events[t].notes   || [events[t]];
      const prevNotes  = events[t - 1].notes || [events[t - 1]];
      const currStates = generateValidStates(currNotes.length, hand);
      const prevDp     = dp[t - 1];

      dp[t]        = [];
      backtrace[t] = [];

      for (let cIdx = 0; cIdx < currStates.length; cIdx++) {
        const cState = currStates[cIdx];
        let minCost    = Infinity;
        let bestPrevIdx = -1;

        for (let pIdx = 0; pIdx < prevDp.length; pIdx++) {
          const transitionCost = calculateTransitionCost(
            prevNotes, prevDp[pIdx].state,
            currNotes, cState,
          );
          const totalCost = prevDp[pIdx].cost + transitionCost;
          if (totalCost < minCost) {
            minCost     = totalCost;
            bestPrevIdx = pIdx;
          }
        }

        dp[t][cIdx]        = { cost: minCost, state: cState };
        backtrace[t][cIdx] = bestPrevIdx;
      }
    }

    // ── 回溯最优路径 ──────────────────────────────────────────────────────
    const lastDp = dp[events.length - 1];
    let bestLastIdx  = 0;
    let minFinalCost = Infinity;
    for (let idx = 0; idx < lastDp.length; idx++) {
      if (lastDp[idx].cost < minFinalCost) {
        minFinalCost = lastDp[idx].cost;
        bestLastIdx  = idx;
      }
    }

    const optimalStates = new Array(events.length);
    let currIdx = bestLastIdx;
    for (let t = events.length - 1; t >= 0; t--) {
      optimalStates[t] = dp[t][currIdx].state;
      currIdx = backtrace[t][currIdx];
    }

    // ── 写入 finger 字段（增量注入，不破坏已有属性）───────────────────────
    for (let t = 0; t < events.length; t++) {
      const notes = events[t].notes || [events[t]];
      for (let nIdx = 0; nIdx < notes.length; nIdx++) {
        notes[nIdx].finger = optimalStates[t][nIdx] ?? 1; // 默认保底 1 指
      }
    }

    console.log(
      `[FingeringEngine] 成功为 ${events.length} 个事件生成 ${hand} 手指法`,
    );
    return events;

  } catch (error) {
    // 容错防崩溃：算法异常时静默记录日志，降级返回原事件（不带指法）
    console.error('[FingeringEngine Error] 指法生成异常，降级无指法返回:', error.message);
    return events;
  }
}

module.exports = { predictFingeringForEvents, generateValidStates, calculateTransitionCost, isBlackKey };
