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
