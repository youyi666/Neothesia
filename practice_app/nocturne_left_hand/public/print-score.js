/**
 * @desc 夜曲/手型练习室的打印版乐谱——把 ?course=&hand=&from=&to= 指定的这一段
 *   按音名+建议指法画成简化谱面（不画节奏时值），按 A4 横屏分行铺开，供节奏已经
 *   练熟、只需要巩固手感的阶段脱离电脑打印出来对照弹。
 * @usage 浏览器打开 /nocturne-left-hand/print-score.html?course=chopin_nocturne_9_2&hand=right&from=0&to=8
 * @keywords 打印 五线谱 乐谱 A4 PDF 练习室
 */
const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const COURSE_ID = params.get('course') || 'chopin_nocturne_9_2';
const FROM_MEASURE = Math.max(0, Number(params.get('from')) || 0);
const TO_MEASURE = Math.max(FROM_MEASURE + 1, Number(params.get('to')) || FROM_MEASURE + 8);
const HAND = ['right', 'both'].includes(params.get('hand')) ? params.get('hand') : 'left';
const HAND_LABEL = HAND === 'right' ? '右手' : HAND === 'both' ? '双手' : '左手';

// 音名/音级换算跟 app.js 是同一套约定（sharp 一律拼成下一个字母的降号），这个页面
// 是独立静态页面（不能 import app.js 的内部函数），只能照抄一份小的子集——两边改
// 拼写规则时要记得保持一致。
const PITCHES = ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'G♭', 'G', 'A♭', 'A', 'B♭', 'B'];
const LETTER_STEP = { C: 0, D: 1, E: 2, F: 3, G: 4, A: 5, B: 6 };
const pitch = (n) => PITCHES[((n % 12) + 12) % 12];
const octave = (n) => Math.floor(n / 12) - 1;
const name = (n) => pitch(n) + octave(n);
const noteStep = (n) => octave(n) * 7 + LETTER_STEP[pitch(n)[0]];

const IS_TREBLE = HAND === 'right' || HAND === 'both';
const STAFF_BOTTOM_STEP = IS_TREBLE ? 30 : 18; // 高音谱表底线E4 / 低音谱表底线G2
const STAFF_TOP_STEP = IS_TREBLE ? 38 : 26;    // 高音谱表顶线F5 / 低音谱表顶线A3
const CLEF_CHAR = IS_TREBLE ? '\u{1D11E}' : '\u{1D122}';

// 下面全部用 mm 做单位：SVG viewBox 宽高直接等于纸面上的毫米数，屏幕预览和打印
// 出来是同一套坐标，不需要按 DPI 再换算一遍。STEP_MM 比屏幕上练习室用的 8px/155
// 那套紧凑坐标系宽松很多——纸上不像那个固定高度的小组件要在有限像素里塞下最宽
// 音域，可以放心画得大一点，方便打印后翻着弹。
const STEP_MM = 2.4;
const SYSTEM_TOP_MARGIN_MM = 8;
const SYSTEM_BOTTOM_MARGIN_MM = 8; // 给小节号/音名·指法这两行文字留空间
const PAGE_CONTENT_WIDTH_MM = 277; // A4 横屏 297mm 减去 .sheet 左右各 10mm padding
const CLEF_GUTTER_MM = 15;
const RIGHT_MARGIN_MM = 3;
const LINE_USABLE_MM = PAGE_CONTENT_WIDTH_MM - (CLEF_GUTTER_MM + 4) - RIGHT_MARGIN_MM;
// 每个"音符位"（不是每个事件）最小水平间距——够放下单个音"音名-指法"标签不
// 重叠。原来按事件分配间距时，和弦事件（左手常见的低音+和弦，一个事件好几个
// 音）会把整个和弦拼成一条长文字（比如"E♭2-4 G3-5 B♭4-2"），比留的间距宽得多，
// 照样叠成一团。改成拆到音符级别：和弦内每个音各自占一个位置、各自标短标签，
// 跟应用里 drawScoreInto 画和弦的方式（音符横向摊开、各自标注）是同一个思路。
// 注意：不同拍之间用的是"正常"间距，和弦内部才是"收紧"的那一档——不是反过来
// 在正常间距上再加量。第一版改成"和弦内间距 + 跨拍额外加量"，结果纯旋律（右手
// 常见，每个事件只有一个音，事件与事件之间永远是"新一拍"）反而比原来更宽，
// 白白多占地方——纯旋律本来就没有"和弦内/跨拍"的疏密对比可言，不该被这个
// 机制拖累。
const BASE_SPACING_MM = 7;            // 不同拍（新事件）之间的间距，纯旋律也用这个
const CHORD_INTERNAL_SPACING_MM = 4.5; // 同一和弦/事件内部，相邻音符收紧一点——
// 和弦音只标指法（见 noteLabel），标签本身比"音名-指法"短很多，间距可以收得
// 更紧，音高直接从谱表位置读（这本来就是五线谱的作用），不用每个和弦音都重复
// 拼一遍音名。
const MEASURE_SIDE_PADDING_MM = 2.5;
const MIN_MEASURE_WIDTH_MM = 10;

