// 专项特训 MIDI 生成器：指法训练（顺/穿/扩/跨/缩）+ 基本功训练（音阶/半音阶/短琶音/
// 双音/和弦/长琶音/轮指/颤音/八度/分解八度/震音）。
// 输出到 practice_midis/06_drills/{fingering,technique}/*.mid，
// 并把 { id, title, category, drillGroup, midi, bpm, fingering } 元数据写到
// practice_midis/06_drills/drills_manifest.json，供 practice_app/lib/course-store.js
// 读取生成课程种子，以及 practice_app 前端读取显式指法标注。
//
// 和弦/双音写法：item.n 传数组即为同时按下的和弦音，数组内必须按音高从低到高排列
// （extractTrackNotes 对同一 tick 的音符按 midi 音高升序排序，指法数组要对齐这个顺序）。

const fs = require("fs");
const path = require("path");
const { writeMidi, ROOT, noteNumber } = require("./midi_writer.js");

const Q = 1;
const E = 0.5;
const S = 0.25;
const H = 2;

const drills = [];

// items: [{ n: 'C4' | ['C4','G4'], d, v?, f: number | [number,...] }]
// f 必须和 n 的顺序（含和弦内的低到高顺序）一一对应。
function validateDrillFingering(id, items) {
  for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
    const item = items[itemIndex];
    const notes = Array.isArray(item.n) ? item.n : [item.n];
    const fingers = Array.isArray(item.f) ? item.f : [item.f];
    if (notes.length !== fingers.length) {
      throw new Error(`${id} 第 ${itemIndex + 1} 组的音符数与指法数不一致`);
    }
    for (let noteIndex = 0; noteIndex < notes.length; noteIndex++) {
      const finger = fingers[noteIndex];
      if (!Number.isInteger(finger) || finger < 1 || finger > 5) {
        throw new Error(`${id} 第 ${itemIndex + 1} 组包含非法指法：${finger}`);
      }
      const pitchClass = ((noteNumber(notes[noteIndex]) % 12) + 12) % 12;
      if (finger === 1 && [1, 3, 6, 8, 10].includes(pitchClass)) {
        throw new Error(`${id} 第 ${itemIndex + 1} 组让拇指按黑键：${notes[noteIndex]}`);
      }
      if (noteIndex > 0 && fingers[noteIndex - 1] >= finger) {
        throw new Error(`${id} 第 ${itemIndex + 1} 组的右手和弦指法没有按音高递增`);
      }
    }
  }
}

function addDrill(id, title, group, bpm, items) {
  validateDrillFingering(id, items);
  const subdir = group === "fingering" ? "fingering" : "technique";
  const right = items.map((it) => ({ n: it.n, d: it.d, ...(it.v ? { v: it.v } : {}) }));
  const fingering = [];
  for (const it of items) {
    if (Array.isArray(it.n)) fingering.push(...it.f);
    else fingering.push(it.f);
  }
  drills.push({
    id,
    title,
    category: "drill",
    drillGroup: group,
    midi: `06_drills/${subdir}/${id}.mid`,
    bpm,
    fingering: { right: fingering },
  });
  writeMidi(`06_drills/${subdir}/${id}.mid`, { title, bpm, right });
}

// ═══════════════════════════════════════
//  指法训练 (fingering) — 5 种
// ═══════════════════════════════════════

// 顺指：手指 1-2-3-4-5 顺序对应相邻音，不换把位。
addDrill("finger_seq", "顺指：五指顺序", "fingering", 70, [
  { n: "C4", d: Q, f: 1 }, { n: "D4", d: Q, f: 2 }, { n: "E4", d: Q, f: 3 }, { n: "F4", d: Q, f: 4 }, { n: "G4", d: Q, f: 5 },
  { n: "F4", d: Q, f: 4 }, { n: "E4", d: Q, f: 3 }, { n: "D4", d: Q, f: 2 }, { n: "C4", d: Q, f: 1 },
  { n: "C4", d: Q, f: 1 }, { n: "D4", d: Q, f: 2 }, { n: "E4", d: Q, f: 3 }, { n: "F4", d: Q, f: 4 }, { n: "G4", d: Q, f: 5 },
  { n: "F4", d: Q, f: 4 }, { n: "E4", d: Q, f: 3 }, { n: "D4", d: Q, f: 2 }, { n: "C4", d: Q, f: 1 },
]);

