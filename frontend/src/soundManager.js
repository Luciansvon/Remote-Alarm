// Web Audio API Sound Synthesizer & Voice Recorder Player

const AUDIO_DATA_URL_REGEX = /^data:audio\/(webm|ogg|mp3|mpeg|wav|mp4|aac|x-m4a);base64,[A-Za-z0-9+/=]+$/i;

export function sanitizeVoiceDataUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return null;
  const trimmed = rawUrl.trim();
  return AUDIO_DATA_URL_REGEX.test(trimmed) ? trimmed : null;
}

class AlarmSoundManager {
  constructor() {
    this.audioCtx = null;
    this.isPlaying = false;
    this.intervalId = null;
    this.oscillators = [];
    this.gainNode = null;
    this.customAudioEl = null;
  }

  initContext() {
    if (!this.audioCtx) {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      this.audioCtx = new AudioContext();
    }
    if (this.audioCtx.state === 'suspended') {
      this.audioCtx.resume();
    }
  }

  play(soundType = 'siren', volumePercent = 100, voiceDataUrl = null) {
    this.stop();
    this.isPlaying = true;

    // Jika menggunakan rekaman suara kustom Bima atau file audio TikTok / MP3
    if ((soundType === 'voice' || soundType === 'tiktok' || soundType === 'custom_audio') && voiceDataUrl) {
      const safeAudioUrl = sanitizeVoiceDataUrl(voiceDataUrl);
      if (safeAudioUrl) {
        try {
          this.customAudioEl = new Audio(safeAudioUrl);
          this.customAudioEl.loop = true;
          this.customAudioEl.volume = Math.min(Math.max(volumePercent / 100, 0.1), 1.0);
          this.customAudioEl.play().catch(e => console.error("Gagal putar suara custom:", e));
          return;
        } catch (err) {
          console.error("Audio tag error:", err);
        }
      } else {
        console.warn("AUD-04: Audio Data URI tidak valid atau berisiko, mengalihkan pemutaran ke sirine bawaan.");
      }
    }

    // Menggunakan synthesizer Web Audio API untuk suara bawaan
    this.initContext();
    const volume = Math.min(Math.max(volumePercent / 100, 0.1), 1.0);

    this.gainNode = this.audioCtx.createGain();
    this.gainNode.gain.setValueAtTime(volume, this.audioCtx.currentTime);
    this.gainNode.connect(this.audioCtx.destination);

    if (soundType === 'siren') {
      this.playSiren();
    } else if (soundType === 'alarm_clock') {
      this.playClockBeeps();
    } else if (soundType === 'military') {
      this.playMilitaryKlaxon();
    } else {
      this.playSiren();
    }
  }

  playSiren() {
    const osc = this.audioCtx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(600, this.audioCtx.currentTime);
    osc.connect(this.gainNode);
    osc.start();
    this.oscillators.push(osc);

    const sweep = () => {
      if (!this.isPlaying) return;
      const now = this.audioCtx.currentTime;
      osc.frequency.exponentialRampToValueAtTime(1200, now + 0.4);
      osc.frequency.exponentialRampToValueAtTime(600, now + 0.8);
    };

    sweep();
    this.intervalId = setInterval(sweep, 800);
  }

  playClockBeeps() {
    const beep = () => {
      if (!this.isPlaying) return;
      const osc = this.audioCtx.createOscillator();
      const beepGain = this.audioCtx.createGain();
      
      osc.type = 'square';
      osc.frequency.value = 1400;
      
      beepGain.gain.setValueAtTime(1, this.audioCtx.currentTime);
      beepGain.gain.exponentialRampToValueAtTime(0.001, this.audioCtx.currentTime + 0.08);

      osc.connect(beepGain);
      beepGain.connect(this.gainNode);

      osc.start();
      osc.stop(this.audioCtx.currentTime + 0.09);
    };

    this.intervalId = setInterval(() => {
      beep();
    }, 130);
  }

  playMilitaryKlaxon() {
    const blast = () => {
      if (!this.isPlaying) return;
      const osc1 = this.audioCtx.createOscillator();
      const osc2 = this.audioCtx.createOscillator();
      const blastGain = this.audioCtx.createGain();

      osc1.type = 'sawtooth';
      osc2.type = 'sawtooth';

      osc1.frequency.setValueAtTime(440, this.audioCtx.currentTime);
      osc2.frequency.setValueAtTime(554.37, this.audioCtx.currentTime);

      blastGain.gain.setValueAtTime(1, this.audioCtx.currentTime);
      blastGain.gain.exponentialRampToValueAtTime(0.01, this.audioCtx.currentTime + 0.6);

      osc1.connect(blastGain);
      osc2.connect(blastGain);
      blastGain.connect(this.gainNode);

      osc1.start();
      osc2.start();
      osc1.stop(this.audioCtx.currentTime + 0.65);
      osc2.stop(this.audioCtx.currentTime + 0.65);
    };

    blast();
    this.intervalId = setInterval(blast, 900);
  }

  stop() {
    this.isPlaying = false;
    if (this.customAudioEl) {
      try {
        this.customAudioEl.pause();
        this.customAudioEl.currentTime = 0;
      } catch (e) {}
      this.customAudioEl = null;
    }
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.oscillators.forEach(osc => {
      try {
        osc.stop();
        osc.disconnect();
      } catch (e) {}
    });
    this.oscillators = [];

    // Istirahatkan AudioContext untuk menghemat baterai saat alarm mati
    if (this.audioCtx && this.audioCtx.state === 'running') {
      try {
        this.audioCtx.suspend();
      } catch (e) {}
    }
  }
}

export const soundManager = new AlarmSoundManager();