// 把一个小节的事件拆成"音符位"序列——和弦内部按 note 逐个展开，isNewEvent 标记
// 这个音符位是不是新一拍的第一个音（决定用大间距还是和弦内的小间距），isChord
// 标记这个音是不是"和弦音"（事件本身有2个以上的音）——决定标签是完整的
// "音名-指法"还是只标指法（见 noteLabel）。
function flattenSlots(measure) {
  const slots = [];
  measure.events.forEach((ev) => {
    const isChord = ev.notes.length > 1;
    ev.notes.forEach((n, ni) => slots.push({ note: n, isNewEvent: ni === 0, isChord }));
  });
  return slots;
}

// 音符位之间的"自然"累计位置（还没按小节实际分配到的宽度缩放）——和弦内部
// 间距小、跨拍间距大，这个疏密对比在缩放后仍会保留，纸面上还能看出"这几个音
// 是一起按的，那几个音是下一拍"。
function slotNaturalPositions(slots) {
  const positions = [0];
  for (let i = 1; i < slots.length; i++) {
    const gap = slots[i].isNewEvent ? BASE_SPACING_MM : CHORD_INTERNAL_SPACING_MM;
    positions.push(positions[i - 1] + gap);
  }
  return positions;
}

async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function loadSegment() {
  const { course } = await fetchJSON(`/api/courses/${encodeURIComponent(COURSE_ID)}`);
  const lastMeasure = Math.min(TO_MEASURE, course.measure_count);
  if (FROM_MEASURE >= lastMeasure) {
    throw new Error(`小节范围 ${FROM_MEASURE + 1}-${TO_MEASURE} 超出了这首曲子的 ${course.measure_count} 小节`);
  }
  const measures = [];
  for (let m = FROM_MEASURE; m < lastMeasure; m++) {
    const data = await fetchJSON(`/api/courses/${encodeURIComponent(COURSE_ID)}/measures/${m}/practice-data?hand_mode=${HAND}`);
    const events = data.events
      .filter((e) => e.notes.length)
      .map((e) => ({ notes: [...e.notes].sort((a, b) => a.note - b.note) }));
    measures.push({ index: m, events });
  }
  return { course, measures, lastMeasure };
}

// 小节实际需要多宽，按展开后的"音符位"数量算（不是事件数）——一个三音和弦
// 事件展开成3个音符位，各自只需要单音那么窄的位置，不会因为拼成长文字而
// 把小节撑爆。
function measureRequiredWidth(measure) {
  const positions = slotNaturalPositions(flattenSlots(measure));
  const inner = positions.length ? positions[positions.length - 1] : 0;
  return Math.max(MIN_MEASURE_WIDTH_MM, MEASURE_SIDE_PADDING_MM * 2 + inner);
}

// 贪心装箱：一行能塞下多少小节，按每个小节的实际需求宽度算，不再固定"每行4小节"。
// 密的小节自己就占大半行，疏的小节能挤好几个进一行，跟真实排版软件的换行逻辑
// 是同一个道理。
function buildLines(measures) {
  const lines = [];
  let current = [];
  let currentWidth = 0;
  for (const measure of measures) {
    const req = measureRequiredWidth(measure);
    if (current.length && currentWidth + req > LINE_USABLE_MM) {
      lines.push(current);
      current = [];
      currentWidth = 0;
    }
    current.push(measure);
    currentWidth += req;
  }
  if (current.length) lines.push(current);
  return lines;
}

