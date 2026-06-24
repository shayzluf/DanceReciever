/*
 * DanceNow custom Cast receiver — the "TV app."
 *
 * The TV is the big shared screen: it plays the song (and is the authoritative clock the phone syncs
 * to), shows the COACH (a drawn figure / the user's silent clip / a platform embed) in a constrained
 * STAGE, and renders feedback in a RAIL beside (portrait) or under (landscape) the video — a Just-Dance
 * "now / next move" pictogram filmstrip + per-player score chips + a tasteful rating flash. We NEVER draw
 * feedback on top of the video (licensing/ToS). The phone is the camera/scorer.
 *
 * Browser preview (NO Chromecast): open  receiver/index.html?mock=1  in Chrome (DNTestMoves/DNTestOrient/
 * DNTestDebug to exercise the rail). Add ?debug=1 for the dev reference-pose overlay.
 *
 * Namespace urn:x-cast:com.dancenow.sync
 *   phone → TV   { t:'load', audioUrl, mirrored, chunks, moveChunks, aspectW, aspectH, orient }  then { t:'pose', frames:[{t,j}] } × chunks
 *   phone → TV   { t:'loadEmbed', provider, videoID, mirrored, moveChunks, orient }   // TV plays the platform video
 *   phone → TV   { t:'loadVideo', videoUrl, audioUrl, mirrored, moveChunks, aspectW, aspectH, orient }  // silent clip + catalog mp3
 *   phone → TV   { t:'moves', moves:[{i,t,gold,j}] } × moveChunks   // one-shot move pictograms (TV advances by playhead)
 *   phone → TV   { t:'cmd', cmd:'play'|'pause'|'stop'|'debug', on? }
 *   phone → TV   { t:'feedback', lane, rating, points, gold, at, idx, timing }   // timing: ''|'early'|'on'|'late' (player-vs-coach)
 *   phone → TV   { t:'score', scores:[{lane,total,combo,seen,fix}] }   // seen:'ok'|'fix'|'lost' (+fix cue) → beacons
 *   phone → TV   { t:'final', players:[{lane,total,stars}] }   // round over → big final-score reveal
 *   phone → TV   { t:'getready', n }  ·  { t:'go' }            // "Get Ready" countdown on the TV
 *   phone → TV   { t:'framing', state:'setup'|'paused', instr, players:[{lane,ok,j}] }  // Set up your stage
 *   phone → TV   { t:'guard', lane, state:'grace'|'nudge'|'rejoin'|'ok', ring }  // in-round "come back" nudge
 *   phone → TV   { t:'dbgpose', j, bones }   // DEV-ONLY: reference pose + per-bone match for the debug overlay
 *   phone → TV   { t:'ping', id, cs }
 *   TV → phone   { t:'ph', rt, ts, st, seq }  ·  { t:'pong', id, cs, rs }  ·  { t:'ready' }
 */
