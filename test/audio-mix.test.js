/*
 * Simulation tests for the receiver's audio-mix policies (audio-mix.js).
 * Run:  node --test receiver/test/
 *
 * Why these exist: "casting: the music ducks and is almost never heard after the beginning, the
 * feedback effects keep sounding." Two mechanisms can produce that on the TV, and both are pinned
 * here against fake clocks — no DOM, no Chromecast:
 *
 *   1. The duck/restore envelope (createDucker). A rapid feedback storm must never leave the music
 *      stuck quiet: the gain may dip to the duck floor (0.7) but must ALWAYS return to 1.0.
 *      FakeAudioParam implements real Web Audio automation semantics (setValueAtTime /
 *      linearRampToValueAtTime / cancelScheduledValues, value computed from the event timeline), so
 *      the tests assert the actual envelope, not just that callbacks fired.
 *
 *   2. The video-mode re-seek policy (createSyncGuard). The old per-frame `drift > 0.3 → re-seek`
 *      turned into a 60fps seek storm once a seek was in flight (audio.currentTime lags the
 *      assignment, so the drift test stayed true and every frame restarted the seek) — the mp3 was
 *      effectively muted for the rest of the round. The "old vs new" test below reproduces that
 *      numerically on a small device model: the old policy is mid-seek ~100% of the time after the
 *      first drift event ("almost never heard after the beginning"); the guard corrects in 1–3
 *      audible events.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createDucker, createSyncGuard } = require('../audio-mix.js');

// ---------- fakes ----------

/** Deterministic clock owning timers; advance() runs due callbacks in time order. */
class FakeClock {
  constructor() { this.now = 0; this.timers = []; this.nextId = 1; }
  setTimeout(fn, ms) { const id = this.nextId++; this.timers.push({ id, due: this.now + ms / 1000, fn, repeatMs: null }); return id; }
  setInterval(fn, ms) { const id = this.nextId++; this.timers.push({ id, due: this.now + ms / 1000, fn, repeatMs: ms }); return id; }
  clearInterval(id) { this.timers = this.timers.filter((t) => t.id !== id); }
  advance(seconds) {
    const target = this.now + seconds;
    for (;;) {
      const due = this.timers.filter((t) => t.due <= target).sort((a, b) => a.due - b.due)[0];
      if (!due) break;
      this.now = Math.max(this.now, due.due);
      if (due.repeatMs != null) due.due += due.repeatMs / 1000;
      else this.timers = this.timers.filter((t) => t !== due);
      due.fn();
    }
    this.now = target;
  }
}

/**
 * AudioParam with real automation semantics. cancelScheduledValues removes only FUTURE events, so
 * the event list doubles as the full gain history — valueAt(t) can sample the whole envelope after
 * a simulation.
 */
class FakeAudioParam {
  constructor(clock, initial = 1) { this.clock = clock; this.initial = initial; this.events = []; }
  setValueAtTime(v, t) { this._insert({ type: 'set', time: t, value: v }); }
  linearRampToValueAtTime(v, t) { this._insert({ type: 'ramp', time: t, value: v }); }
  cancelScheduledValues(t) { this.events = this.events.filter((e) => e.time < t); }
  _insert(e) { this.events.push(e); this.events.sort((a, b) => a.time - b.time); }
  get value() { return this.valueAt(this.clock.now); }
  valueAt(t) {
    let prev = { time: 0, value: this.initial };
    for (const e of this.events) {
      if (e.time <= t) { prev = e; continue; }
      if (e.type === 'ramp') {
        const span = e.time - prev.time;
        if (span <= 0) return e.value;
        const k = Math.min(1, Math.max(0, (t - prev.time) / span));
        return prev.value + (e.value - prev.value) * k;
      }
      break; // next event is a future 'set' → hold prev until it
    }
    return prev.value;
  }
}

function makeDucker(clock, param, opts) {
  return createDucker({
    now: () => clock.now,
    gain: () => param,
    gainTime: () => clock.now,
    setTimeout: (fn, ms) => clock.setTimeout(fn, ms),
    setInterval: (fn, ms) => clock.setInterval(fn, ms),
    clearInterval: (id) => clock.clearInterval(id),
  }, opts);
}

function sampleStats(param, from, to, step = 0.01) {
  let min = Infinity, sum = 0, n = 0;
  for (let t = from; t <= to; t += step) {
    const v = param.valueAt(t);
    min = Math.min(min, v);
    sum += v; n += 1;
  }
  return { min, mean: sum / n };
}

/** Deterministic PRNG (mulberry32) so the storm test never flakes. */
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- ducker: WebAudio gain path ----------

test('fade-in establishes the music from 0.2 to full', (t) => {
  const clock = new FakeClock();
  const param = new FakeAudioParam(clock);
  const ducker = makeDucker(clock, param);
  ducker.fadeIn();
  clock.advance(1.0);
  assert.ok(Math.abs(param.valueAt(0.001) - 0.2) < 0.02, 'starts quiet');
  assert.ok(param.valueAt(0.24) > 0.2 && param.valueAt(0.24) < 1, 'ramping up');
  assert.equal(param.valueAt(0.6), 1, 'fully established by 480ms');
});

