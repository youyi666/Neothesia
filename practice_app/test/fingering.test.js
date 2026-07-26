'use strict';
const test   = require('node:test');
const assert = require('node:assert/strict');
const {
  predictFingeringForEvents,
  generateValidStates,
  calculateTransitionCost,
  isBlackKey,
} = require('../lib/fingering-engine.js');

// ── 辅助函数 ──────────────────────────────────────────────────────────────
// 构造单音事件（右手）
function singleNote(midiPitch) {
  return { notes: [{ note: midiPitch, hand: 'right' }] };
}
// 构造和弦事件（按音高升序）
function chordNotes(pitches, hand = 'right') {
  return { notes: pitches.sort((a, b) => a - b).map(p => ({ note: p, hand })) };
}

// ── 1. isBlackKey ────────────────────────────────────────────────────────
test('isBlackKey 正确识别黑白键', () => {
  // C=0, D=2, E=4, F=5, G=7, A=9, B=11 → 白键
  assert.equal(isBlackKey(60), false, 'C4 是白键');
  assert.equal(isBlackKey(62), false, 'D4 是白键');
  assert.equal(isBlackKey(64), false, 'E4 是白键');
  // C#=1, D#=3, F#=6, G#=8, A#=10 → 黑键
  assert.equal(isBlackKey(61), true,  'C#4 是黑键');
  assert.equal(isBlackKey(63), true,  'D#4 是黑键');
  assert.equal(isBlackKey(66), true,  'F#4 是黑键');
});

// ── 2. generateValidStates ───────────────────────────────────────────────
test('generateValidStates 单音返回 5 种状态', () => {
  const states = generateValidStates(1, 'right');
  assert.equal(states.length, 5);
  assert.deepEqual(states, [[1],[2],[3],[4],[5]]);
});

test('generateValidStates 右手双音组合手指递增', () => {
  const states = generateValidStates(2, 'right');
  // C(5,2)=10 种
  assert.equal(states.length, 10);
  for (const s of states) {
    assert.equal(s.length, 2);
    assert.ok(s[0] < s[1], `右手低音手指 ${s[0]} 必须 < 高音手指 ${s[1]}`);
  }
});

test('generateValidStates 左手三音组合手指从低音到高音递减', () => {
  const states = generateValidStates(3, 'left');
  // C(5,3)=10 种
  assert.equal(states.length, 10);
  for (const s of states) {
    assert.equal(s.length, 3);
    assert.ok(s[0] > s[1] && s[1] > s[2],
      `左手 [${s}] 应从低音到高音手指递减`);
  }
  // 不应出现任何交叉死锁（升序组合）
  const flat = states.map(s => s.join(','));
  assert.ok(!flat.includes('3,1,5'), '不应包含交叉死锁 [3,1,5]');
});

// ── 3. calculateTransitionCost ───────────────────────────────────────────
test('calculateTransitionCost 相邻音同指（异音）应有高惩罚', () => {
  const prev = [{ note: 60 }];
  const curr = [{ note: 62 }];
  const costSameFinger = calculateTransitionCost(prev, [2], curr, [2]);
  const costDiffFinger = calculateTransitionCost(prev, [2], curr, [3]);
  assert.ok(costSameFinger > costDiffFinger,
    '同指异音代价应高于换指代价');
});

test('calculateTransitionCost 大拇指按黑键应有惩罚', () => {
  // 用空前驱避免 sameFingerRepeat 干扰，只对比黑键惩罚差异
  const curr = [{ note: 61 }]; // C# 黑键
  const costThumb  = calculateTransitionCost([], [], curr, [1]);
  const costMiddle = calculateTransitionCost([], [], curr, [2]);
  assert.ok(costThumb > costMiddle, '拇指按黑键代价应更高');
});