// 穿指：上行音阶，拇指在第 3 指后从掌下穿过（1 2 3 1 2 3 4 5）。
addDrill("finger_thumb_under", "穿指：拇指穿越（上行音阶）", "fingering", 66, [
  { n: "C4", d: Q, f: 1 }, { n: "D4", d: Q, f: 2 }, { n: "E4", d: Q, f: 3 }, { n: "F4", d: Q, f: 1 },
  { n: "G4", d: Q, f: 2 }, { n: "A4", d: Q, f: 3 }, { n: "B4", d: Q, f: 4 }, { n: "C5", d: Q, f: 5 },
  { n: "C4", d: Q, f: 1 }, { n: "D4", d: Q, f: 2 }, { n: "E4", d: Q, f: 3 }, { n: "F4", d: Q, f: 1 },
  { n: "G4", d: Q, f: 2 }, { n: "A4", d: Q, f: 3 }, { n: "B4", d: Q, f: 4 }, { n: "C5", d: Q, f: 5 },
]);

// 扩指：拇指固定在 C4，其余手指依次向外伸展再收回（2→3→4→5→4→3→2）。
addDrill("finger_expand", "扩指：手掌张开", "fingering", 60, [
  { n: "C4", d: E, f: 1 }, { n: "D4", d: E, f: 2 }, { n: "C4", d: E, f: 1 }, { n: "E4", d: E, f: 3 },
  { n: "C4", d: E, f: 1 }, { n: "F4", d: E, f: 4 }, { n: "C4", d: E, f: 1 }, { n: "G4", d: E, f: 5 },
  { n: "C4", d: E, f: 1 }, { n: "F4", d: E, f: 4 }, { n: "C4", d: E, f: 1 }, { n: "E4", d: E, f: 3 },
  { n: "C4", d: E, f: 1 }, { n: "D4", d: E, f: 2 },
]);

// 跨指：下行音阶，第 3 指跨过拇指落下（5 4 3 2 1 3 2 1）。
addDrill("finger_cross_over", "跨指：手指跨越（下行音阶）", "fingering", 66, [
  { n: "C5", d: Q, f: 5 }, { n: "B4", d: Q, f: 4 }, { n: "A4", d: Q, f: 3 }, { n: "G4", d: Q, f: 2 },
  { n: "F4", d: Q, f: 1 }, { n: "E4", d: Q, f: 3 }, { n: "D4", d: Q, f: 2 }, { n: "C4", d: Q, f: 1 },
  { n: "C5", d: Q, f: 5 }, { n: "B4", d: Q, f: 4 }, { n: "A4", d: Q, f: 3 }, { n: "G4", d: Q, f: 2 },
  { n: "F4", d: Q, f: 1 }, { n: "E4", d: Q, f: 3 }, { n: "D4", d: Q, f: 2 }, { n: "C4", d: Q, f: 1 },
]);

// 缩指：先张开到五度双音（1+5），再收拢成级进的窄音程（2 3 4 5，不用拇指）。
addDrill("finger_contract", "缩指：手掌收拢", "fingering", 60, [
  { n: ["C4", "G4"], d: Q, f: [1, 5] },
  { n: "E4", d: E, f: 2 }, { n: "F4", d: E, f: 3 }, { n: "G4", d: E, f: 4 }, { n: "A4", d: E, f: 5 },
  { n: ["D4", "A4"], d: Q, f: [1, 5] },
  { n: "F4", d: E, f: 2 }, { n: "G4", d: E, f: 3 }, { n: "A4", d: E, f: 4 }, { n: "B4", d: E, f: 5 },
  { n: ["C4", "G4"], d: Q, f: [1, 5] },
  { n: "E4", d: E, f: 2 }, { n: "F4", d: E, f: 3 }, { n: "G4", d: E, f: 4 }, { n: "A4", d: E, f: 5 },
]);

// ═══════════════════════════════════════
//  基本功训练 (technique) — 11 种
// ═══════════════════════════════════════