test('single duck dips to the level and always restores to full', (t) => {
  const clock = new FakeClock();
  const param = new FakeAudioParam(clock);
  const ducker = makeDucker(clock, param);
  ducker.fadeIn();
  clock.advance(2.0);
  assert.equal(ducker.duck(0.7, 0.4), true);
  clock.advance(1.5);
  assert.ok(Math.abs(param.valueAt(2.08) - 0.7) < 0.02, 'ducked within ~70ms');
  assert.ok(Math.abs(param.valueAt(2.39) - 0.7) < 0.02, 'held for the hold window');
  assert.equal(param.valueAt(2.7), 1, 'restored to FULL (2.0 + hold 0.4 + ramp 0.22)');
  assert.ok(sampleStats(param, 2.0, 3.5).min >= 0.7 - 1e-9, 'never below the duck floor');
});

test('settle window: ducks are ignored for ~0.9s after play so the track establishes', (t) => {
  const clock = new FakeClock();
  const param = new FakeAudioParam(clock);
  const ducker = makeDucker(clock, param);
  ducker.fadeIn();
  clock.advance(0.5);
  assert.equal(ducker.duck(0.7, 0.4), false, 'suppressed during settle');
  clock.advance(0.39); // t = 0.89 ≤ 0.9
  assert.equal(ducker.duck(0.7, 0.4), false, 'still suppressed at the boundary');
  clock.advance(1.0);
  assert.equal(param.valueAt(0.6), 1, 'fade-in completed untouched');
  assert.equal(ducker.duck(0.7, 0.4), true, 'allowed after settle');
});

test('duck with no prior fade-in is allowed (mock preview)', (t) => {
  const clock = new FakeClock();
  const param = new FakeAudioParam(clock);
  const ducker = makeDucker(clock, param);
  clock.advance(5);
  assert.equal(ducker.duck(0.8, 0.25), true);
});

test('latest duck wins: an older restore never fires under a newer hold', (t) => {
  const clock = new FakeClock();
  const param = new FakeAudioParam(clock);
  const ducker = makeDucker(clock, param);
  ducker.fadeIn();
  clock.advance(2.0);
  ducker.duck(0.7, 0.4);   // restore would fire at 2.40
  clock.advance(0.1);
  ducker.duck(0.8, 0.25);  // newer: restore at 2.35 → ramps to 1.0 by ~2.57
  clock.advance(2.0);
  // After the newer restore begins, the envelope must rise monotonically — the older duck's timer
  // (2.40, mid-restore) must be a dropped no-op, not a re-ramp.
  for (let t1 = 2.36; t1 < 2.56; t1 += 0.01) {
    assert.ok(param.valueAt(t1 + 0.01) >= param.valueAt(t1) - 1e-9, `monotonic restore at ${t1.toFixed(2)}`);
  }
  assert.equal(param.valueAt(2.7), 1, 'fully restored');
});

test('feedback storm: music never sticks quiet and always returns to full', (t) => {
  const clock = new FakeClock();
  const param = new FakeAudioParam(clock);
  const ducker = makeDucker(clock, param);
  const rand = prng(42);
  ducker.fadeIn();
  clock.advance(1.2);
  let lastDuckAt = 0;
  // ~60 gold/perfect moments over 30s — a hot 2-player round's worth of prominent feedback.
  while (clock.now < 31) {
    const gold = rand() < 0.4;
    ducker.duck(gold ? 0.7 : 0.8, gold ? 0.4 : 0.25);
    lastDuckAt = clock.now;
    clock.advance(0.4 + rand() * 0.4);
  }
  clock.advance(1.0);
  const storm = sampleStats(param, 1.2, lastDuckAt);
  assert.ok(storm.min >= 0.7 - 1e-9, `floor respected (min ${storm.min.toFixed(3)})`);
  assert.ok(storm.mean >= 0.75, `music stays audible through the storm (mean ${storm.mean.toFixed(3)})`);
  assert.equal(param.valueAt(lastDuckAt + 0.7), 1, 'back to FULL within 0.7s of the last duck');
});

// ---------- ducker: element-volume fallback path (no WebAudio graph) ----------

test('fallback path (no graph): same floor + always-restores invariants via element volume', (t) => {
  const clock = new FakeClock();
  let vol = 1;
  const samples = [];
  const ducker = createDucker({
    now: () => clock.now,
    gain: () => null,
    getVolume: () => vol,
    setVolume: (v) => { vol = v; samples.push({ t: clock.now, v }); },
    setTimeout: (fn, ms) => clock.setTimeout(fn, ms),
    setInterval: (fn, ms) => clock.setInterval(fn, ms),
    clearInterval: (id) => clock.clearInterval(id),
  });
  const rand = prng(7);
  ducker.fadeIn();
  clock.advance(1.2);
  while (clock.now < 16) {
    ducker.duck(rand() < 0.4 ? 0.7 : 0.8, rand() < 0.4 ? 0.4 : 0.25);
    clock.advance(0.4 + rand() * 0.4);
  }
  clock.advance(1.0);
  const after = samples.filter((s) => s.t > 1.2);
  assert.ok(after.length > 50, 'fallback interval actually ramped');
  assert.ok(Math.min(...after.map((s) => s.v)) >= 0.7 - 1e-9, 'floor respected');
  assert.equal(vol, 1, 'restored to FULL after the storm');
});

