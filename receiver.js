/*
 * DanceNow custom Cast receiver — the "TV app."
 *
 * The TV is the big shared screen: it plays the song (and is the authoritative clock the phone syncs
 * to), renders the COACH figure from a pose timeline the phone streams, and shows all feedback (edge-
 * glow + a rating word + tone + spoken callout + scoreboard). The phone is the camera/scorer; it never
 * overlays anything on a player here, which is the whole point of the second-screen design.
 *
 * Browser preview (NO Chromecast): open  receiver/index.html?mock=1  in Chrome to see the coach
 * animate + feedback fire (click once to enable sound — browser autoplay policy).
 *
 * Namespace urn:x-cast:com.dancenow.sync
 *   phone → TV   { t:'load', audioUrl, mirrored, chunks }     then { t:'pose', frames:[{t,j}] } × chunks
 *   phone → TV   { t:'cmd', cmd:'play'|'pause'|'stop' }
 *   phone → TV   { t:'feedback', lane, rating, points, gold, at }   // at = target TV-playhead (sec)
 *   phone → TV   { t:'score', scores:[{lane,total,combo}] }
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
  var statusEl = document.getElementById('status');

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

  function now() { return performance.now() / 1000; }
  function setStatus(t) { if (statusEl) statusEl.textContent = t; }
  function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

  function resize() { canvas.width = window.innerWidth; canvas.height = window.innerHeight; }
  window.addEventListener('resize', resize);
  resize();

  // ---- Audio: tier tones (WebAudio) + spoken callouts + music ducking ----
  var AudioCtx = window.AudioContext || window.webkitAudioContext;
  var actx = AudioCtx ? new AudioCtx() : null;

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

  function say(text) {
    if (!window.speechSynthesis) return;
    try {
      var u = new SpeechSynthesisUtterance(text);
      u.rate = 1.05;
      u.pitch = 1.15;
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(u);
    } catch (e) { /* ignore */ }
  }

  var duckToken = 0;
  function duck(level, holdSeconds) {
    if (!audio) return;
    audio.volume = level;
    duckToken += 1;
    var token = duckToken;
    setTimeout(function () { if (token === duckToken) audio.volume = 1.0; }, holdSeconds * 1000);
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

  function renderScores(scores) {
    if (!scores || !scores.length) { scoresEl.innerHTML = ''; return; }
    var html = '';
    for (var i = 0; i < scores.length; i++) {
      var s = scores[i];
      html += '<div class="chip"><div class="p">P' + (s.lane + 1) + '</div>'
        + '<div class="sc">' + Math.round(s.total) + '</div>'
        + (s.combo > 1 ? '<div class="cb">x' + s.combo + '</div>' : '')
        + '</div>';
    }
    scoresEl.innerHTML = html;
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
    if (!loaded || !poseFrames.length) return;
    var dur = poseFrames[poseFrames.length - 1].t || 1;
    var t = mockMode ? ((now() - mockStart) % dur) : (audio.currentTime || 0);
    var f = poseAt(t);
    if (f) drawFigure(f.j);

    if (!mockMode && now() - lastBeacon > 0.05) {
      lastBeacon = now();
      broadcast({ t: 'ph', rt: t, ts: now(), st: audio.paused ? 'paused' : 'playing', seq: seq++ });
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

  function onLoad(d) {
    clearPendingFeedback();
    poseFrames = [];
    receivedChunks = 0;
    expectedChunks = d.chunks || 0;
    mirrored = d.mirrored !== false;
    loaded = false;
    mockMode = false;
    if (d.audioUrl) { audio.src = d.audioUrl; audio.load(); }
    if (actx && actx.state === 'suspended') actx.resume();
    setStatus('loading routine…');
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

  function onCmd(d) {
    if (d.cmd === 'play') {
      if (actx && actx.state === 'suspended') actx.resume();
      audio.play().catch(function () {});
      document.body.classList.add('playing');
    } else if (d.cmd === 'pause') {
      audio.pause();
    } else if (d.cmd === 'stop') {
      clearPendingFeedback();
      audio.pause();
      audio.currentTime = 0;
      document.body.classList.remove('playing');
      setStatus('ready');
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
    if (d.gold && d.rating !== 'miss') { say(pick(['Yeah!', 'Star move!', 'Amazing!'])); duck(0.3, 0.7); }
    else if (d.rating === 'perfect') { say(pick(['Perfect!', 'Nailed it!', 'Yeah!'])); duck(0.3, 0.7); }
    else { duck(0.65, 0.18); }
    pulseGlow(d.rating, d.gold);
    showWord(d.rating, d.gold, d.points);
  }

  function onFeedback(d) {
    var delay = (typeof d.at === 'number') ? (d.at - (audio.currentTime || 0)) : 0;
    if (delay > 0.03 && delay < 3) {
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
        case 'pose': onPose(d); break;
        case 'cmd': onCmd(d); break;
        case 'feedback': onFeedback(d); break;
        case 'score': renderScores(d.scores); break;
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
    document.body.classList.add('playing');
    setStatus('MOCK preview (click to enable sound)');
    var tiers = [['perfect', false, 100], ['good', false, 60], ['ok', false, 30], ['perfect', true, 300], ['miss', false, 0]];
    var total = 0, combo = 0;
    setInterval(function () {
      var x = pick(tiers);
      onFeedback({ rating: x[0], gold: x[1], points: x[2], lane: 0 });
      combo = x[0] === 'miss' ? 0 : combo + 1;
      total += x[2];
      renderScores([{ lane: 0, total: total, combo: combo }]);
    }, 1300);
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

  requestAnimationFrame(frame);
})();
