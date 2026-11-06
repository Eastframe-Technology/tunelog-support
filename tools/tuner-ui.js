/* TuneLog web tuner: page wiring. The sound is read from the browser's analyser
   into memory, one short frame at a time, and thrown away. Nothing is stored or
   sent, and this page's Content-Security-Policy forbids network requests. */
(function () {
  'use strict';
  var T = window.TunerLogic;
  var $ = function (id) { return document.getElementById(id); };
  var els = {
    tuning: $('tuning'), a4: $('a4'), start: $('start'), note: $('note'), octave: $('octave'),
    hint: $('hint'), cents: $('cents'), hz: $('hz'), strings: $('strings'), level: $('level'),
    needle: $('needle'), msg: $('micmsg'), readout: $('readout')
  };

  var MESSAGES = {
    unsupported: '<strong>This browser cannot use the microphone here.</strong> Microphone access needs a current browser and a secure (https) page. You can still tune by ear: pick an instrument above and tap a string to hear its note.',
    denied: '<strong>Microphone access is blocked.</strong> The tuner cannot hear you until you allow it. Look for the microphone or lock icon next to the address bar, allow the microphone for this site, then press Start again. On a phone you may also need to allow the microphone for your browser in the system settings. Without it you can still tune by ear: pick an instrument above and tap a string to hear its note.',
    nomic: '<strong>No microphone found.</strong> Connect one, or open this page on your phone, then press Start again. You can still tune by ear: pick an instrument above and tap a string to hear its note.',
    busy: '<strong>The microphone is busy or could not start.</strong> Another app or tab may be using it. Close it and press Start again.',
    other: '<strong>The microphone could not start.</strong> Press Start to try again. You can still tune by ear: pick an instrument above and tap a string to hear its note.',
    ended: '<strong>The microphone stopped.</strong> Another app may have taken it, or the device changed. Press Start to listen again.'
  };

  function load(key) { try { return localStorage.getItem('tuner.' + key); } catch (e) { return null; } }
  function save(key, value) { try { localStorage.setItem('tuner.' + key, value); } catch (e) { /* optional */ } }

  var tuning = T.tuningById(load('tuning') || 'chromatic');
  var a4 = clampA4(load('a4') || 440);
  var ctx = null, stream = null, source = null, analyser = null, silence = null;
  var detector = null, buffer = null, timer = null;
  var smoother = new T.Smoother();
  var wanted = false, suppressUntil = 0, lastAudio = 0, tonePlaying = null;
  var tunedStrings = {}, inTuneString = null, inTuneSince = 0;

  function clampA4(v) {
    v = Math.round(Number(v));
    if (!isFinite(v)) return 440;
    return Math.max(415, Math.min(466, v));
  }

  function audio() {
    if (!ctx) {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
    }
    if (ctx.state !== 'running' && ctx.resume) ctx.resume().catch(function () {});
    return ctx;
  }

  function showMessage(kind) {
    if (!kind) { els.msg.hidden = true; els.msg.innerHTML = ''; return; }
    els.msg.innerHTML = MESSAGES[kind];
    els.msg.hidden = false;
  }

  function setRunningUi(on) {
    els.start.textContent = on ? 'Stop tuner' : 'Start tuner';
    els.start.setAttribute('aria-pressed', on ? 'true' : 'false');
  }

  function start() {
    showMessage(null);
    var md = navigator.mediaDevices;
    if (!md || !md.getUserMedia) { showMessage('unsupported'); return; }
    // Created inside the tap, so phones let it make and hear sound.
    if (!audio()) { showMessage('unsupported'); return; }
    wanted = true;
    els.hint.textContent = 'Waiting for the microphone...';
    openMic();
  }

  function openMic() {
    navigator.mediaDevices.getUserMedia({
      // A tuner wants the raw signal: voice processing removes steady tones.
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
      video: false
    }).then(function (s) {
      if (!wanted) { s.getTracks().forEach(function (t) { t.stop(); }); return; }
      stream = s;
      var track = s.getAudioTracks()[0];
      if (track) track.onended = function () { if (wanted) { stopMic(); wanted = false; setRunningUi(false); showMessage('ended'); resetDisplay(); } };
      detector = new T.PitchDetector({ sampleRate: ctx.sampleRate });
      buffer = new Float32Array(detector.frameSize);
      source = ctx.createMediaStreamSource(s);
      analyser = ctx.createAnalyser();
      analyser.fftSize = detector.frameSize;
      analyser.smoothingTimeConstant = 0;
      // Silent path to the output: some browsers only run nodes that lead there.
      // The gain is 0, so the microphone is never played back.
      silence = ctx.createGain();
      silence.gain.value = 0;
      source.connect(analyser);
      analyser.connect(silence);
      silence.connect(ctx.destination);
      lastAudio = performance.now();
      setRunningUi(true);
      els.hint.textContent = 'Listening. Play one note and let it ring.';
      timer = setInterval(read, 23);
    }).catch(function (err) {
      wanted = false;
      setRunningUi(false);
      resetDisplay();
      showMessage(T.micErrorKind(err));
    });
  }

  function stopMic() {
    if (timer) { clearInterval(timer); timer = null; }
    if (source) { source.disconnect(); source = null; }
    if (analyser) { analyser.disconnect(); analyser = null; }
    if (silence) { silence.disconnect(); silence = null; }
    if (stream) { stream.getTracks().forEach(function (t) { t.onended = null; t.stop(); }); stream = null; }
    smoother.reset();
  }

  function stop() {
    wanted = false;
    stopMic();
    setRunningUi(false);
    resetDisplay();
    showMessage(null);
  }

  function read() {
    if (!analyser) return;
    if (ctx.state !== 'running' && ctx.resume) ctx.resume().catch(function () {});
    analyser.getFloatTimeDomainData(buffer);
    var now = performance.now();
    var level = T.rms(buffer);
    els.level.style.width = Math.min(100, level * 800) + '%';
    if (level > 0) lastAudio = now;
    else if (now - lastAudio > 2500) els.hint.textContent = 'No sound is reaching the page. Check that the microphone is not muted.';
    // While a reference tone plays the tuner would only hear the speaker.
    if (now < suppressUntil) { smoother.reset(); render(now); return; }
    smoother.update(detector.detect(buffer), now);
    render(now);
  }

  function setNeedle(cents) {
    var deg = Math.max(-50, Math.min(50, cents)) * 1.2;
    els.needle.setAttribute('transform', 'rotate(' + deg.toFixed(2) + ' 160 164)');
  }

  function render(now) {
    if (smoother.hz === null) {
      if (now >= suppressUntil && lastAudio && now - lastAudio <= 2500) els.hint.textContent = 'Listening. Play one note and let it ring.';
      els.note.textContent = '–';
      els.octave.textContent = '';
      els.cents.textContent = '';
      els.hz.textContent = '';
      els.readout.className = 'readout';
      setNeedle(0);
      markString(null);
      trackTuned(null, 99, now);
      return;
    }
    var v = T.viewFor(smoother.hz, tuning, a4);
    var good = Math.abs(v.cents) <= 5;
    els.note.textContent = T.noteName(v.midi);
    els.octave.textContent = String(T.octaveOf(v.midi));
    var whole = Math.round(v.cents);
    els.cents.textContent = (whole > 0 ? '+' : whole < 0 ? '\u2212' : '') + Math.abs(whole) + ' cents';
    els.hz.textContent = smoother.hz.toFixed(1) + ' Hz';
    els.hint.textContent = good ? 'In tune' : (v.cents < 0 ? 'Too low: tune up' : 'Too high: tune down');
    els.readout.className = 'readout' + (good ? ' good' : '') + (smoother.held ? ' held' : '');
    setNeedle(v.cents);
    markString(v.stringIndex);
    trackTuned(smoother.held ? null : v.stringIndex, v.cents, now);
  }

  function markString(i) {
    var b = els.strings.querySelectorAll('button');
    for (var k = 0; k < b.length; k++) b[k].classList.toggle('target', k === i);
  }

  /* Ticks a string once it has stayed within 3 cents for a moment, as the app does. */
  function trackTuned(i, cents, now) {
    if (i === null || Math.abs(cents) > 3) { inTuneString = null; return; }
    if (inTuneString !== i) { inTuneString = i; inTuneSince = now; return; }
    if (!tunedStrings[i] && now - inTuneSince > 700) {
      tunedStrings[i] = true;
      var b = els.strings.querySelectorAll('button')[i];
      if (b) b.classList.add('tuned');
    }
  }

  function resetDisplay() {
    els.note.textContent = '–';
    els.octave.textContent = '';
    els.cents.textContent = '';
    els.hz.textContent = '';
    els.level.style.width = '0';
    els.readout.className = 'readout';
    els.hint.textContent = 'Press Start and play one note.';
    setNeedle(0);
    markString(null);
  }

  function playTone(midi, button) {
    var c = audio();
    if (!c) return;
    if (tonePlaying) { try { tonePlaying.stop(); } catch (e) { /* already ended */ } }
    var samples = T.pluck(T.midiToHz(midi, a4), c.sampleRate, 2.5);
    var buf = c.createBuffer(1, samples.length, c.sampleRate);
    buf.copyToChannel(samples, 0);
    var s = c.createBufferSource();
    s.buffer = buf;
    s.connect(c.destination);
    s.start();
    tonePlaying = s;
    suppressUntil = performance.now() + 2600;
    button.classList.add('playing');
    s.onended = function () { button.classList.remove('playing'); if (tonePlaying === s) tonePlaying = null; };
  }

  function buildStrings() {
    els.strings.innerHTML = '';
    tunedStrings = {};
    tuning.strings.forEach(function (midi) {
      var b = document.createElement('button');
      b.type = 'button';
      var name = T.noteName(midi), oct = T.octaveOf(midi);
      b.innerHTML = name + '<sub>' + oct + '</sub>';
      b.setAttribute('aria-label', 'Play ' + name + oct);
      b.addEventListener('click', function () { playTone(midi, b); });
      els.strings.appendChild(b);
    });
    $('stringhelp').hidden = tuning.strings.length === 0;
  }

  T.TUNINGS.forEach(function (t) {
    var o = document.createElement('option');
    o.value = t.id;
    o.textContent = t.label;
    els.tuning.appendChild(o);
  });
  els.tuning.value = tuning.id;
  els.a4.value = String(a4);
  buildStrings();
  resetDisplay();

  els.tuning.addEventListener('change', function () {
    tuning = T.tuningById(els.tuning.value);
    save('tuning', tuning.id);
    buildStrings();
  });
  els.a4.addEventListener('change', function () {
    a4 = clampA4(els.a4.value);
    els.a4.value = String(a4);
    save('a4', String(a4));
  });
  els.start.addEventListener('click', function () { if (wanted) stop(); else start(); });

  // The microphone runs only while the tuner is on screen, as in the app.
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      if (wanted) stopMic();
    } else if (wanted && !stream) {
      if (ctx && ctx.state !== 'running' && ctx.resume) ctx.resume().catch(function () {});
      openMic();
    }
  });
  window.addEventListener('pagehide', function () { stopMic(); });
  window.addEventListener('pageshow', function (e) { if (e.persisted && wanted && !stream) openMic(); });
})();
