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

test('practice score checks cursor visibility without forgetting a temporarily missing cursor', () => {
  const source = functionSource('renderPracticeScore', 'scrollPracticeSystemIntoView');

  let currentSystem = 0;
  let currentAnchor = {
    dataset: { practiceSystem: String(currentSystem) },
  };
  let followedAnchors = 0;
  const mount = {
    getBoundingClientRect: () => ({ width: 800 }),
    replaceChildren: () => {},
    querySelector: () => currentAnchor,
  };
  const context = {
    document: { getElementById: () => mount },
    buildStaffSvg: () => ({}),
    practiceNoteTone: () => '',
    practiceScoreAnnotation: () => null,
    scrollPracticeSystemIntoView: anchor => {
      assert.equal(anchor, currentAnchor);
      followedAnchors += 1;
    },
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
  assert.equal(followedAnchors, 1, 'the initial staff system should be positioned once');

  renderPracticeScore(practice);
  assert.equal(followedAnchors, 2, 'the same staff system should still have its visibility checked');

  currentAnchor = null;
  renderPracticeScore(practice);
  assert.equal(practice.lastScoreSystem, 0, 'a missing anchor must not erase the last stable system');
  assert.equal(followedAnchors, 2, 'a missing anchor must not schedule a new scroll');

  currentSystem = 1;
  currentAnchor = {
    dataset: { practiceSystem: String(currentSystem) },
  };
  renderPracticeScore(practice);
  assert.equal(followedAnchors, 3, 'moving to the next staff system should check the new anchor');
});

test('cursor visibility check only writes scrollTop outside the safe zone', () => {
  const source = functionSource('scrollPracticeSystemIntoView', 'renderScoreModeControls');
  const contentRect = { top: 64, bottom: 535, height: 471 };
  let writes = 0;
  let scrollTop = 120;
  const content = {
    get scrollTop() { return scrollTop; },
    set scrollTop(value) { scrollTop = value; writes += 1; },
    scrollHeight: 1500,
    clientHeight: 471,
    getBoundingClientRect: () => contentRect,
  };
  let anchorRect = { top: 220, bottom: 220 };
  const anchor = {
    closest: selector => selector === '.content' ? content : null,
    getBoundingClientRect: () => anchorRect,
  };
  const scrollPracticeSystemIntoView = vm.runInNewContext(`(${source.trim()})`);

  scrollPracticeSystemIntoView(anchor);
  assert.equal(writes, 0, 'a visible cursor must not disturb manual scrolling');

  anchorRect = { top: 520, bottom: 520 };
  scrollPracticeSystemIntoView(anchor);
  assert.equal(writes, 1, 'an offscreen cursor should be brought back once');
  assert.ok(scrollTop > 120, 'following a lower cursor should move the score downward');
});
