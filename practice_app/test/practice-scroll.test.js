const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const htmlPath = path.join(__dirname, '..', 'public', 'index.html');
const html = fs.readFileSync(htmlPath, 'utf8');

function functionSource(name, nextName) {
  const start = html.indexOf(`function ${name}(`);
  const end = html.indexOf(`function ${nextName}(`, start + 1);
  assert.notEqual(start, -1, `missing function ${name}`);
  assert.notEqual(end, -1, `missing function ${nextName}`);
  return html.slice(start, end);
}

test('practice render restores scrolling before synchronously redrawing the score', () => {
  const source = functionSource('render', 'setView');
  const restoreIndex = source.indexOf('if (nextScroller) nextScroller.scrollTop = prevScrollTop;');
  const redrawIndex = source.indexOf('renderPracticeScore(state.practice);');
  const redraws = source.match(/renderPracticeScore\(state\.practice\);/g) || [];

  assert.equal(redraws.length, 1);
  assert.ok(restoreIndex >= 0, 'the rebuilt scroll container should restore its prior position');
  assert.ok(redrawIndex > restoreIndex, 'the score should redraw after restoring the scroll position');
  assert.doesNotMatch(source, /requestAnimationFrame\(\(\) => renderPracticeScore/);
});

test('practice score paginates the staff instead of scrolling to the cursor', () => {
  const source = functionSource('renderPracticeScore', 'scrollPracticeSystemIntoView');

  assert.match(source, /practiceScoreSystemForEvent/);
  assert.match(source, /practiceSystemsPerPage/);
  assert.match(source, /pageSystemStart/);
  assert.match(source, /pageSystemCount:systemsPerPage/);
  assert.doesNotMatch(source, /scrollPracticeSystemIntoView\(/);
});

test('staff SVG can render only the current page of systems', () => {
  const source = functionSource('buildStaffSvg', 'renderActiveScore');

  assert.match(source, /pageSystemStart/);
  assert.match(source, /pageSystemEnd/);
  assert.match(source, /visibleSystemCount/);
  assert.match(source, /for \(let system = pageSystemStart; system < pageSystemEnd; system\+\+\)/);
  assert.match(source, /const displaySystem = system - pageSystemStart/);
});

test('practice page is a fixed score slide with a single-line progress strip', () => {
  assert.match(html, /#root\[data-render-key\^="practice:"\] \.content \{\s*overflow:hidden;/);
  assert.match(html, /#root\[data-render-key\^="practice:"\] \.practice-stage \{[\s\S]*?flex-wrap:nowrap;/);
  assert.match(html, /#root\[data-render-key\^="practice:"\] \.practice-wrap \{[\s\S]*?grid-template-rows:auto minmax\(0,1fr\) auto;/);
});
