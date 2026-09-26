const FEEDBACK = {
  selection: { haptic: "selection", tones: [[620, 0.025, 0]] },
  recordStart: { haptic: "medium", tones: [[760, 0.045, 0]] },
  recordStop: { haptic: "light", tones: [[440, 0.05, 0]] },
  success: { haptic: "success", tones: [[660, 0.045, 0], [880, 0.065, 0.055]] },
  error: { haptic: "error", tones: [[220, 0.06, 0], [180, 0.08, 0.07]] }
};

let audioContext = null;

export function performNativeFeedback(kind, win = globalThis.window) {
  if (!win || !isNativeRuntime(win)) return false;
  const feedback = FEEDBACK[kind] || FEEDBACK.selection;
  void playHaptic(win, feedback.haptic);
  playTones(win, feedback.tones);
  return true;
}

function isNativeRuntime(win) {
  try {
    return win.__VB_CONFIG?.nativeApp === true
      || win.Capacitor?.isNativePlatform?.() === true;
  } catch {
    return false;
  }
}

async function playHaptic(win, haptic) {
  const plugin = win.Capacitor?.Plugins?.Haptics;
  if (!plugin) {
    win.navigator?.vibrate?.(haptic === "error" ? [25, 35, 25] : 18);
    return;
  }
  try {
    if (haptic === "selection" && plugin.selectionChanged) {
      await plugin.selectionChanged();
    } else if ((haptic === "success" || haptic === "error") && plugin.notification) {
      await plugin.notification({ type: haptic.toUpperCase() });
    } else if (plugin.impact) {
      await plugin.impact({ style: haptic.toUpperCase() });
    }
  } catch {
    // Feedback must never interrupt recording, pairing, or sending.
  }
}

function playTones(win, tones) {
  const AudioContextCtor = win.AudioContext || win.webkitAudioContext;
  if (!AudioContextCtor) return;
  try {
    audioContext ||= new AudioContextCtor();
    void audioContext.resume?.();
    const start = audioContext.currentTime + 0.005;
    for (const [frequency, duration, offset] of tones) {
      const oscillator = audioContext.createOscillator();
      const gain = audioContext.createGain();
      oscillator.type = "sine";
      oscillator.frequency.setValueAtTime(frequency, start + offset);
      gain.gain.setValueAtTime(0.0001, start + offset);
      gain.gain.exponentialRampToValueAtTime(0.035, start + offset + 0.008);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + offset + duration);
      oscillator.connect(gain);
      gain.connect(audioContext.destination);
      oscillator.start(start + offset);
      oscillator.stop(start + offset + duration + 0.01);
    }
  } catch {
    // Some iOS audio sessions reject a first resume; haptics still work.
  }
}
