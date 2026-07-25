'use strict';
// Launches the Neothesia GUI with a lesson MIDI file pre-loaded.
//
// Verified against the actual source (not assumed, per doc 十八):
//  - neothesia/src/song.rs Song::from_env() reads std::env::args()[1] as a
//    MIDI path, so `neothesia.exe <path>` opens it directly. No workarounds
//    (file association / simulated keystrokes) are needed.
//  - neothesia-core/src/utils/resources.rs resolves default.sf2 and
//    settings.ron as `./default.sf2` / `./settings.ron` on Windows - i.e.
//    relative to the process's CURRENT WORKING DIRECTORY, not the exe's
//    location. Those files live at the repo root, so the child process must
//    be spawned with cwd = repo root or the soundfont/settings won't load.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { readSettings } = require('./course-store.js');

const REPO_ROOT = path.join(__dirname, '..', '..');

function candidatePaths() {
  const exeName = process.platform === 'win32' ? 'neothesia.exe' : 'neothesia';
  return [
    path.join(REPO_ROOT, 'target', 'release', exeName),
    path.join(REPO_ROOT, 'target', 'debug', exeName),
  ];
}

function findNeothesiaExecutable() {
  const override = readSettings().neothesiaPath || process.env.NEOTHESIA_PATH;
  if (override && fs.existsSync(override)) return override;
  return candidatePaths().find(p => fs.existsSync(p)) || null;
}

/**
 * @param {string} midiAbsPath - absolute path to the lesson MIDI to open
 * @returns {{ pid: number, exe: string }}
 */
function launchNeothesia(midiAbsPath) {
  if (!path.isAbsolute(midiAbsPath)) throw new Error('midiAbsPath must be an absolute path');
  if (!fs.existsSync(midiAbsPath)) throw new Error(`MIDI file not found: ${midiAbsPath}`);

  const exe = findNeothesiaExecutable();
  if (!exe) {
    throw new Error(
      'Neothesia executable not found. Build it with `cargo build -p neothesia` (or --release), ' +
        'or set "neothesiaPath" in practice_app/data/settings.json.',
    );
  }

  const child = spawn(exe, [midiAbsPath], {
    cwd: REPO_ROOT, // required so ./default.sf2 and ./settings.ron resolve (Windows)
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  return { pid: child.pid, exe };
}

module.exports = { findNeothesiaExecutable, launchNeothesia, REPO_ROOT };
