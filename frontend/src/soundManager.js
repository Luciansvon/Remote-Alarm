// Web Audio API Sound Synthesizer & Voice Recorder Player
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
      try {
        this.customAudioEl = new Audio(voiceDataUrl);
        this.customAudioEl.loop = true;
        this.customAudioEl.volume = Math.min(Math.max(volumePercent / 100, 0.1), 1.0);
        this.customAudioEl.play().catch(e => console.error("Gagal putar suara custom:", e));
        return;
      } catch (err) {
        console.error("Audio tag error:", err);
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

    const now = this.audioCtx.currentTime;
    for (let i = 0; i < 60; i++) {
      const t = now + i * 0.8;
      osc.frequency.exponentialRampToValueAtTime(1200, t + 0.4);
      osc.frequency.exponentialRampToValueAtTime(600, t + 0.8);
    }

    osc.connect(this.gainNode);
    osc.start();
    this.oscillators.push(osc);
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

    let counter = 0;
    this.intervalId = setInterval(() => {
      beep();
      counter++;
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
  }
}

export const soundManager = new AlarmSoundManager();