// 谱表在纸面上的竖直位置只按"这一整段"算一次（不是每行各算各的），所有系统
// 共用同一个 staffBottomMm/systemHeightMm——这样每一行的谱表高度完全一致，
// 翻页时视线不用重新适应，跟真实印刷乐谱一样。
function computeLayout(measures) {
  const allSteps = measures.flatMap((m) => m.events.flatMap((e) => e.notes.map((n) => noteStep(n.note))));
  allSteps.push(STAFF_BOTTOM_STEP, STAFF_TOP_STEP);
  const maxStep = Math.max(...allSteps);
  const minStep = Math.min(...allSteps);
  const ledgerAbove = Math.max(0, maxStep - STAFF_TOP_STEP);
  const ledgerBelow = Math.max(0, STAFF_BOTTOM_STEP - minStep);
  const staffBottomMm = SYSTEM_TOP_MARGIN_MM + ledgerAbove * STEP_MM + (STAFF_TOP_STEP - STAFF_BOTTOM_STEP) * STEP_MM;
  const systemHeightMm = staffBottomMm + ledgerBelow * STEP_MM + SYSTEM_BOTTOM_MARGIN_MM;
  return { staffBottomMm, systemHeightMm };
}

// 和弦音（isChordTone=true）只标指法，不重复拼音名——音高本来就能从谱表上的
// 位置直接读出来，五线谱存在的意义就是这个；每个和弦音都重复标一遍音名只会
// 把标签拉得比单音还长，挤占本来就紧张的横向空间。单音（旋律/低音）仍然保留
// 完整"音名-指法"，这类位置不缺空间，完整标注也确实有助于确认具体音高。
function noteLabel(n, isChordTone) {
  const finger = Number.isInteger(n.finger) ? String(n.finger) : '';
  const handTag = HAND === 'both' ? (n.hand === 'left' ? 'L' : 'R') : '';
  if (isChordTone) return finger ? `${finger}${handTag}` : (handTag || '·');
  return `${name(n.note)}${finger ? '-' + finger : ''}${handTag}`;
}

