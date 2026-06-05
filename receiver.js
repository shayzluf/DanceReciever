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
 *   phone → TV   { t:'loadEmbed', provider, videoID, mirrored }   // TV plays the platform video (its own sound)
 *   phone → TV   { t:'loadVideo', videoUrl, audioUrl, mirrored }  // TV plays the user's silent clip + catalog mp3
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

  // Build stamp — bump this (and the ?v= in index.html) on every receiver change. The TV shows it
  // bottom-right, so a stale/cached Cast device is detectable at a glance (wrong/missing = reboot it).
  var BUILD = 'jun5-video2';
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

    // Draw the figure only in figure mode (embed + video modes show real footage instead).
    if (!embedMode && !videoMode && (mockMode || loaded) && poseFrames.length) {
      var dur = poseFrames[poseFrames.length - 1].t || 1;
      var t = mockMode ? ((now() - mockStart) % dur) : (audio.currentTime || 0);
      var f = poseAt(t);
      if (f) drawFigure(f.j);
    }

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

  function onLoad(d) {
    clearPendingFeedback();
    exitVideoMode();
    canvas.style.display = '';
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

  // Local catalog routine on the TV: play the user's *silent* recorded clip (staged on R2) as the coach,
  // with the licensed catalog mp3 synced to it. Video is the master clock; play/pause/stop drive both.
  // Our own content → feedback overlays are allowed (presentFeedback only suppresses them for embeds).
  function onLoadVideo(d) {
    clearPendingFeedback();
    poseFrames = []; loaded = false; mockMode = false;
    embedMode = false; embedPlaying = false; embedApi = null; embedPlayer = null;
    if (embedEl) { embedEl.style.display = 'none'; embedEl.innerHTML = ''; }
    mirrored = d.mirrored !== false;
    if (!videoEl) videoEl = document.getElementById('castvideo');
    canvas.style.display = 'none';
    videoMode = true; videoPlaying = false;
    videoEl.style.display = 'block';
    videoEl.style.transform = mirrored ? 'scaleX(-1)' : 'none';
    videoEl.muted = true;
    videoEl.onended = function () {
      videoPlaying = false;
      document.body.classList.remove('playing');
      broadcast({ t: 'ph', rt: videoEl.duration || 0, ts: now(), st: 'ended', seq: seq++ });
    };
    if (d.audioUrl) { audio.src = d.audioUrl; audio.load(); } else { audio.removeAttribute('src'); }
    videoEl.src = d.videoUrl || '';
    videoEl.load();
    if (actx && actx.state === 'suspended') actx.resume();
    setStatus('loading video…');
  }

  // Reference-don't-host on the TV: load the routine's platform video (real video + original sound).
  function onLoadEmbed(d) {
    clearPendingFeedback();
    exitVideoMode();
    loaded = false; mockMode = false;
    embedMode = true; embedPlaying = false; embedTime = 0; embedApi = null; embedPlayer = null;
    canvas.style.display = 'none';
    if (!embedEl) embedEl = document.getElementById('embed');
    embedEl.innerHTML = '';
    embedEl.style.display = 'block';
    if (actx && actx.state === 'suspended') actx.resume();
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

  function onCmd(d) {
    if (d.cmd === 'play') {
      if (actx && actx.state === 'suspended') actx.resume();
      if (embedMode) { if (embedApi) embedApi.play(); }
      else if (videoMode) { videoEl.play().catch(function () {}); audio.play().catch(function () {}); videoPlaying = true; }
      else { audio.play().catch(function () {}); }
      document.body.classList.add('playing');
    } else if (d.cmd === 'pause') {
      if (embedMode) { if (embedApi) embedApi.pause(); }
      else if (videoMode) { videoEl.pause(); audio.pause(); videoPlaying = false; }
      else { audio.pause(); }
    } else if (d.cmd === 'stop') {
      clearPendingFeedback();
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
    // Over an embedded player we must not draw overlays (platform ToS) → audio-only feedback there.
    if (!embedMode) { pulseGlow(d.rating, d.gold); showWord(d.rating, d.gold, d.points); }
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
