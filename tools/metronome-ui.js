/* TuneLog web metronome: page wiring around the scheduler in metronome.js. */
(function () {
  'use strict';
  var M = window.MetronomeLogic;
  var $ = function (id) { return document.getElementById(id); };
  var els = {
    bpm: $('bpm'), slider: $('bpmrange'), minus: $('minus'), plus: $('plus'), marking: $('marking'),
    sig: $('sig'), sub: $('sub'), sound: $('sound'), tap: $('tap'), go: $('go'), lights: $('lights'), note: $('note8')
  };
  var LOOKAHEAD = 0.12, HIDDEN_LOOKAHEAD = 1.5, TICK_MS = 25;

  function load(key, dflt) { try { var v = localStorage.getItem('metronome.' + key); return v === null ? dflt : v; } catch (e) { return dflt; } }
  function save(key, value) { try { localStorage.setItem('metronome.' + key, value); } catch (e) { /* optional */ } }

  var ctx = null, timer = null, wake = null, running = false;
  var buffers = {}, live = [], queue = [];
  var tapper = new M.TapTempo();
  var bpm = M.clampBpm(load('bpm', 100));
  var sigs = ['4/4', '3/4', '2/4', '1/4', '5/4', '6/4', '7/4', '3/8', '5/8', '6/8', '7/8', '9/8', '12/8'];
  var sigValue = load('sig', '4/4');
  if (sigs.indexOf(sigValue) < 0) sigValue = '4/4';
  var beats = parseInt(sigValue, 10);
  var parts = parseInt(load('sub', '1'), 10) || 1;
  var accents = M.defaultAccents(beats);
  var sound = load('sound', 'wood');

  var scheduler = new M.Scheduler({
    now: function () { return ctx ? ctx.currentTime : 0; },
    onClick: play,
    bpm: bpm, beats: beats, parts: parts, accents: accents
  });

  function bufferFor(level) {
    var key = sound + level;
    if (!buffers[key]) {
      var samples = M.renderClick(sound, level, ctx.sampleRate);
      var b = ctx.createBuffer(1, samples.length, ctx.sampleRate);
      b.copyToChannel(samples, 0);
      buffers[key] = b;
    }
    return buffers[key];
  }

  /* Hands one click to the audio clock. This is what makes it accurate:
     Web Audio starts the sound on the exact sample for c.time. */
  function play(c) {
    if (!c.muted) {
      var s = ctx.createBufferSource();
      s.buffer = bufferFor(c.level);
      s.connect(ctx.destination);
      s.start(c.time);
      live.push(s);
      s.onended = function () { var i = live.indexOf(s); if (i >= 0) live.splice(i, 1); };
    }
    if (c.part === 0) queue.push(c);
  }

  function loop() {
    scheduler.tick(document.hidden ? HIDDEN_LOOKAHEAD : LOOKAHEAD);
    draw();
  }

  /* Lights follow what is being heard, not what was scheduled. */
  function draw() {
    if (!running) return;
    var heard = ctx.currentTime - (ctx.outputLatency || 0);
    var lit = null;
    while (queue.length && queue[0].time <= heard) lit = queue.shift();
    if (lit) setLight(lit.beat);
  }
  function frame() {
    if (!running) return;
    draw();
    requestAnimationFrame(frame);
  }

  function setLight(beat) {
    var b = els.lights.children;
    for (var i = 0; i < b.length; i++) b[i].classList.toggle('on', i === beat);
  }

  function accentLabel(a) { return a === M.STRONG ? 'accent' : a === M.NORMAL ? 'normal' : 'silent'; }

  function buildLights() {
    els.lights.innerHTML = '';
    accents.forEach(function (a, i) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'light ' + a;
      b.setAttribute('aria-label', 'Beat ' + (i + 1) + ': ' + accentLabel(a) + '. Press to change.');
      b.textContent = String(i + 1);
      b.addEventListener('click', function () {
        accents[i] = M.nextAccent(accents[i]);
        b.className = 'light ' + accents[i];
        b.setAttribute('aria-label', 'Beat ' + (i + 1) + ': ' + accentLabel(accents[i]) + '. Press to change.');
      });
      els.lights.appendChild(b);
    });
  }

  function showBpm() {
    els.bpm.value = String(bpm);
    els.slider.value = String(bpm);
    els.marking.textContent = M.tempoMarking(bpm);
  }

  function setBpm(v) {
    bpm = M.clampBpm(v);
    scheduler.setBpm(bpm);
    save('bpm', String(bpm));
    showBpm();
  }

  function requestWake() {
    if (!navigator.wakeLock || wake) return;
    navigator.wakeLock.request('screen').then(function (w) {
      wake = w;
      w.addEventListener('release', function () { wake = null; });
    }).catch(function () { /* optional: the page works without it */ });
  }

  function start() {
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) { els.go.textContent = 'Web Audio is not available'; return; }
    if (!ctx) ctx = new AC();
    if (ctx.state !== 'running' && ctx.resume) ctx.resume().catch(function () {});
    running = true;
    scheduler.start(0.08);
    loop();
    timer = setInterval(loop, TICK_MS);
    requestAnimationFrame(frame);
    requestWake();
    els.go.textContent = 'Stop';
    els.go.setAttribute('aria-pressed', 'true');
  }

  function stop() {
    running = false;
    scheduler.stop();
    clearInterval(timer);
    timer = null;
    live.forEach(function (s) { try { s.stop(); } catch (e) { /* already ended */ } });
    live = [];
    queue = [];
    setLight(-1);
    if (wake) { wake.release().catch(function () {}); wake = null; }
    els.go.textContent = 'Start';
    els.go.setAttribute('aria-pressed', 'false');
  }

  function toggle() { if (running) stop(); else start(); }

  function applyMeter() {
    sigValue = els.sig.value;
    beats = parseInt(sigValue, 10);
    parts = parseInt(els.sub.value, 10) || 1;
    accents = M.defaultAccents(beats);
    scheduler.setMeter(beats, parts, accents);
    save('sig', sigValue);
    save('sub', String(parts));
    buildLights();
    els.note.hidden = !/\/8$/.test(sigValue);
  }

  sigs.forEach(function (s) {
    var o = document.createElement('option');
    o.value = s;
    o.textContent = s;
    els.sig.appendChild(o);
  });
  els.sig.value = sigValue;
  els.sub.value = String(parts);
  els.sound.value = sound;
  els.note.hidden = !/\/8$/.test(sigValue);
  buildLights();
  showBpm();

  els.go.addEventListener('click', toggle);
  els.minus.addEventListener('click', function () { setBpm(bpm - 1); });
  els.plus.addEventListener('click', function () { setBpm(bpm + 1); });
  els.slider.addEventListener('input', function () { setBpm(els.slider.value); });
  els.bpm.addEventListener('change', function () { setBpm(els.bpm.value); });
  els.tap.addEventListener('click', function () {
    var b = tapper.tap(Date.now());
    if (b !== null) setBpm(b);
  });
  els.sig.addEventListener('change', applyMeter);
  els.sub.addEventListener('change', applyMeter);
  els.sound.addEventListener('change', function () { sound = els.sound.value; save('sound', sound); });

  document.addEventListener('keydown', function (e) {
    if (e.target !== document.body || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === ' ') { e.preventDefault(); toggle(); }
    else if (e.key === 't' || e.key === 'T') { var b = tapper.tap(Date.now()); if (b !== null) setBpm(b); }
  });
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && running) {
      if (ctx.state !== 'running' && ctx.resume) ctx.resume().catch(function () {});
      requestWake();
      loop();
    }
  });
  window.addEventListener('pagehide', function () { if (running) stop(); });
})();
