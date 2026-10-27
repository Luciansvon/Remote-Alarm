import React, { useState, useEffect, useRef } from 'react';
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
  Music,
  Upload,
  Pause
} from 'lucide-react';
import { soundManager } from './soundManager';
import './App.css';

const defaultServer = localStorage.getItem('wakemate_server') || (
  window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
    ? 'http://192.168.0.23:4000'
    : `http://${window.location.hostname}:4000`
);

export default function App() {
  // Pengaturan Kamar & Peran
  const [roomId, setRoomId] = useState('CINTA-BIMA');
  const [tempRoomId, setTempRoomId] = useState('CINTA-BIMA');
  const [currentRole, setCurrentRole] = useState('bima'); // 'bima', 'pacar', 'simulasi'

  // Pengaturan Server
  const [serverUrl, setServerUrl] = useState(defaultServer);
  const [tempServerUrl, setTempServerUrl] = useState(defaultServer);
  
  // Tab Navigasi Aktif: 'instant' | 'schedule' | 'list' | 'settings'
  const [activeTab, setActiveTab] = useState('instant');

  // Status Koneksi & Data
  const [isConnected, setIsConnected] = useState(false);
  const [scheduledAlarms, setScheduledAlarms] = useState([]);
  
  // Pengaturan Alarm
  const [selectedVolume, setSelectedVolume] = useState(100);
  const [selectedSound, setSelectedSound] = useState('siren'); // 'siren', 'alarm_clock', 'tiktok', 'voice'
  const [customMessage, setCustomMessage] = useState('BANGUN SAYANG! UDAH SIANG!');
  const [missionRequired, setMissionRequired] = useState(true); // Wajib ketuk 3x

  // Jadwal Jam & Menit
  const [scheduleTime, setScheduleTime] = useState('06:30');

  // Suara Kustom TikTok / Berkas Audio Sendiri
  const [tiktokAudioDataUrl, setTiktokAudioDataUrl] = useState(null);
  const [tiktokAudioFileName, setTiktokAudioFileName] = useState('');
  const fileInputRef = useRef(null);

  // Rekaman Suara
  const [isRecording, setIsRecording] = useState(false);
  const [voiceDataUrl, setVoiceDataUrl] = useState(null);
  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);

  // Preview Audio Controller (Hanya berbunyi jika Bima klik tombol Putar, tidak pernah otomatis)
  const [previewAudioEl, setPreviewAudioEl] = useState(null);
  const [isPlayingPreview, setIsPlayingPreview] = useState(false);

  // Status Alarm Menyala
  const [isAlarmActive, setIsAlarmActive] = useState(false);
  const [alarmData, setAlarmData] = useState(null);
  const [wakeUpNotice, setWakeUpNotice] = useState(null);
  const [missionCount, setMissionCount] = useState(0);

  const socketRef = useRef(null);

  // Scroll otomatis ke atas saat ganti tab agar layout tidak bergeser aneh
  const switchTab = (tabName) => {
    stopPreviewAudio();
    setActiveTab(tabName);
    window.scrollTo({ top: 0, behavior: 'instant' });
  };

  useEffect(() => {
    const socket = io(serverUrl, {
      transports: ['websocket', 'polling'],
      reconnectionAttempts: 10
    });
    socketRef.current = socket;

    socket.on('connect', () => {
      setIsConnected(true);
      const username = currentRole === 'bima' ? 'Bima' : 'Pacar';
      socket.emit('join_room', { roomId, username });
    });

    socket.on('disconnect', () => {
      setIsConnected(false);
    });

    socket.on('room_state', (data) => {
      if (data.roomId === roomId) {
        setScheduledAlarms(data.scheduledAlarms || []);
        if (data.isAlarmActive && data.currentAlarm) {
          triggerLocalAlarm(data.currentAlarm);
        }
      }
    });

    socket.on('scheduled_list_updated', (list) => {
      setScheduledAlarms(list || []);
    });

    socket.on('alarm_triggered', (data) => {
      // Periksa apakah perangkat ini adalah pengirim alarm
      const myName = currentRole === 'bima' ? 'Bima' : 'Pacar';
      const isSender = data?.sender === myName && currentRole !== 'simulasi';

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
      stopLocalAlarm(data?.stopper || 'Pasangan');
    });

    return () => {
      socket.disconnect();
      stopPreviewAudio();
    };
  }, [serverUrl, roomId, currentRole]);

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

  // Upload Audio TikTok / MP3
  const handleAudioUpload = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (file.size > 15 * 1024 * 1024) {
      alert("Ukuran audio maksimal 15MB ya, Bima!");
      return;
    }

    const reader = new FileReader();
    reader.onload = (event) => {
      setTiktokAudioDataUrl(event.target.result);
      setTiktokAudioFileName(file.name);
      setSelectedSound('tiktok');
      stopPreviewAudio();
    };
    reader.readAsDataURL(file);
  };

  // Memicu Alarm Aktif di Layar
  const triggerLocalAlarm = (data) => {
    stopPreviewAudio();
    setIsAlarmActive(true);
    setAlarmData(data);
    setMissionCount(0);
    setWakeUpNotice(null);

    const volume = data.volume || 100;
    const soundType = data.sound || 'siren';
    soundManager.play(soundType, volume, data.voiceDataUrl);

    if ('vibrate' in navigator) {
      navigator.vibrate([800, 400, 800, 400, 1000]);
    }
  };

  // Menghentikan Alarm
  const stopLocalAlarm = (stopper) => {
    setIsAlarmActive(false);
    setAlarmData(null);
    setMissionCount(0);
    soundManager.stop();

    if ('vibrate' in navigator) {
      navigator.vibrate(0);
    }

    confetti({
      particleCount: 80,
      spread: 70,
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
        const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
        const reader = new FileReader();
        reader.readAsDataURL(audioBlob);
        reader.onloadend = () => {
          setVoiceDataUrl(reader.result);
          setSelectedSound('voice');
        };
        stream.getTracks().forEach(track => track.stop());
      };

      mediaRecorder.start();
      setIsRecording(true);
    } catch (err) {
      console.error("Gagal akses mikrofon:", err);
      alert("Izin mikrofon diperlukan untuk merekam suara.");
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && isRecording) {
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

    const payload = {
      roomId,
      sender: creatorName,
      targetName,
      volume: selectedVolume,
      sound: selectedSound,
      message: customMessage || 'BANGUN SEKARANG!',
      voiceDataUrl: getActiveAudioPayload(),
      missionRequired
    };

    socketRef.current.emit('trigger_alarm', payload);
  };

  // Jadwalkan Alarm dari Jauh
  const handleScheduleAlarm = () => {
    if (!socketRef.current) return;
    const creatorName = currentRole === 'bima' ? 'Bima' : 'Pacar';
    const targetName = currentRole === 'bima' ? 'Pacar' : 'Bima';

    const [hours, minutes] = scheduleTime.split(':').map(Number);
    const targetDate = new Date();
    targetDate.setHours(hours, minutes, 0, 0);

    if (targetDate.getTime() <= Date.now()) {
      targetDate.setDate(targetDate.getDate() + 1);
    }

    const payload = {
      roomId,
      creator: creatorName,
      targetName,
      timeString: scheduleTime,
      triggerTime: targetDate.getTime(),
      volume: selectedVolume,
      sound: selectedSound,
      message: customMessage || 'BANGUN SAYANG!',
      voiceDataUrl: getActiveAudioPayload(),
      missionRequired
    };

    socketRef.current.emit('schedule_alarm', payload);
    setWakeUpNotice(`⏰ Jadwal jam ${scheduleTime} tersimpan di HP ${targetName}!`);
    setTimeout(() => setWakeUpNotice(null), 4000);
    switchTab('list');
  };

  const handleDeleteSchedule = (alarmId) => {
    if (!socketRef.current) return;
    socketRef.current.emit('delete_scheduled_alarm', { alarmId });
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
    setRoomId(tempRoomId.toUpperCase().trim());
    setWakeUpNotice(`🔑 Berhasil pindah ke kamar ${tempRoomId.toUpperCase().trim()}`);
    setTimeout(() => setWakeUpNotice(null), 3000);
  };

  // Preset pesan cepat
  const quickMessages = [
    'BANGUN SAYANG! ☀️',
    'ADA KULIAH / KERJA! ⏰',
    'TELPON AKU SEKARANG! 📞',
    'JANGAN TIDUR LAGI! 🛑'
  ];

  // Preset jam cepat
  const setQuickTime = (type) => {
    const now = new Date();
    if (type === 'plus15') {
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

  // Tampilan Layar Darurat Saat Alarm Berdering
  if (isAlarmActive && currentRole !== 'simulasi') {
    return (
      <div className="alarm-ringing-bg">
        <div className="nb-card pulse-alarm" style={{ maxWidth: '420px', width: '100%', textAlign: 'center', padding: '28px 20px', backgroundColor: '#FFFFFF' }}>
          <div className="nb-badge" style={{ backgroundColor: '#FF5757', color: '#FFFFFF', marginBottom: '14px' }}>
            <AlertTriangle size={16} /> ALARM DARURAT AKTIF
          </div>
          
          <h1 style={{ fontSize: '1.9rem', fontWeight: 900, lineHeight: 1.2, marginBottom: '10px' }}>
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

  const targetPartner = currentRole === 'bima' ? 'Pacar' : 'Bima';

  return (
    <div className="app-container">
      
      {/* Notifikasi Pop-up */}
      {wakeUpNotice && (
        <div className="nb-card-sm" style={{ backgroundColor: '#48E59B', marginBottom: '14px', textAlign: 'center', fontWeight: 800, fontSize: '0.9rem', border: '2.5px solid #000' }}>
          {wakeUpNotice}
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
            <input 
              type="text" 
              value={customMessage}
              onChange={(e) => setCustomMessage(e.target.value)}
              className="nb-input"
              placeholder="Contoh: BANGUN SAYANG! UDAH SIANG!"
              style={{ marginBottom: '10px' }}
            />
            {/* Quick Chips */}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
              {quickMessages.map((msg, idx) => (
                <button
                  key={idx}
                  type="button"
                  onClick={() => setCustomMessage(msg)}
                  className="nb-chip"
                >
                  {msg}
                </button>
              ))}
            </div>
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
          </div>

          {/* Kartu Volume & Misi Bangun */}
          <div className="nb-card">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
              <label style={{ fontWeight: 800, fontSize: '0.9rem', display: 'flex', alignItems: 'center', gap: '6px' }}>
                <Volume2 size={16} /> Volume Suara:
              </label>
              <span className="nb-badge" style={{ backgroundColor: selectedVolume >= 90 ? '#FF5757' : '#FFE600', color: selectedVolume >= 90 ? '#FFF' : '#000' }}>
                {selectedVolume}% {selectedVolume === 100 ? '⚡ FULL' : ''}
              </span>
            </div>
            <input 
              type="range" 
              min="50" 
              max="100" 
              step="5" 
              value={selectedVolume}
              onChange={(e) => setSelectedVolume(Number(e.target.value))}
              style={{ width: '100%', accentColor: '#000000', cursor: 'pointer', height: '8px', marginBottom: '14px' }}
            />

            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', paddingTop: '8px', borderTop: '2px dashed #EEE' }}>
              <input 
                type="checkbox" 
                id="missionCheckInstant" 
                checked={missionRequired}
                onChange={(e) => setMissionRequired(e.target.checked)}
                style={{ width: '20px', height: '20px', accentColor: '#000', cursor: 'pointer' }}
              />
              <label htmlFor="missionCheckInstant" style={{ fontWeight: 800, fontSize: '0.85rem', cursor: 'pointer' }}>
                🎯 Wajib ketuk tombol 3x agar alarm mati
              </label>
            </div>
          </div>

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
              <button type="button" onClick={() => setQuickTime('plus15')} className="nb-chip">+15 Mnt</button>
              <button type="button" onClick={() => setQuickTime('plus30')} className="nb-chip">+30 Mnt</button>
              <button type="button" onClick={() => setQuickTime('0600')} className="nb-chip">06:00 Pagi</button>
              <button type="button" onClick={() => setQuickTime('0700')} className="nb-chip">07:00 Pagi</button>
            </div>
          </div>

          {/* Kartu Pesan Jadwal */}
          <div className="nb-card">
            <label style={{ fontWeight: 800, fontSize: '0.9rem', display: 'block', marginBottom: '8px' }}>
              💬 Pesan Saat Jam Tiba:
            </label>
            <input 
              type="text" 
              value={customMessage}
              onChange={(e) => setCustomMessage(e.target.value)}
              className="nb-input"
              placeholder="Contoh: BANGUN SAYANG! WAKTUNYA KULIAH!"
            />
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
          </div>

          {/* Kartu Volume & Misi Bangun untuk Jadwal */}
          <div className="nb-card">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
              <label style={{ fontWeight: 800, fontSize: '0.9rem', display: 'flex', alignItems: 'center', gap: '6px' }}>
                <Volume2 size={16} /> Volume Jam Bangun:
              </label>
              <span className="nb-badge" style={{ backgroundColor: selectedVolume >= 90 ? '#FF5757' : '#FFE600', color: selectedVolume >= 90 ? '#FFF' : '#000' }}>
                {selectedVolume}% {selectedVolume === 100 ? '⚡ FULL' : ''}
              </span>
            </div>
            <input 
              type="range" 
              min="50" 
              max="100" 
              step="5" 
              value={selectedVolume}
              onChange={(e) => setSelectedVolume(Number(e.target.value))}
              style={{ width: '100%', accentColor: '#000000', cursor: 'pointer', height: '8px', marginBottom: '14px' }}
            />

            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', paddingTop: '8px', borderTop: '2px dashed #EEE' }}>
              <input 
                type="checkbox" 
                id="missionCheckSchedule" 
                checked={missionRequired}
                onChange={(e) => setMissionRequired(e.target.checked)}
                style={{ width: '20px', height: '20px', accentColor: '#000', cursor: 'pointer' }}
              />
              <label htmlFor="missionCheckSchedule" style={{ fontWeight: 800, fontSize: '0.85rem', cursor: 'pointer' }}>
                🎯 Wajib ketuk tombol 3x agar alarm mati
              </label>
            </div>
          </div>

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

          {/* Ganti Kode Kamar Pasangan */}
          <div className="nb-card">
            <h3 style={{ fontSize: '1.05rem', fontWeight: 900, marginBottom: '6px' }}>
              🔑 Kode Kamar Pasangan:
            </h3>
            <p style={{ fontSize: '0.8rem', color: '#666', marginBottom: '12px' }}>
              Pastikan HP Bima dan HP Pacar memasukkan kode rahasia yang sama persis agar sinyal alarm terhubung.
            </p>
            <form onSubmit={handleChangeRoom}>
              <input 
                type="text" 
                value={tempRoomId}
                onChange={(e) => setTempRoomId(e.target.value)}
                className="nb-input"
                style={{ textTransform: 'uppercase', letterSpacing: '1px', marginBottom: '10px' }}
              />
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
                placeholder="http://192.168.0.23:4000"
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
