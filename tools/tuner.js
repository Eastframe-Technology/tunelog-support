/* TuneLog web tuner: pitch logic. No browser APIs here, so it also runs under
   node (see test/tuner.test.js). Ported from the app's lib/logic/pitch.dart,
   notes.dart, tunings.dart and the smoothing in services/tuner_engine.dart, so
   the site and the app agree. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TunerLogic = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* In-place iterative radix-2 FFT. */
  function Fft(n) {
    this.n = n;
    this.cos = new Float64Array(n >> 1);
    this.sin = new Float64Array(n >> 1);
    this.rev = new Int32Array(n);
    for (var i = 0; i < n >> 1; i++) {
      this.cos[i] = Math.cos(-2 * Math.PI * i / n);
      this.sin[i] = Math.sin(-2 * Math.PI * i / n);
    }
    var bits = 0;
    while ((1 << bits) < n) bits++;
    for (i = 0; i < n; i++) {
      var r = 0;
      for (var b = 0; b < bits; b++) if (i & (1 << b)) r |= 1 << (bits - 1 - b);
      this.rev[i] = r;
    }
  }
  Fft.prototype.transform = function (re, im) {
    var n = this.n, rev = this.rev, cos = this.cos, sin = this.sin, i, t;
    for (i = 0; i < n; i++) {
      var j = rev[i];
      if (j > i) {
        t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (var size = 2; size <= n; size <<= 1) {
      var half = size >> 1, step = n / size;
      for (var start = 0; start < n; start += size) {
        for (var k = 0; k < half; k++) {
          var wr = cos[k * step], wi = sin[k * step];
          var a = start + k, c = a + half;
          var tr = re[c] * wr - im[c] * wi;
          var ti = re[c] * wi + im[c] * wr;
          re[c] = re[a] - tr;
          im[c] = im[a] - ti;
          re[a] += tr;
          im[a] += ti;
        }
      }
    }
  };

  /* Smallest power of two whose frame can hold the lowest note at this sample
     rate. Browsers run at 44.1 or 48 kHz (4096 samples, as in the app), and
     some audio interfaces at 96 kHz (8192). */
  function frameSizeFor(sampleRate, minHz) {
    var maxLag = Math.ceil(sampleRate / (minHz || 27));
    var size = 4096;
    while (maxLag >= size >> 1) size <<= 1;
    return size;
  }

  /* YIN pitch detection (de Cheveigne and Kawahara, 2002) with the difference
     function computed through an FFT. Returns {hz, clarity} or null. */
  function PitchDetector(opts) {
    opts = opts || {};
    this.sampleRate = opts.sampleRate || 44100;
    this.minHz = opts.minHz || 27;
    this.maxHz = opts.maxHz || 4500;
    this.frameSize = opts.frameSize || frameSizeFor(this.sampleRate, this.minHz);
    this.threshold = opts.threshold === undefined ? 0.15 : opts.threshold;
    this.gateRms = opts.gateRms === undefined ? 0.003 : opts.gateRms;
    this.maxLag = Math.ceil(this.sampleRate / this.minHz);
    this.minLag = Math.max(2, Math.floor(this.sampleRate / this.maxHz));
    if (this.maxLag >= this.frameSize >> 1) throw new Error('frame too short for minHz');
    this.window = this.frameSize - this.maxLag;
    var m = 1;
    while (m < this.frameSize + this.window) m <<= 1;
    this.m = m;
    this.fft = new Fft(m);
    this.aRe = new Float64Array(m);
    this.aIm = new Float64Array(m);
    this.bRe = new Float64Array(m);
    this.bIm = new Float64Array(m);
    this.diff = new Float64Array(this.maxLag + 1);
    this.energy = new Float64Array(this.frameSize + 1);
  }

  PitchDetector.prototype.detect = function (x) {
    var frameSize = this.frameSize, maxLag = this.maxLag, minLag = this.minLag;
    var threshold = this.threshold, window = this.window, m = this.m;
    var diff = this.diff, energy = this.energy;
    var aRe = this.aRe, aIm = this.aIm, bRe = this.bRe, bIm = this.bIm;
    var i, t;
    if (x.length < frameSize) throw new Error('frame too short');

    // Remove DC so a microphone offset does not look like a long period.
    var mean = 0;
    for (i = 0; i < frameSize; i++) mean += x[i];
    mean /= frameSize;
    var e = 0;
    energy[0] = 0;
    for (i = 0; i < frameSize; i++) {
      var v = x[i] - mean;
      e += v * v;
      energy[i + 1] = e;
    }
    if (Math.sqrt(e / frameSize) < this.gateRms) return null;

    // Cross term r(t) = sum_{j<W} x[j] * x[j+t], as a correlation via FFT.
    for (i = 0; i < m; i++) {
      aRe[i] = i < window ? x[i] - mean : 0;
      bRe[i] = i < frameSize ? x[i] - mean : 0;
      aIm[i] = 0;
      bIm[i] = 0;
    }
    this.fft.transform(aRe, aIm);
    this.fft.transform(bRe, bIm);
    for (i = 0; i < m; i++) {
      // conj(A) * B
      var re = aRe[i] * bRe[i] + aIm[i] * bIm[i];
      var im = aRe[i] * bIm[i] - aIm[i] * bRe[i];
      bRe[i] = re;
      bIm[i] = -im; // conjugate, so a forward transform acts as the inverse
    }
    this.fft.transform(bRe, bIm);
    // bRe[t] / m is now r(t).

    // Difference function and its cumulative mean normalisation.
    var e0 = energy[window];
    diff[0] = 1;
    var running = 0;
    for (t = 1; t <= maxLag; t++) {
      var et = energy[t + window] - energy[t];
      var d = e0 + et - 2 * bRe[t] / m;
      running += d;
      diff[t] = running <= 0 ? 1 : d * t / running;
    }

    // First dip under the threshold, then the deepest point of that dip.
    var tau = -1;
    for (t = minLag; t < maxLag; t++) {
      if (diff[t] < threshold) {
        tau = t;
        while (t + 1 < maxLag && diff[t + 1] < threshold) {
          t++;
          if (diff[t] < diff[tau]) tau = t;
        }
        break;
      }
    }
    if (tau < 0) {
      // No dip under the threshold: take the global minimum if it is clear.
      var best = minLag;
      for (t = minLag + 1; t < maxLag; t++) if (diff[t] < diff[best]) best = t;
      if (diff[best] > 0.35) return null;
      tau = best;
    }

    var refined = this.interpolate(tau);
    // Short periods: measure across the furthest clean multiple of the period,
    // which divides the interpolation error by that count.
    var limit = threshold * 2 + diff[tau];
    for (var k = Math.trunc((maxLag - 2) / refined); k >= 2; k--) {
      var centre = Math.round(refined * k);
      var span = Math.max(3, Math.round(refined * 0.06));
      t = centre;
      var hi = Math.min(maxLag - 1, centre + span);
      for (var u = Math.max(minLag, centre - span); u <= hi; u++) if (diff[u] < diff[t]) t = u;
      if (diff[t] <= limit) {
        refined = this.interpolate(t) / k;
        break;
      }
    }
    var hz = this.sampleRate / refined;
    if (hz < this.minHz || hz > this.maxHz) return null;
    return { hz: hz, clarity: Math.min(1, Math.max(0, 1 - diff[tau])) };
  };

  /* Parabolic interpolation around a minimum, for sub-sample accuracy. */
  PitchDetector.prototype.interpolate = function (t) {
    if (t < 1 || t >= this.maxLag) return t;
    var a = this.diff[t - 1], b = this.diff[t], c = this.diff[t + 1];
    var den = a - 2 * b + c;
    if (Math.abs(den) < 1e-12) return t;
    return t + 0.5 * (a - c) / den;
  };

  function rms(x, n) {
    n = n || x.length;
    var s = 0;
    for (var i = 0; i < n; i++) s += x[i] * x[i];
    return Math.sqrt(s / n);
  }

  /* Notes. */
  var LETTERS = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
  function noteName(midi) { return LETTERS[((midi % 12) + 12) % 12]; }
  /* Scientific octave number: middle C (MIDI 60) is C4. */
  function octaveOf(midi) { return Math.floor(midi / 12) - 1; }
  function midiToHz(midi, a4) { return (a4 || 440) * Math.pow(2, (midi - 69) / 12); }
  function hzToMidi(hz, a4) { return 69 + 12 * Math.log(hz / (a4 || 440)) / Math.LN2; }
  /* The nearest note to a frequency and how far off it is (-50 to +50 cents). */
  function readingFor(hz, a4) {
    var m = hzToMidi(hz, a4), n = Math.round(m);
    return { midi: n, cents: (m - n) * 100, hz: hz };
  }
  /* Cents from a target note, not wrapped to +/-50 (for string tuning). */
  function centsFrom(hz, targetMidi, a4) { return (hzToMidi(hz, a4) - targetMidi) * 100; }

  /* Tunings: MIDI notes, in the order players name the strings. */
  var TUNINGS = [
    { id: 'chromatic', label: 'Chromatic', strings: [] },
    { id: 'guitar.standard', label: 'Guitar, standard', strings: [40, 45, 50, 55, 59, 64] },
    { id: 'guitar.dropD', label: 'Guitar, drop D', strings: [38, 45, 50, 55, 59, 64] },
    { id: 'bass.standard', label: 'Bass, 4-string', strings: [28, 33, 38, 43] },
    { id: 'bass.five', label: 'Bass, 5-string', strings: [23, 28, 33, 38, 43] },
    { id: 'ukulele.standard', label: 'Ukulele, standard', strings: [67, 60, 64, 69] },
    { id: 'violin.standard', label: 'Violin', strings: [55, 62, 69, 76] },
    { id: 'viola.standard', label: 'Viola', strings: [48, 55, 62, 69] },
    { id: 'cello.standard', label: 'Cello', strings: [36, 43, 50, 57] }
  ];
  function tuningById(id) {
    for (var i = 0; i < TUNINGS.length; i++) if (TUNINGS[i].id === id) return TUNINGS[i];
    return TUNINGS[0];
  }

  /* Index of the string closest to hz, or null when nothing is within a fourth
     (so a stray note does not jump the highlight). */
  function nearestString(tuning, hz, a4) {
    if (!tuning.strings.length) return null;
    var best = 0, bestDist = Infinity;
    for (var i = 0; i < tuning.strings.length; i++) {
      var d = Math.abs(centsFrom(hz, tuning.strings[i], a4));
      if (d < bestDist) { bestDist = d; best = i; }
    }
    return bestDist <= 500 ? best : null;
  }

  /* What the needle should show for a frequency under the chosen tuning. */
  function viewFor(hz, tuning, a4) {
    var i = nearestString(tuning, hz, a4);
    if (i !== null) {
      var midi = tuning.strings[i];
      var c = centsFrom(hz, midi, a4);
      return { midi: midi, cents: Math.max(-50, Math.min(50, c)), stringIndex: i, hz: hz };
    }
    var r = readingFor(hz, a4);
    return { midi: r.midi, cents: r.cents, stringIndex: null, hz: hz };
  }

  /* Median of the last few readings plus light easing. A new note drops the old
     history so the needle jumps rather than crawls. After 350 ms of silence the
     last note is held (dimmed); after 4 s it clears. Times are in milliseconds. */
  function Smoother() { this.reset(); }
  Smoother.prototype.reset = function () {
    this.recent = [];
    this.hz = null;
    this.held = false;
    this.lastHeard = -Infinity;
  };
  Smoother.prototype.update = function (pitch, now) {
    if (!pitch || pitch.clarity < 0.85) { this.decay(now); return this.hz; }
    var r = this.recent;
    if (r.length && Math.abs(hzToMidi(pitch.hz) - hzToMidi(r[r.length - 1])) > 0.6) r.length = 0;
    r.push(pitch.hz);
    if (r.length > 5) r.shift();
    var sorted = r.slice().sort(function (a, b) { return a - b; });
    var median = sorted[sorted.length >> 1];
    var prev = this.hz;
    this.hz = (prev === null || this.held || Math.abs(hzToMidi(median) - hzToMidi(prev)) > 0.3)
      ? median
      : prev + (median - prev) * 0.45;
    this.held = false;
    this.lastHeard = now;
    return this.hz;
  };
  Smoother.prototype.decay = function (now) {
    if (this.hz === null) return;
    var quiet = now - this.lastHeard;
    if (quiet > 4000) { this.hz = null; this.held = false; this.recent.length = 0; }
    else if (quiet > 350) this.held = true;
  };

  /* A plucked reference tone: exact pitch from additive partials, higher
     partials dying away faster. From the app's audio_synth.dart. */
  function pluck(hz, sampleRate, seconds) {
    sampleRate = sampleRate || 44100;
    seconds = seconds || 2.5;
    var n = Math.round(sampleRate * seconds);
    var out = new Float32Array(n);
    var parts = [];
    for (var h = 1; h <= 8; h++) {
      if (hz * h > sampleRate * 0.45) break;
      parts.push([2 * Math.PI * hz * h / sampleRate, 1 / Math.pow(h, 1.3), 1.4 + 0.9 * h]);
    }
    var sustain = 0.6 + 0.8 * (1 - Math.max(0, Math.min(1, hz / 800)));
    var peak = 1e-9, i;
    for (i = 0; i < n; i++) {
      var t = i / sampleRate, s = 0;
      for (var p = 0; p < parts.length; p++) {
        s += parts[p][1] * Math.exp(-parts[p][2] * t / sustain) * Math.sin(parts[p][0] * i);
      }
      out[i] = s * Math.min(1, i / (sampleRate * 0.004));
      peak = Math.max(peak, Math.abs(out[i]));
    }
    var fade = Math.round(sampleRate * 0.25);
    for (i = 0; i < n; i++) {
      var g = 0.8 / peak;
      if (i > n - fade) g *= (n - i) / fade;
      out[i] *= g;
    }
    return out;
  }

  /* What to tell the player when the browser refuses the microphone. */
  function micErrorKind(err) {
    var name = err && err.name;
    if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError') return 'denied';
    if (name === 'NotFoundError' || name === 'DevicesNotFoundError' || name === 'OverconstrainedError') return 'nomic';
    if (name === 'NotReadableError' || name === 'TrackStartError' || name === 'AbortError') return 'busy';
    return 'other';
  }

  return {
    PitchDetector: PitchDetector, frameSizeFor: frameSizeFor, rms: rms,
    noteName: noteName, octaveOf: octaveOf, midiToHz: midiToHz, hzToMidi: hzToMidi,
    readingFor: readingFor, centsFrom: centsFrom,
    TUNINGS: TUNINGS, tuningById: tuningById, nearestString: nearestString, viewFor: viewFor,
    Smoother: Smoother, pluck: pluck, micErrorKind: micErrorKind
  };
});
