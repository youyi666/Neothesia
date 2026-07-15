const fs   = require('fs');
const path = require('path');

const INPUT   = path.resolve(__dirname, '../../qing-hua-ci-zhou-jie-lun-arr-norm4ndy.mid');
const OUT_DIR = path.resolve(__dirname, '../05_qinghuaci');

fs.mkdirSync(OUT_DIR, { recursive: true });

const src = fs.readFileSync(INPUT);

// 将文件中所有 tempo 元事件替换成目标 BPM 对应的值
function setTempo(buf, bpm) {
  const result  = Buffer.from(buf);
  const usPerBeat = Math.round(60_000_000 / bpm);
  for (let i = 0; i < result.length - 5; i++) {
    if (result[i] === 0xFF && result[i+1] === 0x51 && result[i+2] === 0x03) {
      result[i+3] = (usPerBeat >> 16) & 0xFF;
      result[i+4] = (usPerBeat >>  8) & 0xFF;
      result[i+5] =  usPerBeat        & 0xFF;
    }
  }
  return result;
}

const configs = [
  { file: '01_超慢_45bpm.mid',   bpm: 45,  label: 'Lv.1 超慢 45 BPM（原速42%）· 初次接触，听清每个音' },
  { file: '02_慢速_60bpm.mid',   bpm: 60,  label: 'Lv.2 慢速 60 BPM（原速56%）· 双手跟弹' },
  { file: '03_中慢_80bpm.mid',   bpm: 80,  label: 'Lv.3 中慢 80 BPM（原速75%）· 提速巩固' },
  { file: '04_原速_107bpm.mid',  bpm: 107, label: 'Lv.4 原速 107 BPM · 目标速度' },
];

for (const c of configs) {
  const out = setTempo(src, c.bpm);
  fs.writeFileSync(path.join(OUT_DIR, c.file), out);
  console.log(`✓ ${c.label}`);
}

console.log(`\n输出目录: ${OUT_DIR}`);