// 音阶：C 大调 1 个八度，标准指法 1231234 5 / 54321321。
addDrill("tech_scale_c_major", "音阶：C 大调", "technique", 70, [
  { n: "C4", d: Q, f: 1 }, { n: "D4", d: Q, f: 2 }, { n: "E4", d: Q, f: 3 }, { n: "F4", d: Q, f: 1 },
  { n: "G4", d: Q, f: 2 }, { n: "A4", d: Q, f: 3 }, { n: "B4", d: Q, f: 4 }, { n: "C5", d: Q, f: 5 },
  { n: "B4", d: Q, f: 4 }, { n: "A4", d: Q, f: 3 }, { n: "G4", d: Q, f: 2 }, { n: "F4", d: Q, f: 1 },
  { n: "E4", d: Q, f: 3 }, { n: "D4", d: Q, f: 2 }, { n: "C4", d: Q, f: 1 },
  { n: "C4", d: Q, f: 1 }, { n: "D4", d: Q, f: 2 }, { n: "E4", d: Q, f: 3 }, { n: "F4", d: Q, f: 1 },
  { n: "G4", d: Q, f: 2 }, { n: "A4", d: Q, f: 3 }, { n: "B4", d: Q, f: 4 }, { n: "C5", d: Q, f: 5 },
  { n: "B4", d: Q, f: 4 }, { n: "A4", d: Q, f: 3 }, { n: "G4", d: Q, f: 2 }, { n: "F4", d: Q, f: 1 },
  { n: "E4", d: Q, f: 3 }, { n: "D4", d: Q, f: 2 }, { n: "C4", d: Q, f: 1 },
]);

// 半音阶：白键通常用拇指，黑键用中指；F/C 处用 2 指衔接，避免拇指按黑键。
addDrill("tech_chromatic", "半音阶：C4-C5", "technique", 66, [
  { n: "C4", d: E, f: 1 }, { n: "C#4", d: E, f: 3 }, { n: "D4", d: E, f: 1 }, { n: "D#4", d: E, f: 3 },
  { n: "E4", d: E, f: 1 }, { n: "F4", d: E, f: 2 }, { n: "F#4", d: E, f: 3 }, { n: "G4", d: E, f: 1 },
  { n: "G#4", d: E, f: 3 }, { n: "A4", d: E, f: 1 }, { n: "A#4", d: E, f: 3 }, { n: "B4", d: E, f: 1 },
  { n: "C5", d: E, f: 2 },
  { n: "B4", d: E, f: 1 }, { n: "A#4", d: E, f: 3 }, { n: "A4", d: E, f: 1 }, { n: "G#4", d: E, f: 3 },
  { n: "G4", d: E, f: 1 }, { n: "F#4", d: E, f: 3 }, { n: "F4", d: E, f: 2 }, { n: "E4", d: E, f: 1 },
  { n: "D#4", d: E, f: 3 }, { n: "D4", d: E, f: 1 }, { n: "C#4", d: E, f: 3 }, { n: "C4", d: E, f: 1 },
]);

// 短琶音：C 大三和弦一个八度内分解。
addDrill("tech_arpeggio_short", "短琶音：C 大三和弦", "technique", 70, [
  { n: "C4", d: Q, f: 1 }, { n: "E4", d: Q, f: 2 }, { n: "G4", d: Q, f: 3 }, { n: "C5", d: Q, f: 5 },
  { n: "G4", d: Q, f: 3 }, { n: "E4", d: Q, f: 2 }, { n: "C4", d: Q, f: 1 },
  { n: "C4", d: Q, f: 1 }, { n: "E4", d: Q, f: 2 }, { n: "G4", d: Q, f: 3 }, { n: "C5", d: Q, f: 5 },
  { n: "G4", d: Q, f: 3 }, { n: "E4", d: Q, f: 2 }, { n: "C4", d: Q, f: 1 },
]);

// 双音：级进上行/下行三度双音，1+3 与 2+4 交替。
addDrill("tech_double_notes", "双音：三度音程", "technique", 60, [
  { n: ["C4", "E4"], d: Q, f: [1, 3] }, { n: ["D4", "F4"], d: Q, f: [2, 4] },
  { n: ["E4", "G4"], d: Q, f: [1, 3] }, { n: ["F4", "A4"], d: Q, f: [2, 4] },
  { n: ["G4", "B4"], d: Q, f: [1, 3] },
  { n: ["F4", "A4"], d: Q, f: [2, 4] }, { n: ["E4", "G4"], d: Q, f: [1, 3] },
  { n: ["D4", "F4"], d: Q, f: [2, 4] }, { n: ["C4", "E4"], d: Q, f: [1, 3] },
]);

// 和弦：C 大调 I-IV-V-I 原位三和弦，1-3-5 指标准指法。
addDrill("tech_chords", "和弦：I-IV-V-I 原位三和弦", "technique", 60, [
  { n: ["C4", "E4", "G4"], d: H, f: [1, 3, 5] },
  { n: ["F4", "A4", "C5"], d: H, f: [1, 3, 5] },
  { n: ["G4", "B4", "D5"], d: H, f: [1, 3, 5] },
  { n: ["C4", "E4", "G4"], d: H, f: [1, 3, 5] },
]);

