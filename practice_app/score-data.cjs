const fs = require('fs');
const path = require('path');

function readVarLength(buffer, start) {
  let value = 0;
  let offset = start;
  let byte;
  do {
    if (offset >= buffer.length) throw new Error('Unexpected end of MIDI variable length value');
    byte = buffer[offset++];
    value = (value << 7) | (byte & 0x7f);
  } while (byte & 0x80);
  return { value, offset };
}

function roundBeat(value) {
  return Math.round(value * 1000000) / 1000000;
}

function parseMidi(file) {
  const buffer = fs.readFileSync(file);
  if (buffer.toString('ascii', 0, 4) !== 'MThd') throw new Error('Missing MThd header');

  const headerLength = buffer.readUInt32BE(4);
  const trackCount = buffer.readUInt16BE(10);
  const division = buffer.readUInt16BE(12);
  if (division & 0x8000) throw new Error('SMPTE MIDI timing is not supported');

  const ticksPerQuarter = division;
  let offset = 8 + headerLength;
  let numerator = 4;
  let denominator = 4;
  let bpm = 120;
  let title = path.basename(file, path.extname(file));
  const tracks = [];

  for (let trackIndex = 0; trackIndex < trackCount; trackIndex++) {
    if (buffer.toString('ascii', offset, offset + 4) !== 'MTrk') {
      throw new Error(`Missing MTrk header at track ${trackIndex}`);
    }
    const trackLength = buffer.readUInt32BE(offset + 4);
    const end = offset + 8 + trackLength;
    offset += 8;

    let tick = 0;
    let runningStatus = null;
    let trackName = '';
    let primaryChannel = null;
    const active = new Map();
    const notes = [];

    while (offset < end) {
      const delta = readVarLength(buffer, offset);
      tick += delta.value;
      offset = delta.offset;

      let status = buffer[offset++];
      if (status < 0x80) {
        if (runningStatus === null) throw new Error(`Invalid running status in track ${trackIndex}`);
        offset--;
        status = runningStatus;
      } else if (status < 0xf0) {
        runningStatus = status;
      }

      if (status === 0xff) {
        runningStatus = null;
        const type = buffer[offset++];
        const length = readVarLength(buffer, offset);
        offset = length.offset;
        const payload = buffer.subarray(offset, offset + length.value);
        offset += length.value;
        if (type === 0x03) {
          const name = payload.toString('utf8').trim();
          if (name) {
            trackName = name;
            if (trackIndex === 0) title = name;
          }
        } else if (type === 0x51 && payload.length === 3) {
          const micros = (payload[0] << 16) | (payload[1] << 8) | payload[2];
          if (micros) bpm = Math.round(60000000 / micros);
        } else if (type === 0x58 && payload.length >= 2) {
          numerator = payload[0];
          denominator = 2 ** payload[1];
        }
        continue;
      }

      if (status === 0xf0 || status === 0xf7) {
        runningStatus = null;
        const length = readVarLength(buffer, offset);
        offset = length.offset + length.value;
        continue;
      }

      const command = status & 0xf0;
      const channel = status & 0x0f;
      const data1 = buffer[offset++];
      const data2 = (command === 0xc0 || command === 0xd0) ? null : buffer[offset++];

      if (command === 0x90 && data2 > 0) {
        if (primaryChannel === null) primaryChannel = channel;
        const key = `${channel}:${data1}`;
        const starts = active.get(key) || [];
        starts.push({ tick, velocity: data2 });
        active.set(key, starts);
      } else if (command === 0x80 || (command === 0x90 && data2 === 0)) {
        const key = `${channel}:${data1}`;
        const starts = active.get(key);
        if (starts?.length) {
          const started = starts.shift();
          if (!starts.length) active.delete(key);
          notes.push({
            midi: data1,
            start: roundBeat(started.tick / ticksPerQuarter),
            duration: roundBeat((tick - started.tick) / ticksPerQuarter),
            velocity: started.velocity,
          });
        }
      }
    }

    offset = end;
    if (notes.length) {
      notes.sort((a, b) => a.start - b.start || a.midi - b.midi);
      const lowerName = trackName.toLowerCase();
      const role = lowerName.includes('left') || primaryChannel === 1 ? 'left' : 'right';
      tracks.push({ name: trackName || `Track ${trackIndex}`, role, notes });
    }
  }

  const totalBeats = tracks.reduce((max, track) => {
    return Math.max(max, ...track.notes.map(note => note.start + note.duration));
  }, 0);

  return {
    title,
    bpm,
    numerator,
    denominator,
    ticksPerQuarter,
    totalBeats: roundBeat(totalBeats),
    tracks,
  };
}

function listMidiFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return listMidiFiles(full);
    return entry.isFile() && path.extname(entry.name).toLowerCase() === '.mid' ? [full] : [];
  });
}

function loadScoreLibrary(midiRoot) {
  const folders = ['01_single_hand', '02_two_hands_easy', '03_beautiful_slow', '04_challenge'];
  const library = {};
  const errors = [];

  for (const folder of folders) {
    for (const file of listMidiFiles(path.join(midiRoot, folder))) {
      const relative = path.relative(midiRoot, file).split(path.sep).join('/');
      try {
        library[relative] = parseMidi(file);
      } catch (error) {
        errors.push(`${relative}: ${error.message}`);
      }
    }
  }

  return { library, errors };
}

module.exports = { parseMidi, loadScoreLibrary, listMidiFiles };
