const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const html = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'index.html'),
  'utf8',
);

test('desktop practice view can use a 1600px-wide workspace', () => {
  assert.match(
    html,
    /#root\[data-render-key\^="practice:"\] \.hdr-shell,\s*#root\[data-render-key\^="practice:"\] \.content-inner\s*{\s*width:min\(1600px,100%\);/s,
  );
  assert.match(
    html,
    /#root\[data-render-key\^="practice:"\] \.practice-score-layout\s*{\s*width:100%;/s,
  );
});

test('small desktop practice view stacks the finger guide above the score', () => {
  const smallDesktopMedia = html.match(
    /@media \(max-width:1200px\)\s*{([\s\S]*?)\n}/,
  );

  assert.ok(smallDesktopMedia, 'missing the small-desktop practice breakpoint');
  assert.match(
    smallDesktopMedia[1],
    /\.practice-score-layout\s*{\s*display:flex;\s*flex-direction:column;/,
  );
  assert.match(
    smallDesktopMedia[1],
    /\.practice-finger-float\s*{\s*position:static;[\s\S]*?width:100%;/,
  );
});

test('short landscape view removes the hidden finger-guide grid column', () => {
  const shortLandscapeMedia = [
    ...html.matchAll(
      /@media \(orientation:landscape\) and \(max-height:700px\)\s*{([\s\S]*?)\n}/g,
    ),
  ].find(match => match[1].includes('.practice-finger-float'));

  assert.ok(shortLandscapeMedia, 'missing the short-landscape breakpoint');
  assert.match(
    shortLandscapeMedia[1],
    /\.practice-score-layout\s*{\s*display:block;\s*width:100%;\s*margin-top:0;/,
  );
});

test('lesson score annotations stay inside the final measure boundary', () => {
  assert.match(
    html,
    /const finalBarlineX = contentX \+ systemMeasures \* measureWidth;/,
  );
  assert.match(
    html,
    /finalBarlineX - noteRightSafety/,
  );
  assert.match(
    html,
    /const rightContentPadding = lessonMode \? 76 : 50;/,
  );
  assert.doesNotMatch(
    html,
    /const xForBeat = beat => Math\.min\(width - 32/,
  );
});

test('dense lesson annotations use horizontal lanes and preserve the grand-staff gap', () => {
  assert.match(
    html,
    /function annotationLaneX\(x, stackIndex, minX, maxX\)/,
  );
  assert.match(
    html,
    /const laneOffsets = \[0, -14, 14, -28, 28, -42, 42\];/,
  );
  assert.match(
    html,
    /layout\.hasBass && clef === 'treble' \? 58 : 76/,
  );
  assert.match(
    html,
    /annotationMaxX: finalBarlineX - 12/,
  );
});
