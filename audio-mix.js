/*
 * Floored receiver — audio-mix policies (music ducking + audio↔video sync guard).
 *
 * Extracted from receiver.js so the two behaviors behind every "the music disappeared on the TV"
 * report are unit-testable in Node (`node --test receiver/test/`) against fake clocks/params:
 *
 *   createDucker    — brief music ducks under feedback tones that ALWAYS restore to full volume
 *                     (latest duck wins), the play fade-in, and the post-play settle window during
 *                     which ducks are ignored so the track can establish.
 *
 *   createSyncGuard — WHEN video mode may re-seek the catalog mp3 to the silent clip. This is the
 *                     fix for the "seek storm": the old per-frame `if (drift > 0.3) re-seek` kept
 *                     firing at ~60fps while a seek was still in flight (audio.currentTime lags the
 *                     assignment, so the drift test stayed true), which held the mp3 in a permanent
 *                     seek → the music went silent for the rest of the round while the WebAudio
 *                     feedback tones (a separate pipeline) kept playing. The guard never seeks while
 *                     `audio.seeking`, and rate-limits corrections with a cooldown.
 *
 * Plain ES5 (Cast devices run old Chrome). UMD-ish: window.FlooredAudioMix in the browser,
 * module.exports in Node tests.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FlooredAudioMix = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---- Ducker ----
  // ports (timers default to the real globals; accessors are re-read on every use because the
  // WebAudio graph is built lazily after the first play):
  //   now()                    — seconds, monotonic (performance.now()/1000)
  //   gain()                   — the music AudioParam (musicGain.gain) or null
  //   gainTime()               — AudioContext.currentTime (sec) for scheduling ramps
  //   getVolume()/setVolume(v) — element-volume fallback when no gain param exists
  //   setTimeout / setInterval / clearInterval — injectable timers (tests drive a fake clock)
  // opts: settleNoDuck (0.9s), duckRampMs (70), restoreRampMs (220), fadeInMs (480), fadeInFrom (0.2)
  function createDucker(ports, opts) {
    ports = ports || {};
    opts = opts || {};
    var now = ports.now || function () { return Date.now() / 1000; };
    var gain = ports.gain || function () { return null; };
    var gainTime = ports.gainTime || function () { return 0; };
    var getVolume = ports.getVolume || function () { return 1; };
    var setVolume = ports.setVolume || function () {};
    var setTimeoutFn = ports.setTimeout || function (fn, ms) { return setTimeout(fn, ms); };
    var setIntervalFn = ports.setInterval || function (fn, ms) { return setInterval(fn, ms); };
    var clearIntervalFn = ports.clearInterval || function (id) { clearInterval(id); };

    var settleNoDuck = opts.settleNoDuck != null ? opts.settleNoDuck : 0.9;
    var duckRampMs = opts.duckRampMs != null ? opts.duckRampMs : 70;
    var restoreRampMs = opts.restoreRampMs != null ? opts.restoreRampMs : 220;
    var fadeInMs = opts.fadeInMs != null ? opts.fadeInMs : 480;
    var fadeInFrom = opts.fadeInFrom != null ? opts.fadeInFrom : 0.2;

    var playStartedAt = -1e9; // "never" → ducks allowed before any fadeIn (mock preview has no music)
    var duckToken = 0;
    var fallbackRamp = null;

    // Smooth volume ramp, no hard jump → no click/pop. WebAudio path: read the CURRENT value FIRST
    // (cancelling a mid-flight ramp snaps the param back to its pre-ramp value otherwise), cancel
    // pending automation, re-anchor at that value, then one linear ramp. Fallback path (graph not
    // built): step the element volume on a short interval; a newer ramp replaces an older one.
    function ramp(target, ms) {
      var dur = Math.max(0.02, ms / 1000);
      var g = gain();
      if (g) {
        var t = gainTime(), cur = g.value;
        g.cancelScheduledValues(t);
        g.setValueAtTime(cur, t);
        g.linearRampToValueAtTime(target, t + dur);
        return;
      }
      if (fallbackRamp) { clearIntervalFn(fallbackRamp); fallbackRamp = null; }
      var from = getVolume(), t0 = now();
      fallbackRamp = setIntervalFn(function () {
        var k = Math.min(1, (now() - t0) / dur);
        setVolume(Math.max(0, Math.min(1, from + (target - from) * k)));
        if (k >= 1 && fallbackRamp) { clearIntervalFn(fallbackRamp); fallbackRamp = null; }
      }, 16);
    }

    // Start playback with the music quiet, then ramp to full — establishes the track smoothly
    // instead of popping in over a still-settling clip. Opens the settle window during which duck()
    // is a no-op (early feedback must not "take over" before the track is established).
    function fadeIn() {
      playStartedAt = now();
      var g = gain();
      if (g) {
        var t = gainTime();
        g.cancelScheduledValues(t);
        g.setValueAtTime(fadeInFrom, t);
      } else {
        setVolume(fadeInFrom);
      }
      ramp(1.0, fadeInMs);
    }

    // Brief duck for a prominent feedback moment. ALWAYS restores to full, and the latest duck wins
    // (an older duck's pending restore is dropped via the token), so rapid feedback can never leave
    // the music stuck quiet. Returns false when suppressed by the settle window.
    function duck(level, holdSeconds) {
      if (now() - playStartedAt <= settleNoDuck) return false;
      ramp(level, duckRampMs);
      duckToken += 1;
      var token = duckToken;
      setTimeoutFn(function () { if (token === duckToken) ramp(1.0, restoreRampMs); }, holdSeconds * 1000);
      return true;
    }

    return { fadeIn: fadeIn, duck: duck, ramp: ramp };
  }

  // ---- Sync guard ----
  // Video mode: the silent clip is the master clock; the catalog mp3 follows. Re-seeking the mp3 is
  // AUDIBLE (the decoder mutes for ~100–400ms while it lands), so corrections must be rare events,
  // never a per-frame reflex. check() is called every animation frame and returns the time to seek
  // the audio to, or null. opts: threshold (0.3s), settleSeconds (1.5), cooldownSeconds (1.2).
  function createSyncGuard(opts) {
    opts = opts || {};
    var threshold = opts.threshold != null ? opts.threshold : 0.3;
    var settleSeconds = opts.settleSeconds != null ? opts.settleSeconds : 1.5;
    var cooldownSeconds = opts.cooldownSeconds != null ? opts.cooldownSeconds : 1.2;
    var lastSeekAt = -1e9;

    // s: { enabled, sincePlay, audioTime, videoTime, seeking, now }
    function check(s) {
      if (!s || !s.enabled) return null;
      if (s.sincePlay != null && s.sincePlay <= settleSeconds) return null; // decoders still settling
      if (s.seeking) return null;                       // a seek is in flight — let it land first
      if (s.now - lastSeekAt < cooldownSeconds) return null; // rate-limit audible corrections
      if (Math.abs((s.audioTime || 0) - (s.videoTime || 0)) <= threshold) return null;
      lastSeekAt = s.now;
      return s.videoTime || 0;
    }

    function reset() { lastSeekAt = -1e9; } // new round → allowed to correct right after its settle

    return { check: check, reset: reset };
  }

  return { createDucker: createDucker, createSyncGuard: createSyncGuard };
}));