(function () {
  'use strict';

  // Shared palette — generated from /design-tokens.json into window.FlooredTokens (index.html loads it
  // before this file), the SAME source the Swift app reads via DesignTokens. The inline fallback is an
  // emergency net only if that generated file failed to load (TV stays functional, just off-brand); the
  // canonical values live in design-tokens.json — edit there + run scripts/gen-design-tokens.mjs.
  var TOK = window.FlooredTokens || {
    skeleton: { core: '#eafeff', glow: '#22d3ee', joint: '#f472b6', ground: '#a78bfa' },
    lanes: ['#ff5ca8', '#6a8bff', '#34c759', '#ff9f0a'],
    gold: '#ffd400', warning: '#ff9f0a', bg: '#0b0b12',
    tiers: { perfect: '#34c759', good: '#30d158', ok: '#64d2ff', miss: '#ff453a', gold: '#ffd400' }
  };

  var NS = 'urn:x-cast:com.dancenow.sync';
  var context = (window.cast && cast.framework) ? cast.framework.CastReceiverContext.getInstance() : null;
  var senders = {};

  var audio = document.getElementById('song');
  var canvas = document.getElementById('coach');
  var ctx = canvas.getContext('2d');
  var glowEl = document.getElementById('glow');
  var wordEl = document.getElementById('word');
  var finalEl = document.getElementById('final');
  var getreadyEl = document.getElementById('getready');
  var stageEl = document.getElementById('stage');
  var stageBox = stageEl ? stageEl.querySelector('.stage-box') : null;
  var stageCanvas = document.getElementById('stagecanvas');
  var stageCtx = stageCanvas ? stageCanvas.getContext('2d') : null;
  var statusEl = document.getElementById('status');
  var lobbyEl = document.getElementById('lobby');
  var lobbyStatusEl = document.getElementById('lobbystatus');
  var recordEl = document.getElementById('record');
  var recordMode = false;   // a take is recording on the PHONE → show the "watch the phone" card, hide boxes
  var castlockEl = document.getElementById('castlock');   // out of free casts → "Casting is Plus" + QR card

  // Stage + rail (the split layout). The coach lives in #videostage; the rail's sole job now is the
  // move filmstrip — scores/identity/presence live in the in-sightline #beacons layer.
  var videostageEl = document.getElementById('videostage');
  var railEl = document.getElementById('rail');
  var filmstripEl = document.getElementById('filmstrip');
  var dbgCanvas = document.getElementById('dbgskeleton');
  var dbgCtx = dbgCanvas ? dbgCanvas.getContext('2d') : null;

  // Move filmstrip: the checkpoint key-poses ("now / next" pictograms), sent once at load. The TV advances
  // the strip itself off the playhead (no per-frame streaming). nowIndex = the current move (last arrived).
  var moves = [];
  var moveChunks = 0;
  var recvMoveChunks = 0;
  var movesReady = false;
  var nowIndex = 0;
  var lastDrawnNow = -1;
  var tiles = [];            // [{el, canvas, ctx, kicker, badge, hairFill, plus}] — 4 tiles
  var dbgLive = null;        // dev-only: { j:{joint:[x,y]}, bones:[..] } streamed when debug is on

  // Build stamp — bump this (and the ?v= in index.html) on every receiver change. The TV shows it
  // bottom-right, so a stale/cached Cast device is detectable at a glance (wrong/missing = reboot it).
  var BUILD = 'jun24-byo0';
  var buildEl = document.getElementById('build');
  if (buildEl) buildEl.textContent = 'build ' + BUILD;

  var bones = [
    ['neck', 'nose'],
    ['neck', 'leftShoulder'], ['neck', 'rightShoulder'],
    ['leftShoulder', 'leftElbow'], ['leftElbow', 'leftWrist'],
    ['rightShoulder', 'rightElbow'], ['rightElbow', 'rightWrist'],
    ['neck', 'root'],
    ['root', 'leftHip'], ['root', 'rightHip'],
    ['leftHip', 'leftKnee'], ['leftKnee', 'leftAnkle'],
    ['rightHip', 'rightKnee'], ['rightKnee', 'rightAnkle']
  ];

  var poseFrames = [];
  var expectedChunks = 0;
  var receivedChunks = 0;
  var loaded = false;
  var mirrored = true;
  var seq = 0;
  var lastBeacon = 0;
  var mockMode = false;
  var mockStart = 0;

  // Embed mode: the TV shows the routine's platform video (YouTube/TikTok/Vimeo) WITH its own sound,
  // instead of the drawn figure + mp3. The embed's currentTime becomes the authoritative playhead.
  var embedMode = false;
  var embedPlaying = false;
  var embedTime = 0;
  var embedPlayer = null;
  var embedApi = null;
  var embedEl = document.getElementById('embed');

  // Video mode (local catalog routine): the TV shows the user's *silent* recorded clip (staged on R2) as
  // the coach, with the licensed catalog mp3 (#song) synced to it. The video is the master clock. Because
  // it's our own content (not a platform embed), feedback overlays ARE allowed here (unlike embed mode).
  var videoMode = false;
  var videoPlaying = false;
  var videoEl = document.getElementById('castvideo');

  // When playback actually started (sec). For ~1.5s after, the music+video decoders are still settling, so
  // we DON'T re-seek the mp3 to the clip (those re-seeks were the start stutter) and we DON'T duck the
  // music for early feedback (which made the tones "take over" before the track established).
  var playStartedAt = 0;
  var SETTLE_NO_DUCK = 0.9;   // sec: hold full music
  var SETTLE_NO_SYNC = 1.5;   // sec: don't correct audio↔video drift

  function now() { return performance.now() / 1000; }
  function setStatus(t) { if (statusEl) statusEl.textContent = t; }
  function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
  // Idle install QR (In-Room QR loop): shown when nothing is happening, hidden the moment a phone
  // starts any routine activity (see the message listener) and restored on stop / disconnect.
  // The QR is for the BYSTANDERS; the status line beneath it is for the CASTER (waiting vs "you're
  // connected — pick a song"), so the idle screen never reads as a dead end to the person who cast.
  function updateLobbyStatus() {
    if (!lobbyStatusEl) return;
    var connected = Object.keys(senders).length > 0;
    lobbyStatusEl.textContent = connected
      ? 'Phone connected — pick a song and hit Dance!'
      : 'Dancing? Open Floored on your phone and tap the Cast button';
    lobbyStatusEl.classList.toggle('ok', connected);
  }
  function showLobby() { updateLobbyStatus(); if (lobbyEl) lobbyEl.style.display = 'flex'; }
  function hideLobby() { if (lobbyEl) lobbyEl.style.display = 'none'; }
  // Browser-preview hook: fake N connected phones and refresh the lobby line (no Cast SDK in a tab).
  window.DNTestLobbySenders = function (n) {
    senders = {};
    for (var i = 0; i < (n || 0); i++) senders['dev' + i] = true;
    updateLobbyStatus();
  };
  // Audio diagnostics + a feedback-storm driver (browser sims of the duck envelope; harmless on TV).
  // `graph:false` after a play means createMediaElementSource failed → tones live OUTSIDE the music
  // stream (on Cast hardware they then steal output focus and cut the music on every effect).
  window.DNTestAudioState = function () {
    return {
      graph: !!musicGain,
      ctx: actx ? actx.state : 'none',
      gain: musicGain ? musicGain.gain.value : null,
      vol: audio ? audio.volume : null,
      seeking: !!(audio && audio.seeking),
      t: audio ? (audio.currentTime || 0) : 0
    };
  };
  window.DNTestFeedbackStorm = function (seconds, perSecond) {
    var tiers = [['perfect', false], ['good', false], ['perfect', true], ['ok', false], ['miss', false]];
    var n = 0, max = Math.max(1, Math.round((seconds || 10) * (perSecond || 3)));
    var iv = setInterval(function () {
      var x = tiers[n % tiers.length];
      onFeedback({ rating: x[0], gold: x[1], points: 100, lane: n % 2, idx: 0 });
      if (++n >= max) clearInterval(iv);
    }, 1000 / (perSecond || 3));
  };

  // The authoritative playhead the phone syncs to: embed time (embed), the silent clip's time (video),
  // else the song's time.
  function currentPlayhead() {
    if (embedMode) return embedApi ? embedApi.time() : embedTime;
    if (videoMode) return videoEl ? (videoEl.currentTime || 0) : 0;
    if (mockMode) { var dur = (poseFrames.length ? poseFrames[poseFrames.length - 1].t : 1) || 1; return (now() - mockStart) % dur; }
    return audio.currentTime || 0;
  }

  // The coach canvas (+ debug overlay) now fill the STAGE box, not the window.
  function sizeStageCanvases() {
    if (!videostageEl) return;
    var w = videostageEl.clientWidth, h = videostageEl.clientHeight;
    if (w && h) {
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
      if (dbgCanvas && (dbgCanvas.width !== w || dbgCanvas.height !== h)) { dbgCanvas.width = w; dbgCanvas.height = h; }
    }
  }
  function resize() { sizeStageCanvases(); if (movesReady) renderFilmstrip(); }
  window.addEventListener('resize', resize);

  // Layout switches: orientation (portrait → side rail, landscape → bottom rail) + coach mode.
  function applyOrientation(orient) {
    var o = (orient === 'landscape' || orient === 'square') ? 'landscape' : 'portrait';
    document.body.classList.remove('orient-portrait', 'orient-landscape');
    document.body.classList.add('orient-' + o);
    sizeStageCanvases();
    if (movesReady) renderFilmstrip();   // tiles were resized by the new layout
  }
  function setMode(m) {
    document.body.classList.remove('mode-figure', 'mode-video', 'mode-embed');
    document.body.classList.add('mode-' + m);
  }
  function orientFrom(d) {
    if (d.aspectW && d.aspectH && d.aspectW > 0 && d.aspectH > 0) {
      var r = d.aspectW / d.aspectH;
      return r > 1.05 ? 'landscape' : (r < 0.95 ? 'portrait' : 'square');
    }
    return d.orient || null;
  }

  // Build the 4 filmstrip tiles once (NOW + next 3).
  function buildTiles() {
    if (!filmstripEl || tiles.length) return;
    for (var i = 0; i < 4; i++) {
      var el = document.createElement('div'); el.className = 'tile';
      var cv = document.createElement('canvas');
      var kicker = document.createElement('div'); kicker.className = 'kicker';
      var badge = document.createElement('div'); badge.className = 'badge'; badge.textContent = '★'; badge.style.display = 'none';
      var hair = document.createElement('div'); hair.className = 'hair';
      var hairFill = document.createElement('i'); hair.appendChild(hairFill);
      var plus = document.createElement('div'); plus.className = 'plus';
      el.appendChild(cv); el.appendChild(kicker); el.appendChild(badge); el.appendChild(hair); el.appendChild(plus);
      filmstripEl.appendChild(el);
      tiles.push({ el: el, canvas: cv, ctx: cv.getContext('2d'), kicker: kicker, badge: badge, hairFill: hairFill, plus: plus });
    }
  }

  document.body.classList.add('orient-portrait');   // a sane default until a routine reports its aspect
  buildTiles();
  sizeStageCanvases();

  // ---- Audio: ONE WebAudio graph for music + tone feedback ----
  // The music (HTML <audio>) is routed THROUGH the AudioContext (createMediaElementSource → musicGain →
  // destination) so it shares a SINGLE output stream with the WebAudio feedback tones. On Cast devices a
  // bare <audio> element and WebAudio are two separate streams, and the tone steals the output — cutting
  // the music on every signal. Routing the music into the same graph fixes that. Requires CORS on the
  // audio origin (#song has crossorigin="anonymous"); a no-CORS cross-origin source can't be routed.
  var AudioCtx = window.AudioContext || window.webkitAudioContext;
  var actx = AudioCtx ? new AudioCtx() : null;
  var musicGain = null;
  var musicGraphTried = false;

  function ensureMusicGraph() {
    if (musicGraphTried || !actx || !audio) return;
    musicGraphTried = true;
    try {
      var src = actx.createMediaElementSource(audio);
      musicGain = actx.createGain();
      musicGain.gain.value = 1;
      src.connect(musicGain);
      musicGain.connect(actx.destination);
    } catch (e) {
      musicGain = null; // already sourced / unsupported → volume-ducking fallback
    }
  }

  // Resume the context AND wire the music into it (must run from a play, ideally after a gesture).
  function resumeAudio() {
    if (actx && actx.state === 'suspended') actx.resume();
    ensureMusicGraph();
  }

  function tone(freq, dur, vol) {
    if (!actx) return;
    if (actx.state === 'suspended') actx.resume();
    var osc = actx.createOscillator();
    var gain = actx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    var t0 = actx.currentTime;
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.linearRampToValueAtTime(vol, t0 + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(gain);
    gain.connect(actx.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  function toneTier(rating, gold) {
    if (gold && rating !== 'miss') {
      tone(880, 0.07, 0.5);
      setTimeout(function () { tone(1175, 0.07, 0.5); }, 70);
      setTimeout(function () { tone(1568, 0.13, 0.5); }, 140);
      return;
    }
    if (rating === 'perfect') tone(1320, 0.11, 0.45);
    else if (rating === 'good') tone(990, 0.11, 0.4);
    else if (rating === 'ok') tone(660, 0.11, 0.35);
    else tone(196, 0.16, 0.4);
  }

  // NOTE: no system TTS (speechSynthesis) on the TV. On Cast devices the speech engine takes audio
  // focus and ducks/cuts the music element — which removed the background track on every callout. The
  // WebAudio tones are the audio feedback; they mix with the music without stealing focus.

  // Smooth, gentle music ducking via short volume ramps (no hard jump → no click/pop). Always restores
  // to full, and the latest duck wins, so rapid feedback can never leave the music stuck quiet. The
  // mechanics live in audio-mix.js (FlooredAudioMix) so they're unit-tested (receiver/test/); the
  // ducker also owns the post-play settle window (SETTLE_NO_DUCK) during which ducks are ignored.
  var ducker = window.FlooredAudioMix.createDucker({
    now: now,
    gain: function () { return musicGain ? musicGain.gain : null; },   // graph builds lazily on play
    gainTime: function () { return actx ? actx.currentTime : 0; },
    getVolume: function () { return audio ? audio.volume : 1; },
    setVolume: function (v) { if (audio) audio.volume = v; }
  }, { settleNoDuck: SETTLE_NO_DUCK });

  function duck(level, holdSeconds) { ducker.duck(level, holdSeconds); }

  // Video-mode audio↔video sync corrections go through this guard (audio-mix.js): never re-seek while
  // a seek is in flight, and rate-limit corrections. The old per-frame `drift > 0.3 → re-seek` became
  // a ~60fps seek storm once one seek was in flight (audio.currentTime lags the assignment, so the
  // drift test stayed true) — the mp3 stayed muted for the rest of the round while the WebAudio
  // feedback tones kept playing ("music disappears after the start, the effects keep sounding").
  var syncGuard = window.FlooredAudioMix.createSyncGuard({
    threshold: 0.3, settleSeconds: SETTLE_NO_SYNC, cooldownSeconds: 1.2
  });

  // Start playback with the music quiet, then ramp it up — establishes the track smoothly instead of
  // popping in over a still-settling clip. Stamps playStartedAt for the settle windows (the ducker
  // keeps its own stamp via fadeIn). Also refreshes the build stamp with audio diagnostics readable
  // on the TV itself: 'no-graph' = createMediaElementSource failed (CORS / unsupported) → the tones
  // play OUTSIDE the music stream, and on Cast hardware they then steal output focus and CUT the
  // music on every effect; 'actx-…' = the AudioContext never reached 'running'.
  function startMusicFadeIn() {
    playStartedAt = now();
    ducker.fadeIn();
    if (buildEl) {
      buildEl.textContent = 'build ' + BUILD +
        (musicGain ? '' : ' · no-graph') +
        (actx && actx.state !== 'running' ? ' · actx-' + actx.state : '');
    }
  }

  // ---- Feedback visuals ----
  function tierColor(rating, gold) {
    var t = TOK.tiers;
    if (gold && rating !== 'miss') return t.gold;
    if (rating === 'perfect') return t.perfect;
    if (rating === 'good') return t.good;
    if (rating === 'ok') return t.ok;
    return t.miss;
  }

  function pulseGlow(rating, gold) {
    var color = tierColor(rating, gold);
    var peak = gold && rating !== 'miss' ? 0.95 : rating === 'miss' ? 0.6 : 0.7;
    glowEl.style.transition = 'none';
    glowEl.style.boxShadow = 'inset 0 0 140px 44px ' + color;
    glowEl.style.opacity = String(peak);
    void glowEl.offsetWidth;
    glowEl.style.transition = 'opacity ' + (gold ? 0.75 : 0.4) + 's ease-out';
    glowEl.style.opacity = '0';
  }

  function showWord(rating, gold, points) {
    var text = gold && rating !== 'miss' ? 'STAR!'
      : rating === 'perfect' ? 'PERFECT'
      : rating === 'good' ? 'GOOD'
      : rating === 'ok' ? 'OK' : 'MISS';
    if (points) text += '  +' + points;
    wordEl.textContent = text;
    wordEl.style.color = tierColor(rating, gold);
    wordEl.style.transition = 'none';
    wordEl.style.opacity = '1';
    wordEl.style.transform = 'scale(1.2)';
    void wordEl.offsetWidth;
    wordEl.style.transition = 'opacity 0.7s ease-out, transform 0.7s ease-out';
    wordEl.style.opacity = '0';
    wordEl.style.transform = 'scale(1.0) translateY(-50px)';
  }

  // ---- Beacons: one pill per player = lane dot (identity color) + score + combo/cue + presence.
  // Nodes are created ONCE per lane and mutated in place (Chromecast: transform/opacity animations
  // only; the sole text churn is the score roll, ≤5 steps per 0.4s wire update).
  var LANE_COLORS = TOK.lanes;   // === Theme.laneColors / DesignTokens.lanes (one source: design-tokens.json)
  var beaconsEl = document.getElementById('beacons');
  var beacons = {};        // lane → {el, dot, ring, score, slot, step, plus, shown, target, tick, ringOn}
  var framingLanes = [0];  // lanes seen on the framing screen → entrance roll-call at Get Ready

  function laneColor(lane) { return LANE_COLORS[lane % LANE_COLORS.length]; }
  function hexRGBA(h, a) {   // '#rrggbb' + alpha → 'rgba(r,g,b,a)'
    return 'rgba(' + parseInt(h.slice(1, 3), 16) + ',' + parseInt(h.slice(3, 5), 16) + ','
      + parseInt(h.slice(5, 7), 16) + ',' + a + ')';
  }
  function laneRGBA(lane, a) { return hexRGBA(laneColor(lane), a); }

  function ensureBeacon(lane, enterDelayMs) {
    var B = beacons[lane];
    if (B) return B;
    var el = document.createElement('div');
    el.className = 'beacon';
    el.style.setProperty('--lc', laneColor(lane));
    el.style.setProperty('--lcdim', laneRGBA(lane, 0.5));
    el.style.setProperty('--lcglow', laneRGBA(lane, 0.3));
    el.innerHTML = '<i class="bwash"></i>'
      + '<div class="bdot"><i class="bring"></i><span>' + (lane + 1) + '</span></div>'
      + '<div class="bscore">0</div>'
      + '<div class="bslot"></div>'
      + '<div class="bstep">← STEP IN</div>'
      + '<div class="bplus"></div>';
    if (typeof enterDelayMs === 'number') {
      el.classList.add('enter');
      el.style.animationDelay = (enterDelayMs / 1000) + 's';
    }
    // Keep DOM order = lane order (left→right matches the mirrored floor).
    var nextLane = null;
    for (var k in beacons) {
      if (beacons.hasOwnProperty(k) && +k > lane && (nextLane === null || +k < nextLane)) nextLane = +k;
    }
    beaconsEl.insertBefore(el, nextLane === null ? null : beacons[nextLane].el);
    B = beacons[lane] = {
      el: el,
      dot: el.querySelector('.bdot'),
      ring: el.querySelector('.bring'),
      score: el.querySelector('.bscore'),
      slot: el.querySelector('.bslot'),
      step: el.querySelector('.bstep'),
      plus: el.querySelector('.bplus'),
      shown: 0, target: 0, tick: null, ringOn: false
    };
    if (Object.keys(beacons).length >= 3) beaconsEl.classList.add('many');
    return B;
  }
  function showBeacons() { if (beaconsEl) beaconsEl.classList.add('show'); }
  function hideBeacons() { if (beaconsEl) beaconsEl.classList.remove('show'); }
  function clearBeacons() {
    for (var k in beacons) { if (beacons.hasOwnProperty(k) && beacons[k].tick) clearInterval(beacons[k].tick); }
    beacons = {};
    if (beaconsEl) { beaconsEl.innerHTML = ''; beaconsEl.classList.remove('many', 'show'); }
  }

  function fmtScore(v) {
    if (beaconsEl && beaconsEl.classList.contains('many') && v >= 10000) return (v / 1000).toFixed(1) + 'k';
    return String(Math.round(v));
  }

  // Roll the displayed score toward the target in a few quick steps (felt progress, cheap paint).
  function setBeaconScore(B, value) {
    B.target = Math.round(value || 0);
    if (B.tick) return;   // the in-flight roll picks up the new target
    if (B.shown === B.target) { B.score.textContent = fmtScore(B.shown); return; }
    B.tick = setInterval(function () {
      var diff = B.target - B.shown;
      if (!diff) { clearInterval(B.tick); B.tick = null; return; }
      var step = Math.max(1, Math.ceil(Math.abs(diff) * 0.45));
      B.shown += (diff > 0 ? step : -step);
      if ((diff > 0 && B.shown > B.target) || (diff < 0 && B.shown < B.target)) B.shown = B.target;
      B.score.textContent = fmtScore(B.shown);
    }, 76);
  }

  var FIX_GLYPH = { left: '←', right: '→', back: '!', closer: '!', body: '!' };
  function renderBeacons(scores) {
    if (!beaconsEl || !scores || !scores.length) return;
    showBeacons();
    for (var i = 0; i < scores.length; i++) {
      var s = scores[i];
      var B = ensureBeacon(s.lane || 0);
      setBeaconScore(B, s.total);
      var seen = s.seen || 'ok';
      B.el.classList.toggle('lost', seen === 'lost');
      B.el.classList.toggle('fix', seen === 'fix');
      if (seen === 'lost') {
        B.step.textContent = (s.fix === 'right') ? 'STEP IN →' : '← STEP IN';
      } else if (seen === 'fix' && s.fix) {
        B.slot.className = 'bslot cue';
        B.slot.textContent = FIX_GLYPH[s.fix] || '!';
      } else {
        B.slot.className = 'bslot';
        B.slot.textContent = (s.combo > 1) ? ('x' + s.combo) : '';
      }
    }
  }

  // Judged moment on the player's own pill: tier wash + bump + a "+N" float (numbers only — the
  // audio owns the words; the filmstrip tile flashes separately as the choreography cue).
  function flashBeacon(lane, rating, gold, points) {
    var B = beacons[lane]; if (!B) return;
    var col = tierColor(rating, gold);
    B.el.style.setProperty('--fc', col);
    B.el.classList.remove('flash', 'gold', 'bump'); void B.el.offsetWidth;
    B.el.classList.add('flash', 'bump');
    if (gold && rating !== 'miss') B.el.classList.add('gold');
    if (points && rating !== 'miss') {
      B.plus.textContent = '+' + points;
      B.plus.style.color = col;
      B.plus.classList.remove('go'); void B.plus.offsetWidth; B.plus.classList.add('go');
    }
  }

  // ---- Neon-tube skeleton (shared coach aesthetic) ----
  // Mirrors SkeletonKit's `default.neon` (Sources/SkeletonKit/Style.swift) so the TV draws the SAME
  // figure as the app: a near-white core stroke wrapped in two ADDITIVE halo passes (wide + mid) in
  // the cyan glow color, magenta articulation nodes with white centers, a head RING (not a balloon),
  // and an optional violet ground pool. `P` = joints already mapped to canvas px; `span` = the drawn
  // figure height (px) → drives stroke scale. No canvas shadowBlur (too slow on the Cast SoC) — the
  // glow IS the layered additive strokes, which is also how the app does it.
  var NEON_NODES = ['leftElbow', 'rightElbow', 'leftWrist', 'rightWrist',
                    'leftKnee', 'rightKnee', 'leftAnkle', 'rightAnkle'];
  function neonSkeleton(c, P, span, opt) {
    opt = opt || {};
    var glow = opt.glow || TOK.skeleton.glow;     // cyan halo
    var core = opt.core || TOK.skeleton.core;     // near-white tube core
    var jcol = opt.joint || TOK.skeleton.joint;   // magenta nodes
    var k = opt.k || 1;
    // Limb line width from the shared token (design-tokens.json — same knob as the app). Joint + head
    // sizes are DECOUPLED from it (fixed ratios of figure height) so widening the line never grows the
    // joint circles.
    var coreW = Math.max(1.2, span * ((TOK.skeleton && TOK.skeleton.strokeWidthRatio) || 0.016)) * k;
    var midW = coreW * 3, wideW = coreW * 6;
    var jointR = Math.max(1.5, span * 0.018) * k;   // articulation node radius (was coreW * 1.5)
    var headR = Math.max(3, span * 0.031) * k;      // head ring radius (was coreW * 2.6)

    // Violet floor pool — anchors the figure to a stage (additive ellipse under the lowest joint).
    if (opt.ground) {
      var lowest = -1e9;
      for (var nm in P) { if (P.hasOwnProperty(nm) && P[nm] && P[nm][1] > lowest) lowest = P[nm][1]; }
      var la = P.leftAnkle, ra = P.rightAnkle, root = P.root;
      var gx = root ? root[0] : (la && ra ? (la[0] + ra[0]) / 2 : null);
      if (gx != null && lowest > -1e9) {
        var rw = span * 0.42, rh = Math.max(4, span * 0.07);
        c.save();
        c.globalCompositeOperation = 'lighter';
        c.translate(gx, lowest); c.scale(1, rh / rw);
        var grd = c.createRadialGradient(0, 0, 0, 0, 0, rw);
        grd.addColorStop(0, hexRGBA(TOK.skeleton.ground, 0.32)); grd.addColorStop(1, hexRGBA(TOK.skeleton.ground, 0));
        c.fillStyle = grd;
        c.beginPath(); c.arc(0, 0, rw, 0, 2 * Math.PI); c.fill();
        c.restore();
      }
    }

    function pass(width, color, alpha, op) {
      c.save();
      c.globalCompositeOperation = op; c.globalAlpha = alpha;
      c.lineCap = 'round'; c.lineJoin = 'round'; c.lineWidth = width; c.strokeStyle = color;
      for (var i = 0; i < bones.length; i++) {
        var a = P[bones[i][0]], b = P[bones[i][1]];
        if (!a || !b) continue;
        c.beginPath(); c.moveTo(a[0], a[1]); c.lineTo(b[0], b[1]); c.stroke();
      }
      c.restore();
    }
    pass(wideW, glow, 0.12, 'lighter');    // wide outer halo
    pass(midW, glow, 0.30, 'lighter');     // mid halo
    pass(coreW, core, 1.0, 'source-over'); // bright near-white tube

    // Glowing articulation nodes: additive magenta dot + a white center so they read as lit.
    for (var j = 0; j < NEON_NODES.length; j++) {
      var p = P[NEON_NODES[j]]; if (!p) continue;
      c.save();
      c.globalCompositeOperation = 'lighter'; c.globalAlpha = 0.9; c.fillStyle = jcol;
      c.beginPath(); c.arc(p[0], p[1], jointR, 0, 2 * Math.PI); c.fill();
      c.restore();
      c.fillStyle = '#ffffff';
      c.beginPath(); c.arc(p[0], p[1], jointR * 0.4, 0, 2 * Math.PI); c.fill();
    }

    // Head as a RING (faint inner fill + additive glow ring + core ring).
    var head = P.nose || P.neck;
    if (head) {
      var hr = headR;
      c.save(); c.globalAlpha = 0.12; c.fillStyle = core;
      c.beginPath(); c.arc(head[0], head[1], hr, 0, 2 * Math.PI); c.fill(); c.restore();
      c.save(); c.globalCompositeOperation = 'lighter'; c.globalAlpha = 0.5;
      c.strokeStyle = glow; c.lineWidth = midW * 0.5;
      c.beginPath(); c.arc(head[0], head[1], hr, 0, 2 * Math.PI); c.stroke(); c.restore();
      c.strokeStyle = core; c.lineWidth = coreW;
      c.beginPath(); c.arc(head[0], head[1], hr, 0, 2 * Math.PI); c.stroke();
    }
  }

  // ---- Move filmstrip (Just-Dance "now / next" pictograms) ----
  // Draw one key-pose centered + fit to the tile (bbox-fit like drawFigure, in unit-square space so a tall
  // standing pose fills a portrait tile). Mirror-matched to the on-screen video. Star moves glow gold.
  function drawMoveTile(c, joints, W, H, mir, isNow, gold) {
    c.clearRect(0, 0, W, H);
    var minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9, any = false;
    for (var n in joints) {
      if (!joints.hasOwnProperty(n)) continue;
      var p = joints[n]; if (!p) continue;
      if (p[0] < minX) minX = p[0]; if (p[0] > maxX) maxX = p[0];
      if (p[1] < minY) minY = p[1]; if (p[1] > maxY) maxY = p[1];
      any = true;
    }
    if (!any) return;
    var pbw = Math.max(0.001, maxX - minX), pbh = Math.max(0.001, maxY - minY);
    var s = Math.min(W * 0.8 / pbw, H * 0.8 / pbh);
    var ccx = (minX + maxX) / 2, ccy = (minY + maxY) / 2;
    function map(p) { var x = W / 2 + (p[0] - ccx) * s; if (mir) x = W - x; return [x, H / 2 + (p[1] - ccy) * s]; }
    var P = {};
    for (var nm in joints) { if (joints.hasOwnProperty(nm) && joints[nm]) P[nm] = map(joints[nm]); }
    neonSkeleton(c, P, pbh * s, {
      k: isNow ? 0.78 : 0.66,
      glow: gold ? TOK.gold : TOK.skeleton.glow,
      core: gold ? '#fff7cc' : TOK.skeleton.core,   // '#fff7cc' = a gold-tint core highlight (derived, not a token)
      joint: gold ? TOK.gold : TOK.skeleton.joint
    });
  }

  function renderFilmstrip() {
    if (!tiles.length) return;
    for (var i = 0; i < tiles.length; i++) {
      var T = tiles[i];
      var mv = moves[nowIndex + i];
      T.el.className = 'tile' + (i === 0 ? ' now' : ' dim' + (i + 1));
      if (!mv) { T.el.style.visibility = 'hidden'; continue; }
      T.el.style.visibility = '';
      if (mv.gold) { T.el.classList.add('gold'); T.badge.style.display = ''; } else { T.badge.style.display = 'none'; }
      T.kicker.textContent = i === 0 ? 'NOW' : (i === 1 ? 'NEXT' : '');
      var w = T.el.clientWidth, h = T.el.clientHeight;
      if (w && h && (T.canvas.width !== w || T.canvas.height !== h)) { T.canvas.width = w; T.canvas.height = h; }
      if (T.canvas.width) drawMoveTile(T.ctx, mv.j, T.canvas.width, T.canvas.height, mirrored, i === 0, mv.gold);
    }
  }

  function onMoves(d) {
    if (d.moves && d.moves.length) { for (var i = 0; i < d.moves.length; i++) moves.push(d.moves[i]); }
    recvMoveChunks += 1;
    if (moveChunks > 0 && recvMoveChunks >= moveChunks) {
      moves.sort(function (a, b) { return a.t - b.t; });
      movesReady = moves.length > 0;
      nowIndex = 0; lastDrawnNow = -1;
      if (filmstripEl) filmstripEl.style.display = movesReady ? '' : 'none';
      renderFilmstrip();
    }
  }

  // Tasteful rating flash in the rail (replaces the full-screen glow + word): pulse the move tile that was
  // just judged + float a +NN; miss = a small shake. The exact tile comes from the checkpoint idx.
  function flashTile(idx, rating, gold, points) {
    if (!tiles.length) return;
    var offset = (typeof idx === 'number' && idx >= 0) ? (idx - nowIndex) : 0;
    if (offset < 0 || offset > 3) offset = 0;   // retired / unknown → flash NOW
    var T = tiles[offset];
    var col = tierColor(rating, gold);
    T.el.style.setProperty('--fc', col);
    T.el.classList.remove('flash', 'shake'); void T.el.offsetWidth;
    if (rating === 'miss') { T.el.classList.add('shake'); }
    else { T.el.classList.add('flash'); setTimeout(function () { T.el.classList.remove('flash'); }, 460); }
    if (points && rating !== 'miss' && T.plus) {
      T.plus.textContent = '+' + points; T.plus.style.color = col;
      T.plus.classList.remove('go'); void T.plus.offsetWidth; T.plus.classList.add('go');
    }
  }

  // ---- Dev-only debug overlay: the reference pose drawn ON the clip (alignment/mirror/sync + bone match) ----
  function setDebug(on) {
    document.body.classList.toggle('debug', !!on);
    if (!on && dbgCtx && dbgCanvas) dbgCtx.clearRect(0, 0, dbgCanvas.width, dbgCanvas.height);
  }
  function onDbgPose(d) { dbgLive = d; }
  function matchColor(m) { if (m == null || m < 0) return '#39ff14'; if (m >= 0.7) return '#34c759'; if (m >= 0.4) return '#ffd400'; return '#ff453a'; }
  function drawDebug() {
    if (!dbgCtx || !dbgCanvas || !dbgLive || !dbgLive.j) return;
    var W = dbgCanvas.width, H = dbgCanvas.height;
    dbgCtx.clearRect(0, 0, W, H);
    // The reference pose is normalized to the recording frame; map it to the video's letterboxed content
    // rect (object-fit:contain) so it lands on the dancer. Embed/figure → whole stage box (approximate).
    var rx = 0, ry = 0, rw = W, rh = H;
    if (videoMode && videoEl && videoEl.videoWidth && videoEl.videoHeight) {
      var sc = Math.min(W / videoEl.videoWidth, H / videoEl.videoHeight);
      rw = videoEl.videoWidth * sc; rh = videoEl.videoHeight * sc; rx = (W - rw) / 2; ry = (H - rh) / 2;
    }
    var j = dbgLive.j, bm = dbgLive.bones || [];
    function map(p) { var nx = mirrored ? (1 - p[0]) : p[0]; return [rx + nx * rw, ry + p[1] * rh]; }
    var lw = Math.max(2, rh * 0.014);
    // POSITIVE-ONLY: only the limbs you're nailing light up green; off limbs simply don't draw (no red
    // nagging, far less clutter — legible at a distance).
    var GREEN = 0.6;
    dbgCtx.lineCap = 'round'; dbgCtx.lineWidth = lw;
    dbgCtx.strokeStyle = '#3ee06b';
    dbgCtx.shadowColor = 'rgba(62,224,107,0.85)'; dbgCtx.shadowBlur = lw * 1.6;
    for (var i = 0; i < bones.length; i++) {
      if (bm[i] == null || bm[i] < GREEN) continue;
      var a = j[bones[i][0]], b = j[bones[i][1]]; if (!a || !b) continue;
      var ma = map(a), mb = map(b);
      dbgCtx.beginPath(); dbgCtx.moveTo(ma[0], ma[1]); dbgCtx.lineTo(mb[0], mb[1]); dbgCtx.stroke();
    }
    dbgCtx.shadowBlur = 0;
    // A faint head dot anchors the lit limbs to a body without nagging.
    var head = j.nose || j.neck;
    if (head) { var mh = map(head); dbgCtx.fillStyle = 'rgba(255,255,255,0.22)'; dbgCtx.beginPath(); dbgCtx.arc(mh[0], mh[1], lw * 1.2, 0, 2 * Math.PI); dbgCtx.fill(); }
  }

  // ---- Final-score reveal (end of a cast round): big, exact total in sync with the phone ----
  function showFinal(players) {
    if (!finalEl) finalEl = document.getElementById('final');
    if (!finalEl) return;
    var wrap = finalEl.querySelector('.final-scores');
    players = players || [];
    var count = Math.max(1, players.length);
    // Winner (top total) gets a gold-warmed glow — only when there's more than one player.
    var winLane = -1, winTotal = -1;
    for (var w = 0; w < players.length; w++) {
      if ((players[w].total || 0) > winTotal) { winTotal = players[w].total || 0; winLane = players[w].lane || 0; }
    }
    var html = '';
    for (var i = 0; i < players.length; i++) {
      var p = players[i];
      var lane = p.lane || 0;
      var stars = '', n = p.stars || 0;
      for (var s = 0; s < 5; s++) stars += (s < n) ? '★' : '☆';
      var isWin = players.length > 1 && lane === winLane;
      // One lane-framed glass card per player (identity dot + Pn, white hero score, gold stars).
      html += '<div class="final-player' + (isWin ? ' win' : '') + '"'
        + ' style="--lc:' + laneColor(lane) + ';--lcglow:' + laneRGBA(lane, 0.45) + '">'
        + '<div class="final-lane"><i class="dot"></i>P' + (lane + 1) + '</div>'
        + '<div class="final-num">' + Math.round(p.total || 0) + '</div>'
        + '<div class="final-stars">' + stars + '</div></div>';
    }
    if (wrap) {
      // Pop the cards in via a CSS animation whose RESTING state is visible (opacity 1). The old inline
      // opacity 0→1 transition could stick at 0 on a slow Cast device → scores invisible (only the FINAL
      // title showed). Clear any legacy inline styles, then re-trigger the animation class with a reflow.
      wrap.style.opacity = ''; wrap.style.transform = ''; wrap.style.transition = '';
      wrap.innerHTML = html;
      wrap.className = 'final-scores n' + Math.min(4, count) + (players.length > 1 ? ' multi' : '');
      finalEl.style.display = 'flex';
      void wrap.offsetWidth;
      wrap.classList.add('pop');
    } else {
      finalEl.style.display = 'flex';
    }
    // celebratory rising arpeggio
    tone(784, 0.12, 0.5);
    setTimeout(function () { tone(988, 0.12, 0.5); }, 120);
    setTimeout(function () { tone(1319, 0.22, 0.5); }, 240);
  }

  function hideFinal() { if (finalEl) finalEl.style.display = 'none'; }

  function onFinal(d) {
    clearPendingFeedback();
    clearGuards(); hideStage(); hideGetReady(); hideBeacons();
    // HIDE the clip (not just pause it). On Cast a hardware <video> surface composites ABOVE the HTML
    // layers regardless of z-index, so a paused clip COVERS the #final reveal — the score only ever showed
    // in figure mode (a <canvas>, which the reveal can cover). display:none drops the surface so the reveal
    // is visible. (The embed branch below already hides its iframe for the same reason.) onLoadVideo
    // re-shows the element next round.
    try { if (videoEl) { videoEl.pause(); videoEl.style.display = 'none'; } } catch (e) { /* ignore */ }
    try { if (audio) audio.pause(); } catch (e) { /* ignore */ }
    if (embedMode) { if (embedApi) { try { embedApi.pause(); } catch (e) {} } if (embedEl) embedEl.style.display = 'none'; }
    document.body.classList.remove('playing');
    setStatus('');
    showFinal(d.players);
  }

  // ---- Pro cast UX: "Get Ready" countdown, "Set up your stage" framing, in-round guard ----

  function hideGetReady() { if (getreadyEl) getreadyEl.style.display = 'none'; }
  function onGetReady(d) {
    hideStage(); hideFinal();
    // Beacon roll-call: the framing screen's lanes pop in left→right (100ms stagger), each in its
    // lane color — position + color binding lands right before GO. Idempotent across the 5 counts.
    // Skipped in record mode: a take has no score/identity boxes (the action is on the phone, behind
    // the card), so the count plays clean over the record card instead of empty placeholders.
    if (!recordMode) {
      for (var i = 0; i < framingLanes.length; i++) ensureBeacon(framingLanes[i], i * 100);
      showBeacons();
    }
    if (!getreadyEl) return;
    var num = getreadyEl.querySelector('.gr-num');
    if (num) {
      num.textContent = String(d.n);
      num.style.transition = 'none'; num.style.transform = 'scale(1.35)';
      void num.offsetWidth;
      num.style.transition = 'transform 0.55s ease-out';
      num.style.transform = 'scale(1)';
    }
    getreadyEl.style.display = 'flex';
    tone(d.n <= 1 ? 1320 : 660, 0.09, 0.4);   // brighter tone on the last beat
  }
  function onGo() {
    if (recordMode) { showRecordCard(); if (recordEl) recordEl.classList.remove('counting'); }   // fade in REC + direction for the take
    var num = getreadyEl ? getreadyEl.querySelector('.gr-num') : null;
    if (num) num.textContent = 'GO!';
    tone(784, 0.1, 0.5);
    setTimeout(function () { tone(988, 0.1, 0.5); }, 90);
    setTimeout(function () { tone(1319, 0.18, 0.5); }, 180);
    setTimeout(hideGetReady, 650);
  }

  // Record mode: a take is being captured on the PHONE (the recording is never cast as video). The phone
  // brackets it with record:start (just before the count) / record:stop (when the take ends). Rather than
  // empty score/coach boxes, show a calm "watch the phone" card — the countdown still plays on top of it.
  function showRecordCard() { if (recordEl) recordEl.style.display = 'flex'; }
  function hideRecordCard() { if (recordEl) { recordEl.style.display = 'none'; recordEl.classList.remove('counting'); } }
  function onRecord(d) {
    if (d.state === 'stop') {
      recordMode = false;
      hideRecordCard(); hideGetReady();
      showLobby();                 // take done → back to the idle install QR
      setStatus('ready');
      return;
    }
    recordMode = true;             // 'start' (default): drop any stale boxes and raise the full-bleed card NOW so
    clearPendingFeedback(); clearGuards();   // its bg covers the empty coach/rail layers (the role the lobby plays at idle).
    hideStage(); hideFinal(); hideBeacons(); clearBeacons();
    if (recordEl) recordEl.classList.add('counting');   // count shows just the number on the card's dark bg; text fades in at GO
    showRecordCard();
    setStatus('recording on phone');
  }

  // Cast paywall lock: the phone is out of free cast sessions. Rather than a dark TV / stale frame, show a
  // calm "Casting is Plus" boundary + the install QR (a passive upsell to the room). `on` raises it on a
  // blocked cast; `off` (decline) clears it back to the idle lobby. A real round's load also clears it.
  function hideCastLock() { if (castlockEl) castlockEl.style.display = 'none'; }
  function onCastLock(d) {
    if (d.on) {
      clearPendingFeedback(); clearGuards();
      hideStage(); hideFinal(); hideBeacons(); clearBeacons(); hideGetReady(); hideRecordCard();
      if (castlockEl) castlockEl.style.display = 'flex';
      setStatus('casting is Plus');
    } else {
      hideCastLock();
      showLobby();   // declined / cleared → back to the idle install QR
    }
  }

  // ---- BYO music: the phone streams the user's OWN audio file to us over the data channel (never via a
  // server). We reassemble the base64 chunks into a Blob and play it from an object URL. Same-origin to this
  // HTTPS page, so no mixed-content problem (unlike an http:// local server). PHASE 0: a debug-triggered
  // proof — receive → Blob → play standalone. Wiring into the cast round (loadVideo + audioBlobId) is later.
  var byoBuf = null, byoMime = '', byoChunks = 0, byoChunkBytes = 0, byoReceived = 0, byoID = '';
  var byoAudioURL = null, lastAudioBlobID = '';
  function onAudioInit(d) {
    if (d.id && d.id === lastAudioBlobID && byoAudioURL) {   // dedup: we already hold this exact clip
      broadcast({ t: 'audioAck', id: d.id, have: 'all' });
      return;
    }
    byoID = d.id || ''; byoMime = d.mime || 'audio/mpeg';
    byoChunks = d.chunks || 0; byoChunkBytes = d.chunkBytes || 0;
    byoBuf = new Uint8Array(d.total || 0); byoReceived = 0;
    setStatus('receiving audio… 0/' + byoChunks);
  }
  function onAudioChunk(d) {
    if (d.id !== byoID || !byoBuf) return;
    var bin = atob(d.d || ''), off = d.i * byoChunkBytes;
    for (var k = 0; k < bin.length; k++) byoBuf[off + k] = bin.charCodeAt(k);
    byoReceived++;
    if ((byoReceived % 16) === 0) { setStatus('receiving audio… ' + byoReceived + '/' + byoChunks); }
    if (byoReceived >= byoChunks) finalizeByoAudio();   // don't wait on audioEnd
  }
  function onAudioEnd(d) { if (d.id === byoID) finalizeByoAudio(); }   // backstop if the last chunk was missed
  function finalizeByoAudio() {
    if (!byoBuf) return;   // idempotent (chunk-complete and audioEnd can both call)
    if (byoAudioURL) { try { URL.revokeObjectURL(byoAudioURL); } catch (e) { /* ignore */ } }
    var blob = new Blob([byoBuf], { type: byoMime });
    byoAudioURL = URL.createObjectURL(blob);
    lastAudioBlobID = byoID; byoBuf = null;
    broadcast({ t: 'audioAck', id: lastAudioBlobID, have: 'all' });
    // PHASE 0 proof: play the rebuilt clip standalone so it's audible/verifiable on the TV right now.
    hideLobby();
    audio.src = byoAudioURL; audio.load();
    audio.play().catch(function () { /* autoplay gate in the browser preview; fine on a real Cast device */ });
    setStatus('BYO audio ready — ' + blob.size + ' bytes, playing');
  }

  // Draw one live skeleton mapped DIRECTLY from [0,1] frame coords into the box, so the dancer's real
  // position (and any edge clipping) is visible — unlike drawFigure, which fills the screen. Rendered as
  // a neon tube whose HALO is the lane color (the framing "identity beat": a well-framed dancer glows in
  // their lane color, off-frame ones glow neutral grey).
  function drawSkeletonRaw(c, joints, W, H, mir, color) {
    function map(p) { var nx = mir ? (1 - p[0]) : p[0]; return [nx * W, p[1] * H]; }
    var P = {}, minY = 1e9, maxY = -1e9;
    for (var n in joints) {
      if (!joints.hasOwnProperty(n) || !joints[n]) continue;
      P[n] = map(joints[n]);
      if (P[n][1] < minY) minY = P[n][1];
      if (P[n][1] > maxY) maxY = P[n][1];
    }
    var span = Math.max(40, maxY - minY);
    neonSkeleton(c, P, span, { glow: color, joint: color, core: TOK.skeleton.core, k: 0.95 });
  }

  function hideStage() { if (stageEl) stageEl.style.display = 'none'; }
  function onFraming(d) {
    hideGetReady(); hideFinal(); clearGuards();   // the framing/paused screen owns the moment — drop stale nudges
    if (!stageEl) return;
    var title = stageEl.querySelector('.stage-title');
    var instr = stageEl.querySelector('.stage-instr');
    if (title) title.textContent = (d.state === 'paused') ? 'Paused' : 'Set up your stage';
    if (instr) instr.textContent = d.instr || '';
    var players = d.players || [];
    var allOk = players.length > 0 && players.every(function (p) { return p.ok; });
    if (stageBox) stageBox.classList.toggle('ok', allOk);
    // The identity beat: a well-framed dancer's skeleton lights up in THEIR lane color ("I'm the
    // pink one") right before the round; the same lanes get the beacon roll-call at Get Ready.
    if (players.length) {
      framingLanes = players.map(function (p) { return p.lane || 0; }).sort(function (a, b) { return a - b; });
    }
    if (stageCtx && stageCanvas) {
      var w = stageCanvas.clientWidth || 360, h = stageCanvas.clientHeight || 640;
      if (stageCanvas.width !== w || stageCanvas.height !== h) { stageCanvas.width = w; stageCanvas.height = h; }
      stageCtx.clearRect(0, 0, stageCanvas.width, stageCanvas.height);
      for (var i = 0; i < players.length; i++) {
        if (players[i].j) {
          drawSkeletonRaw(stageCtx, players[i].j, stageCanvas.width, stageCanvas.height, mirrored,
                          players[i].ok ? laneColor(players[i].lane || 0) : '#f2f2f7');
        }
      }
    }
    stageEl.style.display = 'flex';
  }

  // In-round "come back!" — no more top-left chips (outside the dancer's sightline): the guard's
  // rejoin ring fills around the player's own beacon dot, where their eyes already go for the score.
  function clearGuards() {
    for (var k in beacons) {
      if (beacons.hasOwnProperty(k)) { beacons[k].ring.style.setProperty('--p', 0); beacons[k].ringOn = false; }
    }
  }
  function onGuard(d) {
    var B = beacons[d.lane || 0]; if (!B) return;
    if (d.state === 'ok' || d.state === 'rejoin') {
      B.ring.style.setProperty('--p', 0);
      B.ringOn = false;
      return;
    }
    if (!B.ringOn) { B.ringOn = true; tone(440, 0.12, 0.3); }   // soft, distinct from a "miss"
    B.ring.style.setProperty('--p', Math.round((d.ring || 0) * 100));
  }

  // ---- Coach rendering (synced to the song) ----
  function poseAt(t) {
    var fr = poseFrames;
    if (!fr.length) return null;
    var hi = fr.length - 1;
    if (t <= fr[0].t) return fr[0];
    if (t >= fr[hi].t) return fr[hi];
    var lo = 0;
    while (lo + 1 < hi) {
      var mid = (lo + hi) >> 1;
      if (fr[mid].t < t) lo = mid; else hi = mid;
    }
    return (t - fr[lo].t) <= (fr[hi].t - t) ? fr[lo] : fr[hi];
  }

  function drawFigure(joints) {
    var W = canvas.width, H = canvas.height;
    var minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9, any = false;
    for (var name in joints) {
      if (!joints.hasOwnProperty(name)) continue;
      var p = joints[name];
      if (!p) continue;
      var px = p[0] * W, py = p[1] * H;
      if (px < minX) minX = px;
      if (px > maxX) maxX = px;
      if (py < minY) minY = py;
      if (py > maxY) maxY = py;
      any = true;
    }
    if (!any) return;
    var pbw = Math.max(1, maxX - minX);
    var pbh = Math.max(1, maxY - minY);
    var scale = Math.min(W * 0.7 / pbw, H * 0.8 / pbh);
    var drawW = pbw * scale, drawH = pbh * scale;
    var ox = (W - drawW) / 2, oy = (H - drawH) / 2;

    function map(p) {
      var nx = (p[0] * W - minX) / pbw;
      var ny = (p[1] * H - minY) / pbh;
      var mx = mirrored ? (1 - nx) : nx;
      return [ox + mx * drawW, oy + ny * drawH];
    }

    var P = {};
    for (var nm in joints) { if (joints.hasOwnProperty(nm) && joints[nm]) P[nm] = map(joints[nm]); }
    neonSkeleton(ctx, P, drawH, { ground: true });
  }

  function frame() {
    requestAnimationFrame(frame);
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Draw the figure only in figure mode (embed + video modes show real footage instead).
    if (!embedMode && !videoMode && (mockMode || loaded) && poseFrames.length) {
      var dur = poseFrames[poseFrames.length - 1].t || 1;
      var t = mockMode ? ((now() - mockStart) % dur) : (audio.currentTime || 0);
      var f = poseAt(t);
      if (f) drawFigure(f.j);
    }

    // Advance the move filmstrip off the playhead (the TV is the master clock → no per-frame streaming).
    // Freezes automatically on pause (currentPlayhead() stops). Only redraw tiles when NOW changes.
    if (movesReady && moves.length) {
      var ph = currentPlayhead();
      while (nowIndex + 1 < moves.length && ph >= moves[nowIndex + 1].t) nowIndex++;
      if (nowIndex !== lastDrawnNow) { renderFilmstrip(); lastDrawnNow = nowIndex; }
      if (tiles.length && tiles[0].hairFill) {
        var t0 = moves[nowIndex].t;
        var t1 = (nowIndex + 1 < moves.length) ? moves[nowIndex + 1].t : (t0 + 1);
        var frac = (t1 > t0) ? (ph - t0) / (t1 - t0) : 0;
        tiles[0].hairFill.style.width = (Math.max(0, Math.min(1, frac)) * 100).toFixed(1) + '%';
      }
    }

    // Dev-only reference-pose overlay (no-op unless debug is on + a dbgpose has arrived).
    if (document.body.classList.contains('debug')) drawDebug();

    // Video mode: the silent clip is the master clock — keep the catalog mp3 locked to it. All the
    // "when may we re-seek" rules (settle window, never while a seek is in flight, cooldown between
    // audible corrections) live in syncGuard — see its creation above for the seek-storm history.
    if (videoMode && videoEl && audio) {
      var seekTo = syncGuard.check({
        enabled: !videoEl.paused && !audio.paused,
        sincePlay: now() - playStartedAt,
        audioTime: audio.currentTime || 0,
        videoTime: videoEl.currentTime || 0,
        seeking: !!audio.seeking,
        now: now()
      });
      if (seekTo != null) { try { audio.currentTime = seekTo; } catch (e) { /* not seekable yet */ } }
    }

    // Beacon the playhead so the phone can score (figure, embed, and video modes; never in mock).
    if (!mockMode && (embedMode || videoMode || loaded) && now() - lastBeacon > 0.05) {
      lastBeacon = now();
      var playing = embedMode ? embedPlaying : videoMode ? !videoEl.paused : !audio.paused;
      broadcast({ t: 'ph', rt: currentPlayhead(), ts: now(), st: playing ? 'playing' : 'paused', seq: seq++ });
    }
  }

  // ---- Messaging ----
  function broadcast(msg) {
    if (!context) return;
    for (var id in senders) {
      if (senders.hasOwnProperty(id)) {
        try { context.sendCustomMessage(NS, id, msg); } catch (e) { /* sender gone */ }
      }
    }
  }

  // Tear down video mode (when switching to a figure/embed round, or on stop): pause + drop the clip and
  // restore the figure canvas at the call site.
  function exitVideoMode() {
    if (videoEl) {
      try { videoEl.pause(); } catch (e) { /* ignore */ }
      videoEl.onended = null;
      videoEl.style.display = 'none';
      videoEl.removeAttribute('src');
      try { videoEl.load(); } catch (e) { /* ignore */ }
    }
    videoMode = false;
    videoPlaying = false;
  }

  // Reset the move filmstrip + beacons for a new routine, and switch the layout (mode + orientation).
  function resetMoves(d) {
    moves = []; moveChunks = d.moveChunks || 0; recvMoveChunks = 0; movesReady = false;
    nowIndex = 0; lastDrawnNow = -1;
    if (filmstripEl) filmstripEl.style.display = 'none';
    clearBeacons();
  }

  function onLoad(d) {
    clearPendingFeedback();
    recordMode = false; hideRecordCard(); hideCastLock();   // a real routine supersedes a record take / cast lock
    hideFinal(); clearGuards();
    exitVideoMode();
    if (embedEl) { embedEl.style.display = 'none'; embedEl.innerHTML = ''; }
    embedMode = false;
    canvas.style.display = '';
    poseFrames = [];
    receivedChunks = 0;
    expectedChunks = d.chunks || 0;
    mirrored = d.mirrored !== false;
    loaded = false;
    mockMode = false;
    resetMoves(d);
    setMode('figure');
    applyOrientation('portrait');   // the drawn coach is a tall standing figure → portrait stage + side rail
    if (d.audioUrl) { audio.src = d.audioUrl; audio.load(); }
    resumeAudio();
    setStatus('loading routine…');
  }

  // Local catalog routine on the TV: play the user's *silent* recorded clip (staged on R2) as the coach,
  // with the licensed catalog mp3 synced to it. Video is the master clock; play/pause/stop drive both.
  // Our own content → feedback overlays are allowed (presentFeedback only suppresses them for embeds).
  function onLoadVideo(d) {
    clearPendingFeedback();
    recordMode = false; hideRecordCard(); hideCastLock();   // a real routine supersedes a record take / cast lock
    hideFinal(); clearGuards();
    poseFrames = []; loaded = false; mockMode = false;
    embedMode = false; embedPlaying = false; embedApi = null; embedPlayer = null;
    if (embedEl) { embedEl.style.display = 'none'; embedEl.innerHTML = ''; }
    mirrored = d.mirrored !== false;
    if (!videoEl) videoEl = document.getElementById('castvideo');
    canvas.style.display = 'none';
    videoMode = true; videoPlaying = false;
    syncGuard.reset();   // new round → may correct again right after its own settle window
    var orientHint = orientFrom(d);
    resetMoves(d);
    setMode('video');
    applyOrientation(orientHint || 'portrait');
    videoEl.style.display = 'block';
    videoEl.style.transform = mirrored ? 'scaleX(-1)' : 'none';
    videoEl.muted = true;
    videoEl.addEventListener('loadedmetadata', function () {   // refine orientation from the real clip dims
      if (!orientHint && videoEl.videoWidth && videoEl.videoHeight) {
        var r = videoEl.videoWidth / videoEl.videoHeight;
        applyOrientation(r > 1.05 ? 'landscape' : (r < 0.95 ? 'portrait' : 'square'));
      }
      sizeStageCanvases();
    }, { once: true });
    videoEl.onended = function () {
      videoPlaying = false;
      document.body.classList.remove('playing');
      broadcast({ t: 'ph', rt: videoEl.duration || 0, ts: now(), st: 'ended', seq: seq++ });
    };
    if (d.audioUrl) { audio.src = d.audioUrl; audio.load(); } else { audio.removeAttribute('src'); }
    videoEl.src = d.videoUrl || '';
    videoEl.load();
    resumeAudio();
    setStatus('loading video…');
  }

  // Reference-don't-host on the TV: load the routine's platform video (real video + original sound).
  function onLoadEmbed(d) {
    clearPendingFeedback();
    recordMode = false; hideRecordCard(); hideCastLock();   // a real routine supersedes a record take / cast lock
    hideFinal(); clearGuards();
    exitVideoMode();
    loaded = false; mockMode = false;
    embedMode = true; embedPlaying = false; embedTime = 0; embedApi = null; embedPlayer = null;
    canvas.style.display = 'none';
    if (!embedEl) embedEl = document.getElementById('embed');
    embedEl.innerHTML = '';
    embedEl.style.display = 'block';
    mirrored = d.mirrored !== false;
    resetMoves(d);
    setMode('embed');
    applyOrientation(orientFrom(d) || 'portrait');   // embed can't be measured → trust the phone's hint
    resumeAudio();
    setStatus('loading video…');
    if (d.provider === 'youtube') buildYouTube(d.videoID);
    else if (d.provider === 'vimeo') buildVimeo(d.videoID);
    else if (d.provider === 'tiktok') buildTikTok(d.videoID);
    else setStatus('unknown video provider');
  }

  function buildYouTube(id) {
    var div = document.createElement('div');
    div.id = 'ytplayer';
    div.style.cssText = 'position:absolute;inset:0;width:100%;height:100%';
    embedEl.appendChild(div);
    window.onYouTubeIframeAPIReady = function () {
      embedPlayer = new YT.Player('ytplayer', {
        width: '100%', height: '100%', videoId: id,
        playerVars: { autoplay: 1, controls: 0, playsinline: 1, rel: 0, fs: 0, modestbranding: 1 },
        events: {
          onReady: function (e) { try { e.target.playVideo(); } catch (x) {} embedPlaying = true; setStatus(''); },
          onStateChange: function (e) { embedPlaying = (e.data === 1); if (e.data === 0) broadcast({ t: 'ended' }); }
        }
      });
    };
    if (window.YT && window.YT.Player) window.onYouTubeIframeAPIReady();
    else { var tag = document.createElement('script'); tag.src = 'https://www.youtube.com/iframe_api'; document.head.appendChild(tag); }
    embedApi = {
      time: function () { return (embedPlayer && embedPlayer.getCurrentTime) ? embedPlayer.getCurrentTime() : 0; },
      play: function () { if (embedPlayer && embedPlayer.playVideo) embedPlayer.playVideo(); },
      pause: function () { if (embedPlayer && embedPlayer.pauseVideo) embedPlayer.pauseVideo(); },
      seek0: function () { if (embedPlayer && embedPlayer.seekTo) embedPlayer.seekTo(0, true); }
    };
  }

  function buildVimeo(id) {
    var ifr = document.createElement('iframe');
    ifr.src = 'https://player.vimeo.com/video/' + id + '?autoplay=1&controls=0&playsinline=1&title=0&byline=0&portrait=0';
    ifr.allow = 'autoplay; fullscreen';
    ifr.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;border:0';
    embedEl.appendChild(ifr);
    embedApi = {
      time: function () { return embedTime; },
      play: function () { if (embedPlayer) embedPlayer.play().catch(function () {}); },
      pause: function () { if (embedPlayer) embedPlayer.pause(); },
      seek0: function () { if (embedPlayer) embedPlayer.setCurrentTime(0); }
    };
    function init() {
      embedPlayer = new Vimeo.Player(ifr);
      embedPlayer.on('timeupdate', function (dd) { embedTime = dd.seconds; embedPlaying = true; });
      embedPlayer.on('play', function () { embedPlaying = true; });
      embedPlayer.on('pause', function () { embedPlaying = false; });
      embedPlayer.on('ended', function () { broadcast({ t: 'ended' }); });
      embedPlayer.ready().then(function () { embedPlayer.play().catch(function () {}); setStatus(''); });
    }
    if (window.Vimeo && window.Vimeo.Player) init();
    else { var tag = document.createElement('script'); tag.src = 'https://player.vimeo.com/api/player.js'; tag.onload = init; document.head.appendChild(tag); }
  }

  function buildTikTok(id) {
    var ifr = document.createElement('iframe');
    ifr.id = 'ttplayer';
    ifr.src = 'https://www.tiktok.com/player/v1/' + id + '?autoplay=1&controls=0&music_info=0&description=0&rel=0';
    ifr.allow = 'autoplay';
    ifr.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;border:0';
    embedEl.appendChild(ifr);
    function post(m) { m['x-tiktok-player'] = true; if (ifr.contentWindow) ifr.contentWindow.postMessage(m, '*'); }
    window.addEventListener('message', function (ev) {
      var dd = ev.data; if (!dd || !dd['x-tiktok-player']) return;
      if (dd.type === 'onCurrentTime' && dd.value) { embedTime = dd.value.currentTime; embedPlaying = true; }
      if (dd.type === 'onStateChange') { embedPlaying = (dd.value === 1); if (dd.value === 0) broadcast({ t: 'ended' }); }
    });
    ifr.addEventListener('load', function () { post({ type: 'play' }); setStatus(''); });
    embedApi = {
      time: function () { return embedTime; },
      play: function () { post({ type: 'play' }); },
      pause: function () { post({ type: 'pause' }); },
      seek0: function () { post({ type: 'seekTo', value: 0 }); }
    };
  }

  function onPose(d) {
    if (d.frames && d.frames.length) {
      for (var i = 0; i < d.frames.length; i++) poseFrames.push(d.frames[i]);
    }
    receivedChunks += 1;
    if (expectedChunks > 0 && receivedChunks >= expectedChunks) {
      poseFrames.sort(function (a, b) { return a.t - b.t; });
      loaded = true;
      setStatus('ready');
      broadcast({ t: 'ready' });
    }
  }

  // Start a video-mode round robustly: WAIT until the clip can actually play. On a cold load the clip
  // isn't ready when the play command arrives — the old single play() attempt rejected and only the
  // music started (first "Dance" = no video; the warm second try worked). Gate on canplay, then play the
  // video and start the music synced to it. Falls back to audio-only so the round is never silent.
  function startVideoModePlayback() {
    if (!videoEl) return;
    audio.pause();
    var done = false;
    function begin() {
      if (done) return; done = true;
      videoEl.play().then(function () {
        try { audio.currentTime = videoEl.currentTime || 0; } catch (e) {}
        audio.play().catch(function () {});
        startMusicFadeIn();
      }).catch(function () {
        audio.play().catch(function () {}); // last resort: don't leave the round silent
        startMusicFadeIn();
      });
    }
    if (videoEl.readyState >= 3) begin();               // HAVE_FUTURE_DATA → ready now
    else {
      videoEl.addEventListener('canplay', begin, { once: true });
      setTimeout(begin, 2500);                          // fallback if canplay never fires
    }
  }

  function onCmd(d) {
    if (d.cmd === 'play') {
      resumeAudio();
      if (embedMode) { if (embedApi) embedApi.play(); }
      else if (videoMode) { startVideoModePlayback(); videoPlaying = true; }
      else { audio.play().catch(function () {}); startMusicFadeIn(); }  // figure mode: fade music in too
      document.body.classList.add('playing');
    } else if (d.cmd === 'pause') {
      if (embedMode) { if (embedApi) embedApi.pause(); }
      else if (videoMode) { videoEl.pause(); audio.pause(); videoPlaying = false; }
      else { audio.pause(); }
    } else if (d.cmd === 'stop') {
      clearPendingFeedback();
      hideFinal(); clearGuards(); hideStage(); hideGetReady(); hideBeacons();
      if (embedMode) {
        if (embedApi) { embedApi.pause(); embedApi.seek0(); }
        embedEl.style.display = 'none';
        embedEl.innerHTML = '';
        embedMode = false; embedApi = null; embedPlayer = null;
        canvas.style.display = '';
      } else if (videoMode) {
        audio.pause(); try { audio.currentTime = 0; } catch (e) { /* ignore */ }
        exitVideoMode();
        canvas.style.display = '';
      } else {
        audio.pause();
        audio.currentTime = 0;
      }
      nowIndex = 0; lastDrawnNow = -1;   // a fresh re-dance previews move #1 again
      document.body.classList.remove('playing');
      showLobby();                        // back to idle → bring back the install QR
      setStatus('ready');
    } else if (d.cmd === 'debug') {
      setDebug(d.on);
    }
  }

  // Feedback is scheduled against the TV playhead (d.at): present it when the song reaches that moment,
  // so the tone/word land musically rather than whenever the packet arrived. If d.at is already in the
  // past (pipeline slower than the lead) or absent (mock), present immediately.
  var pendingFeedback = [];
  function clearPendingFeedback() {
    for (var i = 0; i < pendingFeedback.length; i++) clearTimeout(pendingFeedback[i]);
    pendingFeedback = [];
  }

  function presentFeedback(d) {
    toneTier(d.rating, d.gold);
    // Cast-mode timing cue: a quick directional grace note through the TV speakers when notably off-beat
    // (early = high, late = low) — the SAME audio channel the phone uses, since the dancer is across the room
    // from the TV too. Pitched clear of the rating tones (1320/990/660/196) so it reads as a separate cue.
    if (d.timing === 'early') tone(1568, 0.05, 0.34);
    else if (d.timing === 'late') tone(392, 0.06, 0.34);
    // Gentle, brief duck only on the prominent moments so the tone pops — the music stays clearly audible
    // and never disappears. good/ok/miss don't duck at all (their tone cuts through on its own). The
    // first ~0.9s after play is suppressed by the ducker itself (settle window — early feedback must
    // not "take over" before the track establishes).
    if (d.gold && d.rating !== 'miss') duck(0.7, 0.4);
    else if (d.rating === 'perfect') duck(0.8, 0.25);
    // The judged moment lands on the player's BEACON (in the sightline): tier wash + bump + "+N".
    // The filmstrip tile still flashes as the choreography cue (no +N there anymore — one home).
    flashTile(d.idx, d.rating, d.gold);
    flashBeacon(d.lane || 0, d.rating, d.gold, d.points);
  }

  function onFeedback(d) {
    var delay = (typeof d.at === 'number') ? (d.at - currentPlayhead()) : 0;
    // Only schedule a SMALL forward wait. A large positive delay means the phone's target playhead is
    // well ahead of ours (clock skew / over-lead) — waiting it out would land the feedback seconds late,
    // after the moment has passed, so present immediately instead. (Was `< 3`, which let skew stack up
    // into multi-second lateness.) Negative delay (moment already passed) also presents immediately.
    if (delay > 0.03 && delay < 0.45) {
      pendingFeedback.push(setTimeout(function () { presentFeedback(d); }, delay * 1000));
    } else {
      presentFeedback(d);
    }
  }

  if (context) {
    context.addCustomMessageListener(NS, function (event) {
      var d = event.data || {};
      senders[event.senderId] = true;
      if (d.t && d.t !== 'ping' && d.t !== 'pong') hideLobby();   // any routine activity → drop the idle QR
      switch (d.t) {
        case 'ping': try { context.sendCustomMessage(NS, event.senderId, { t: 'pong', id: d.id, cs: d.cs, rs: now() }); } catch (e) {} break;
        case 'load': onLoad(d); break;
        case 'loadEmbed': onLoadEmbed(d); break;
        case 'loadVideo': onLoadVideo(d); break;
        case 'pose': onPose(d); break;
        case 'moves': onMoves(d); break;
        case 'cmd': onCmd(d); break;
        case 'feedback': onFeedback(d); break;
        case 'score': renderBeacons(d.scores); break;
        case 'final': onFinal(d); break;
        case 'getready': onGetReady(d); break;
        case 'go': onGo(d); break;
        case 'record': onRecord(d); break;
        case 'castlock': onCastLock(d); break;
        case 'audioInit': onAudioInit(d); break;
        case 'audioChunk': onAudioChunk(d); break;
        case 'audioEnd': onAudioEnd(d); break;
        case 'framing': onFraming(d); break;
        case 'guard': onGuard(d); break;
        case 'dbgpose': onDbgPose(d); break;
        default: break;
      }
    });

    context.addEventListener(cast.framework.system.EventType.SENDER_CONNECTED, function (e) {
      senders[e.senderId] = true;
      setStatus('phone connected');
      updateLobbyStatus();   // idle screen flips to "connected — pick a song"
      // Announce a fresh boot to the (re)connecting phone. After a receiver PAGE RELOAD mid-session the
      // phone's Cast session stays up (no disconnect event fires), so this `hello` is the ONLY signal it
      // gets that the TV reset and needs re-initialising. The phone ignores it unless a cast round is live
      // (so a normal first connect is harmless); mid-round it ends the round cleanly so a re-tap reloads us.
      try { context.sendCustomMessage(NS, e.senderId, { t: 'hello' }); } catch (ex) { /* sender vanished */ }
    });
    context.addEventListener(cast.framework.system.EventType.SENDER_DISCONNECTED, function (e) {
      delete senders[e.senderId];
      if (Object.keys(senders).length === 0) showLobby();   // phone left → back to the idle install QR
      else updateLobbyStatus();
    });
  }

  audio.addEventListener('ended', function () {
    document.body.classList.remove('playing');
    broadcast({ t: 'ph', rt: audio.duration || 0, ts: now(), st: 'ended', seq: seq++ });
  });

  // ---- Browser preview (?mock=1) ----
  function standingJoints(a) {
    var seg = 0.09;
    var ls = [0.42, 0.23], rs = [0.58, 0.23];
    function arm(sh, side, ang) {
      var dx = Math.sin(ang) * side, dy = Math.cos(ang);
      var e = [sh[0] + dx * seg, sh[1] + dy * seg];
      var w = [e[0] + dx * seg, e[1] + dy * seg];
      return [e, w];
    }
    var l = arm(ls, -1, a), r = arm(rs, 1, a);
    return {
      nose: [0.5, 0.10], neck: [0.5, 0.20],
      leftShoulder: ls, rightShoulder: rs,
      leftElbow: l[0], leftWrist: l[1], rightElbow: r[0], rightWrist: r[1],
      leftHip: [0.45, 0.50], rightHip: [0.55, 0.50], root: [0.5, 0.50],
      leftKnee: [0.45, 0.68], rightKnee: [0.55, 0.68],
      leftAnkle: [0.45, 0.85], rightAnkle: [0.55, 0.85]
    };
  }

  // Synthetic move pictograms for the browser (varied poses, every 4th a gold Star Move), spaced to fit
  // within the mock playhead loop.
  function mockMoves(n) {
    n = n || 12;
    var arr = [];
    for (var i = 0; i < n; i++) {
      arr.push({ i: i, t: 0.5 + i * 0.6, gold: (i % 4 === 3), j: standingJoints(0.2 + (i % 5) * 0.45) });
    }
    return arr;
  }

  function setupMock() {
    hideLobby();
    poseFrames = [];
    for (var k = 0; k < 8 * 15; k++) {
      var t = k / 15;
      poseFrames.push({ t: t, j: standingJoints((Math.sin(t * 1.6) * 0.5 + 0.5) * (Math.PI / 2)) });
    }
    loaded = true;
    mirrored = true;
    mockMode = true;
    mockStart = now();
    setMode('figure');
    applyOrientation('portrait');
    moveChunks = 1; recvMoveChunks = 0; moves = [];
    onMoves({ moves: mockMoves(12) });   // light up the filmstrip
    document.body.classList.add('playing');
    setStatus('MOCK preview (click to enable sound)');
    var tiers = [['perfect', false, 100], ['good', false, 60], ['ok', false, 30], ['perfect', true, 300], ['miss', false, 0]];
    var mockN = 2;                                   // simulated player count (1–4)
    var totals = [0, 0, 0, 0], combos = [0, 0, 0, 0];
    var mockSeen = [{ seen: 'ok' }, { seen: 'ok' }, { seen: 'ok' }, { seen: 'ok' }];
    function mockLanesArr() { var a = []; for (var i = 0; i < mockN; i++) a.push(i); return a; }
    // (Re)start the round for the current player count: reset scores, roll-call the beacons, GO.
    function mockRollCall() {
      clearBeacons();
      framingLanes = mockLanesArr();
      for (var i = 0; i < mockN; i++) { totals[i] = 0; combos[i] = 0; mockSeen[i] = { seen: 'ok' }; }
      onGetReady({ n: 3 }); onGo();
    }
    mockRollCall();
    setInterval(function () {
      var scores = [];
      for (var lane = 0; lane < mockN; lane++) {
        var x = pick(tiers);
        onFeedback({ rating: x[0], gold: x[1], points: x[2], lane: lane, idx: nowIndex });
        combos[lane] = x[0] === 'miss' ? 0 : combos[lane] + 1;
        totals[lane] += x[2];
        scores.push({ lane: lane, total: totals[lane], combo: combos[lane], seen: mockSeen[lane].seen, fix: mockSeen[lane].fix });
      }
      renderBeacons(scores);
    }, 1300);
    // Drive a beacon's presence state from the console: DNTestSeen(1,'lost','left') / ('fix','back') / ('ok').
    window.DNTestSeen = function (lane, seen, fix) {
      mockSeen[lane || 0] = { seen: seen || 'ok', fix: fix || null };
    };
    // Set the simulated player count (1–4) and restart the roll-call — exercises every beacon layout.
    window.DNTestPlayers = function (n) { mockN = Math.max(1, Math.min(4, n || 2)); mockRollCall(); };
    // Browser-only dev hooks (mock): preview the rail + cast-UX overlays.
    window.DNTestMoves = function (n) { moveChunks = 1; recvMoveChunks = 0; moves = []; nowIndex = 0; lastDrawnNow = -1; onMoves({ moves: mockMoves(n || 12) }); };
    window.DNTestOrient = function (o) { applyOrientation(o || 'portrait'); };
    window.DNTestDebug = function (on) {
      setDebug(on !== false);
      if (window._dbgTimer) { clearInterval(window._dbgTimer); window._dbgTimer = null; }
      if (on === false) return;
      window._dbgTimer = setInterval(function () {
        var a = (Math.sin(now() * 1.6) * 0.5 + 0.5) * (Math.PI / 2);
        var bm = []; for (var i = 0; i < 14; i++) bm.push(Math.random());
        onDbgPose({ j: standingJoints(a), bones: bm });
      }, 60);
    };
    window.DNTestFinal = function (p) {
      if (!p) { p = []; for (var i = 0; i < mockN; i++) p.push({ lane: i, total: 1480 + i * 690 + (i === 1 ? 800 : 0), stars: Math.min(5, 2 + i) }); }
      onFinal({ players: p });
    };
    window.DNTestGetReady = function (n) { onGetReady({ n: n == null ? 3 : n }); };
    window.DNTestGo = function () { onGo(); };
    window.DNTestFraming = function (instr, ok) { onFraming({ state: 'setup', instr: instr || 'Back up — I need to see your feet', players: [{ lane: 0, ok: !!ok, j: standingJoints(0.3) }] }); };
    window.DNTestPaused = function () { onFraming({ state: 'paused', instr: 'Step back into view', players: [{ lane: 0, ok: false, j: standingJoints(0.3) }] }); };
    window.DNTestGuard = function (ring) { onGuard({ lane: 1, state: 'nudge', ring: ring == null ? 0.45 : ring }); };
  }

  // ---- Start ----
  if (context) {
    try {
      var options = new cast.framework.CastReceiverOptions();
      options.customNamespaces = {};
      options.customNamespaces[NS] = cast.framework.system.MessageType.JSON;
      options.disableIdleTimeout = true;
      context.start(options);
    } catch (e) { /* not in a Cast environment (e.g. browser preview) */ }
  }

  showLobby();   // idle screen: the install QR until a phone starts a routine
  if (location.search.indexOf('mock') >= 0) setupMock();
  if (location.search.indexOf('debug') >= 0) setDebug(true);   // dev reference-pose overlay (off in production)

  requestAnimationFrame(frame);
})();
