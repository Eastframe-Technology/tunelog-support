// Run with: node --test test/*.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const T = require('../tools/tuner.js');
const dart = require('./dart-vectors.json');

const sine = (hz, n, sr, amp = 0.5) =>
  Float64Array.from({ length: n }, (_, i) => amp * Math.sin(2 * Math.PI * hz * i / sr));

// Same recipe as harmonicTone in the app's audio_synth.dart.
const HARM = [1.0, 0.6, 0.35, 0.2, 0.12];
function harmonicTone(hz, n, { sr = 44100, amp = 0.4, noise = 0, offset = 0, seed = 1 } = {}) {
  let s = seed;
  const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const t = (i + offset) / sr;
    let v = 0;
    HARM.forEach((a, h) => { v += a * Math.sin(2 * Math.PI * hz * (h + 1) * t); });
    out[i] = amp * v / 2.27 + (noise > 0 ? noise * (rnd() * 2 - 1) : 0);
  }
  return out;
}
const centsOff = (got, want) => 1200 * Math.log(got / want) / Math.LN2;

for (const sr of [44100, 48000, 96000]) {
  const d = new T.PitchDetector({ sampleRate: sr });

  test(`pure sines across the range are within 1 cent at ${sr} Hz`, () => {
    for (const hz of [30.87, 41.2, 55, 82.41, 110, 196, 329.63, 440, 659.25, 1046.5, 2093, 4186]) {
      const p = d.detect(sine(hz, d.frameSize, sr));
      assert.ok(p, `${hz} not detected`);
      assert.ok(Math.abs(centsOff(p.hz, hz)) < 1, `${hz} got ${p.hz}`);
      assert.ok(p.clarity > 0.9);
    }
  });

  test(`harmonic-rich tones do not jump an octave at ${sr} Hz`, () => {
    for (const hz of [41.2, 55, 82.41, 146.83, 246.94, 392, 880]) {
      const p = d.detect(harmonicTone(hz, d.frameSize, { sr }));
      assert.ok(p, `${hz}`);
      assert.ok(Math.abs(centsOff(p.hz, hz)) < 2, `${hz} got ${p.hz}`);
    }
  });
}

test('frame size holds the lowest note at every browser sample rate', () => {
  assert.strictEqual(T.frameSizeFor(44100), 4096);
  assert.strictEqual(T.frameSizeFor(48000), 4096);
  assert.strictEqual(T.frameSizeFor(96000), 8192);
  assert.strictEqual(T.frameSizeFor(192000), 16384);
});

test('agrees with the Dart detector in the app, on the same signals', () => {
  const d = new T.PitchDetector({ sampleRate: 44100 });
  for (const v of dart.sine44100) {
    const p = d.detect(sine(v.in, d.frameSize, 44100));
    assert.ok(Math.abs(p.hz - v.hz) < 1e-6, `${v.in}: js ${p.hz} dart ${v.hz}`);
    assert.ok(Math.abs(p.clarity - v.clarity) < 1e-6);
  }
  const d48 = new T.PitchDetector({ sampleRate: 48000 });
  for (const v of dart.sine48000) {
    const p = d48.detect(sine(v.in, d48.frameSize, 48000));
    assert.ok(Math.abs(p.hz - v.hz) < 1e-6, `${v.in}: js ${p.hz} dart ${v.hz}`);
  }
  for (const v of dart.harmonic44100) {
    const p = d.detect(harmonicTone(v.in, d.frameSize));
    assert.ok(Math.abs(p.hz - v.hz) < 1e-4, `${v.in}: js ${p.hz} dart ${v.hz}`);
  }
});

test('a low B with a weak fundamental is still found (5-string bass)', () => {
  const d = new T.PitchDetector();
  const hz = 30.87;
  const x = Float64Array.from({ length: d.frameSize }, (_, i) => {
    const t = i / 44100;
    return 0.05 * Math.sin(2 * Math.PI * hz * t) + 0.4 * Math.sin(2 * Math.PI * 2 * hz * t) + 0.3 * Math.sin(2 * Math.PI * 3 * hz * t);
  });
  const p = d.detect(x);
  assert.ok(p);
  assert.ok(Math.abs(centsOff(p.hz, hz)) < 3, `got ${p.hz}`);
});

