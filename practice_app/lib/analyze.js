'use strict';
// Turns a parsed MIDI (from lib/midi-file.js) into the information the
// course/lesson layer needs: per-track summaries, tempo/time-signature,
// measure boundaries, and merged "note events" (simultaneous notes = one
// chord event, per doc section MVP-2/3).

const { META_TEMPO, META_TIME_SIGNATURE, META_TRACK_NAME } = require('./midi-file.js');

const DEFAULT_CHORD_TOLERANCE_TICKS_FACTOR = 1 / 32; // ~ a 128th note at 4 beats/measure

function extractTrackNotes(events) {
  const notes = [];
  const active = new Map(); // `${channel}:${note}` -> stack of {tick, velocity}
  for (const event of events) {
    if (event.type === 'noteOn') {
      const key = `${event.channel}:${event.note}`;
      const stack = active.get(key) || [];
      stack.push({ tick: event.tick, velocity: event.velocity });
      active.set(key, stack);
    } else if (event.type === 'noteOff') {
      const key = `${event.channel}:${event.note}`;
      const stack = active.get(key);
      if (stack && stack.length) {
        const started = stack.shift();
        if (!stack.length) active.delete(key);
        notes.push({
          note: event.note,
          channel: event.channel,
          tick: started.tick,
          endTick: event.tick,
          velocity: started.velocity,
        });
      }
    }
  }
  notes.sort((a, b) => a.tick - b.tick || a.note - b.note);
  return notes;
}

function getTrackName(events) {
  const meta = events.find(e => e.type === 'meta' && e.metaType === META_TRACK_NAME);
  return meta ? meta.text.trim() : '';
}

function getTempoEvents(midi) {
  const tempos = [];
  for (const track of midi.tracks) {
    for (const event of track) {
      if (event.type === 'meta' && event.metaType === META_TEMPO) {
        tempos.push({ tick: event.tick, microsecondsPerQuarter: event.microsecondsPerQuarter });
      }
    }
  }
  tempos.sort((a, b) => a.tick - b.tick);
  return tempos.length ? tempos : [{ tick: 0, microsecondsPerQuarter: 500000 }];
}

function getTimeSignatureEvents(midi) {
  const sigs = [];
  for (const track of midi.tracks) {
    for (const event of track) {
      if (event.type === 'meta' && event.metaType === META_TIME_SIGNATURE) {
        sigs.push({ tick: event.tick, numerator: event.numerator, denominator: event.denominator });
      }
    }
  }
  sigs.sort((a, b) => a.tick - b.tick);
  if (!sigs.length || sigs[0].tick !== 0) sigs.unshift({ tick: 0, numerator: 4, denominator: 4 });
  return sigs;
}

function ticksPerMeasure(ticksPerQuarter, numerator, denominator) {
  return ticksPerQuarter * 4 * (numerator / denominator);
}

// Returns [{ index, startTick, endTick, numerator, denominator }]
function computeMeasures(midi, endTick) {
  const sigs = getTimeSignatureEvents(midi);
  const measures = [];
  let tick = 0;
  let index = 0;
  for (let i = 0; i < sigs.length && tick < endTick; i++) {
    const sig = sigs[i];
    const nextChange = i + 1 < sigs.length ? sigs[i + 1].tick : endTick;
    const measureLen = ticksPerMeasure(midi.ticksPerQuarter, sig.numerator, sig.denominator);
    if (measureLen <= 0) continue;
    while (tick < nextChange && tick < endTick) {
      measures.push({
        index,
        startTick: tick,
        endTick: Math.min(tick + measureLen, endTick),
        numerator: sig.numerator,
        denominator: sig.denominator,
      });
      tick += measureLen;
      index++;
    }
  }
  return measures;
}

function guessRole(name, notes) {
  const lower = name.toLowerCase();
  if (/\b(left|lh|l\.h\.|bass)\b/.test(lower)) return 'left';
  if (/\b(right|rh|r\.h\.|melody|treble)\b/.test(lower)) return 'right';
  if (!notes.length) return 'unknown';
  const avgPitch = notes.reduce((sum, n) => sum + n.note, 0) / notes.length;
  return avgPitch < 60 ? 'left' : 'right';
}

function songEndTick(midi) {
  let end = 0;
  for (const track of midi.tracks) {
    for (const event of track) end = Math.max(end, event.tick);
  }
  return end;
}

// notes: flat array from one or more tracks (already merged), sorted by tick.
// Groups near-simultaneous note-ons into chord "events" per doc requirement
// that a chord must never be split across levels.
function groupIntoEvents(notes, ticksPerQuarter) {
  const tolerance = ticksPerQuarter * DEFAULT_CHORD_TOLERANCE_TICKS_FACTOR;
  const sorted = notes.slice().sort((a, b) => a.tick - b.tick || a.note - b.note);
  const events = [];
  for (const note of sorted) {
    const last = events[events.length - 1];
    if (last && note.tick - last.tick <= tolerance) {
      last.notes.push(note);
      last.endTick = Math.max(last.endTick, note.endTick);
    } else {
      events.push({ tick: note.tick, endTick: note.endTick, notes: [note] });
    }
  }
  events.forEach((event, index) => { event.index = index; });
  return events;
}

function analyzeSong(midi, { title } = {}) {
  const tempos = getTempoEvents(midi);
  const bpm = Math.round(60000000 / tempos[0].microsecondsPerQuarter);
  const timeSignatures = getTimeSignatureEvents(midi);
  const endTick = songEndTick(midi);
  const measures = computeMeasures(midi, endTick);

  let resolvedTitle = title;
  const tracks = midi.tracks.map((events, index) => {
    const notes = extractTrackNotes(events);
    const name = getTrackName(events);
    if (index === 0 && !resolvedTitle && name) resolvedTitle = name;
    const pitches = notes.map(n => n.note);
    const channels = [...new Set(notes.map(n => n.channel))];
    return {
      index,
      name,
      channels,
      noteCount: notes.length,
      minPitch: pitches.length ? Math.min(...pitches) : null,
      maxPitch: pitches.length ? Math.max(...pitches) : null,
      roleGuess: guessRole(name, notes),
    };
  });

  return {
    title: resolvedTitle || 'Untitled',
    bpm,
    timeSignature: { numerator: timeSignatures[0].numerator, denominator: timeSignatures[0].denominator },
    timeSignatureChanges: timeSignatures,
    ticksPerQuarter: midi.ticksPerQuarter,
    durationTicks: endTick,
    durationSeconds: ticksToSeconds(endTick, midi.ticksPerQuarter, tempos),
    measureCount: measures.length,
    measures,
    tracks,
  };
}

function ticksToSeconds(tick, ticksPerQuarter, tempos) {
  let seconds = 0;
  let lastTick = 0;
  let lastUsPerQuarter = tempos[0].microsecondsPerQuarter;
  for (const change of tempos) {
    if (change.tick >= tick) break;
    if (change.tick > lastTick) {
      seconds += ((change.tick - lastTick) / ticksPerQuarter) * (lastUsPerQuarter / 1e6);
    }
    lastTick = change.tick;
    lastUsPerQuarter = change.microsecondsPerQuarter;
  }
  seconds += ((tick - lastTick) / ticksPerQuarter) * (lastUsPerQuarter / 1e6);
  return seconds;
}

module.exports = {
  extractTrackNotes,
  computeMeasures,
  groupIntoEvents,
  analyzeSong,
  getTempoEvents,
  getTimeSignatureEvents,
  ticksPerMeasure,
  songEndTick,
};
