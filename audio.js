/* Sound, synthesised on the fly.

   Every effect is generated with the Web Audio API — there are no audio files
   to download, so the arcade still works offline and from a file:// page.

   Browsers refuse to start audio until the user has interacted with the page,
   so the context is created lazily on the first sound and resumed if it has
   been suspended. Everything degrades to silence when Web Audio is missing
   (as it is under a test harness), rather than throwing. */

const audio = (() => {
  let ctx = null;
  let master = null;
  let noiseBuffer = null;
  let enabled = storage.get('sound-on', true) !== false;

  function context() {
    if (ctx === null) {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      if (!Ctor) { ctx = false; return null; }   // false = checked, unavailable
      try {
        ctx = new Ctor();
        master = ctx.createGain();
        master.gain.value = enabled ? 0.5 : 0;
        master.connect(ctx.destination);
      } catch {
        ctx = false;
        return null;
      }
    }
    if (!ctx) return null;
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    return ctx;
  }

  /* Browsers create the context suspended and only let it start inside a user
     gesture. A continuous sound like the engine never calls back into
     context(), so without this it would stay silent forever: the first click,
     key or touch anywhere on the page resumes it. */
  function unlock() {
    const c = ctx;
    if (c && c.state === 'suspended') c.resume().catch(() => {});
  }

  if (typeof window !== 'undefined' && window.addEventListener) {
    for (const type of ['pointerdown', 'keydown', 'touchstart']) {
      window.addEventListener(type, unlock, { capture: true });
    }
  }

  function noise(c) {
    if (!noiseBuffer) {
      const frames = c.sampleRate * 0.6;
      noiseBuffer = c.createBuffer(1, frames, c.sampleRate);
      const data = noiseBuffer.getChannelData(0);
      // A fixed pseudo-random fill; no need for real randomness here.
      let seed = 22222;
      for (let i = 0; i < frames; i++) {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        data[i] = (seed / 0x3fffffff) - 1;
      }
    }
    return noiseBuffer;
  }

  // One shaped oscillator note.
  function tone({ freq, to, dur = 0.14, type = 'sine', gain = 0.25, delay = 0 }) {
    const c = context();
    if (!c || !enabled) return;

    const t = c.currentTime + delay;
    const osc = c.createOscillator();
    const amp = c.createGain();

    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (to && to !== freq) osc.frequency.exponentialRampToValueAtTime(Math.max(20, to), t + dur);

    amp.gain.setValueAtTime(0.0001, t);
    amp.gain.exponentialRampToValueAtTime(gain, t + Math.min(0.02, dur * 0.2));
    amp.gain.exponentialRampToValueAtTime(0.0001, t + dur);

    osc.connect(amp);
    amp.connect(master);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  // A burst of filtered noise — impacts, scrapes.
  function hiss({ dur = 0.2, gain = 0.25, freq = 1200, type = 'bandpass', delay = 0 }) {
    const c = context();
    if (!c || !enabled) return;

    const t = c.currentTime + delay;
    const src = c.createBufferSource();
    const filter = c.createBiquadFilter();
    const amp = c.createGain();

    src.buffer = noise(c);
    filter.type = type;
    filter.frequency.value = freq;
    amp.gain.setValueAtTime(gain, t);
    amp.gain.exponentialRampToValueAtTime(0.0001, t + dur);

    src.connect(filter);
    filter.connect(amp);
    amp.connect(master);
    src.start(t);
    src.stop(t + dur);
  }

  const notes = (list, step = 0.09, opts = {}) => {
    list.forEach((freq, i) => tone({ freq, dur: 0.16, type: 'triangle', delay: i * step, ...opts }));
  };

  const EFFECTS = {
    click: () => tone({ freq: 420, to: 300, dur: 0.06, type: 'square', gain: 0.13 }),
    place: () => tone({ freq: 540, to: 380, dur: 0.09, type: 'triangle', gain: 0.2 }),
    drop: () => tone({ freq: 300, to: 130, dur: 0.18, type: 'sine', gain: 0.26 }),
    flip: () => tone({ freq: 700, to: 900, dur: 0.07, type: 'sine', gain: 0.16 }),
    match: () => notes([660, 990], 0.08),
    miss: () => tone({ freq: 220, to: 160, dur: 0.16, type: 'sawtooth', gain: 0.14 }),
    eat: () => tone({ freq: 620, to: 940, dur: 0.09, type: 'square', gain: 0.16 }),
    win: () => notes([523, 659, 784, 1047], 0.1),
    lose: () => notes([392, 330, 262], 0.13, { type: 'sawtooth', gain: 0.18 }),
    draw: () => notes([440, 415], 0.12),
    step: () => hiss({ dur: 0.07, freq: 260, gain: 0.09, type: 'lowpass' }),
    /* A gunshot.

       Two dials, because the two things that shape a report are not the same
       thing. `heft` is how substantial the weapon is overall — it decides how
       far the crack is pitched down and how long it rings. `punch` is how hard
       the round hits, and it alone decides whether there is a boom under the
       shot at all.

       The boom is deliberately small: a short low sine you feel more than hear,
       with a soft slap off the walls behind it. Loud enough that a hard-hitting
       gun is unmistakable, quiet enough that firing one repeatedly does not
       wear you out. Across the whole range the shot roughly doubles in volume
       rather than trebling. */
    shot: (heft = 0, punch = 0) => {
      const w = Math.max(0, Math.min(1, heft));
      const hit = Math.max(0, Math.min(1, punch));

      // The crack. Bright and brief when light, dull and drawn out when heavy.
      hiss({
        dur: 0.05 + w * 0.09,
        freq: 3600 - w * 2500,
        gain: 0.19 + w * 0.09,
        type: w > 0.5 ? 'lowpass' : 'highpass',
      });

      // The report under it: further to fall, and longer about it, with weight.
      tone({
        freq: 320 - w * 215,
        to: 70 - w * 34,
        dur: 0.11 + w * 0.26,
        type: w > 0.45 ? 'sawtooth' : 'square',
        gain: 0.17 + w * 0.11,
      });

      // Only a gun that hits hard gets a boom, and only a small one.
      if (hit > 0.2) {
        tone({ freq: 96 - hit * 46, to: 34, dur: 0.15 + hit * 0.18, type: 'sine', gain: 0.07 + hit * 0.15 });
        hiss({
          dur: 0.2 + hit * 0.28,
          freq: 340,
          gain: 0.025 + hit * 0.055,
          type: 'lowpass',
          delay: 0.05 + hit * 0.04,
        });
      }
    },
    impact: () => hiss({ dur: 0.11, freq: 700, gain: 0.2, type: 'bandpass' }),
    hurt: () => {
      tone({ freq: 170, to: 90, dur: 0.22, type: 'sawtooth', gain: 0.2 });
      hiss({ dur: 0.18, freq: 420, gain: 0.16, type: 'lowpass' });
    },
    // Something large going down: a long descending howl.
    slain: () => {
      tone({ freq: 420, to: 48, dur: 0.9, type: 'sawtooth', gain: 0.26 });
      tone({ freq: 300, to: 40, dur: 1, type: 'triangle', gain: 0.18, delay: 0.06 });
      hiss({ dur: 0.7, freq: 300, gain: 0.16, type: 'lowpass' });
    },
    caught: () => {
      tone({ freq: 320, to: 60, dur: 0.7, type: 'sawtooth', gain: 0.34 });
      tone({ freq: 190, to: 44, dur: 0.8, type: 'square', gain: 0.2, delay: 0.04 });
      hiss({ dur: 0.6, freq: 900, gain: 0.3, type: 'bandpass' });
    },
    beep: () => tone({ freq: 440, dur: 0.16, type: 'square', gain: 0.2 }),
    go: () => { tone({ freq: 880, dur: 0.3, type: 'square', gain: 0.24 }); hiss({ dur: 0.25, freq: 2400, gain: 0.1 }); },
    crash: () => { tone({ freq: 150, to: 50, dur: 0.3, type: 'sawtooth', gain: 0.3 }); hiss({ dur: 0.3, freq: 700, gain: 0.3, type: 'lowpass' }); },
    finish: () => notes([523, 659, 784, 1047, 1319], 0.11),
  };

  function play(name, ...args) {
    const effect = EFFECTS[name];
    if (effect && enabled) effect(...args);
  }

  /* The sound of a car in motion: an engine note whose pitch and brightness
     follow road speed, layered with rushing road/wind noise that rises with
     it. Both fall silent when the car is stopped. Returns a no-op controller
     when audio is unavailable, so callers never have to check. */
  function engine() {
    const c = context();
    if (!c) return { set() {}, stop() {} };

    const low = c.createOscillator();
    const high = c.createOscillator();
    const filter = c.createBiquadFilter();
    const amp = c.createGain();

    low.type = 'sawtooth';
    high.type = 'square';
    filter.type = 'lowpass';
    filter.frequency.value = 600;
    amp.gain.value = 0;

    low.connect(filter);
    high.connect(filter);
    filter.connect(amp);
    amp.connect(master);
    low.start();
    high.start();

    // Road roar: looping noise, opened up as speed rises.
    const rush = c.createBufferSource();
    const rushFilter = c.createBiquadFilter();
    const rushAmp = c.createGain();

    rush.buffer = noise(c);
    rush.loop = true;
    rushFilter.type = 'bandpass';
    rushFilter.frequency.value = 500;
    rushFilter.Q.value = 0.7;
    rushAmp.gain.value = 0;

    rush.connect(rushFilter);
    rushFilter.connect(rushAmp);
    rushAmp.connect(master);
    rush.start();

    let stopped = false;

    return {
      set(load, throttle, scrub) {
        if (stopped) return;
        const t = c.currentTime;
        const rev = Math.min(2.2, load);
        const moving = Math.min(1, load * 1.6);

        low.frequency.setTargetAtTime(42 + rev * 95, t, 0.06);
        high.frequency.setTargetAtTime(21 + rev * 47, t, 0.06);
        filter.frequency.setTargetAtTime(420 + rev * 1500 + (throttle ? 350 : 0), t, 0.09);
        amp.gain.setTargetAtTime(enabled ? 0.03 + rev * 0.055 : 0, t, 0.08);

        // Grass is a coarser, louder scrape than tarmac.
        rushFilter.frequency.setTargetAtTime(scrub ? 900 : 420 + rev * 900, t, 0.12);
        rushAmp.gain.setTargetAtTime(
          enabled ? moving * (scrub ? 0.16 : 0.05) : 0, t, 0.1);
      },
      stop() {
        if (stopped) return;
        stopped = true;
        try {
          const t = c.currentTime;
          amp.gain.setTargetAtTime(0, t, 0.05);
          rushAmp.gain.setTargetAtTime(0, t, 0.05);
          low.stop(t + 0.2);
          high.stop(t + 0.2);
          rush.stop(t + 0.2);
        } catch { /* already stopped */ }
      },
    };
  }

  /* Something following you. A low drone with a pulse over it; both get
     louder, brighter and faster as whatever it is closes in, which tells you
     it is near before you can see it. */
  function stalker() {
    const c = context();
    if (!c) return { set() {}, stop() {} };

    const drone = c.createOscillator();
    const filter = c.createBiquadFilter();
    const amp = c.createGain();

    drone.type = 'sawtooth';
    drone.frequency.value = 38;
    filter.type = 'lowpass';
    filter.frequency.value = 160;
    amp.gain.value = 0;

    // A slow pulse riding on the gain — the heartbeat.
    const pulse = c.createOscillator();
    const pulseDepth = c.createGain();
    pulse.type = 'sine';
    pulse.frequency.value = 0.9;
    pulseDepth.gain.value = 0;
    pulse.connect(pulseDepth);
    pulseDepth.connect(amp.gain);

    drone.connect(filter);
    filter.connect(amp);
    amp.connect(master);
    drone.start();
    pulse.start();

    let stopped = false;

    return {
      // closeness runs 0 (far away or nothing there) to 1 (right behind you)
      set(closeness) {
        if (stopped) return;
        const t = c.currentTime;
        const near = Math.max(0, Math.min(1, closeness));
        amp.gain.setTargetAtTime(enabled ? near * 0.1 : 0, t, 0.15);
        pulseDepth.gain.setTargetAtTime(enabled ? near * 0.07 : 0, t, 0.15);
        pulse.frequency.setTargetAtTime(0.8 + near * 3.4, t, 0.25);
        filter.frequency.setTargetAtTime(140 + near * 620, t, 0.25);
        drone.frequency.setTargetAtTime(36 + near * 30, t, 0.25);
      },
      stop() {
        if (stopped) return;
        stopped = true;
        try {
          const t = c.currentTime;
          amp.gain.setTargetAtTime(0, t, 0.05);
          drone.stop(t + 0.25);
          pulse.stop(t + 0.25);
        } catch { /* already stopped */ }
      },
    };
  }

  return {
    get enabled() { return enabled; },
    available: () => Boolean(context()),
    play,
    engine,
    stalker,
    toggle() {
      enabled = !enabled;
      storage.set('sound-on', enabled);
      const c = context();
      if (c && master) master.gain.setTargetAtTime(enabled ? 0.5 : 0, c.currentTime, 0.02);
      if (enabled) play('click');
      return enabled;
    },
  };
})();