test('noise and silence give nothing', () => {
  const d = new T.PitchDetector();
  let s = 3;
  const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
  assert.strictEqual(d.detect(Float64Array.from({ length: d.frameSize }, () => rnd() - 0.5)), null);
  assert.strictEqual(d.detect(new Float64Array(d.frameSize)), null);
  assert.strictEqual(d.detect(sine(440, d.frameSize, 44100, 0.001)), null);
});

test('heavy noise (about 10 dB SNR) stays within a few cents', () => {
  const d = new T.PitchDetector();
  for (const hz of [82.41, 196, 659.25]) {
    let sum = 0;
    for (let k = 0; k < 8; k++) {
      const p = d.detect(harmonicTone(hz, d.frameSize, { noise: 0.08, seed: k + 1, offset: k * 977 }));
      assert.ok(p, `${hz} seed ${k}`);
      const c = centsOff(p.hz, hz);
      assert.ok(Math.abs(c) < 6, `${hz} seed ${k} got ${p.hz}`);
      sum += c;
    }
    assert.ok(Math.abs(sum / 8) < 2, `${hz}`);
  }
});

test('reference tones are in tune, and match the app', () => {
  const d = new T.PitchDetector();
  for (const v of dart.pluck) {
    const hz = T.midiToHz(v.midi);
    const x = T.pluck(hz);
    assert.ok(Math.abs(x[8000] - v.peakSample) < 1e-5, `${v.midi} sample differs from the app`);
    const p = d.detect(x.subarray(4410, 4410 + d.frameSize));
    assert.ok(p, `${v.midi}`);
    assert.ok(Math.abs(centsOff(p.hz, hz)) < 1.5, `${v.midi} got ${p.hz}`);
  }
});

test('sliding frames of a slowly bending note track it, as the live page reads them', () => {
  const d = new T.PitchDetector();
  const frame = new Float64Array(d.frameSize);
  let phase = 0, last = null, want = 0;
  for (let k = 0; k < 60; k++) {
    want = T.midiToHz(45) * Math.pow(2, (-30 + k * 0.5) / 1200);
    frame.copyWithin(0, 1024);
    for (let i = 0; i < 1024; i++) {
      let v = 0;
      HARM.forEach((a, h) => { v += a * Math.sin(2 * Math.PI * (h + 1) * phase); });
      frame[frame.length - 1024 + i] = 0.35 * v / 2.27;
      phase += want / 44100;
    }
    phase -= Math.floor(phase);
    if (k > 4) { const p = d.detect(frame); last = p && p.hz; }
  }
  assert.ok(last);
  assert.ok(Math.abs(centsOff(last, want)) < 3, `got ${last} want ${want}`);
});

test('frequencies and note names, same values as the app', () => {
  assert.ok(Math.abs(T.midiToHz(69) - 440) < 1e-9);
  assert.ok(Math.abs(T.midiToHz(60) - 261.6256) < 1e-3);
  assert.ok(Math.abs(T.midiToHz(69, 442) - 442) < 1e-9);
  assert.strictEqual(T.noteName(60), 'C');
  assert.strictEqual(T.octaveOf(60), 4);
  assert.strictEqual(T.octaveOf(23), 0);
  for (const v of dart.midiHz) assert.ok(Math.abs(T.midiToHz(v.midi) - v.hz) < 1e-9);
  for (const v of dart.readings) {
    const r = T.readingFor(v.hz);
    assert.strictEqual(r.midi, v.midi);
    assert.ok(Math.abs(r.cents - v.cents) < 1e-9);
    assert.strictEqual(T.noteName(r.midi), v.name);
    assert.strictEqual(T.octaveOf(r.midi), v.octave);
  }
});

test('readings and calibration (vectors from the app tests)', () => {
  const r = T.readingFor(445);
  assert.strictEqual(r.midi, 69);
  assert.ok(Math.abs(r.cents - 19.56) < 0.05);
  const flat = T.readingFor(T.midiToHz(64) * 0.999);
  assert.strictEqual(flat.midi, 64);
  assert.ok(Math.abs(flat.cents + 1.73) < 0.05);
  assert.ok(Math.abs(T.readingFor(442, 442).cents) < 1e-9);
  assert.ok(Math.abs(T.readingFor(440, 442).cents + 7.85) < 0.05);
  assert.strictEqual(T.readingFor(415.3).midi, 68);
  assert.strictEqual(T.readingFor(415.3, 415.3).midi, 69);
});

