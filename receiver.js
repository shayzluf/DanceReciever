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
 *   phone → TV   { t:'feedback', lane, rating, points, gold, at, idx }   // at = target TV-playhead (sec); idx = checkpoint
 *   phone → TV   { t:'score', scores:[{lane,total,combo}] }
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

  var NS = 'urn:x-cast:com.dancenow.sync';
  var context = (window.cast && cast.framework) ? cast.framework.CastReceiverContext.getInstance() : null;
  var senders = {};

  var audio = document.getElementById('song');
  var canvas = document.getElementById('coach');
  var ctx = canvas.getContext('2d');
  var glowEl = document.getElementById('glow');
  var wordEl = document.getElementById('word');
  var scoresEl = document.getElementById('scores');
  var finalEl = document.getElementById('final');
  var getreadyEl = document.getElementById('getready');
  var stageEl = document.getElementById('stage');
  var stageBox = stageEl ? stageEl.querySelector('.stage-box') : null;
  var stageCanvas = document.getElementById('stagecanvas');
  var stageCtx = stageCanvas ? stageCanvas.getContext('2d') : null;
  var guardEl = document.getElementById('guard');
  var statusEl = document.getElementById('status');

  // Stage + rail (the split layout). The coach lives in #videostage; feedback lives in #rail.
  var videostageEl = document.getElementById('videostage');
  var railEl = document.getElementById('rail');
  var railScoresEl = document.getElementById('railscores');
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
  var chipEls = {};          // lane → {el, sc, cb}
  var dbgLive = null;        // dev-only: { j:{joint:[x,y]}, bones:[..] } streamed when debug is on

  // Build stamp — bump this (and the ?v= in index.html) on every receiver change. The TV shows it
  // bottom-right, so a stale/cached Cast device is detectable at a glance (wrong/missing = reboot it).
  var BUILD = 'jun9-rail2';
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

  function now() { return performance.now() / 1000; }
  function setStatus(t) { if (statusEl) statusEl.textContent = t; }
  function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

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
  // to full, and the latest duck wins, so rapid feedback can never leave the music stuck quiet.
  var duckToken = 0;
  var duckRamp = null;
  function rampMusic(target, ms) {
    var dur = Math.max(0.02, ms / 1000);
    // Preferred: ramp the WebAudio musicGain (sample-accurate, no click).
    if (musicGain && actx) {
      var t = actx.currentTime, cur = musicGain.gain.value;
      musicGain.gain.cancelScheduledValues(t);
      musicGain.gain.setValueAtTime(cur, t);
      musicGain.gain.linearRampToValueAtTime(target, t + dur);
      return;
    }
    // Fallback (graph not built): ramp the element volume.
    if (!audio) return;
    if (duckRamp) { clearInterval(duckRamp); duckRamp = null; }
    var from = audio.volume, t0 = now();
    duckRamp = setInterval(function () {
      var k = Math.min(1, (now() - t0) / dur);
      audio.volume = Math.max(0, Math.min(1, from + (target - from) * k));
      if (k >= 1) { clearInterval(duckRamp); duckRamp = null; }
    }, 16);
  }
  function duck(level, holdSeconds) {
    rampMusic(level, 70);
    duckToken += 1;
    var token = duckToken;
    setTimeout(function () { if (token === duckToken) rampMusic(1.0, 220); }, holdSeconds * 1000);
  }

  // ---- Feedback visuals ----
  function tierColor(rating, gold) {
    if (gold && rating !== 'miss') return '#ffd400';
    if (rating === 'perfect') return '#34c759';
    if (rating === 'good') return '#30d158';
    if (rating === 'ok') return '#64d2ff';
    return '#ff453a';
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

  // Per-player score chips in the rail. Built once per lane then updated IN PLACE, so a flash class isn't
  // wiped by the next 0.4s score update.
  function renderChips(scores) {
    if (!railScoresEl || !scores || !scores.length) return;
    for (var i = 0; i < scores.length; i++) {
      var s = scores[i], lane = s.lane || 0;
      var C = chipEls[lane];
      if (!C) {
        var el = document.createElement('div'); el.className = 'rchip';
        el.innerHTML = '<div class="p">P' + (lane + 1) + '</div><div class="sc">0</div><div class="cb"></div>';
        railScoresEl.appendChild(el);
        C = chipEls[lane] = { el: el, sc: el.querySelector('.sc'), cb: el.querySelector('.cb') };
      }
      C.sc.textContent = Math.round(s.total);
      C.cb.textContent = (s.combo > 1) ? ('x' + s.combo) : '';
    }
  }
  function clearChips() { if (railScoresEl) railScoresEl.innerHTML = ''; chipEls = {}; }
  function flashChip(lane, rating, gold) {
    var C = chipEls[lane]; if (!C) return;
    C.el.style.setProperty('--fc', tierColor(rating, gold));
    C.el.classList.remove('flash', 'bump'); void C.el.offsetWidth;
    C.el.classList.add('flash', 'bump');
    setTimeout(function () { C.el.classList.remove('flash'); }, 420);
  }

  // ---- Move filmstrip (Just-Dance "now / next" pictograms) ----
  // Draw one key-pose centered + fit to the tile (bbox-fit like drawFigure, in unit-square space so a tall
  // standing pose fills a portrait tile). Mirror-matched to the on-screen video.
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
    var s = Math.min(W * 0.84 / pbw, H * 0.84 / pbh);
    var ccx = (minX + maxX) / 2, ccy = (minY + maxY) / 2;
    function map(p) { var x = W / 2 + (p[0] - ccx) * s; if (mir) x = W - x; return [x, H / 2 + (p[1] - ccy) * s]; }
    var color = gold ? '#ffd400' : (isNow ? '#ffffff' : '#f2f2f7');
    var lw = Math.max(2, H * (isNow ? 0.05 : 0.04));
    c.lineCap = 'round'; c.lineJoin = 'round'; c.lineWidth = lw; c.strokeStyle = color;
    for (var i = 0; i < bones.length; i++) {
      var a = joints[bones[i][0]], b = joints[bones[i][1]];
      if (!a || !b) continue;
      var ma = map(a), mb = map(b);
      c.beginPath(); c.moveTo(ma[0], ma[1]); c.lineTo(mb[0], mb[1]); c.stroke();
    }
    var head = joints.nose || joints.neck;
    if (head) { var mh = map(head); c.fillStyle = color; c.beginPath(); c.arc(mh[0], mh[1], lw * 1.25, 0, 2 * Math.PI); c.fill(); }
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
    var html = '';
    if (players && players.length) {
      for (var i = 0; i < players.length; i++) {
        var p = players[i];
        var stars = '', n = p.stars || 0;
        for (var s = 0; s < 5; s++) stars += (s < n) ? '★' : '☆';
        html += '<div class="final-player">'
          + (players.length > 1 ? '<div class="final-lane">P' + ((p.lane || 0) + 1) + '</div>' : '')
          + '<div class="final-num">' + Math.round(p.total || 0) + '</div>'
          + '<div class="final-stars">' + stars + '</div></div>';
      }
    }
    if (wrap) {
      wrap.innerHTML = html;
      finalEl.style.display = 'flex';
      wrap.style.transition = 'none'; wrap.style.transform = 'scale(0.6)'; wrap.style.opacity = '0';
      void wrap.offsetWidth;
      wrap.style.transition = 'transform 0.55s cubic-bezier(.2,.9,.2,1.25), opacity 0.4s ease';
      wrap.style.transform = 'scale(1)'; wrap.style.opacity = '1';
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
    clearGuards(); hideStage(); hideGetReady();
    // Freeze the round on its last frame and reveal the score. Over an embed we must not draw on the
    // player (ToS) — hide it first so the score sits on a clean background.
    try { if (videoEl) videoEl.pause(); } catch (e) { /* ignore */ }
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
    var num = getreadyEl ? getreadyEl.querySelector('.gr-num') : null;
    if (num) num.textContent = 'GO!';
    tone(784, 0.1, 0.5);
    setTimeout(function () { tone(988, 0.1, 0.5); }, 90);
    setTimeout(function () { tone(1319, 0.18, 0.5); }, 180);
    setTimeout(hideGetReady, 650);
  }

  // Draw one live skeleton mapped DIRECTLY from [0,1] frame coords into the box, so the dancer's real
  // position (and any edge clipping) is visible — unlike drawFigure, which fills the screen.
  function drawSkeletonRaw(c, joints, W, H, mir, color) {
    function map(p) { var nx = mir ? (1 - p[0]) : p[0]; return [nx * W, p[1] * H]; }
    var lw = Math.max(3, H * 0.016);
    c.lineCap = 'round'; c.lineJoin = 'round'; c.lineWidth = lw; c.strokeStyle = color;
    for (var i = 0; i < bones.length; i++) {
      var a = joints[bones[i][0]], b = joints[bones[i][1]];
      if (!a || !b) continue;
      var ma = map(a), mb = map(b);
      c.beginPath(); c.moveTo(ma[0], ma[1]); c.lineTo(mb[0], mb[1]); c.stroke();
    }
    var head = joints.nose || joints.neck;
    if (head) { var mh = map(head); c.fillStyle = color; c.beginPath(); c.arc(mh[0], mh[1], lw * 1.3, 0, 2 * Math.PI); c.fill(); }
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
    if (stageCtx && stageCanvas) {
      var w = stageCanvas.clientWidth || 360, h = stageCanvas.clientHeight || 640;
      if (stageCanvas.width !== w || stageCanvas.height !== h) { stageCanvas.width = w; stageCanvas.height = h; }
      stageCtx.clearRect(0, 0, stageCanvas.width, stageCanvas.height);
      for (var i = 0; i < players.length; i++) {
        if (players[i].j) {
          drawSkeletonRaw(stageCtx, players[i].j, stageCanvas.width, stageCanvas.height, mirrored, players[i].ok ? '#34c759' : '#f2f2f7');
        }
      }
    }
    stageEl.style.display = 'flex';
  }

  // In-round per-player "come back!" nudge chips with a rejoin ring.
  var guardChips = {};
  function clearGuards() {
    if (guardEl) { for (var k in guardChips) { if (guardChips.hasOwnProperty(k)) { try { guardEl.removeChild(guardChips[k]); } catch (e) {} } } }
    guardChips = {};
  }
  function onGuard(d) {
    if (!guardEl) return;
    var lane = d.lane || 0;
    if (d.state === 'ok' || d.state === 'rejoin') {
      if (guardChips[lane]) { try { guardEl.removeChild(guardChips[lane]); } catch (e) {} delete guardChips[lane]; }
      return;
    }
    var chip = guardChips[lane];
    if (!chip) {
      chip = document.createElement('div');
      chip.className = 'nudge';
      chip.innerHTML = '<span class="ring"></span><span class="lbl"></span>';
      guardEl.appendChild(chip);
      guardChips[lane] = chip;
      tone(440, 0.12, 0.3);   // soft, distinct from a "miss"
    }
    chip.querySelector('.lbl').textContent = 'P' + (lane + 1) + ' — come back!';
    chip.querySelector('.ring').style.setProperty('--p', Math.round((d.ring || 0) * 100));
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

    var lw = Math.max(10, drawH * 0.05);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = lw;
    ctx.strokeStyle = '#f2f2f7';
    for (var i = 0; i < bones.length; i++) {
      var a = joints[bones[i][0]], b = joints[bones[i][1]];
      if (!a || !b) continue;
      var ma = map(a), mb = map(b);
      ctx.beginPath();
      ctx.moveTo(ma[0], ma[1]);
      ctx.lineTo(mb[0], mb[1]);
      ctx.stroke();
    }
    var head = joints.nose || joints.neck;
    if (head) {
      var mh = map(head);
      ctx.fillStyle = '#f2f2f7';
      ctx.beginPath();
      ctx.arc(mh[0], mh[1], lw * 1.15, 0, 2 * Math.PI);
      ctx.fill();
    }
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

    // Video mode: the silent clip is the master clock — keep the catalog mp3 locked to it.
    if (videoMode && videoEl && !videoEl.paused && audio && !audio.paused) {
      if (Math.abs((audio.currentTime || 0) - (videoEl.currentTime || 0)) > 0.25) {
        try { audio.currentTime = videoEl.currentTime; } catch (e) { /* not seekable yet */ }
      }
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

  // Reset the move filmstrip + score chips for a new routine, and switch the layout (mode + orientation).
  function resetMoves(d) {
    moves = []; moveChunks = d.moveChunks || 0; recvMoveChunks = 0; movesReady = false;
    nowIndex = 0; lastDrawnNow = -1;
    if (filmstripEl) filmstripEl.style.display = 'none';
    clearChips();
  }

  function onLoad(d) {
    clearPendingFeedback();
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
    hideFinal(); clearGuards();
    poseFrames = []; loaded = false; mockMode = false;
    embedMode = false; embedPlaying = false; embedApi = null; embedPlayer = null;
    if (embedEl) { embedEl.style.display = 'none'; embedEl.innerHTML = ''; }
    mirrored = d.mirrored !== false;
    if (!videoEl) videoEl = document.getElementById('castvideo');
    canvas.style.display = 'none';
    videoMode = true; videoPlaying = false;
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
      }).catch(function () {
        audio.play().catch(function () {}); // last resort: don't leave the round silent
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
      else { audio.play().catch(function () {}); }
      document.body.classList.add('playing');
    } else if (d.cmd === 'pause') {
      if (embedMode) { if (embedApi) embedApi.pause(); }
      else if (videoMode) { videoEl.pause(); audio.pause(); videoPlaying = false; }
      else { audio.pause(); }
    } else if (d.cmd === 'stop') {
      clearPendingFeedback();
      hideFinal(); clearGuards(); hideStage(); hideGetReady();
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
    // Gentle, brief duck only on the prominent moments so the tone pops — the music stays clearly audible
    // and never disappears. good/ok/miss don't duck at all (their tone cuts through on its own).
    if (d.gold && d.rating !== 'miss') duck(0.7, 0.4);
    else if (d.rating === 'perfect') duck(0.8, 0.25);
    // Rail feedback in EVERY mode — flash the move tile just judged + the player's score chip. We never
    // draw over the video (licensing/ToS); the old full-screen glow + centered word are retired.
    flashTile(d.idx, d.rating, d.gold, d.points);
    flashChip(d.lane || 0, d.rating, d.gold);
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
      switch (d.t) {
        case 'ping': try { context.sendCustomMessage(NS, event.senderId, { t: 'pong', id: d.id, cs: d.cs, rs: now() }); } catch (e) {} break;
        case 'load': onLoad(d); break;
        case 'loadEmbed': onLoadEmbed(d); break;
        case 'loadVideo': onLoadVideo(d); break;
        case 'pose': onPose(d); break;
        case 'moves': onMoves(d); break;
        case 'cmd': onCmd(d); break;
        case 'feedback': onFeedback(d); break;
        case 'score': renderChips(d.scores); break;
        case 'final': onFinal(d); break;
        case 'getready': onGetReady(d); break;
        case 'go': onGo(d); break;
        case 'framing': onFraming(d); break;
        case 'guard': onGuard(d); break;
        case 'dbgpose': onDbgPose(d); break;
        default: break;
      }
    });

    context.addEventListener(cast.framework.system.EventType.SENDER_CONNECTED, function (e) {
      senders[e.senderId] = true;
      setStatus('phone connected');
    });
    context.addEventListener(cast.framework.system.EventType.SENDER_DISCONNECTED, function (e) {
      delete senders[e.senderId];
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
    var totals = [0, 0], combos = [0, 0];
    setInterval(function () {
      for (var lane = 0; lane < 2; lane++) {
        var x = pick(tiers);
        onFeedback({ rating: x[0], gold: x[1], points: x[2], lane: lane, idx: nowIndex });
        combos[lane] = x[0] === 'miss' ? 0 : combos[lane] + 1;
        totals[lane] += x[2];
      }
      renderChips([{ lane: 0, total: totals[0], combo: combos[0] }, { lane: 1, total: totals[1], combo: combos[1] }]);
    }, 1300);
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
    window.DNTestFinal = function (p) { onFinal({ players: p || [{ lane: 0, total: 2910, stars: 4 }] }); };
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

  if (location.search.indexOf('mock') >= 0) setupMock();
  if (location.search.indexOf('debug') >= 0) setDebug(true);   // dev reference-pose overlay (off in production)

  requestAnimationFrame(frame);
})();
