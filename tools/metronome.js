/* TuneLog web metronome: timing logic. No browser APIs here, so it also runs
   under node (see test/metronome.test.js). The tap tempo, tempo names, accents
   and click sounds are ported from the app's lib/logic/click_track.dart and
   notes.dart.

   Timing: a JavaScript timer is far too jittery to play clicks directly, so the
   timer only wakes up often and asks "which clicks fall in the next moment?".
   Each one is handed to Web Audio with an exact start time on the audio clock.
   Click times are computed as origin + n * interval, not by adding intervals up,
   so rounding errors cannot accumulate into drift. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MetronomeLogic = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var MIN_BPM = 20, MAX_BPM = 300;
  var STRONG = 'strong', NORMAL = 'normal', MUTE = 'mute';

  function clampBpm(b) {
    b = Math.round(Number(b));
    if (!isFinite(b)) return 120;
    return Math.max(MIN_BPM, Math.min(MAX_BPM, b));
  }

  /* Classic tempo markings, by lower bound in BPM. Same table as the app. */
  function tempoMarking(bpm) {
    if (bpm < 40) return 'Grave';
    if (bpm < 60) return 'Largo';
    if (bpm < 66) return 'Larghetto';
    if (bpm < 76) return 'Adagio';
    if (bpm < 108) return 'Andante';
    if (bpm < 120) return 'Moderato';
    if (bpm < 156) return 'Allegro';
    if (bpm < 176) return 'Vivace';
    if (bpm < 200) return 'Presto';
    return 'Prestissimo';
  }

  /* Strong on one, normal on the other beats. */
  function defaultAccents(beats) {
    var out = [];
    for (var i = 0; i < beats; i++) out.push(i === 0 ? STRONG : NORMAL);
    return out;
  }

  /* Tapping a beat light cycles strong, normal, mute. */
  function nextAccent(a) { return a === STRONG ? NORMAL : a === NORMAL ? MUTE : STRONG; }

  /* Tap tempo: the average of the last few intervals; a pause resets it. */
  function TapTempo() { this.taps = []; }
  TapTempo.prototype.tap = function (millis) {
    var t = this.taps;
    if (t.length && millis - t[t.length - 1] > 2000) t.length = 0;
    t.push(millis);
    if (t.length > 5) t.shift();
    if (t.length < 2) return null;
    var avg = (t[t.length - 1] - t[0]) / (t.length - 1);
    return clampBpm(60000 / avg);
  };

  /* Options: now() returns audio-clock seconds; onClick({time, beat, part, level,
     muted}) receives each click to schedule (level 2 accent, 1 beat, 0
     subdivision). A muted beat makes no sound, but its light still moves. */
  function Scheduler(opts) {
    this.now = opts.now;
    this.onClick = opts.onClick;
    this.bpm = clampBpm(opts.bpm || 120);
    this.beats = opts.beats || 4;
    this.parts = opts.parts || 1;
    this.accents = opts.accents || defaultAccents(this.beats);
    this.running = false;
    this.skipped = 0;
  }
  Scheduler.prototype.tickSeconds = function () { return 60 / this.bpm / this.parts; };
  Scheduler.prototype.barTicks = function () { return this.beats * this.parts; };

  Scheduler.prototype.start = function (delay) {
    this.origin = this.now() + (delay === undefined ? 0.06 : delay);
    this.n = 0;      // ticks since origin
    this.pos = 0;    // tick position in the bar at n = 0
    this.running = true;
    this.skipped = 0;
  };
  Scheduler.prototype.stop = function () { this.running = false; };

  /* Time of the next click not yet handed to Web Audio. */
  Scheduler.prototype.nextTime = function () { return this.origin + this.n * this.tickSeconds(); };

  /* Call often. Hands over every click due before now + lookahead. If the timer
     slept through some clicks (a throttled tab), their moment has passed: they
     are dropped rather than played in a burst, and the beat stays on its grid. */
  Scheduler.prototype.tick = function (lookahead) {
    if (!this.running) return;
    var now = this.now();
    var sec = this.tickSeconds();
    var late = Math.ceil((now - this.origin) / sec - 1e-9);
    if (late > this.n) {
      this.skipped += late - this.n;
      this.n = late;
    }
    var horizon = now + lookahead;
    var t = this.nextTime();
    while (t < horizon) {
      this.emit(t);
      this.n++;
      t = this.nextTime();
    }
  };

  Scheduler.prototype.emit = function (time) {
    var total = this.barTicks();
    var at = (this.pos + this.n) % total;
    var beat = Math.floor(at / this.parts);
    var part = at % this.parts;
    var a = this.accents[beat] || NORMAL;
    var level = part !== 0 ? 0 : (a === STRONG ? 2 : 1);
    this.onClick({ time: time, beat: beat, part: part, level: level, muted: a === MUTE });
  };

  /* Keep the place in the bar and carry on from the next unscheduled click, so a
     tempo change does not restart the bar or shift clicks already scheduled. */
  Scheduler.prototype.rebase = function () {
    if (!this.running) return;
    var t = this.nextTime();
    this.pos = (this.pos + this.n) % this.barTicks();
    this.origin = t;
    this.n = 0;
  };
  Scheduler.prototype.setBpm = function (bpm) {
    this.rebase();
    this.bpm = clampBpm(bpm);
  };
  /* A new meter or subdivision starts again on beat one at the next click. */
  Scheduler.prototype.setMeter = function (beats, parts, accents) {
    this.rebase();
    this.beats = beats;
    this.parts = parts;
    this.accents = accents || defaultAccents(beats);
    this.pos = 0;
  };

  var GAIN = [0.35, 0.7, 0.95];
  var SOUNDS = {
    wood: { dur: 0.045, decay: 90 },
    beep: { dur: 0.06, decay: 55 },
    click: { dur: 0.012, decay: 400 },
    bell: { dur: 0.16, decay: 22 }
  };
  function square(phase) { return Math.sin(phase) >= 0 ? 1 : -1; }

  /* One click as samples. level 2 = accent, 1 = beat, 0 = subdivision. */
  function renderClick(sound, level, sampleRate) {
    var s = SOUNDS[sound] || SOUNDS.wood;
    var gain = GAIN[level];
    var up = level === 2 ? 1.5 : 1;
    var n = Math.round(sampleRate * s.dur);
    var out = new Float32Array(n);
    var seed = 11;
    function rnd() { seed = (seed * 16807) % 2147483647; return seed / 2147483647; }
    for (var i = 0; i < n; i++) {
      var t = i / sampleRate;
      var env = Math.exp(-s.decay * t) * Math.min(1, i / (sampleRate * 0.0008));
      var w = 2 * Math.PI * t, v;
      if (sound === 'beep') v = Math.sin(w * 1000 * up);
      else if (sound === 'click') v = (rnd() * 2 - 1) * 0.6 + 0.4 * Math.sin(w * 3200 * up);
      else if (sound === 'bell') v = 0.55 * square(w * 560 * up) + 0.45 * square(w * 845 * up);
      else v = 0.7 * Math.sin(w * 950 * up) + 0.3 * Math.sin(w * 2570 * up);
      out[i] = gain * env * v * (sound === 'bell' ? 0.5 : 1);
    }
    return out;
  }

  return {
    MIN_BPM: MIN_BPM, MAX_BPM: MAX_BPM, STRONG: STRONG, NORMAL: NORMAL, MUTE: MUTE,
    clampBpm: clampBpm, tempoMarking: tempoMarking, defaultAccents: defaultAccents,
    nextAccent: nextAccent, TapTempo: TapTempo, Scheduler: Scheduler, renderClick: renderClick
  };
});
