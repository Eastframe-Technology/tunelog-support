// Run with: node --test test/*.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const M = require('../tools/metronome.js');
const dart = require('./dart-vectors.json');

function harness(opts) {
  const clock = { t: 10 };
  const clicks = [];
  const s = new M.Scheduler(Object.assign({ now: () => clock.t, onClick: (c) => clicks.push(c) }, opts));
  return { clock, clicks, s };
}
// A deterministic jittery timer: wakes every 15 to 45 ms.
function run(h, seconds, lookahead = 0.12) {
  const end = h.clock.t + seconds;
  let seed = 7;
  while (h.clock.t < end) {
    h.s.tick(lookahead);
    seed = (seed * 16807) % 2147483647;
    h.clock.t += 0.015 + 0.03 * (seed / 2147483647);
  }
}

test('clicks land exactly on the grid and do not drift over a long run', () => {
  for (const bpm of [20, 60, 97, 120, 137, 300]) {
    const h = harness({ bpm, beats: 4 });
    h.s.start(0.1);
    const t0 = h.s.origin;
    run(h, 600);
    const interval = 60 / bpm;
    assert.ok(h.clicks.length >= Math.floor(600 / interval) - 1, `${bpm} count ${h.clicks.length}`);
    h.clicks.forEach((c, i) => {
      assert.ok(Math.abs(c.time - (t0 + i * interval)) < 1e-9, `${bpm} click ${i} off by ${c.time - t0 - i * interval}`);
    });
  }
});

test('no click is missed, repeated or scheduled out of order under a jittery timer', () => {
  const h = harness({ bpm: 300, beats: 4, parts: 4 });
  h.s.start();
  run(h, 60);
  assert.strictEqual(h.s.skipped, 0);
  for (let i = 1; i < h.clicks.length; i++) {
    assert.ok(Math.abs(h.clicks[i].time - h.clicks[i - 1].time - 0.05) < 1e-9, `gap at ${i}`);
  }
});

test('every click is scheduled ahead of the audio clock', () => {
  const clock = { t: 5 };
  const lead = [];
  const s = new M.Scheduler({ now: () => clock.t, onClick: (c) => lead.push(c.time - clock.t), bpm: 200, beats: 4 });
  s.start();
  for (let i = 0; i < 4000; i++) { s.tick(0.12); clock.t += 0.025; }
  assert.ok(Math.min(...lead) > 0, `min lead ${Math.min(...lead)}`);
  assert.ok(Math.max(...lead) <= 0.12 + 1e-9);
});

test('accents, beats and subdivisions fall where they should', () => {
  const h = harness({ bpm: 120, beats: 3, parts: 2 });
  h.s.start();
  run(h, 6);
  const first = h.clicks.slice(0, 7).map((c) => [c.beat, c.part, c.level]);
  assert.deepStrictEqual(first, [[0, 0, 2], [0, 1, 0], [1, 0, 1], [1, 1, 0], [2, 0, 1], [2, 1, 0], [0, 0, 2]]);
  assert.ok(Math.abs(h.clicks[1].time - h.clicks[0].time - 0.25) < 1e-9);
});

test('a muted beat stays silent but keeps its place', () => {
  const h = harness({ bpm: 120, beats: 4, accents: [M.STRONG, M.NORMAL, M.MUTE, M.NORMAL] });
  h.s.start();
  run(h, 3);
  assert.deepStrictEqual(h.clicks.slice(0, 4).map((c) => c.muted), [false, false, true, false]);
  assert.strictEqual(M.nextAccent(M.STRONG), M.NORMAL);
  assert.strictEqual(M.nextAccent(M.NORMAL), M.MUTE);
  assert.strictEqual(M.nextAccent(M.MUTE), M.STRONG);
});

test('a tempo change keeps the place in the bar and never moves a scheduled click', () => {
  const h = harness({ bpm: 120, beats: 4 });
  h.s.start();
  run(h, 1.1);
  const before = h.clicks.length;
  const lastTime = h.clicks[before - 1].time;
  const lastBeat = h.clicks[before - 1].beat;
  h.s.setBpm(60);
  run(h, 5);
  assert.strictEqual(h.clicks[before].beat, (lastBeat + 1) % 4);
  assert.ok(Math.abs(h.clicks[before].time - (lastTime + 0.5)) < 1e-9, 'first click at new tempo follows the old grid');
  assert.ok(Math.abs(h.clicks[before + 1].time - h.clicks[before].time - 1) < 1e-9, 'then the new interval');
});

