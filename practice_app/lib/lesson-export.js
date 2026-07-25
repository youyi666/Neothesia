'use strict';
// Slices a parsed MIDI (lib/midi-file.js) down to a lesson-sized fragment
// and re-encodes it as a standalone, playable MIDI file.
//
// Handles (per MVP功能五 in the requirements doc):
//  - notes that started before the range but release inside it
//  - notes that started inside the range but release after it (clipped)
//  - sustain pedal (CC64) and program-change state carried over from before
//    the range, so the slice sounds correct in isolation
//  - a 1-measure count-in with metronome clicks on a hidden drum channel
//  - original tempo / time signature preserved

const { META_TEMPO, META_TIME_SIGNATURE, META_TRACK_NAME, writeMidi } = require('./midi-file.js');
const { extractTrackNotes, getTempoEvents, getTimeSignatureEvents, ticksPerMeasure } = require('./analyze.js');

const DRUM_CHANNEL = 9;
const CLICK_NOTE = 76; // GM "High Wood Block"

function lastAtOrBefore(list, tick, getTick) {
  let result = null;
  for (const item of list) {
    if (getTick(item) <= tick) result = item;
    else break;
  }
  return result;
}

function activeTimeSignatureAt(timeSigs, tick) {
  return lastAtOrBefore(timeSigs, tick, s => s.tick) || timeSigs[0];
}

function activeTempoAt(tempos, tick) {
  return lastAtOrBefore(tempos, tick, t => t.tick) || tempos[0];
}

function buildCountInTrack(countInTicks, numerator, denominator, ticksPerQuarter) {
  if (!countInTicks) return [];
  const beatTicks = ticksPerQuarter * (4 / denominator);
  const events = [];
  for (let beat = 0; beat < numerator; beat++) {
    const tick = Math.round(beat * beatTicks);
    if (tick >= countInTicks) break;
    events.push({ tick, type: 'noteOn', channel: DRUM_CHANNEL, note: CLICK_NOTE, velocity: 100 });
    events.push({ tick: tick + Math.round(beatTicks / 4), type: 'noteOff', channel: DRUM_CHANNEL, note: CLICK_NOTE, velocity: 0 });
  }
  return events;
}

// Returns the note+program+pedal state that should be re-asserted at the
// start of the slice for a single source track.
function carriedControllerEvents(events, channel, startTick, outTick) {
  const out = [];
  const programs = events.filter(e => e.type === 'programChange' && e.channel === channel && e.tick <= startTick);
  if (programs.length) {
    const last = programs[programs.length - 1];
    out.push({ tick: outTick, type: 'programChange', channel, program: last.program });
  }
  const pedals = events.filter(e => e.type === 'controller' && e.channel === channel && e.controller === 64 && e.tick <= startTick);
  if (pedals.length && pedals[pedals.length - 1].value >= 64) {
    out.push({ tick: outTick, type: 'controller', channel, controller: 64, value: pedals[pedals.length - 1].value });
  }
  return out;
}

/**
 * @param {object} midi - parsed MIDI from readMidi()
 * @param {object} selection
 * @param {number[]} selection.trackIndexes - which source tracks to include
 * @param {number} selection.startTick
 * @param {number} selection.endTick - exclusive
 * @param {object} [opts]
 * @param {boolean} [opts.countIn=true]
 */
function sliceMidi(midi, selection, opts = {}) {
  const { trackIndexes, startTick, endTick } = selection;
  if (endTick <= startTick) throw new Error('endTick must be greater than startTick');
  const countIn = opts.countIn !== false;

  const tempos = getTempoEvents(midi);
  const timeSigs = getTimeSignatureEvents(midi);
  const sigAtStart = activeTimeSignatureAt(timeSigs, startTick);
  const tempoAtStart = activeTempoAt(tempos, startTick);

  const countInTicks = countIn
    ? ticksPerMeasure(midi.ticksPerQuarter, sigAtStart.numerator, sigAtStart.denominator)
    : 0;
  const shift = countInTicks;

  const conductorTrack = [
    { tick: 0, type: 'meta', metaType: META_TEMPO, microsecondsPerQuarter: tempoAtStart.microsecondsPerQuarter },
    { tick: 0, type: 'meta', metaType: META_TIME_SIGNATURE, numerator: sigAtStart.numerator, denominator: sigAtStart.denominator },
    { tick: 0, type: 'meta', metaType: META_TRACK_NAME, data: Buffer.from('Lesson', 'utf8') },
  ];
  for (const t of tempos) {
    if (t.tick > startTick && t.tick < endTick) {
      conductorTrack.push({ tick: t.tick - startTick + shift, type: 'meta', metaType: META_TEMPO, microsecondsPerQuarter: t.microsecondsPerQuarter });
    }
  }
  for (const s of timeSigs) {
    if (s.tick > startTick && s.tick < endTick) {
      conductorTrack.push({ tick: s.tick - startTick + shift, type: 'meta', metaType: META_TIME_SIGNATURE, numerator: s.numerator, denominator: s.denominator });
    }
  }

  if (countIn) {
    conductorTrack.push(...buildCountInTrack(countInTicks, sigAtStart.numerator, sigAtStart.denominator, midi.ticksPerQuarter));
  }

  const outTracks = [conductorTrack];

  for (const trackIndex of trackIndexes) {
    const events = midi.tracks[trackIndex];
    if (!events) continue;
    const notes = extractTrackNotes(events);
    const channels = [...new Set(notes.map(n => n.channel))];
    const outEvents = [];
    const name = events.find(e => e.type === 'meta' && e.metaType === META_TRACK_NAME);
    if (name) outEvents.push({ tick: 0, type: 'meta', metaType: META_TRACK_NAME, text: name.text, data: Buffer.from(name.text, 'utf8') });

    for (const channel of channels) {
      outEvents.push(...carriedControllerEvents(events, channel, startTick, shift));
    }

    for (const event of events) {
      if (event.type !== 'controller' || event.controller !== 64) continue;
      if (event.tick > startTick && event.tick < endTick) {
        outEvents.push({ ...event, tick: event.tick - startTick + shift });
      }
    }
    for (const event of events) {
      if (event.type !== 'programChange') continue;
      if (event.tick > startTick && event.tick < endTick) {
        outEvents.push({ ...event, tick: event.tick - startTick + shift });
      }
    }

    for (const note of notes) {
      if (note.endTick <= startTick || note.tick >= endTick) continue; // fully outside range
      const clippedStart = Math.max(note.tick, startTick);
      const clippedEnd = Math.min(note.endTick, endTick);
      const outStart = clippedStart - startTick + shift;
      const outEnd = Math.max(outStart + 1, clippedEnd - startTick + shift);
      outEvents.push({ tick: outStart, type: 'noteOn', channel: note.channel, note: note.note, velocity: note.velocity });
      outEvents.push({ tick: outEnd, type: 'noteOff', channel: note.channel, note: note.note, velocity: 0 });
    }

    outTracks.push(outEvents);
  }

  return { formatType: 1, ticksPerQuarter: midi.ticksPerQuarter, tracks: outTracks };
}

function exportLessonBuffer(midi, selection, opts) {
  return writeMidi(sliceMidi(midi, selection, opts));
}

module.exports = { sliceMidi, exportLessonBuffer };
