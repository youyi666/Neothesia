const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const htmlPath = path.join(__dirname, '..', 'public', 'index.html');
const html = fs.readFileSync(htmlPath, 'utf8');

function functionSource(name, nextName) {
  const start = html.indexOf(`function ${name}(`);
  const end = html.indexOf(`function ${nextName}(`, start + 1);
  assert.notEqual(start, -1, `missing function ${name}`);
  assert.notEqual(end, -1, `missing function ${nextName}`);
  return html.slice(start, end);
}

test('practice render schedules one score redraw per UI render', () => {
  const source = functionSource('render', 'setView');
  const redraws = source.match(
    /requestAnimationFrame\(\(\) => renderPracticeScore\(state\.practice\)\)/g,
  ) || [];

  assert.equal(redraws.length, 1);
});

test('practice score only follows the cursor when the staff system changes', () => {
  const source = functionSource('renderPracticeScore', 'scrollPracticeSystemIntoView');

  assert.match(source, /const previousSystem = p\.lastScoreSystem/);
  assert.match(source, /previousSystem !== currentSystem/);

  let currentSystem = 0;
  let scheduledScrolls = 0;
  const mount = {
    getBoundingClientRect: () => ({ width: 800 }),
    replaceChildren: () => {},
    querySelector: () => ({
      dataset: { practiceSystem: String(currentSystem) },
    }),
  };
  const context = {
    document: { getElementById: () => mount },
    buildStaffSvg: () => ({}),
    practiceNoteTone: () => '',
    practiceScoreAnnotation: () => null,
    requestAnimationFrame: () => { scheduledScrolls += 1; },
  };
  const renderPracticeScore = vm.runInNewContext(`(${source.trim()})`, context);
  const practice = {
    finished: null,
    sheet: {
      score: {},
      targetEventIndexes: [0],
    },
    session: { getEventIndex: () => 0 },
  };

  renderPracticeScore(practice);
  assert.equal(scheduledScrolls, 1, 'the initial staff system should be positioned once');

  renderPracticeScore(practice);
  assert.equal(scheduledScrolls, 1, 'notes on the same staff system must not trigger another scroll');

  currentSystem = 1;
  renderPracticeScore(practice);
  assert.equal(scheduledScrolls, 2, 'moving to the next staff system should trigger one scroll');
});