// 长琶音：C 大三和弦跨 2 个八度，拇指穿越到第 2 个八度。
addDrill("tech_arpeggio_long", "长琶音：跨两个八度", "technique", 64, [
  { n: "C4", d: Q, f: 1 }, { n: "E4", d: Q, f: 2 }, { n: "G4", d: Q, f: 3 },
  { n: "C5", d: Q, f: 1 }, { n: "E5", d: Q, f: 2 }, { n: "G5", d: Q, f: 3 }, { n: "C6", d: Q, f: 5 },
  { n: "G5", d: Q, f: 3 }, { n: "E5", d: Q, f: 2 }, { n: "C5", d: Q, f: 1 },
  { n: "G4", d: Q, f: 3 }, { n: "E4", d: Q, f: 2 }, { n: "C4", d: Q, f: 1 },
]);

// 轮指：单音快速重复，3-2-1 指轮流触键，避免同指连击。
addDrill("tech_finger_roll", "轮指：单音重复轮指", "technique", 76, [
  { n: "C4", d: E, f: 3 }, { n: "C4", d: E, f: 2 }, { n: "C4", d: E, f: 1 },
  { n: "C4", d: E, f: 3 }, { n: "C4", d: E, f: 2 }, { n: "C4", d: E, f: 1 },
  { n: "C4", d: E, f: 3 }, { n: "C4", d: E, f: 2 },
]);

// 颤音：相邻二度音快速交替，2-3 指交替。
addDrill("tech_trill", "颤音：二度快速交替", "technique", 80, [
  { n: "C4", d: S, f: 2 }, { n: "D4", d: S, f: 3 }, { n: "C4", d: S, f: 2 }, { n: "D4", d: S, f: 3 },
  { n: "C4", d: S, f: 2 }, { n: "D4", d: S, f: 3 }, { n: "C4", d: S, f: 2 }, { n: "D4", d: S, f: 3 },
  { n: "C4", d: S, f: 2 }, { n: "D4", d: S, f: 3 }, { n: "C4", d: S, f: 2 }, { n: "D4", d: S, f: 3 },
]);

// 八度：级进上行/下行八度双音，拇指(1)+小指(5)固定跨度。
addDrill("tech_octaves", "八度：级进八度双音", "technique", 60, [
  { n: ["C4", "C5"], d: Q, f: [1, 5] }, { n: ["D4", "D5"], d: Q, f: [1, 5] },
  { n: ["E4", "E5"], d: Q, f: [1, 5] }, { n: ["F4", "F5"], d: Q, f: [1, 5] },
  { n: ["G4", "G5"], d: Q, f: [1, 5] },
  { n: ["F4", "F5"], d: Q, f: [1, 5] }, { n: ["E4", "E5"], d: Q, f: [1, 5] },
  { n: ["D4", "D5"], d: Q, f: [1, 5] }, { n: ["C4", "C5"], d: Q, f: [1, 5] },
]);

// 分解八度：低音/高音单音快速交替（非同时按下），拇指(1)与小指(5)交替。
addDrill("tech_broken_octaves", "分解八度：低高交替", "technique", 72, [
  { n: "C4", d: E, f: 1 }, { n: "C5", d: E, f: 5 }, { n: "C4", d: E, f: 1 }, { n: "C5", d: E, f: 5 },
  { n: "C4", d: E, f: 1 }, { n: "C5", d: E, f: 5 }, { n: "C4", d: E, f: 1 }, { n: "C5", d: E, f: 5 },
]);

// 震音：五度音程快速交替，比颤音音程更宽、时值更密。
addDrill("tech_tremolo", "震音：五度快速交替", "technique", 80, [
  { n: "C4", d: S, f: 1 }, { n: "G4", d: S, f: 5 }, { n: "C4", d: S, f: 1 }, { n: "G4", d: S, f: 5 },
  { n: "C4", d: S, f: 1 }, { n: "G4", d: S, f: 5 }, { n: "C4", d: S, f: 1 }, { n: "G4", d: S, f: 5 },
  { n: "C4", d: S, f: 1 }, { n: "G4", d: S, f: 5 }, { n: "C4", d: S, f: 1 }, { n: "G4", d: S, f: 5 },
]);

const manifestPath = path.join(ROOT, "06_drills", "drills_manifest.json");
fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
fs.writeFileSync(manifestPath, JSON.stringify(drills, null, 2), "utf8");
console.log(manifestPath);
console.log(`Generated ${drills.length} drills.`);
