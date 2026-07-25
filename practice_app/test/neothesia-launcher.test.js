'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { findNeothesiaExecutable, launchNeothesia, REPO_ROOT } = require('../lib/neothesia-launcher.js');

test('findNeothesiaExecutable locates the built debug/release binary', () => {
  const exe = findNeothesiaExecutable();
  assert.ok(exe, 'expected a built neothesia executable under target/debug or target/release');
  assert.ok(fs.existsSync(exe));
});

test('REPO_ROOT points at the directory containing default.sf2 (cwd resolution requirement)', () => {
  // neothesia-core resolves `./default.sf2` relative to CWD on Windows, so the
  // launcher must spawn with cwd = REPO_ROOT for the soundfont to load.
  assert.ok(fs.existsSync(path.join(REPO_ROOT, 'default.sf2')));
});

test('launchNeothesia rejects a relative MIDI path', () => {
  assert.throws(() => launchNeothesia('relative/lesson.mid'), /absolute path/);
});

test('launchNeothesia rejects a MIDI path that does not exist', () => {
  const missing = path.join(REPO_ROOT, 'practice_app', 'does-not-exist-lesson.mid');
  assert.throws(() => launchNeothesia(missing), /not found/);
});

// NOTE: actually spawning Neothesia opens a real GUI window, so it is
// intentionally not exercised by the automated suite. Verified manually
// instead (see dev log / README).