test('a new meter starts on beat one', () => {
  const h = harness({ bpm: 120, beats: 4 });
  h.s.start();
  run(h, 1.1);
  const before = h.clicks.length;
  h.s.setMeter(3, 1);
  run(h, 3);
  assert.deepStrictEqual(h.clicks.slice(before, before + 4).map((c) => c.beat), [0, 1, 2, 0]);
});

test('a throttled timer drops missed clicks instead of bursting, and stays on the grid', () => {
  const h = harness({ bpm: 120, beats: 4 });
  h.s.start();
  const t0 = h.s.origin;
  run(h, 1);
  const count = h.clicks.length;
  h.clock.t += 5;                  // the tab slept for five seconds
  h.s.tick(0.12);
  const after = h.clicks.slice(count);
  assert.ok(after.length <= 1, `burst of ${after.length}`);
  assert.ok(h.s.skipped > 0);
  run(h, 2);
  for (const c of h.clicks.slice(count)) {
    const beats = (c.time - t0) / 0.5;
    assert.ok(Math.abs(beats - Math.round(beats)) < 1e-9, 'left the grid');
    assert.ok(c.beat === Math.round(beats) % 4, 'lost the place in the bar');
  }
});

test('stop means no more clicks', () => {
  const h = harness({ bpm: 120 });
  h.s.start();
  run(h, 1);
  const n = h.clicks.length;
  h.s.stop();
  run(h, 1);
  assert.strictEqual(h.clicks.length, n);
});

test('tap tempo (vectors from the app, run on its Dart code)', () => {
  const t = new M.TapTempo();
  for (const v of dart.tap) assert.strictEqual(t.tap(v.ms), v.bpm, `at ${v.ms}`);
});

test('tempo names match the app at every boundary', () => {
  for (const v of dart.tempo) assert.strictEqual(M.tempoMarking(v.bpm), v.name, `${v.bpm}`);
});

test('BPM stays in the 20 to 300 range', () => {
  assert.strictEqual(M.clampBpm(5), 20);
  assert.strictEqual(M.clampBpm(999), 300);
  assert.strictEqual(M.clampBpm('137.4'), 137);
  assert.strictEqual(M.clampBpm('junk'), 120);
});

test('click sounds: accent loudest, all finite, loudness matches the level', () => {
  for (const sound of ['wood', 'beep', 'click', 'bell']) {
    const peak = (l) => Math.max(...M.renderClick(sound, l, 48000).map(Math.abs));
    assert.ok(peak(2) > peak(1) && peak(1) > peak(0), sound);
    assert.ok(peak(2) <= 1, `${sound} clips`);
    assert.ok(M.renderClick(sound, 1, 44100).every(Number.isFinite));
  }
  assert.strictEqual(M.renderClick('wood', 1, 44100).length, Math.round(44100 * 0.045));
  assert.strictEqual(M.renderClick('wood', 1, 44100)[0], 0);   // fade-in, so no pop
});

test('the tempo table in the guide matches the names the page shows', () => {
  const fs = require('node:fs'), path = require('node:path');
  const html = fs.readFileSync(path.join(__dirname, '../guides/metronome-practice.html'), 'utf8');
  const rows = [...html.matchAll(/<tr><td>([A-Z][a-z]+)<\/td><td>(\d+) to (\d+)<\/td><\/tr>/g)];
  assert.strictEqual(rows.length, 10);
  for (const [, name, lo, hi] of rows) {
    assert.strictEqual(M.tempoMarking(+lo), name);
    assert.strictEqual(M.tempoMarking(+hi), name);
  }
});

test('the worked example on the metronome page is right', () => {
  assert.strictEqual(60 / 120, 0.5);
  assert.strictEqual((60 / 137).toFixed(3), '0.438');
  const h = harness({ bpm: 137, beats: 4 });
  h.s.start(0.1);
  const t0 = h.s.origin;
  run(h, 450);
  assert.ok(Math.abs(h.clicks[1000].time - (t0 + 1000 * 60 / 137)) < 1e-9);
});
