import { useState, useEffect, useRef } from 'react';
import { io } from 'socket.io-client';
import confetti from 'canvas-confetti';
import { 
  Bell, 
  Volume2, 
  Radio, 
  AlertTriangle, 
  CheckCircle2, 
  Clock,
  Mic, 
  Square, 
  Play, 
  Trash2,
  Calendar,
  Settings, 
  Zap,
  User,
  ShieldCheck,
  ListTodo,
  Upload,
  Pause
} from 'lucide-react';
import { Capacitor, registerPlugin } from '@capacitor/core';
import {
  soundManager,
  computeAudioId,
  saveCachedAudio,
  getCachedAudio,
  getCachedAudioList,
  deleteCachedAudio
} from './soundManager';

// Jembatan Native Android WakeMate (AUD-06)
const WakeMateNative = registerPlugin('WakeMateNative');

// ID perangkat stabil: server memakai ini untuk membedakan pengirim alarm
const getDeviceId = () => {
  try {
    const saved = localStorage.getItem('wakemate_device_id');
    if (saved) return saved;
    const id = window.crypto?.randomUUID
      ? window.crypto.randomUUID()
      : `dev-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    localStorage.setItem('wakemate_device_id', id);
    return id;
  } catch (_) {
    return `dev-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
};

const DEVICE_ID = getDeviceId();

// AUD-05: Konfigurasi URL server fleksibel dengan dukungan environment variable
const defaultServer = localStorage.getItem('wakemate_server') || (
  import.meta.env?.VITE_DEFAULT_SERVER_URL || (
    Capacitor.isNativePlatform() ? 'https://alarm.birescompanny.my.id' : `http://${window.location.hostname}:4000`
  )
);

const DEFAULT_CUSTOM_TEXTS = [
  'BANGUN SAYANG! ☀️',
  'ADA KULIAH / KERJA! ⏰',
  'TELPON AKU SEKARANG! 📞',
  'JANGAN TIDUR LAGI! 🛑'
];

const loadStoredSchedules = (room) => {
  try {
    const raw = localStorage.getItem(`wakemate_schedules_${room}`);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
};

export default function App() {
  // Pengaturan Kamar & Peran (AUD-01)
  const [roomId, setRoomId] = useState(() => localStorage.getItem('wakemate_room') || 'CINTA-BIMA');
  const [tempRoomId, setTempRoomId] = useState(() => roomId);
  // PIN tidak dibuat otomatis: kedua HP harus memakai PIN yang sama dan bisa dibaca pengguna
  const [roomPin, setRoomPin] = useState(() => localStorage.getItem('wakemate_pin') || '');
  const [tempRoomPin, setTempRoomPin] = useState(() => roomPin);
  const [authError, setAuthError] = useState(null);
  const [currentRole, setCurrentRole] = useState(() => localStorage.getItem('wakemate_role') || 'bima'); // 'bima', 'pacar', 'simulasi'
  const [batteryRestricted, setBatteryRestricted] = useState(false);

  // Pengaturan Server
  const [serverUrl, setServerUrl] = useState(defaultServer);
  const [tempServerUrl, setTempServerUrl] = useState(defaultServer);
  
  // Tab Navigasi Aktif: 'instant' | 'schedule' | 'list' | 'settings'
  const [activeTab, setActiveTab] = useState('instant');

  // Status Koneksi & Data
  const [isConnected, setIsConnected] = useState(false);
  const [scheduledAlarms, setScheduledAlarms] = useState(() => loadStoredSchedules(roomId));
  
  // Pengaturan Alarm
  const [selectedVolume, setSelectedVolume] = useState(100);
  const [selectedSound, setSelectedSound] = useState('siren'); // 'siren', 'alarm_clock', 'tiktok', 'voice'
  const [customMessage, setCustomMessage] = useState(() => localStorage.getItem('wakemate_custom_msg') || 'BANGUN SAYANG! UDAH SIANG!');
  const [customTexts, setCustomTexts] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('wakemate_custom_texts'));
      return Array.isArray(saved) && saved.length > 0 ? saved : DEFAULT_CUSTOM_TEXTS;
    } catch (_) {
      return DEFAULT_CUSTOM_TEXTS;
    }
  });
  const [receivedCustomText, setReceivedCustomText] = useState(null);
  const [missionRequired, setMissionRequired] = useState(true); // Wajib ketuk 3x

  // Jadwal Jam & Menit (default +1 menit dari sekarang agar mudah dites langsung)
  const [scheduleTime, setScheduleTime] = useState(() => {
    const d = new Date(Date.now() + 60000);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  });

  // Suara Kustom TikTok / Berkas Audio Sendiri & Cache Lokal
  const [tiktokAudioDataUrl, setTiktokAudioDataUrl] = useState(null);
  const [tiktokAudioFileName, setTiktokAudioFileName] = useState('');
  const [savedAudios, setSavedAudios] = useState(() => getCachedAudioList());
  const [activeAudioId, setActiveAudioId] = useState(() => localStorage.getItem('wakemate_active_audio_id') || null);
  const [serverCachedAudioIds, setServerCachedAudioIds] = useState([]);
  const fileInputRef = useRef(null);

  // Rekaman Suara
  const [isRecording, setIsRecording] = useState(false);
  const [voiceDataUrl, setVoiceDataUrl] = useState(null);
  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);
  const recordingTimerRef = useRef(null);

  // Preview Audio Controller (Hanya berbunyi jika Bima klik tombol Putar, tidak pernah otomatis)
  const [previewAudioEl, setPreviewAudioEl] = useState(null);
  const [isPlayingPreview, setIsPlayingPreview] = useState(false);

  // Status Alarm Menyala
  const [isAlarmActive, setIsAlarmActive] = useState(false);
  const [alarmData, setAlarmData] = useState(null);
  const [wakeUpNotice, setWakeUpNotice] = useState(null);
  const [missionCount, setMissionCount] = useState(0);
  const isAlarmActiveRef = useRef(false);
  const alarmDataRef = useRef(null);

  const socketRef = useRef(null);

  const checkBattery = () => {
    if (Capacitor.isNativePlatform()) {
      WakeMateNative.getBatteryStatus()
        .then(r => setBatteryRestricted(!r?.ignoringBatteryOptimizations))
        .catch(() => {});
    }
  };

  useEffect(() => {
    checkBattery();
    const onVis = () => {
      if (document.visibilityState === 'visible') checkBattery();
    };
    document.addEventListener('visibilitychange', onVis);
    let subPromise = null;
    if (Capacitor.isNativePlatform() && typeof WakeMateNative.addListener === 'function') {
      subPromise = WakeMateNative.addListener('nativeAlarmStopped', () => {
        const stopper = currentRole === 'bima' ? 'Bima' : 'Pacar';
        stopLocalAlarm(stopper);
        if (socketRef.current) {
          socketRef.current.emit('stop_alarm', { roomId, stopper });
        }
      }).catch(() => null);
    }
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      if (subPromise) {
        subPromise.then(sub => sub?.remove?.()).catch(() => {});
      }
    };
  }, [currentRole, roomId]);

  useEffect(() => {
    if (!activeAudioId) return;
    getCachedAudio(activeAudioId).then((cached) => {
      if (!cached?.dataUrl) return;
      if (cached.soundType === 'voice') {
        setVoiceDataUrl(cached.dataUrl);
        setSelectedSound('voice');
      } else {
        setTiktokAudioDataUrl(cached.dataUrl);
        setTiktokAudioFileName(cached.name || 'Audio Kustom');
        setSelectedSound('tiktok');
      }
    }).catch(() => {});
  }, []);

  useEffect(() => {
    try { localStorage.setItem('wakemate_role', currentRole); } catch {}
  }, [currentRole]);

  useEffect(() => {
    try { localStorage.setItem('wakemate_custom_msg', customMessage); } catch {}
  }, [customMessage]);

  useEffect(() => {
    try { localStorage.setItem('wakemate_custom_texts', JSON.stringify(customTexts)); } catch {}
  }, [customTexts]);

  useEffect(() => {
    const liteSchedules = scheduledAlarms.map(({ voiceDataUrl: _v, ...rest }) => rest);
    try {
      localStorage.setItem(`wakemate_schedules_${roomId}`, JSON.stringify(liteSchedules));
    } catch {}
    if (Capacitor.isNativePlatform()) {
      WakeMateNative.syncConfig({
        serverUrl,
        roomId,
        roomPin,
        deviceId: DEVICE_ID,
        role: currentRole,
        schedulesJson: JSON.stringify(liteSchedules)
      }).catch(() => {});
    }
  }, [serverUrl, roomId, roomPin, currentRole, scheduledAlarms]);

  // Scroll otomatis ke atas saat ganti tab agar layout tidak bergeser aneh
  const switchTab = (tabName) => {
    stopPreviewAudio();
    setActiveTab(tabName);
    window.scrollTo({ top: 0, behavior: 'instant' });
  };

  useEffect(() => {
    if (!serverUrl || !roomPin) {
      socketRef.current = null;
      setIsConnected(false);
      return;
    }

    const socket = io(serverUrl, {
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 4000,
      timeout: 10000
    });
    socketRef.current = socket;

    socket.on('connect', () => {
      setIsConnected(true);
      setAuthError(null);
      const username = currentRole === 'bima' ? 'Bima' : 'Pacar';
      // AUD-01: Kirim roomId, PIN, daftar audio lokal, dan jadwal lokal
      socket.emit('join_room', {
        roomId,
        username,
        pin: roomPin,
        deviceId: DEVICE_ID,
        cachedAudioIds: getCachedAudioList().map(a => a.audioId),
        clientSchedules: loadStoredSchedules(roomId)
      });

      // AUD-06: Jalankan Foreground Service siaga saat terhubung
      if (Capacitor.isNativePlatform()) {
        try {
          WakeMateNative.startForegroundService().catch(() => {});
        } catch (_) {}
      }
    });

    socket.on('auth_error', (data) => {
      setAuthError(data?.message || 'PIN kamar tidak cocok!');
      setWakeUpNotice(`⚠️ ${data?.message || 'PIN kamar tidak cocok!'}`);
      setTimeout(() => setWakeUpNotice(null), 6000);
    });

    socket.on('alarm_error', (data) => {
      setWakeUpNotice('⚠️ ' + (data?.message || 'Gagal mengatur alarm'));
      setTimeout(() => setWakeUpNotice(null), 5000);
    });

    socket.on('rate_limit_error', (data) => {
      setWakeUpNotice('⏳ ' + (data?.message || 'Tunggu sebentar sebelum mencoba lagi'));
      setTimeout(() => setWakeUpNotice(null), 4000);
    });

    socket.on('disconnect', () => {
      setIsConnected(false);
    });

    socket.on('room_state', (data) => {
      if (data.roomId === roomId) {
        setAuthError(null);
        setScheduledAlarms(data.scheduledAlarms || []);
        setServerCachedAudioIds(data.cachedAudioIds || []);
        const roomAudios = Array.isArray(data.customAudios)
          ? data.customAudios
          : (Array.isArray(data.cachedAudioIds) ? data.cachedAudioIds.map(audioId => ({ audioId })) : []);
        roomAudios.forEach(async (item) => {
          const id = typeof item === 'string' ? item : item?.audioId;
          const name = typeof item === 'object' ? (item.audioName || item.name) : undefined;
          if (!id) return;
          const existing = await getCachedAudio(id);
          if (!existing) {
            socket.emit('get_audio', { audioId: id, audioName: name });
          }
        });
        if (data.isAlarmActive && data.currentAlarm) {
          const myName = currentRole === 'bima' ? 'Bima' : 'Pacar';
          const targetName = data.currentAlarm.target || data.currentAlarm.targetName || '';
          const isSender = currentRole !== 'simulasi' &&
            data.currentAlarm.senderDeviceId === DEVICE_ID &&
            myName !== targetName;
          if (!isSender) {
            triggerLocalAlarm(data.currentAlarm);
          }
        }
      }
    });

    socket.on('audio_uploaded', (data) => {
      if (data?.audioId) {
        setServerCachedAudioIds(prev => prev.includes(data.audioId) ? prev : [...prev, data.audioId]);
        getCachedAudio(data.audioId).then((existing) => {
          if (!existing) {
            socket.emit('get_audio', { audioId: data.audioId, audioName: data.audioName });
          }
        }).catch(() => {});
      }
    });

    socket.on('audio_sync_payload', async (data) => {
      if (!data?.audioId || !data?.voiceDataUrl) return;
      const saved = await saveCachedAudio(data.audioId, data.audioName || 'Audio Pasangan', 'tiktok', data.voiceDataUrl);
      if (saved) {
        setSavedAudios(getCachedAudioList());
        setServerCachedAudioIds(prev => prev.includes(data.audioId) ? prev : [...prev, data.audioId]);
        if (Capacitor.isNativePlatform()) {
          WakeMateNative.saveNativeAudio({ audioId: data.audioId, dataUrl: saved.dataUrl }).catch(() => {});
        }
        socket.emit('client_audio_cached', { audioId: data.audioId });
      }
    });

    socket.on('custom_text_received', (data) => {
      if (currentRole === 'simulasi' || data?.senderDeviceId !== DEVICE_ID) {
        setReceivedCustomText(data);
        soundManager.playBeep();
        if ('vibrate' in navigator) {
          navigator.vibrate([300, 150, 300]);
        }
      }
    });

    socket.on('scheduled_list_updated', (list) => {
      setScheduledAlarms(list || []);
    });

    socket.on('alarm_triggered', (data) => {
      if (data?.id) {
        setScheduledAlarms(prev => prev.map(a => (a.id === data.id ? { ...a, fired: true } : a)));
      }
      // AUD-07: Periksa apakah perangkat fisik ini adalah pengirim alarm murni
      const myName = currentRole === 'bima' ? 'Bima' : 'Pacar';
      const targetName = data?.target || data?.targetName || '';
      const isSameDevice = data?.senderDeviceId
        ? data.senderDeviceId === DEVICE_ID
        : Boolean(data?.senderSocketId && data.senderSocketId === socket.id);
      const isSender = currentRole !== 'simulasi' && isSameDevice && myName !== targetName;

      if (isSender) {
        // Jika saya yang mengirim alarm, jangan bunyikan HP saya dan jangan kunci layar saya!
        setWakeUpNotice(`📢 Sinyal alarm berhasil terkirim dan sedang berdering di HP ${data?.target || 'Pasangan'}!`);
        setTimeout(() => setWakeUpNotice(null), 6000);
        return;
      }

      // Jika saya adalah target penerima, bunyikan alarm darurat di HP saya
      triggerLocalAlarm(data);
    });

    socket.on('alarm_stopped', (data) => {
      const stopper = data?.stopper || 'Pasangan';
      if (isAlarmActiveRef.current) {
        stopLocalAlarm(stopper);
      } else {
        setWakeUpNotice(`🎉 Alarm berhasil dimatikan oleh ${stopper}!`);
        setTimeout(() => setWakeUpNotice(null), 5000);
      }
    });

    return () => {
      socket.disconnect();
      stopPreviewAudio();
    };
  }, [serverUrl, roomId, roomPin, currentRole]);

  // Pemeriksaan jadwal lokal setiap 1 detik (tetap berdering meskipun HP sedang offline)
  useEffect(() => {
    const timer = setInterval(() => {
      const now = Date.now();
      const due = scheduledAlarms.find(
        (a) => !a.fired && a.triggerTime <= now && (now - a.triggerTime) < 300000
      );
      if (!due) return;
      setScheduledAlarms(prev => prev.map(a => (a.id === due.id ? { ...a, fired: true } : a)));
      const myName = currentRole === 'bima' ? 'Bima' : 'Pacar';
      const targetName = due.target || due.targetName || '';
      const isSender = currentRole !== 'simulasi' &&
        Boolean(due.senderDeviceId && due.senderDeviceId === DEVICE_ID) &&
        myName !== targetName;
      if (!isSender) {
        triggerLocalAlarm({
          ...due,
          sender: due.creator || due.sender || 'Pasangan'
        });
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [scheduledAlarms, currentRole]);

  // Coba sambung ulang saat jaringan kembali, aplikasi dibuka lagi, atau berkala setiap 5s jika offline
  useEffect(() => {
    const tryReconnect = () => {
      if (socketRef.current && !socketRef.current.connected) {
        socketRef.current.connect();
      }
    };
    window.addEventListener('online', tryReconnect);
    document.addEventListener('visibilitychange', tryReconnect);
    const retryInterval = setInterval(tryReconnect, 5000);
    return () => {
      window.removeEventListener('online', tryReconnect);
      document.removeEventListener('visibilitychange', tryReconnect);
      clearInterval(retryInterval);
    };
  }, []);

  // Bersihkan timer rekaman saat komponen dibongkar
  useEffect(() => () => clearTimeout(recordingTimerRef.current), []);

  // Kontrol Preview Suara Manual
  const stopPreviewAudio = () => {
    if (previewAudioEl) {
      previewAudioEl.pause();
      previewAudioEl.currentTime = 0;
    }
    setIsPlayingPreview(false);
  };

  const playPreviewAudio = (audioUrl) => {
    if (!audioUrl) return;
    if (isPlayingPreview) {
      stopPreviewAudio();
      return;
    }
    const audio = new Audio(audioUrl);
    audio.volume = 0.5; // Setel pelan agar tidak mengagetkan
    audio.onended = () => setIsPlayingPreview(false);
    setPreviewAudioEl(audio);
    setIsPlayingPreview(true);
    audio.play().catch(e => console.error("Preview audio error:", e));
  };

  const registerCustomAudio = async (name, soundType, dataUrl) => {
    const audioId = computeAudioId(dataUrl);
    if (!audioId) return;
    await saveCachedAudio(audioId, name, soundType, dataUrl);
    setSavedAudios(getCachedAudioList());
    setActiveAudioId(audioId);
    try { localStorage.setItem('wakemate_active_audio_id', audioId); } catch (_) {}
    if (Capacitor.isNativePlatform()) {
      WakeMateNative.saveNativeAudio({ audioId, dataUrl }).catch(() => {});
    }
    if (socketRef.current?.connected) {
      socketRef.current.emit('upload_audio', {
        audioId,
        audioName: name,
        voiceDataUrl: dataUrl
      });
    }
  };

  const handleSelectSavedAudio = async (item) => {
    stopPreviewAudio();
    const cached = await getCachedAudio(item.audioId);
    if (!cached?.dataUrl) return;
    setActiveAudioId(item.audioId);
    try { localStorage.setItem('wakemate_active_audio_id', item.audioId); } catch (_) {}
    if (item.soundType === 'voice') {
      setVoiceDataUrl(cached.dataUrl);
      setSelectedSound('voice');
    } else {
      setTiktokAudioDataUrl(cached.dataUrl);
      setTiktokAudioFileName(item.name || 'Audio Kustom');
      setSelectedSound('tiktok');
    }
    if (socketRef.current?.connected && !serverCachedAudioIds.includes(item.audioId)) {
      socketRef.current.emit('upload_audio', {
        audioId: item.audioId,
        audioName: item.name,
        voiceDataUrl: cached.dataUrl
      });
    }
  };

  const handleDeleteSavedAudio = async (e, audioId) => {
    e.stopPropagation();
    await deleteCachedAudio(audioId);
    setSavedAudios(getCachedAudioList());
    if (activeAudioId === audioId) {
      setActiveAudioId(null);
      try { localStorage.removeItem('wakemate_active_audio_id'); } catch (_) {}
    }
  };

  // Upload Audio TikTok / MP3
  const handleAudioUpload = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (file.size > 15 * 1024 * 1024) {
      alert("Ukuran audio maksimal 15MB ya, Bima!");
      return;
    }

    const reader = new FileReader();
    reader.onload = async (event) => {
      const dataUrl = event.target.result;
      setTiktokAudioDataUrl(dataUrl);
      setTiktokAudioFileName(file.name);
      setSelectedSound('tiktok');
      stopPreviewAudio();
      await registerCustomAudio(file.name, 'tiktok', dataUrl);
    };
    reader.readAsDataURL(file);
  };

  // Memicu Alarm Aktif di Layar
  const triggerLocalAlarm = async (data) => {
    if (isAlarmActiveRef.current && data?.id && alarmDataRef.current?.id === data.id) {
      return;
    }
    isAlarmActiveRef.current = true;
    alarmDataRef.current = data;
    stopPreviewAudio();
    setIsAlarmActive(true);
    setAlarmData(data);
    setMissionCount(0);
    setWakeUpNotice(null);

    let audioUrl = data.voiceDataUrl || null;
    if (data.voiceDataUrl && data.audioId) {
      const saved = await saveCachedAudio(
        data.audioId,
        data.audioName || 'Audio Pasangan',
        data.sound === 'voice' ? 'voice' : 'tiktok',
        data.voiceDataUrl
      );
      if (saved) {
        setSavedAudios(getCachedAudioList());
        if (Capacitor.isNativePlatform()) {
          WakeMateNative.saveNativeAudio({ audioId: data.audioId, dataUrl: saved.dataUrl }).catch(() => {});
        }
        socketRef.current?.emit('client_audio_cached', { audioId: data.audioId });
      }
    } else if (!data.voiceDataUrl && data.audioId) {
      const cached = await getCachedAudio(data.audioId);
      audioUrl = cached?.dataUrl || null;
    }

    const volume = data.volume || 100;
    const soundType = data.sound || 'siren';

    // AUD-06: Paksa volume perangkat fisik ke tingkat maksimal 100% & tampilkan pop-up notifikasi dengan tombol "Aku Udah Bangun Sayang"
    if (Capacitor.isNativePlatform()) {
      try {
        WakeMateNative.maximizeVolume().catch(() => {});
        WakeMateNative.showAlarmNotification({
          id: String(data.id || data.timestamp || Date.now()),
          title: `🚨 Alarm dari ${data.sender || 'Pasangan'}`,
          message: data.message || 'Waktunya bangun!',
          sound: soundType,
          audioId: data.audioId || ''
        }).catch(() => {});
      } catch (_) {}
    }

    if (!(Capacitor.isNativePlatform() && document.hidden)) {
      soundManager.play(soundType, volume, audioUrl);
    }

    if ('vibrate' in navigator) {
      navigator.vibrate([800, 400, 800, 400, 1000]);
    }
  };

  // Menghentikan Alarm
  const stopLocalAlarm = (stopper) => {
    const wasActive = isAlarmActiveRef.current;
    isAlarmActiveRef.current = false;
    alarmDataRef.current = null;
    setIsAlarmActive(false);
    setAlarmData(null);
    setMissionCount(0);
    soundManager.stop();

    if ('vibrate' in navigator) {
      navigator.vibrate(0);
    }

    if (!wasActive) return;

    if (Capacitor.isNativePlatform()) {
      try {
        WakeMateNative.stopAlarmNotification().catch(() => {});
      } catch (_) {}
    }

    confetti({
      particleCount: 35,
      spread: 60,
      origin: { y: 0.6 }
    });

    setWakeUpNotice(`🎉 Alarm berhasil dimatikan oleh ${stopper}!`);
    setTimeout(() => setWakeUpNotice(null), 5000);
  };

  // Perekaman Suara Bima Langsung
  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      audioChunksRef.current = [];
      const mediaRecorder = new MediaRecorder(stream);
      mediaRecorderRef.current = mediaRecorder;

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      mediaRecorder.onstop = () => {
        stream.getTracks().forEach(track => track.stop());
        clearTimeout(recordingTimerRef.current);
        recordingTimerRef.current = null;
        const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
        if (audioBlob.size > 8 * 1024 * 1024) {
          alert("Rekaman terlalu besar (maksimal 8MB). Coba rekam lebih singkat ya!");
        } else {
          const reader = new FileReader();
          reader.readAsDataURL(audioBlob);
          reader.onloadend = async () => {
            const dataUrl = reader.result;
            const recName = `Rekaman ${currentRole === 'bima' ? 'Bima' : 'Pacar'} (${new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })})`;
            setVoiceDataUrl(dataUrl);
            setSelectedSound('voice');
            await registerCustomAudio(recName, 'voice', dataUrl);
          };
        }
      };

      mediaRecorder.start(1000);
      clearTimeout(recordingTimerRef.current);
      recordingTimerRef.current = setTimeout(() => {
        mediaRecorderRef.current?.stop();
        setIsRecording(false);
      }, 60000);
      setIsRecording(true);
    } catch (err) {
      console.error("Gagal akses mikrofon:", err);
      alert("Izin mikrofon diperlukan untuk merekam suara.");
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && isRecording) {
      clearTimeout(recordingTimerRef.current);
      mediaRecorderRef.current.stop();
      setIsRecording(false);
    }
  };

  // Helper mendapatkan audio url yang aktif
  const getActiveAudioPayload = () => {
    if (selectedSound === 'tiktok') return tiktokAudioDataUrl;
    if (selectedSound === 'voice') return voiceDataUrl;
    return null;
  };

  // Kirim Alarm Instan
  const handleSendInstantAlarm = () => {
    if (!socketRef.current) return;
    const creatorName = currentRole === 'bima' ? 'Bima' : 'Pacar';
    const targetName = currentRole === 'bima' ? 'Pacar' : 'Bima';
    const isCustom = selectedSound === 'tiktok' || selectedSound === 'voice';
    const rawAudio = getActiveAudioPayload();
    const resolvedAudioId = isCustom ? (activeAudioId || (rawAudio ? computeAudioId(rawAudio) : null)) : null;
    const audioName = isCustom ? (selectedSound === 'tiktok' ? (tiktokAudioFileName || 'Audio TikTok') : 'Rekaman Suara') : null;

    const payload = {
      roomId,
      sender: creatorName,
      targetName,
      volume: selectedVolume,
      sound: selectedSound,
      message: customMessage || 'BANGUN SEKARANG!',
      audioId: resolvedAudioId,
      audioName,
      voiceDataUrl: isCustom
        ? (resolvedAudioId && serverCachedAudioIds.includes(resolvedAudioId) ? null : rawAudio)
        : null,
      missionRequired
    };

    socketRef.current.emit('trigger_alarm', payload);
  };

  // Jadwalkan Alarm dari Jauh
  const handleScheduleAlarm = () => {
    const creatorName = currentRole === 'bima' ? 'Bima' : 'Pacar';
    const targetName = currentRole === 'bima' ? 'Pacar' : 'Bima';

    const [hours, minutes] = scheduleTime.split(':').map(Number);
    const now = new Date();
    const targetDate = new Date();
    targetDate.setHours(hours, minutes, 0, 0);

    if (targetDate.getTime() <= now.getTime()) {
      if (hours === now.getHours() && minutes === now.getMinutes()) {
        // Jika memilih jam:menit yang sama dengan menit sekarang, bunyikan 5 detik lagi (bukan besok!)
        targetDate.setTime(now.getTime() + 5000);
      } else {
        targetDate.setDate(targetDate.getDate() + 1);
      }
    }

    const delayMs = Math.max(1000, targetDate.getTime() - Date.now());
    const isCustom = selectedSound === 'tiktok' || selectedSound === 'voice';
    const rawAudio = getActiveAudioPayload();
    const resolvedAudioId = isCustom ? (activeAudioId || (rawAudio ? computeAudioId(rawAudio) : null)) : null;
    const audioName = isCustom ? (selectedSound === 'tiktok' ? (tiktokAudioFileName || 'Audio TikTok') : 'Rekaman Suara') : null;

    const newSchedule = {
      id: 'sch_' + Date.now(),
      roomId,
      creator: creatorName,
      sender: creatorName,
      senderDeviceId: DEVICE_ID,
      target: targetName,
      targetName,
      time: scheduleTime,
      timeString: scheduleTime,
      triggerTime: targetDate.getTime(),
      delayMs,
      volume: selectedVolume,
      sound: selectedSound,
      message: customMessage || 'BANGUN SAYANG!',
      audioId: resolvedAudioId,
      audioName,
      voiceDataUrl: isCustom
        ? (resolvedAudioId && serverCachedAudioIds.includes(resolvedAudioId) ? null : rawAudio)
        : null,
      missionRequired,
      fired: false
    };

    setScheduledAlarms(prev => [...prev.filter(a => a.id !== newSchedule.id), newSchedule]);
    socketRef.current?.emit('schedule_alarm', newSchedule);
    const diffSec = Math.max(1, Math.round(delayMs / 1000));
    const diffLabel = diffSec < 60 ? `${diffSec} detik lagi` : `${Math.round(diffSec / 60)} menit lagi`;
    setWakeUpNotice(`⏰ Jadwal jam ${scheduleTime} (${diffLabel}) tersimpan untuk HP ${targetName}!`);
    setTimeout(() => setWakeUpNotice(null), 5000);
    switchTab('list');
  };

  const handleDeleteSchedule = (alarmId) => {
    setScheduledAlarms(prev => prev.filter(a => a.id !== alarmId));
    socketRef.current?.emit('delete_scheduled_alarm', { alarmId });
  };

  const handleSaveCustomText = () => {
    const trimmed = customMessage.trim();
    if (!trimmed) return;
    if (!customTexts.includes(trimmed)) {
      setCustomTexts(prev => [trimmed, ...prev].slice(0, 20));
    }
    setWakeUpNotice('📌 Teks kustom berhasil disimpan ke daftar cepat!');
    setTimeout(() => setWakeUpNotice(null), 3000);
  };

  const handleDeleteCustomText = (e, msg) => {
    e.stopPropagation();
    setCustomTexts(prev => prev.filter(item => item !== msg));
  };

  const targetPartner = currentRole === 'bima' ? 'Pacar' : 'Bima';

  const handleSendCustomText = () => {
    const text = customMessage.trim();
    if (!text || !socketRef.current) return;
    const creatorName = currentRole === 'bima' ? 'Bima' : 'Pacar';
    socketRef.current.emit('send_custom_text', {
      roomId,
      sender: creatorName,
      message: text
    });
    setWakeUpNotice(`💬 Pesan teks terkirim ke layar HP ${targetPartner}!`);
    setTimeout(() => setWakeUpNotice(null), 4000);
  };

  const handleStopAlarm = () => {
    // Jika misi aktif, wajib tekan 3 kali
    if (alarmData?.missionRequired && missionCount < 2) {
      setMissionCount(prev => prev + 1);
      return;
    }

    const stopper = currentRole === 'bima' ? 'Bima' : 'Pacar';

    // Matikan suara lokal terlebih dahulu (optimistic local stop) agar aman jika koneksi offline
    stopLocalAlarm(stopper);

    if (socketRef.current) {
      socketRef.current.emit('stop_alarm', { roomId, stopper });
    }
  };

  const handleChangeRoom = (e) => {
    e.preventDefault();
    if (!tempRoomId.trim()) return;
    const cleanRoom = tempRoomId.toUpperCase().trim();
    const cleanPin = tempRoomPin.trim();

    if (!cleanPin) {
      alert("PIN kamar tidak boleh kosong ya!");
      return;
    }

    localStorage.setItem('wakemate_room', cleanRoom);
    localStorage.setItem('wakemate_pin', cleanPin);
    setRoomId(cleanRoom);
    setRoomPin(cleanPin);
    setScheduledAlarms(loadStoredSchedules(cleanRoom));
    setAuthError(null);
    setWakeUpNotice(`🔑 Menyambungkan ke kamar ${cleanRoom} (PIN: ${cleanPin})...`);
    setTimeout(() => setWakeUpNotice(null), 4000);
  };

  // Preset jam cepat
  const setQuickTime = (type) => {
    const now = new Date();
    if (type === 'plus1') {
      now.setMinutes(now.getMinutes() + 1);
    } else if (type === 'plus5') {
      now.setMinutes(now.getMinutes() + 5);
    } else if (type === 'plus15') {
      now.setMinutes(now.getMinutes() + 15);
    } else if (type === 'plus30') {
      now.setMinutes(now.getMinutes() + 30);
    } else if (type === '0600') {
      now.setHours(6, 0, 0, 0);
    } else if (type === '0700') {
      now.setHours(7, 0, 0, 0);
    }
    const h = String(now.getHours()).padStart(2, '0');
    const m = String(now.getMinutes()).padStart(2, '0');
    setScheduleTime(`${h}:${m}`);
  };

  const renderSavedAudiosBox = () => {
    if (savedAudios.length === 0) return null;
    return (
      <div className="nb-card-sm" style={{ backgroundColor: '#F8FAFC', marginTop: '10px', border: '2px solid #000' }}>
        <div style={{ fontSize: '0.78rem', fontWeight: 900, marginBottom: '6px' }}>
          📦 Audio Kustom Tersimpan di HP ({savedAudios.length}):
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', maxHeight: '150px', overflowY: 'auto' }}>
          {savedAudios.map((item) => {
            const isSelected = (selectedSound === 'tiktok' || selectedSound === 'voice') && activeAudioId === item.audioId;
            return (
              <div
                key={item.audioId}
                onClick={() => handleSelectSavedAudio(item)}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  padding: '6px 10px',
                  borderRadius: '8px',
                  border: '2px solid #000',
                  backgroundColor: isSelected ? '#FFE600' : '#FFFFFF',
                  cursor: 'pointer',
                  fontSize: '0.78rem',
                  fontWeight: 800
                }}
              >
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '75%' }}>
                  {item.soundType === 'voice' ? '🎙️' : '🎵'} {item.name}
                  {serverCachedAudioIds.includes(item.audioId) ? ' ⚡' : ''}
                </span>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  {isSelected && <span style={{ fontSize: '0.7rem', color: '#000' }}>Aktif</span>}
                  <button
                    type="button"
                    onClick={(e) => handleDeleteSavedAudio(e, item.audioId)}
                    style={{
                      background: '#FF5757',
                      color: '#FFF',
                      border: '1.5px solid #000',
                      borderRadius: '6px',
                      padding: '2px 6px',
                      cursor: 'pointer',
                      fontWeight: 900,
                      fontSize: '0.72rem'
                    }}
                    title="Hapus dari HP"
                  >
                    ×
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  // Tampilan Layar Darurat Saat Alarm Berdering
  if (isAlarmActive) {
    return (
      <div className="alarm-ringing-bg">
        <div className="nb-card pulse-alarm" style={{ maxWidth: '420px', width: '100%', textAlign: 'center', padding: '28px 20px', backgroundColor: '#FFFFFF' }}>
          <div className="nb-badge" style={{ backgroundColor: '#FF5757', color: '#FFFFFF', marginBottom: '14px' }}>
            <AlertTriangle size={16} /> ALARM DARURAT AKTIF
          </div>
          
          <h1 style={{ fontSize: '1.55rem', fontWeight: 900, lineHeight: 1.2, marginBottom: '10px', overflowWrap: 'break-word' }}>
            🚨 {alarmData?.sender?.toUpperCase() || 'PASANGAN'} MEMBANGUNKANMU!
          </h1>
          
          <div className="nb-card-sm" style={{ backgroundColor: '#FFE600', padding: '14px', margin: '16px 0', fontSize: '1.15rem', fontWeight: 900 }}>
            "{alarmData?.message || 'WAKTUNYA BANGUN!'}"
          </div>

          <div style={{ fontWeight: 800, fontSize: '0.9rem', color: '#333', marginBottom: '16px' }}>
            {alarmData?.sound === 'tiktok' 
              ? '🎵 Memutar Nada Dering Audio TikTok / MP3!' 
              : alarmData?.sound === 'voice' 
                ? '🎙️ Memutar Suara Rekaman Khusus Bima!' 
                : '🔊 Volume Suara Maksimal 100%'}
          </div>

          {alarmData?.missionRequired && (
            <div className="nb-badge" style={{ backgroundColor: '#D8B4F8', color: '#000', marginBottom: '16px', fontSize: '0.85rem' }}>
              🎯 Misi Bangun: Ketuk {3 - missionCount}x Lagi untuk Mematikan
            </div>
          )}

          <button 
            onClick={handleStopAlarm}
            className="nb-button nb-button-success" 
            style={{ width: '100%', fontSize: '1.25rem', padding: '18px', borderRadius: '14px' }}
          >
            <CheckCircle2 size={26} /> 
            {alarmData?.missionRequired && missionCount < 2 
              ? `KETUK DISINI! (${missionCount + 1}/3)` 
              : 'AKU SUDAH BANGUN!'}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="app-container">
      
      {/* Notifikasi Pop-up */}
      {wakeUpNotice && (
        <div className="nb-card-sm" style={{ backgroundColor: '#48E59B', marginBottom: '14px', textAlign: 'center', fontWeight: 800, fontSize: '0.9rem', border: '2.5px solid #000' }}>
          {wakeUpNotice}
        </div>
      )}

      {/* Pop-up Pesan Teks Kustom dari Pasangan */}
      {receivedCustomText && (
        <div className="nb-card" style={{ backgroundColor: '#FFE600', border: '3px solid #000', marginBottom: '14px', textAlign: 'center', boxShadow: '5px 5px 0px #000' }}>
          <div className="nb-badge" style={{ backgroundColor: '#FFFFFF', marginBottom: '8px' }}>
            💬 PESAN DARI {(receivedCustomText.sender || 'PASANGAN').toUpperCase()}
          </div>
          <div style={{ fontSize: '1.25rem', fontWeight: 900, margin: '8px 0 14px', color: '#000' }}>
            "{receivedCustomText.message}"
          </div>
          <button
            type="button"
            onClick={() => setReceivedCustomText(null)}
            className="nb-button nb-button-success"
            style={{ width: '100%', padding: '10px', fontSize: '0.95rem' }}
          >
            👌 Sudah Dibaca
          </button>
        </div>
      )}

      {/* Header Bersih & Modern */}
      <header className="nb-card" style={{ padding: '14px 16px', marginBottom: '14px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <div style={{ width: '36px', height: '36px', backgroundColor: '#FFE600', border: '2px solid #000', borderRadius: '10px', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '2px 2px 0 #000' }}>
              <Zap size={22} color="#000" />
            </div>
            <div>
              <h1 style={{ fontSize: '1.25rem', fontWeight: 900, lineHeight: 1 }}>WAKE-MATE</h1>
              <span style={{ fontSize: '0.72rem', fontWeight: 800, color: '#666', textTransform: 'uppercase' }}>
                Mode: {currentRole === 'bima' ? '🧔 Bima' : currentRole === 'pacar' ? '👧 Pacar' : '📱 Simulasi 2 HP'}
              </span>
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <span className="nb-badge" style={{ backgroundColor: isConnected ? '#48E59B' : '#FF5757', color: isConnected ? '#000' : '#FFF' }}>
              <Radio size={12} /> {isConnected ? 'ONLINE' : 'OFFLINE'}
            </span>
          </div>
        </div>
      </header>

      {/* Banner Penghemat Baterai Adaptif */}
      {batteryRestricted && (
        <div className="nb-card-sm" style={{ backgroundColor: '#FFE600', marginBottom: '14px', border: '2.5px solid #000', display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <span style={{ fontWeight: 800, fontSize: '0.82rem', color: '#000' }}>
            🔋 Agar alarm tetap bunyi saat window dihapus / layar mati, izinkan jalan di background
          </span>
          <button
            type="button"
            onClick={() => {
              WakeMateNative.requestIgnoreBatteryOptimization()
                .then(() => setTimeout(checkBattery, 2000))
                .catch(() => {});
            }}
            className="nb-button nb-button-primary"
            style={{ padding: '8px 12px', fontSize: '0.82rem', width: '100%' }}
          >
            Izinkan Sekarang
          </button>
        </div>
      )}

      {(!serverUrl || !roomPin) && (
        <div className="nb-card-sm" style={{ backgroundColor: '#FF5757', color: '#FFF', marginBottom: '14px', textAlign: 'center', fontWeight: 800, fontSize: '0.9rem', border: '2.5px solid #000' }}>
          {!serverUrl ? 'Alamat server belum diatur' : 'PIN kamar belum diatur'}{' '}
          <button
            type="button"
            onClick={() => switchTab('settings')}
            className="nb-button"
            style={{ padding: '4px 10px', fontSize: '0.8rem', marginLeft: '6px' }}
          >
            Atur
          </button>
        </div>
      )}

      {/* KONTEN BERDASARKAN TAB NAVIGASI */}

      {/* TAB 1: ⚡ ALARM KILAT */}
      {activeTab === 'instant' && (
        <div>
          {/* Kartu Target Pasangan */}
          <div className="nb-card" style={{ backgroundColor: '#FFE600', padding: '14px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div>
              <span style={{ fontSize: '0.75rem', fontWeight: 900, textTransform: 'uppercase', letterSpacing: '0.5px' }}>Target Alarm:</span>
              <h2 style={{ fontSize: '1.3rem', fontWeight: 900 }}>HP {targetPartner}</h2>
            </div>
            <div className="nb-badge" style={{ backgroundColor: '#FFFFFF' }}>
              <ShieldCheck size={14} /> Tembus Mode Silent
            </div>
          </div>

          {/* Kartu Pesan Bangun */}
          <div className="nb-card">
            <label style={{ fontWeight: 800, fontSize: '0.9rem', display: 'block', marginBottom: '8px' }}>
              💬 Pesan di Layar HP {targetPartner}:
            </label>
            <div style={{ display: 'flex', gap: '6px', marginBottom: '10px' }}>
              <input 
                type="text" 
                value={customMessage}
                onChange={(e) => setCustomMessage(e.target.value)}
                className="nb-input"
                placeholder="Contoh: BANGUN SAYANG! UDAH SIANG!"
                style={{ flex: 1 }}
              />
              <button
                type="button"
                onClick={handleSaveCustomText}
                className="nb-button nb-button-primary"
                style={{ padding: '8px 10px', fontSize: '0.75rem', whiteSpace: 'nowrap' }}
              >
                + Simpan Teks
              </button>
            </div>
            {/* Quick Chips */}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginBottom: '10px' }}>
              {customTexts.map((msg, idx) => (
                <button
                  key={idx}
                  type="button"
                  onClick={() => setCustomMessage(msg)}
                  className="nb-chip"
                  style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}
                >
                  <span>{msg}</span>
                  <span
                    onClick={(e) => handleDeleteCustomText(e, msg)}
                    style={{ fontWeight: 900, color: '#FF5757', paddingLeft: '2px' }}
                    title="Hapus teks"
                  >
                    ×
                  </span>
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={handleSendCustomText}
              className="nb-button nb-button-cyan"
              style={{ width: '100%', padding: '10px', fontSize: '0.85rem' }}
            >
              💬 Kirim Teks Saja ke Layar HP {targetPartner}
            </button>
          </div>

          {/* Kartu Pilihan Suara (DENGAN PILIHAN AUDIO TIKTOK / MP3) */}
          <div className="nb-card">
            <label style={{ fontWeight: 800, fontSize: '0.9rem', display: 'block', marginBottom: '10px' }}>
              🎵 Pilih Jenis Suara Alarm:
            </label>

            <div className="sound-card-grid" style={{ marginBottom: '10px' }}>
              <div 
                className={`sound-card ${selectedSound === 'siren' ? 'selected' : ''}`}
                onClick={() => { setSelectedSound('siren'); stopPreviewAudio(); }}
              >
                <span style={{ fontSize: '1.5rem' }}>🚨</span>
                <span>Sirine Darurat</span>
              </div>
              <div 
                className={`sound-card ${selectedSound === 'alarm_clock' ? 'selected' : ''}`}
                onClick={() => { setSelectedSound('alarm_clock'); stopPreviewAudio(); }}
              >
                <span style={{ fontSize: '1.5rem' }}>⏰</span>
                <span>Jam Beker Bip</span>
              </div>
            </div>

            {/* OPSI 1: NADA DERING DARI TIKTOK / FILE AUDIO HP */}
            <div style={{ marginBottom: '10px' }}>
              <div 
                className={`sound-card ${selectedSound === 'tiktok' ? 'selected' : ''}`}
                onClick={() => setSelectedSound('tiktok')}
                style={{ width: '100%', flexDirection: 'row', justifyContent: 'space-between', padding: '12px 14px' }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <span style={{ fontSize: '1.4rem' }}>🎵</span>
                  <span style={{ textAlign: 'left' }}>
                    <strong>Suara dari TikTok / File MP3</strong>
                    {tiktokAudioFileName && (
                      <div style={{ fontSize: '0.72rem', color: '#555', fontWeight: 600 }}>
                        {tiktokAudioFileName}
                      </div>
                    )}
                  </span>
                </div>
                {tiktokAudioDataUrl ? (
                  <span className="nb-badge" style={{ backgroundColor: '#48E59B' }}>Dipilih</span>
                ) : (
                  <span className="nb-badge" style={{ backgroundColor: '#FFE600' }}>Pilih File</span>
                )}
              </div>

              {selectedSound === 'tiktok' && (
                <div className="nb-card-sm" style={{ backgroundColor: '#F0FDF4', marginTop: '8px', border: '2px solid #000' }}>
                  <input 
                    type="file" 
                    accept="audio/*" 
                    ref={fileInputRef} 
                    style={{ display: 'none' }} 
                    onChange={handleAudioUpload}
                  />

                  <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
                    <button 
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      className="nb-button nb-button-primary"
                      style={{ padding: '8px 12px', fontSize: '0.8rem' }}
                    >
                      <Upload size={14} /> {tiktokAudioDataUrl ? 'Ganti File Audio TikTok' : 'Ambil File Audio TikTok dari HP'}
                    </button>

                    {tiktokAudioDataUrl && (
                      <button 
                        type="button"
                        onClick={() => playPreviewAudio(tiktokAudioDataUrl)}
                        className={`nb-button ${isPlayingPreview ? 'nb-button-danger' : 'nb-button-cyan'}`}
                        style={{ padding: '8px 12px', fontSize: '0.8rem' }}
                      >
                        {isPlayingPreview ? <Pause size={14} /> : <Play size={14} />} 
                        {isPlayingPreview ? 'Hentikan' : 'Dengar Pelan'}
                      </button>
                    )}
                  </div>
                  <p style={{ fontSize: '0.75rem', color: '#666', marginTop: '6px' }}>
                    *Bisa pakai MP3, rekaman TikTok, atau lagu apa pun yang ada di HP kamu.
                  </p>
                </div>
              )}
            </div>

            {/* OPSI 2: REKAM SUARA BIMA LANGSUNG */}
            <div>
              <div 
                className={`sound-card ${selectedSound === 'voice' ? 'selected' : ''}`}
                onClick={() => setSelectedSound('voice')}
                style={{ width: '100%', flexDirection: 'row', justifyContent: 'space-between', padding: '12px 14px' }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <span style={{ fontSize: '1.4rem' }}>🎙️</span>
                  <span>Rekaman Suara {currentRole === 'bima' ? 'Bima' : 'Saya'} Langsung</span>
                </div>
                {voiceDataUrl && (
                  <span className="nb-badge" style={{ backgroundColor: '#48E59B' }}>Tersedia</span>
                )}
              </div>

              {selectedSound === 'voice' && (
                <div className="nb-card-sm" style={{ backgroundColor: '#FFFDF0', marginTop: '8px', border: '2px solid #000' }}>
                  <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                    {!isRecording ? (
                      <button 
                        type="button"
                        onClick={startRecording}
                        className="nb-button nb-button-danger"
                        style={{ padding: '8px 12px', fontSize: '0.8rem' }}
                      >
                        <Mic size={14} /> Mulai Rekam Suara
                      </button>
                    ) : (
                      <button 
                        type="button"
                        onClick={stopRecording}
                        className="nb-button"
                        style={{ backgroundColor: '#000', color: '#FFF', padding: '8px 12px', fontSize: '0.8rem' }}
                      >
                        <Square size={14} /> Selesai Rekam
                      </button>
                    )}

                    {voiceDataUrl && (
                      <button 
                        type="button"
                        onClick={() => playPreviewAudio(voiceDataUrl)}
                        className={`nb-button ${isPlayingPreview ? 'nb-button-danger' : 'nb-button-cyan'}`}
                        style={{ padding: '8px 12px', fontSize: '0.8rem' }}
                      >
                        {isPlayingPreview ? <Pause size={14} /> : <Play size={14} />} 
                        {isPlayingPreview ? 'Hentikan' : 'Dengar Pelan'}
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>

            {renderSavedAudiosBox()}
          </div>

          {/* Kartu Volume & Misi Bangun */}
          <VolumeMissionControl
            label="Volume Suara"
            volume={selectedVolume}
            setVolume={setSelectedVolume}
            mission={missionRequired}
            setMission={setMissionRequired}
            id="missionCheckInstant"
          />

          {/* Tombol Utama Raksasa Bunyikan Sekarang */}
          <button 
            onClick={handleSendInstantAlarm}
            className="nb-button nb-button-danger"
            style={{ width: '100%', fontSize: '1.2rem', padding: '18px', borderRadius: '16px', boxShadow: '5px 5px 0px #000' }}
          >
            <Bell size={24} /> ⚡ BUNYIKAN DI HP {targetPartner.toUpperCase()}!
          </button>
        </div>
      )}

      {/* TAB 2: ⏰ JADWAL JAM */}
      {activeTab === 'schedule' && (
        <div>
          {/* Kartu Jam Digital */}
          <div className="nb-card" style={{ textAlign: 'center', backgroundColor: '#FFFDF0' }}>
            <span style={{ fontSize: '0.78rem', fontWeight: 800, color: '#666', textTransform: 'uppercase' }}>
              Pukul Berapa HP {targetPartner} Harus Berdering?
            </span>
            <div style={{ margin: '14px 0' }}>
              <input 
                type="time" 
                value={scheduleTime}
                onChange={(e) => setScheduleTime(e.target.value)}
                className="nb-input"
                style={{ fontSize: '2.5rem', fontWeight: 900, textAlign: 'center', letterSpacing: '4px', padding: '12px', border: '3px solid #000' }}
              />
            </div>

            {/* Quick Time Chips */}
            <div style={{ display: 'flex', justifyContent: 'center', flexWrap: 'wrap', gap: '6px' }}>
              <button type="button" onClick={() => setQuickTime('plus1')} className="nb-chip">+1 Mnt</button>
              <button type="button" onClick={() => setQuickTime('plus5')} className="nb-chip">+5 Mnt</button>
              <button type="button" onClick={() => setQuickTime('plus15')} className="nb-chip">+15 Mnt</button>
              <button type="button" onClick={() => setQuickTime('plus30')} className="nb-chip">+30 Mnt</button>
              <button type="button" onClick={() => setQuickTime('0600')} className="nb-chip">06:00 Pagi</button>
              <button type="button" onClick={() => setQuickTime('0700')} className="nb-chip">07:00 Pagi</button>
            </div>

            <p style={{ fontSize: '0.75rem', color: '#666', marginTop: '10px' }}>
              Jam mengikuti waktu HP ini (pengirim).
            </p>
          </div>

          {/* Kartu Pesan Jadwal */}
          <div className="nb-card">
            <label style={{ fontWeight: 800, fontSize: '0.9rem', display: 'block', marginBottom: '8px' }}>
              💬 Pesan Saat Jam Tiba:
            </label>
            <div style={{ display: 'flex', gap: '6px', marginBottom: '10px' }}>
              <input 
                type="text" 
                value={customMessage}
                onChange={(e) => setCustomMessage(e.target.value)}
                className="nb-input"
                placeholder="Contoh: BANGUN SAYANG! WAKTUNYA KULIAH!"
                style={{ flex: 1 }}
              />
              <button
                type="button"
                onClick={handleSaveCustomText}
                className="nb-button nb-button-primary"
                style={{ padding: '8px 10px', fontSize: '0.75rem', whiteSpace: 'nowrap' }}
              >
                + Simpan Teks
              </button>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
              {customTexts.map((msg, idx) => (
                <button
                  key={idx}
                  type="button"
                  onClick={() => setCustomMessage(msg)}
                  className="nb-chip"
                  style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}
                >
                  <span>{msg}</span>
                  <span
                    onClick={(e) => handleDeleteCustomText(e, msg)}
                    style={{ fontWeight: 900, color: '#FF5757', paddingLeft: '2px' }}
                    title="Hapus teks"
                  >
                    ×
                  </span>
                </button>
              ))}
            </div>
          </div>

          {/* Pilihan Suara Jadwal Termasuk Suara TikTok */}
          <div className="nb-card">
            <label style={{ fontWeight: 800, fontSize: '0.9rem', display: 'block', marginBottom: '8px' }}>
              🎵 Suara Alarm Jam Bangun:
            </label>
            <div className="sound-card-grid" style={{ marginBottom: '8px' }}>
              <div 
                className={`sound-card ${selectedSound === 'siren' ? 'selected' : ''}`}
                onClick={() => { setSelectedSound('siren'); stopPreviewAudio(); }}
              >
                <span>🚨 Sirine</span>
              </div>
              <div 
                className={`sound-card ${selectedSound === 'alarm_clock' ? 'selected' : ''}`}
                onClick={() => { setSelectedSound('alarm_clock'); stopPreviewAudio(); }}
              >
                <span>⏰ Jam Beker</span>
              </div>
            </div>

            <div 
              className={`sound-card ${selectedSound === 'tiktok' ? 'selected' : ''}`}
              onClick={() => setSelectedSound('tiktok')}
              style={{ width: '100%', flexDirection: 'row', justifyContent: 'space-between', padding: '10px 14px' }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span style={{ fontSize: '1.2rem' }}>🎵</span>
                <span>{tiktokAudioFileName ? `Audio: ${tiktokAudioFileName}` : 'Pakai Suara TikTok / MP3'}</span>
              </div>
              {tiktokAudioDataUrl ? (
                <span className="nb-badge" style={{ backgroundColor: '#48E59B' }}>Siap</span>
              ) : (
                <span className="nb-badge" style={{ backgroundColor: '#FFE600' }}>Pilih</span>
              )}
            </div>

            {renderSavedAudiosBox()}
          </div>

          {/* Kartu Volume & Misi Bangun untuk Jadwal */}
          <VolumeMissionControl
            label="Volume Jam Bangun"
            volume={selectedVolume}
            setVolume={setSelectedVolume}
            mission={missionRequired}
            setMission={setMissionRequired}
            id="missionCheckSchedule"
          />

          {/* Tombol Pasang Jadwal */}
          <button 
            onClick={handleScheduleAlarm}
            className="nb-button nb-button-cyan"
            style={{ width: '100%', fontSize: '1.15rem', padding: '18px', borderRadius: '16px', boxShadow: '5px 5px 0px #000' }}
          >
            <Calendar size={22} /> ⏰ KUNCI JADWAL DI HP {targetPartner.toUpperCase()}
          </button>
        </div>
      )}

      {/* TAB 3: 📋 DAFTAR JADWAL AKTIF */}
      {activeTab === 'list' && (
        <div>
          <div className="nb-card" style={{ padding: '14px 16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h2 style={{ fontSize: '1.15rem', fontWeight: 900, display: 'flex', alignItems: 'center', gap: '8px' }}>
              <ListTodo size={20} /> Jadwal Aktif ({scheduledAlarms.length})
            </h2>
            <button 
              onClick={() => switchTab('schedule')}
              className="nb-button nb-button-primary"
              style={{ padding: '6px 12px', fontSize: '0.8rem' }}
            >
              + Tambah Jam
            </button>
          </div>

          {scheduledAlarms.length === 0 ? (
            <div className="nb-card" style={{ textAlign: 'center', padding: '36px 20px', backgroundColor: '#FFFFFF' }}>
              <Clock size={40} style={{ margin: '0 auto 12px', color: '#999' }} />
              <h3 style={{ fontSize: '1.1rem', fontWeight: 900, marginBottom: '6px' }}>Belum Ada Alarm Terjadwal</h3>
              <p style={{ fontSize: '0.85rem', color: '#666', marginBottom: '16px' }}>
                Kamu bisa menyetel jam bangun untuk HP {targetPartner} di tab "⏰ Jadwal".
              </p>
              <button 
                onClick={() => switchTab('schedule')}
                className="nb-button nb-button-cyan"
                style={{ fontSize: '0.85rem' }}
              >
                Pasang Jadwal Sekarang
              </button>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              {scheduledAlarms.map((alarm) => (
                <div key={alarm.id} className="nb-card" style={{ padding: '14px 16px', margin: 0, display: 'flex', justifyContent: 'space-between', alignItems: 'center', backgroundColor: alarm.fired ? '#F5F5F5' : '#FFFFFF' }}>
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <span className="nb-badge" style={{ backgroundColor: alarm.fired ? '#DDD' : '#FFE600', fontSize: '0.85rem' }}>
                        ⏰ {alarm.timeString}
                      </span>
                      <span style={{ fontWeight: 800, fontSize: '0.85rem' }}>
                        {alarm.creator} ➔ {alarm.targetName}
                      </span>
                    </div>
                    <p style={{ fontWeight: 700, fontSize: '0.85rem', color: '#444', marginTop: '6px' }}>
                      "{alarm.message}" {alarm.sound === 'tiktok' ? '(🎵 Suara TikTok)' : alarm.sound === 'voice' ? '(🎙️ Suara Bima)' : ''}
                    </p>
                  </div>

                  <button 
                    onClick={() => handleDeleteSchedule(alarm.id)}
                    className="nb-button" 
                    style={{ backgroundColor: '#FF5757', color: '#FFF', padding: '8px 10px' }}
                    title="Hapus Alarm"
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* TAB 4: ⚙️ PENGATURAN & KODE KAMAR */}
      {activeTab === 'settings' && (
        <div>
          {/* Pilih Peran Pengguna */}
          <div className="nb-card">
            <h3 style={{ fontSize: '1.05rem', fontWeight: 900, marginBottom: '12px', display: 'flex', alignItems: 'center', gap: '6px' }}>
              <User size={18} /> Peran HP Ini:
            </h3>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginBottom: '10px' }}>
              <button 
                onClick={() => setCurrentRole('bima')}
                className={`nb-button ${currentRole === 'bima' ? 'nb-button-cyan' : ''}`}
                style={{ fontSize: '0.85rem', padding: '12px 8px' }}
              >
                🧔 HP Bima
              </button>
              <button 
                onClick={() => setCurrentRole('pacar')}
                className={`nb-button ${currentRole === 'pacar' ? 'nb-button-purple' : ''}`}
                style={{ fontSize: '0.85rem', padding: '12px 8px' }}
              >
                👧 HP Pacar
              </button>
            </div>
            <button 
              onClick={() => setCurrentRole('simulasi')}
              className={`nb-button ${currentRole === 'simulasi' ? 'nb-button-primary' : ''}`}
              style={{ width: '100%', fontSize: '0.85rem', padding: '10px' }}
            >
              📱 Mode Simulasi (Cek 2 HP Sekaligus)
            </button>
          </div>

          {/* Ganti Kode & PIN Kamar Pasangan (AUD-01) */}
          <div className="nb-card">
            <h3 style={{ fontSize: '1.05rem', fontWeight: 900, marginBottom: '6px' }}>
              🔑 Kode & PIN Kamar Pasangan:
            </h3>
            <p style={{ fontSize: '0.8rem', color: '#666', marginBottom: '12px' }}>
              Pastikan Nama Kamar dan PIN rahasia sama persis di HP Bima dan HP Pacar agar aman dari gangguan luar.
            </p>

            {authError && (
              <div className="nb-badge" style={{ backgroundColor: '#FF5757', color: '#FFF', width: '100%', marginBottom: '12px', textAlign: 'center', padding: '10px' }}>
                ⚠️ {authError}
              </div>
            )}

            <form onSubmit={handleChangeRoom}>
              <label style={{ fontSize: '0.8rem', fontWeight: 800, color: '#333', display: 'block', marginBottom: '4px' }}>
                Nama Kamar:
              </label>
              <input 
                type="text" 
                value={tempRoomId}
                onChange={(e) => setTempRoomId(e.target.value)}
                className="nb-input"
                placeholder="MISAL: CINTA-BIMA"
                maxLength={32}
                style={{ textTransform: 'uppercase', letterSpacing: '1px', marginBottom: '10px' }}
              />

              <label style={{ fontSize: '0.8rem', fontWeight: 800, color: '#333', display: 'block', marginBottom: '4px' }}>
                PIN Rahasia Kamar:
              </label>
              <input 
                type="password" 
                value={tempRoomPin}
                onChange={(e) => setTempRoomPin(e.target.value)}
                className="nb-input"
                placeholder="Minimal 6 digit"
                maxLength={10}
                style={{ letterSpacing: '2px', marginBottom: '6px' }}
              />
              <p style={{ fontSize: '0.75rem', color: '#666', marginBottom: '12px' }}>
                Minimal 6 digit untuk kamar baru.
              </p>

              <button 
                type="submit"
                className="nb-button nb-button-success"
                style={{ width: '100%', fontSize: '0.9rem' }}
              >
                Simpan & Sambungkan Kamar
              </button>
            </form>
          </div>

          {/* Ganti Alamat Server Backend */}
          <div className="nb-card">
            <h3 style={{ fontSize: '1.05rem', fontWeight: 900, marginBottom: '6px' }}>
              🌐 Alamat Server (Jaringan / Komputer):
            </h3>
            <p style={{ fontSize: '0.8rem', color: '#666', marginBottom: '12px' }}>
              Alamat IP server komputer Bima agar HP pacar bisa saling bertukar sinyal alarm.
            </p>
            <form onSubmit={(e) => {
              e.preventDefault();
              if (!tempServerUrl.trim()) return;
              localStorage.setItem('wakemate_server', tempServerUrl.trim());
              setServerUrl(tempServerUrl.trim());
              setWakeUpNotice('🌐 Alamat server berhasil disimpan!');
              setTimeout(() => setWakeUpNotice(null), 3000);
            }}>
              <input 
                type="text" 
                value={tempServerUrl}
                onChange={(e) => setTempServerUrl(e.target.value)}
                className="nb-input"
                placeholder="http://IP-KOMPUTER:4000"
                style={{ marginBottom: '10px' }}
              />
              <button 
                type="submit"
                className="nb-button nb-button-cyan"
                style={{ width: '100%', fontSize: '0.9rem' }}
              >
                Simpan Alamat Server
              </button>
            </form>
          </div>

          {/* Petunjuk Penggunaan */}
          <div className="nb-card" style={{ backgroundColor: '#FFFDF0' }}>
            <h4 style={{ fontSize: '0.95rem', fontWeight: 900, marginBottom: '6px' }}>
              💡 Cara Kerja Wake-Mate:
            </h4>
            <ul style={{ fontSize: '0.82rem', color: '#444', paddingLeft: '18px', lineHeight: 1.6 }}>
              <li><strong>Tembus Silent</strong>: Begitu sinyal terkirim, HP tujuan akan otomatis menaikkan volume alarm ke tingkat maksimal.</li>
              <li><strong>Suara TikTok</strong>: Kamu bisa unduh suara sound TikTok favoritmu di HP, lalu upload di menu suara agar jadi alarm pacar!</li>
              <li><strong>Misi Bangun 3x</strong>: Tombol bangun harus ditekan 3 kali agar tidak bisa dimatikan secara tidak sengaja sambil tidur.</li>
            </ul>
          </div>
        </div>
      )}

      {/* BOTTOM NAVIGATION DOCKED BAR (THUMB-FRIENDLY UNTUK HP) */}
      <nav className="nb-bottom-nav">
        <button 
          onClick={() => switchTab('instant')}
          className={`nb-nav-item ${activeTab === 'instant' ? 'active' : ''}`}
        >
          <Zap size={20} />
          <span>Kilat</span>
        </button>

        <button 
          onClick={() => switchTab('schedule')}
          className={`nb-nav-item ${activeTab === 'schedule' ? 'active' : ''}`}
        >
          <Clock size={20} />
          <span>Jadwal</span>
        </button>

        <button 
          onClick={() => switchTab('list')}
          className={`nb-nav-item ${activeTab === 'list' ? 'active' : ''}`}
          style={{ position: 'relative' }}
        >
          <ListTodo size={20} />
          <span>Daftar</span>
          {scheduledAlarms.length > 0 && (
            <span style={{
              position: 'absolute', top: '3px', right: '16px',
              backgroundColor: '#FF5757', color: '#FFF', fontSize: '0.65rem',
              fontWeight: 900, width: '16px', height: '16px', borderRadius: '50%',
              display: 'flex', alignItems: 'center', justifyContent: 'center', border: '1.5px solid #000'
            }}>
              {scheduledAlarms.length}
            </span>
          )}
        </button>

        <button 
          onClick={() => switchTab('settings')}
          className={`nb-nav-item ${activeTab === 'settings' ? 'active' : ''}`}
        >
          <Settings size={20} />
          <span>Profil</span>
        </button>
      </nav>

    </div>
  );
}

function VolumeMissionControl({ label, volume, setVolume, mission, setMission, id }) {
  return (
    <div className="nb-card">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
        <label style={{ fontWeight: 800, fontSize: '0.9rem', display: 'flex', alignItems: 'center', gap: '6px' }}>
          <Volume2 size={16} /> {label}:
        </label>
        <span className="nb-badge" style={{ backgroundColor: volume >= 90 ? '#FF5757' : '#FFE600', color: volume >= 90 ? '#FFF' : '#000' }}>
          {volume}% {volume === 100 ? '⚡ FULL' : ''}
        </span>
      </div>
      <input
        type="range"
        min="50"
        max="100"
        step="5"
        value={volume}
        onChange={(e) => setVolume(Number(e.target.value))}
        style={{ width: '100%', accentColor: '#000000', cursor: 'pointer', height: '8px', marginBottom: '14px' }}
      />

      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', paddingTop: '8px', borderTop: '2px dashed #EEE' }}>
        <input
          type="checkbox"
          id={id}
          checked={mission}
          onChange={(e) => setMission(e.target.checked)}
          style={{ width: '20px', height: '20px', accentColor: '#000', cursor: 'pointer' }}
        />
        <label htmlFor={id} style={{ fontWeight: 800, fontSize: '0.85rem', cursor: 'pointer' }}>
          🎯 Wajib ketuk tombol 3x agar alarm mati
        </label>
      </div>
    </div>
  );
}