function drawSystem(measuresInLine, isLastLine, staffBottomMm, systemHeightMm) {
  const startX = CLEF_GUTTER_MM + 4;
  const top = staffBottomMm - (STAFF_TOP_STEP - STAFF_BOTTOM_STEP) * STEP_MM;

  // 每个小节按 measureRequiredWidth 分配实际宽度，不再是"总宽度 / 小节数"的
  // 等分——密的小节自己占大半行，疏的小节挤得下好几个，行内没有一个小节会被
  // 硬压扁。非最后一行整体缩放铺满 LINE_USABLE_MM（两端对齐，跟印刷乐谱一样）；
  // 最后一行按自然宽度左对齐，不强行拉伸——收尾没写满整行是正常的，硬拉伸只会
  // 让音符间距忽宽忽窄，比留白更难看。
  const requiredWidths = measuresInLine.map(measureRequiredWidth);
  const totalRequired = requiredWidths.reduce((a, b) => a + b, 0);
  const scale = isLastLine ? 1 : LINE_USABLE_MM / totalRequired;
  const measureWidths = requiredWidths.map((w) => w * scale);
  const finalX = startX + measureWidths.reduce((a, b) => a + b, 0);

  let svg = `<svg viewBox="0 0 ${PAGE_CONTENT_WIDTH_MM} ${systemHeightMm}" role="img" aria-label="这一行的乐谱">`;
  svg += `<path d="M${startX} ${top}V${staffBottomMm}" stroke="#222" stroke-width="0.35"/>`;
  for (let y = top; y <= staffBottomMm + 0.01; y += STEP_MM * 2) {
    svg += `<path d="M${startX} ${y}H${finalX}" stroke="#222" stroke-width="0.22"/>`;
  }
  const clefFontSize = IS_TREBLE ? 15 : 12;
  const clefY = IS_TREBLE ? staffBottomMm + 2.4 : staffBottomMm - 1;
  svg += `<text x="${startX - CLEF_GUTTER_MM + 2}" y="${clefY}" font-size="${clefFontSize}" font-family="Segoe UI Symbol, Noto Music, serif" fill="#111">${CLEF_CHAR}</text>`;

  let cursorX = startX;
  measuresInLine.forEach((measure, mi) => {
    const mStartX = cursorX;
    const mEndX = mStartX + measureWidths[mi];
    cursorX = mEndX;
    const innerStart = mStartX + (mi === 0 ? 3.5 : 2);
    const innerEnd = mEndX - 2;
    // 按"音符位"（和弦拆开后的每个音）摆位，不按事件——position 是未缩放的
    // 自然间距（和弦内紧、跨拍松），按小节实际分配到的宽度整体缩放，疏密对比
    // 保留下来。
    const slots = flattenSlots(measure);
    const positions = slotNaturalPositions(slots);
    const naturalInner = positions.length ? positions[positions.length - 1] : 0;
    const slotX = (i) => (naturalInner > 0
      ? innerStart + (positions[i] / naturalInner) * (innerEnd - innerStart)
      : (innerStart + innerEnd) / 2);
    // 兜底缩字号：正常情况下相邻音符位的实际间距 >= CHORD_INTERNAL_SPACING_MM
    // （非最后一行只会被拉伸，不会被压缩），这里基本不会触发；只有单个小节
    // 音符位多到连自然宽度都超出整行、又是最后一行不被拉伸时才会用上。
    let minGap = Infinity;
    for (let i = 1; i < slots.length; i++) minGap = Math.min(minGap, slotX(i) - slotX(i - 1));
    const labelFontSize = slots.length > 1 ? Math.max(1.3, Math.min(2.5, minGap * 0.36)) : 2.5;
    slots.forEach((slot, i) => {
      const x = slotX(i);
      const n = slot.note;
      const y = staffBottomMm - (noteStep(n.note) - STAFF_BOTTOM_STEP) * STEP_MM;
      for (let ly = staffBottomMm + STEP_MM * 2; ly <= y + 0.01; ly += STEP_MM * 2) {
        svg += `<path d="M${x - 3.2} ${ly}h6.4" stroke="#222" stroke-width="0.3"/>`;
      }
      for (let ly = top - STEP_MM * 2; ly >= y - 0.01; ly -= STEP_MM * 2) {
        svg += `<path d="M${x - 3.2} ${ly}h6.4" stroke="#222" stroke-width="0.3"/>`;
      }
      svg += `<ellipse cx="${x}" cy="${y}" rx="1.7" ry="1.2" transform="rotate(-17 ${x} ${y})" fill="#111"/>`;
      if (pitch(n.note).includes('♭')) svg += `<text x="${x - 4.4}" y="${y + 1}" font-size="3" fill="#111">♭</text>`;
      svg += `<text x="${x}" y="${systemHeightMm - 2}" text-anchor="middle" font-family="system-ui" font-size="${labelFontSize}" fill="#333">${noteLabel(n, slot.isChord)}</text>`;
    });
    svg += `<text x="${mStartX + 1}" y="${top - 1.8}" font-family="system-ui" font-size="2.6" fill="#777">${measure.index + 1}</text>`;
    const isVeryLast = isLastLine && mi === measuresInLine.length - 1;
    if (isVeryLast) {
      svg += `<path d="M${mEndX - 1} ${top}V${staffBottomMm}" stroke="#222" stroke-width="0.3"/>`;
      svg += `<path d="M${mEndX} ${top}V${staffBottomMm}" stroke="#222" stroke-width="0.9"/>`;
    } else {
      svg += `<path d="M${mEndX} ${top}V${staffBottomMm}" stroke="#222" stroke-width="0.35"/>`;
    }
  });
  svg += '</svg>';
  return svg;
}

async function main() {
  const systemsEl = $('systems');
  try {
    const { course, measures, lastMeasure } = await loadSegment();
    const metaText = `${HAND_LABEL} · 第 ${FROM_MEASURE + 1}-${lastMeasure} 小节`;
    document.title = `${course.title} · 打印乐谱`;
    $('sheet-title').textContent = course.title;
    $('sheet-meta').textContent = metaText;
    $('tb-title').textContent = course.title;
    $('tb-meta').textContent = metaText;

    const nonEmpty = measures.filter((m) => m.events.length);
    if (!nonEmpty.length) throw new Error(`第 ${FROM_MEASURE + 1}-${lastMeasure} 小节没有${HAND_LABEL}音符事件`);

    const lines = buildLines(measures);
    const { staffBottomMm, systemHeightMm } = computeLayout(measures);
    systemsEl.innerHTML = lines
      .map((line, i) => `<div>${drawSystem(line, i === lines.length - 1, staffBottomMm, systemHeightMm)}</div>`)
      .join('');
  } catch (e) {
    systemsEl.innerHTML = `<p class="status">加载失败：${e.message}<br>请确认 practice_app 服务器正在运行，且课程 ID / 小节范围正确。</p>`;
  }
}

$('print-btn').onclick = () => window.print();
main();