// ---------- sync guard: the video-mode re-seek policy ----------

const guardInput = (over) => Object.assign({
  enabled: true, sincePlay: 5, audioTime: 10, videoTime: 10, seeking: false, now: 5,
}, over);

test('sync guard: no correction under the drift threshold / while settling / while paused', (t) => {
  const g = createSyncGuard();
  assert.equal(g.check(guardInput({ audioTime: 10.29 })), null, 'under threshold');
  assert.equal(g.check(guardInput({ audioTime: 11, sincePlay: 1.0 })), null, 'settling');
  assert.equal(g.check(guardInput({ audioTime: 11, enabled: false })), null, 'paused');
});

test('sync guard: corrects once, never re-seeks while a seek is in flight, respects the cooldown', (t) => {
  const g = createSyncGuard({ cooldownSeconds: 1.2 });
  assert.equal(g.check(guardInput({ audioTime: 11, now: 5 })), 10, 'seeks to the video time');
  // The exact storm condition: the seek hasn't landed, drift still reads huge.
  assert.equal(g.check(guardInput({ audioTime: 11, now: 5.016, seeking: true })), null, 'in flight → wait');
  assert.equal(g.check(guardInput({ audioTime: 11, now: 5.5 })), null, 'landed but inside cooldown');
  assert.equal(g.check(guardInput({ audioTime: 11, now: 6.3 })), 10, 'cooldown over + still drifted → correct again');
});

test('seek storm, old vs new: the old per-frame policy mutes the music after the first drift; the guard does not', (t) => {
  // Device model: video advances in real time; the audio decoder freezes its reported currentTime
  // while a seek is in flight and lands 0.3s after the LAST seek command (re-seeking restarts the
  // landing — that is what cast hardware does and what made the storm self-sustaining). The decoder
  // hiccups at t=4 and t=7 (currentTime falls 0.5s behind) — once per ~3s, a realistic stutter rate.
  function simulate(policy) {
    const dt = 1 / 60;
    let audioTime = 0, seeking = false, landAt = 0, pendingTarget = 0;
    let seeks = 0, seekingFrames = 0, framesAfterFirstHiccup = 0, seekingAfterFirstHiccup = 0;
    for (let now = 0; now < 10; now += dt) {
      const videoTime = now;
      if (seeking && now >= landAt) { seeking = false; audioTime = pendingTarget; }
      if (!seeking) audioTime += dt;
      if (Math.abs(now - 4) < dt / 2 || Math.abs(now - 7) < dt / 2) audioTime -= 0.5; // hiccup
      const target = policy({ now, sincePlay: now, audioTime, videoTime, seeking });
      if (target != null) { seeks += 1; seeking = true; landAt = now + 0.3; pendingTarget = target; }
      if (seeking) seekingFrames += 1;
      if (now >= 4) { framesAfterFirstHiccup += 1; if (seeking) seekingAfterFirstHiccup += 1; }
    }
    return { seeks, mutedFraction: seekingFrames * dt / 10, mutedAfterHiccup: seekingAfterFirstHiccup / framesAfterFirstHiccup };
  }

  // The pre-fix policy, verbatim: every frame, past settle, drift > 0.3 → re-seek. No guards.
  const old = simulate((s) => (s.sincePlay > 1.5 && Math.abs(s.audioTime - s.videoTime) > 0.3) ? s.videoTime : null);
  // The new policy.
  const g = createSyncGuard({ threshold: 0.3, settleSeconds: 1.5, cooldownSeconds: 1.2 });
  const fixed = simulate((s) => g.check(Object.assign({ enabled: true }, s)));

  // Old: the first hiccup starts a self-sustaining seek storm — the mp3 is mid-seek (muted) for the
  // REST OF THE ROUND. This is the reported bug: "music almost never heard after the beginning."
  assert.ok(old.seeks > 100, `old policy seek storm (${old.seeks} seeks in 10s)`);
  assert.ok(old.mutedAfterHiccup > 0.95, `old policy mutes the round after the first drift (${(old.mutedAfterHiccup * 100).toFixed(0)}% muted)`);
  // New: a couple of brief, audible corrections.
  assert.ok(fixed.seeks <= 3, `guard corrects sparingly (${fixed.seeks} seeks)`);
  assert.ok(fixed.mutedFraction < 0.1, `music plays ≥90% of the round (${((1 - fixed.mutedFraction) * 100).toFixed(0)}% audible)`);
});
