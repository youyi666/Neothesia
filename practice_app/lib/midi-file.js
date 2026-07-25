'use strict';
// Generic Standard MIDI File (SMF) reader/writer.
// Keeps every event (notes, controllers, program change, meta, sysex) with
// absolute tick positions so tracks can be sliced and re-written losslessly
// enough to reconstruct a valid, playable MIDI file.

const META_END_OF_TRACK = 0x2f;
const META_TEMPO = 0x51;
const META_TIME_SIGNATURE = 0x58;
const META_TRACK_NAME = 0x03;

function readVarLength(buffer, offset) {
  let value = 0;
  let byte;
  do {
    if (offset >= buffer.length) throw new Error('Unexpected end of MIDI variable length value');
    byte = buffer[offset++];
    value = (value << 7) | (byte & 0x7f);
  } while (byte & 0x80);
  return { value, offset };
}

function writeVarLength(value) {
  if (value < 0) throw new Error('Cannot encode negative variable length value');
  const bytes = [value & 0x7f];
  value >>= 7;
  while (value > 0) {
    bytes.unshift((value & 0x7f) | 0x80);
    value >>= 7;
  }
  return Buffer.from(bytes);
}

function readMidi(buffer) {
  if (buffer.toString('ascii', 0, 4) !== 'MThd') throw new Error('Missing MThd header');
  const headerLength = buffer.readUInt32BE(4);
  const formatType = buffer.readUInt16BE(8);
  const trackCount = buffer.readUInt16BE(10);
  const division = buffer.readUInt16BE(12);
  if (division & 0x8000) throw new Error('SMPTE MIDI timing is not supported');
  const ticksPerQuarter = division;

  let offset = 8 + headerLength;
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
    const events = [];

    while (offset < end) {
      const delta = readVarLength(buffer, offset);
      tick += delta.value;
      offset = delta.offset;

      let status = buffer[offset];
      if (status < 0x80) {
        if (runningStatus === null) throw new Error(`Invalid running status in track ${trackIndex}`);
        status = runningStatus;
      } else {
        offset++;
        if (status < 0xf0) runningStatus = status;
        else runningStatus = null;
      }

      if (status === 0xff) {
        const metaType = buffer[offset++];
        const length = readVarLength(buffer, offset);
        offset = length.offset;
        const data = Buffer.from(buffer.subarray(offset, offset + length.value));
        offset += length.value;
        events.push(decodeMeta(tick, metaType, data));
        continue;
      }

      if (status === 0xf0 || status === 0xf7) {
        const length = readVarLength(buffer, offset);
        offset = length.offset;
        const data = Buffer.from(buffer.subarray(offset, offset + length.value));
        offset += length.value;
        events.push({ tick, type: 'sysex', raw: status, data });
        continue;
      }

      const command = status & 0xf0;
      const channel = status & 0x0f;

      if (command === 0xc0 || command === 0xd0) {
        const data1 = buffer[offset++];
        if (command === 0xc0) events.push({ tick, type: 'programChange', channel, program: data1 });
        else events.push({ tick, type: 'channelPressure', channel, pressure: data1 });
        continue;
      }

      const data1 = buffer[offset++];
      const data2 = buffer[offset++];

      switch (command) {
        case 0x90:
          if (data2 > 0) events.push({ tick, type: 'noteOn', channel, note: data1, velocity: data2 });
          else events.push({ tick, type: 'noteOff', channel, note: data1, velocity: 0 });
          break;
        case 0x80:
          events.push({ tick, type: 'noteOff', channel, note: data1, velocity: data2 });
          break;
        case 0xa0:
          events.push({ tick, type: 'polyPressure', channel, note: data1, pressure: data2 });
          break;
        case 0xb0:
          events.push({ tick, type: 'controller', channel, controller: data1, value: data2 });
          break;
        case 0xe0:
          events.push({ tick, type: 'pitchBend', channel, value: (data2 << 7) | data1 });
          break;
        default:
          // Unknown/unsupported status; skip.
          break;
      }
    }

    offset = end;
    tracks.push(events);
  }

  return { formatType, ticksPerQuarter, tracks };
}

