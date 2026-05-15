// Shared Web Audio synthesis — used by both popup and content script.

let sharedAudioCtx: AudioContext | null = null;

function getAudioContext(): AudioContext {
  if (!sharedAudioCtx) {
    sharedAudioCtx = new AudioContext();
  }
  if (sharedAudioCtx.state === 'suspended') {
    sharedAudioCtx.resume();
  }
  return sharedAudioCtx;
}

// Beep: single square-wave pulse at 880 Hz.
function playBeep(ctx: AudioContext, vol: number) {
  const t = ctx.currentTime;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.connect(gain);
  gain.connect(ctx.destination);

  osc.type = 'square';
  osc.frequency.setValueAtTime(880, t);

  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(vol * 0.25, t + 0.02);
  gain.gain.setValueAtTime(vol * 0.25, t + 0.18);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);

  osc.start(t);
  osc.stop(t + 0.23);
}

// Chime: two ascending sine notes (C5 → E5).
function playChime(ctx: AudioContext, vol: number) {
  const t = ctx.currentTime;

  const osc1 = ctx.createOscillator();
  const g1 = ctx.createGain();
  osc1.connect(g1);
  g1.connect(ctx.destination);
  osc1.type = 'sine';
  osc1.frequency.setValueAtTime(523.25, t);
  g1.gain.setValueAtTime(0.0001, t);
  g1.gain.exponentialRampToValueAtTime(vol * 0.3, t + 0.02);
  g1.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
  osc1.start(t);
  osc1.stop(t + 0.22);

  const osc2 = ctx.createOscillator();
  const g2 = ctx.createGain();
  osc2.connect(g2);
  g2.connect(ctx.destination);
  osc2.type = 'sine';
  osc2.frequency.setValueAtTime(659.25, t + 0.15);
  g2.gain.setValueAtTime(0.0001, t + 0.15);
  g2.gain.exponentialRampToValueAtTime(vol * 0.3, t + 0.17);
  g2.gain.exponentialRampToValueAtTime(0.0001, t + 0.45);
  osc2.start(t + 0.15);
  osc2.stop(t + 0.47);
}

// Alert: urgent sawtooth double-pulse at 660 Hz.
function playAlert(ctx: AudioContext, vol: number) {
  const t = ctx.currentTime;

  const osc1 = ctx.createOscillator();
  const g1 = ctx.createGain();
  osc1.connect(g1);
  g1.connect(ctx.destination);
  osc1.type = 'sawtooth';
  osc1.frequency.setValueAtTime(660, t);
  g1.gain.setValueAtTime(0.0001, t);
  g1.gain.exponentialRampToValueAtTime(vol * 0.2, t + 0.01);
  g1.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
  osc1.start(t);
  osc1.stop(t + 0.13);

  const osc2 = ctx.createOscillator();
  const g2 = ctx.createGain();
  osc2.connect(g2);
  g2.connect(ctx.destination);
  osc2.type = 'sawtooth';
  osc2.frequency.setValueAtTime(660, t + 0.16);
  g2.gain.setValueAtTime(0.0001, t + 0.16);
  g2.gain.exponentialRampToValueAtTime(vol * 0.2, t + 0.17);
  g2.gain.exponentialRampToValueAtTime(0.0001, t + 0.28);
  osc2.start(t + 0.16);
  osc2.stop(t + 0.3);
}

// Bell: sine fundamental (800 Hz) + quiet 3rd-harmonic overtone, long decay.
function playBell(ctx: AudioContext, vol: number) {
  const t = ctx.currentTime;

  const osc1 = ctx.createOscillator();
  const g1 = ctx.createGain();
  osc1.connect(g1);
  g1.connect(ctx.destination);
  osc1.type = 'sine';
  osc1.frequency.setValueAtTime(800, t);
  g1.gain.setValueAtTime(0.0001, t);
  g1.gain.exponentialRampToValueAtTime(vol * 0.3, t + 0.01);
  g1.gain.exponentialRampToValueAtTime(0.0001, t + 0.6);
  osc1.start(t);
  osc1.stop(t + 0.62);

  const osc2 = ctx.createOscillator();
  const g2 = ctx.createGain();
  osc2.connect(g2);
  g2.connect(ctx.destination);
  osc2.type = 'sine';
  osc2.frequency.setValueAtTime(2400, t);
  g2.gain.setValueAtTime(0.0001, t);
  g2.gain.exponentialRampToValueAtTime(vol * 0.1, t + 0.005);
  g2.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
  osc2.start(t);
  osc2.stop(t + 0.32);
}

// Notification: three quick ascending triangle notes (G5 → B5 → D6).
function playNotification(ctx: AudioContext, vol: number) {
  const t = ctx.currentTime;
  const notes = [783.99, 987.77, 1174.66];

  notes.forEach((freq, i) => {
    const offset = i * 0.12;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(freq, t + offset);
    gain.gain.setValueAtTime(0.0001, t + offset);
    gain.gain.exponentialRampToValueAtTime(vol * 0.3, t + offset + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + offset + 0.12);
    osc.start(t + offset);
    osc.stop(t + offset + 0.14);
  });
}

// Main entry point — normalizes volume (0-100) and dispatches by type.
export function playSound(soundType: string, volume: number): void {
  const ctx = getAudioContext();
  const safeVol = Math.max(0, Math.min(100, volume)) / 100;

  switch (soundType) {
    case 'chime':
      playChime(ctx, safeVol);
      break;
    case 'bell':
      playBell(ctx, safeVol);
      break;
    case 'alert':
      playAlert(ctx, safeVol);
      break;
    case 'notification':
      playNotification(ctx, safeVol);
      break;
    case 'beep':
    default:
      playBeep(ctx, safeVol);
      break;
  }
}