// ── 4. predictFingeringForEvents 单音序列 ────────────────────────────────
test('单音 C-D-E 旋律应分配合理的递增手指', () => {
  // C4=60, D4=62, E4=64（白键步进）
  const events = [singleNote(60), singleNote(62), singleNote(64)];
  predictFingeringForEvents(events, 'right');

  const fingers = events.map(e => e.notes[0].finger);
  // 每个音都应有 1-5 的手指
  for (const f of fingers) {
    assert.ok(f >= 1 && f <= 5, `手指 ${f} 应在 1-5 范围内`);
  }
  // 三个相邻白键，不应所有音都用同一根手指
  const allSame = fingers.every(f => f === fingers[0]);
  assert.ok(!allSame, 'C-D-E 不应全用同一根手指');
  // 常见自然指法期望：1-2-3 或 2-3-4 等升序
  assert.ok(fingers[0] <= fingers[1] && fingers[1] <= fingers[2],
    `手指序列 [${fingers}] 应单调不减（C-D-E 白键步进）`);
});

test('C4-D4-E4-F4-G4 五个白键应覆盖 1-5 指', () => {
  const pitches = [60, 62, 64, 65, 67];
  const events = pitches.map(singleNote);
  predictFingeringForEvents(events, 'right');
  const fingers = events.map(e => e.notes[0].finger);
  for (const f of fingers) {
    assert.ok(f >= 1 && f <= 5, `手指 ${f} 应在 1-5 范围内`);
  }
  // 五个白键紧凑步进，应全部单调不减
  for (let i = 1; i < fingers.length; i++) {
    assert.ok(fingers[i] >= fingers[i - 1],
      `手指序列 [${fingers}] 在第 ${i} 步应不减`);
  }
});

// ── 5. predictFingeringForEvents 和弦 ────────────────────────────────────
test('右手 C 大三和弦 [60,64,67] 应输出升序合法组合', () => {
  const events = [chordNotes([60, 64, 67], 'right')];
  predictFingeringForEvents(events, 'right');

  const fingers = events[0].notes.map(n => n.finger);
  assert.equal(fingers.length, 3);

  // 右手三音和弦：低音→高音手指必须严格递增
  assert.ok(fingers[0] < fingers[1] && fingers[1] < fingers[2],
    `右手和弦指法 [${fingers}] 应严格递增`);

  // 不应出现交叉死锁（如 [3,1,5]）
  assert.ok(
    !(fingers[0] > fingers[1] || fingers[1] > fingers[2]),
    `右手和弦不应出现交叉指法 [${fingers}]`,
  );

  // 常见合理组合：[1,3,5] / [1,2,5] / [1,2,4] / [2,3,5] 等
  for (const f of fingers) {
    assert.ok(f >= 1 && f <= 5, `手指 ${f} 超出范围`);
  }
});

test('左手和弦 [48,52,55] 应输出从低音到高音手指递减', () => {
  const events = [chordNotes([48, 52, 55], 'left')];
  predictFingeringForEvents(events, 'left');

  const fingers = events[0].notes.map(n => n.finger);
  assert.equal(fingers.length, 3);

  // 左手三音和弦：低音→高音手指必须严格递减
  assert.ok(fingers[0] > fingers[1] && fingers[1] > fingers[2],
    `左手和弦指法 [${fingers}] 应从低音到高音递减（如 [5,3,1]）`);
});

// ── 6. 容错与性能 ──────────────────────────────────────────────────────
test('空数组输入不应崩溃', () => {
  assert.doesNotThrow(() => {
    const result = predictFingeringForEvents([], 'right');
    assert.deepEqual(result, []);
  });
});

test('null 输入不应崩溃', () => {
  assert.doesNotThrow(() => {
    const result = predictFingeringForEvents(null, 'right');
    assert.equal(result, null);
  });
});

test('含非法音高（undefined/NaN）的事件不应崩溃', () => {
  const events = [{ notes: [{ note: undefined, hand: 'right' }] }];
  assert.doesNotThrow(() => predictFingeringForEvents(events, 'right'));
});

test('100 个事件的算力消耗应小于 20ms', () => {
  const events = Array.from({ length: 100 }, (_, i) => singleNote(60 + (i % 12)));
  const start = Date.now();
  predictFingeringForEvents(events, 'right');
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 20, `100 个事件耗时 ${elapsed}ms，应 < 20ms`);
  // 确认每个音都有指法
  for (const e of events) {
    assert.ok(e.notes[0].finger >= 1 && e.notes[0].finger <= 5);
  }
});