test('nearest string on a guitar (vectors from the app tests)', () => {
  const g = T.tuningById('guitar.standard');
  assert.strictEqual(T.nearestString(g, 110.5), 1);
  assert.strictEqual(T.nearestString(g, 80), 0);
  assert.strictEqual(T.nearestString(g, 340), 5);
  assert.strictEqual(T.nearestString(g, 2000), null);
  assert.strictEqual(T.nearestString(T.tuningById('chromatic'), 440), null);
  const v = T.viewFor(100, g);       // far below A2: clamps at -50 on that string
  assert.strictEqual(v.stringIndex, 1);
  assert.strictEqual(v.cents, -50);
  const c = T.viewFor(445, T.tuningById('chromatic'));
  assert.strictEqual(c.stringIndex, null);
  assert.strictEqual(c.midi, 69);
});

test('smoothing: calm on a steady note, jumps on a new one, holds then clears', () => {
  const s = new T.Smoother();
  assert.strictEqual(s.update({ hz: 110, clarity: 0.99 }, 0), 110);
  s.update({ hz: 110.05, clarity: 0.99 }, 25);
  s.update({ hz: 180, clarity: 0.5 }, 50);          // unclear frame: ignored
  assert.ok(Math.abs(s.hz - 110) < 0.1);
  s.update({ hz: 220, clarity: 0.99 }, 75);         // new note: jump
  assert.strictEqual(s.hz, 220);
  s.update(null, 300);
  assert.strictEqual(s.held, false);
  s.update(null, 500);
  assert.strictEqual(s.held, true);
  assert.strictEqual(s.hz, 220);
  s.update(null, 4200);
  assert.strictEqual(s.hz, null);
});

test('microphone errors map to a message the page can show', () => {
  assert.strictEqual(T.micErrorKind({ name: 'NotAllowedError' }), 'denied');
  assert.strictEqual(T.micErrorKind({ name: 'SecurityError' }), 'denied');
  assert.strictEqual(T.micErrorKind({ name: 'NotFoundError' }), 'nomic');
  assert.strictEqual(T.micErrorKind({ name: 'NotReadableError' }), 'busy');
  assert.strictEqual(T.micErrorKind(new Error('x')), 'other');
});

test('the tuning tables in the guide match the note and frequency maths', () => {
  const fs = require('node:fs'), path = require('node:path');
  const html = fs.readFileSync(path.join(__dirname, '../guides/standard-tunings.html'), 'utf8');
  const rows = [...html.matchAll(/<td>([A-G]♯?)(\d)<\/td><td>([\d.]+) Hz<\/td>/g)];
  assert.strictEqual(rows.length, 6 + 4 + 4 + 4 + 4);
  const want = ['guitar.standard', 'bass.standard', 'violin.standard', 'ukulele.standard', 'cello.standard']
    .flatMap((id) => T.tuningById(id).strings);
  rows.forEach(([, name, oct, hz], i) => {
    assert.strictEqual(name + oct, T.noteName(want[i]) + T.octaveOf(want[i]));
    assert.strictEqual(T.midiToHz(want[i]).toFixed(2), hz);
  });
  assert.ok(html.includes('D2 (73.42 Hz)') && T.midiToHz(38).toFixed(2) === '73.42');
  assert.ok(html.includes('B0, 30.87 Hz') && T.midiToHz(23).toFixed(2) === '30.87');
  assert.ok(html.includes('G3 (196.00 Hz)') && T.midiToHz(55).toFixed(2) === '196.00');
});

test('the worked example on the tuner page is right', () => {
  const r = T.readingFor(445);
  assert.strictEqual(T.hzToMidi(445).toFixed(3), '69.196');
  assert.strictEqual(r.cents.toFixed(1), '19.6');
  assert.ok(Math.abs(T.readingFor(445, 445).cents) < 1e-9);
});