function decodeMeta(tick, metaType, data) {
  const event = { tick, type: 'meta', metaType, data };
  if (metaType === META_TEMPO && data.length === 3) {
    event.microsecondsPerQuarter = (data[0] << 16) | (data[1] << 8) | data[2];
  } else if (metaType === META_TIME_SIGNATURE && data.length >= 2) {
    event.numerator = data[0];
    event.denominator = 2 ** data[1];
  } else if (metaType === META_TRACK_NAME) {
    event.text = data.toString('utf8');
  }
  return event;
}

function encodeMetaData(event) {
  if (event.metaType === META_TEMPO && event.microsecondsPerQuarter != null) {
    const us = event.microsecondsPerQuarter;
    return Buffer.from([(us >> 16) & 0xff, (us >> 8) & 0xff, us & 0xff]);
  }
  if (event.metaType === META_TIME_SIGNATURE && event.numerator != null) {
    const denomPow = Math.round(Math.log2(event.denominator));
    return Buffer.from([event.numerator, denomPow, event.data?.[2] ?? 24, event.data?.[3] ?? 8]);
  }
  return event.data || Buffer.alloc(0);
}

function encodeEvent(event) {
  switch (event.type) {
    case 'noteOn':
      return Buffer.from([0x90 | event.channel, event.note, event.velocity]);
    case 'noteOff':
      return Buffer.from([0x80 | event.channel, event.note, event.velocity]);
    case 'polyPressure':
      return Buffer.from([0xa0 | event.channel, event.note, event.pressure]);
    case 'controller':
      return Buffer.from([0xb0 | event.channel, event.controller, event.value]);
    case 'programChange':
      return Buffer.from([0xc0 | event.channel, event.program]);
    case 'channelPressure':
      return Buffer.from([0xd0 | event.channel, event.pressure]);
    case 'pitchBend':
      return Buffer.from([0xe0 | event.channel, event.value & 0x7f, (event.value >> 7) & 0x7f]);
    case 'meta': {
      const data = encodeMetaData(event);
      return Buffer.concat([Buffer.from([0xff, event.metaType]), writeVarLength(data.length), data]);
    }
    case 'sysex': {
      const data = event.data || Buffer.alloc(0);
      return Buffer.concat([Buffer.from([event.raw || 0xf0]), writeVarLength(data.length), data]);
    }
    default:
      throw new Error(`Cannot encode unknown event type: ${event.type}`);
  }
}

// events must be sorted by tick ascending; ties are written in array order.
function writeTrack(events) {
  const sorted = events.slice().sort((a, b) => a.tick - b.tick);
  const chunks = [];
  let lastTick = 0;
  let hasEndOfTrack = false;

  for (const event of sorted) {
    if (event.type === 'meta' && event.metaType === META_END_OF_TRACK) {
      hasEndOfTrack = true;
      continue; // appended once at the end, below
    }
    const delta = Math.max(0, event.tick - lastTick);
    chunks.push(writeVarLength(delta));
    chunks.push(encodeEvent(event));
    lastTick = event.tick;
  }

  chunks.push(writeVarLength(0));
  chunks.push(encodeEvent({ type: 'meta', metaType: META_END_OF_TRACK, data: Buffer.alloc(0) }));
  void hasEndOfTrack;

  const body = Buffer.concat(chunks);
  const header = Buffer.alloc(8);
  header.write('MTrk', 0, 'ascii');
  header.writeUInt32BE(body.length, 4);
  return Buffer.concat([header, body]);
}

function writeMidi({ formatType = 1, ticksPerQuarter, tracks }) {
  const header = Buffer.alloc(14);
  header.write('MThd', 0, 'ascii');
  header.writeUInt32BE(6, 4);
  header.writeUInt16BE(formatType, 8);
  header.writeUInt16BE(tracks.length, 10);
  header.writeUInt16BE(ticksPerQuarter, 12);

  const trackChunks = tracks.map(writeTrack);
  return Buffer.concat([header, ...trackChunks]);
}

module.exports = {
  readMidi,
  writeMidi,
  readVarLength,
  writeVarLength,
  META_END_OF_TRACK,
  META_TEMPO,
  META_TIME_SIGNATURE,
  META_TRACK_NAME,
};
