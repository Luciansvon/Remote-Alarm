const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const crypto = require('crypto');

// Konfigurasi CORS (AUD-03): Membaca process.env.ALLOWED_ORIGINS jika didefinisikan
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? (process.env.ALLOWED_ORIGINS.includes(',')
      ? process.env.ALLOWED_ORIGINS.split(',').map(s => s.trim()).filter(Boolean)
      : process.env.ALLOWED_ORIGINS.trim())
  : '*';

const app = express();
app.use(cors({
  origin: allowedOrigins,
  methods: ['GET', 'POST']
}));
app.use(express.json({ limit: '20mb' }));

// Helper enkripsi hash PIN kamar (AUD-01)
function hashPin(pin) {
  return crypto.createHash('sha256').update(String(pin || '1234')).digest('hex');
}

// Konstanta AUD-02 (Manajemen Memori & Kuota)
const MAX_SCHEDULED_PER_ROOM = 10;
const ROOM_IDLE_TTL_MS = 48 * 60 * 60 * 1000; // 48 Jam
const SCHEDULE_CLEANUP_TTL_MS = 3600_000; // 1 Jam

// Regex dan sanitasi Audio Data URI (AUD-04)
const AUDIO_DATA_URL_REGEX = /^data:audio\/(webm|ogg|mp3|mpeg|wav|mp4|aac|x-m4a);base64,[A-Za-z0-9+/=]+$/i;

function sanitizeVoiceDataUrl(rawUrl) {
  if (typeof rawUrl !== 'string') return null;
  const trimmed = rawUrl.trim();
  if (!trimmed) return null;
  return AUDIO_DATA_URL_REGEX.test(trimmed) ? trimmed : null;
}

// Helper pembatas frekuensi aksi per socket (AUD-03)
function isRateLimited(socket, minIntervalMs = 2000) {
  const now = Date.now();
  if (!socket.data) socket.data = {};
  const lastActionAt = socket.data.lastActionAt || 0;
  if (now - lastActionAt < minIntervalMs) {
    return true;
  }
  socket.data.lastActionAt = now;
  return false;
}

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    methods: ['GET', 'POST']
  },
  maxHttpBufferSize: 2e7 // 20 MB untuk transmisi rekaman suara
});

// Menyimpan data ruangan pasangan, status alarm, dan jadwal alarm
const rooms = {};

// Cek otomatis setiap 1 detik untuk alarm yang dijadwalkan & pemeliharaan memori (AUD-02)
const maintenanceInterval = setInterval(() => {
  const now = Date.now();
  for (const roomId in rooms) {
    const room = rooms[roomId];
    if (!room) continue;

    let scheduleUpdated = false;

    // 1. Eksekusi alarm yang waktunya berdering
    if (room.scheduledAlarms && room.scheduledAlarms.length > 0) {
      for (let i = room.scheduledAlarms.length - 1; i >= 0; i--) {
        const alarm = room.scheduledAlarms[i];
        if (alarm.triggerTime <= now && !alarm.fired) {
          alarm.fired = true;
          alarm.firedAt = now;
          room.isAlarmActive = true;
          // Set currentAlarm tanpa voiceDataUrl agar tidak membebani memori server
          room.currentAlarm = { ...alarm, voiceDataUrl: null };

          const alarmTitle = alarm.message || alarm.sound || 'Alarm Terjadwal';
          console.log(`[JADWAL TIBA] Alarm '${alarmTitle}' di Room ${roomId} berdering sekarang!`);
          io.to(roomId).emit('alarm_triggered', alarm);
          
          // Hapus Base64 dari riwayat setelah berdering agar memori RAM tidak bengkak
          alarm.voiceDataUrl = null;
          scheduleUpdated = true;
        }
      }

      // Hapus jadwal yang sudah fired: true lebih dari 1 jam (3600_000 ms)
      const prevLength = room.scheduledAlarms.length;
      room.scheduledAlarms = room.scheduledAlarms.filter(a => {
        if (!a.fired) return true;
        const firedTime = a.firedAt || a.triggerTime || 0;
        return (now - firedTime) <= SCHEDULE_CLEANUP_TTL_MS;
      });
      if (room.scheduledAlarms.length !== prevLength) {
        scheduleUpdated = true;
      }

      if (scheduleUpdated) {
        io.to(roomId).emit('scheduled_list_updated', room.scheduledAlarms);
      }
    }

    // 2. Pembersihan kamar pasif jika tidak ada user, tidak ada jadwal tertunda, tidak ada alarm aktif, dan > 48 jam idle
    const hasUsers = room.users && Object.keys(room.users).length > 0;
    const hasPendingSchedules = room.scheduledAlarms && room.scheduledAlarms.some(a => !a.fired);
    const hasActiveAlarm = room.isAlarmActive || !!room.currentAlarm;
    const isIdleExpired = (now - (room.lastActivityAt || now)) > ROOM_IDLE_TTL_MS;

    if (!hasUsers && !hasPendingSchedules && !hasActiveAlarm && isIdleExpired) {
      console.log(`[CLEANUP] Room ${roomId} dihapus karena tidak aktif melebihi 48 jam.`);
      delete rooms[roomId];
    }
  }
}, 1000);
if (maintenanceInterval.unref) maintenanceInterval.unref();

app.get('/health', (req, res) => {
  res.json({
    status: 'online',
    activeRooms: Object.keys(rooms).length,
    timestamp: new Date().toISOString()
  });
});

io.on('connection', (socket) => {
  console.log(`[Koneksi Baru] ID Klien: ${socket.id}`);

  // Bergabung ke ruangan pasangan dengan verifikasi PIN rahasia (AUD-01)
  socket.on('join_room', (data = {}) => {
    const roomId = String(data.roomId || '').trim().toUpperCase();
    const username = String(data.username || 'Pasangan').trim().slice(0, 50);
    const pin = String(data.pin || '1234').trim();
    const pinHash = hashPin(pin);

    if (!roomId) return;

    if (!rooms[roomId]) {
      // Buat kamar baru dengan kunci PIN yang didaftarkan pertama kali
      rooms[roomId] = {
        pinHash,
        users: {},
        isAlarmActive: false,
        currentAlarm: null,
        scheduledAlarms: [],
        lastActivityAt: Date.now()
      };
    } else if (rooms[roomId].pinHash && rooms[roomId].pinHash !== pinHash) {
      // Tolak jika PIN tidak cocok dengan kamar yang sudah ada
      console.log(`[AUTH DITOLAK] PIN salah untuk Room ${roomId} dari ${username} (${socket.id})`);
      socket.emit('auth_error', { 
        message: 'PIN kamar salah! Pastikan PIN di HP Bima dan HP Pacar sama persis.' 
      });
      return;
    }

    socket.join(roomId);
    socket.data = { ...(socket.data || {}), roomId, username };

    rooms[roomId].users[socket.id] = { 
      id: socket.id,
      username, 
      joinedAt: Date.now() 
    };
    rooms[roomId].lastActivityAt = Date.now();

    console.log(`[Room ${roomId}] ${username} (${socket.id}) berhasil masuk kamar dengan PIN valid.`);
    
    io.to(roomId).emit('room_state', {
      roomId,
      users: Object.values(rooms[roomId].users),
      isAlarmActive: rooms[roomId].isAlarmActive,
      currentAlarm: rooms[roomId].currentAlarm,
      scheduledAlarms: rooms[roomId].scheduledAlarms
    });
  });

  // Memicu alarm instan jarak jauh
  socket.on('trigger_alarm', (data = {}) => {
    // Keamanan AUD-01: Wajib menggunakan roomId dari sesi socket yang terautentikasi
    const roomId = socket.data?.roomId;
    if (!roomId || !rooms[roomId]) {
      console.warn(`[PERINGATAN] Akses ditolak: Socket ${socket.id} mencoba memicu alarm tanpa terdaftar di kamar.`);
      return;
    }

    // AUD-03: Rate limiting per socket (min 2000 ms)
    if (isRateLimited(socket, 2000)) {
      socket.emit('rate_limit_error', { message: 'Harap tunggu 2 detik sebelum mengirim perintah lagi.' });
      return;
    }

    const alarmPayload = {
      id: 'instan_' + Date.now(),
      senderSocketId: socket.id, // AUD-07: Catat ID koneksi fisik perangkat pengirim
      sender: data.sender || socket.data?.username || 'Bima',
      target: data.target || data.targetName || 'Pacar',
      volume: typeof data.volume === 'number' ? data.volume : 100,
      sound: data.sound || 'siren',
      message: String(data.message || 'Waktunya bangun!').slice(0, 200),
      voiceDataUrl: sanitizeVoiceDataUrl(data.voiceDataUrl), // AUD-04: Sanitasi Base64 Audio
      missionRequired: Boolean(data.missionRequired),
      timestamp: Date.now()
    };

    rooms[roomId].isAlarmActive = true;
    rooms[roomId].currentAlarm = alarmPayload;
    rooms[roomId].lastActivityAt = Date.now();

    console.log(`[ALARM INSTAN] Room ${roomId} dari ${alarmPayload.sender} (${socket.id}) ke ${alarmPayload.target} vol: ${alarmPayload.volume}%`);
    io.to(roomId).emit('alarm_triggered', alarmPayload);

    // AUD-02: Kosongkan voiceDataUrl pada server RAM agar string Base64 tidak mengendap
    rooms[roomId].currentAlarm = { ...alarmPayload, voiceDataUrl: null };
  });

  // Menjadwalkan alarm jarak jauh (Custom Jam & Pesan)
  socket.on('schedule_alarm', (data = {}) => {
    // Keamanan AUD-01: Wajib menggunakan roomId dari sesi socket yang terautentikasi
    const roomId = socket.data?.roomId;
    if (!roomId || !rooms[roomId]) {
      console.warn(`[PERINGATAN] Akses ditolak: Socket ${socket.id} mencoba menjadwalkan alarm tanpa terdaftar di kamar.`);
      return;
    }

    // AUD-03: Rate limiting per socket (min 2000 ms)
    if (isRateLimited(socket, 2000)) {
      socket.emit('rate_limit_error', { message: 'Harap tunggu 2 detik sebelum mengirim perintah lagi.' });
      return;
    }

    // AUD-02: Batas maksimal kuota jadwal aktif yang belum berbunyi
    const activeSchedulesCount = (rooms[roomId].scheduledAlarms || []).filter(a => !a.fired).length;
    if (activeSchedulesCount >= MAX_SCHEDULED_PER_ROOM) {
      socket.emit('alarm_error', { message: 'Batas maksimal 10 jadwal aktif tercapai.' });
      return;
    }

    const newAlarm = {
      id: 'sch_' + Date.now(),
      creatorSocketId: socket.id,
      creator: data.creator || socket.data?.username || 'Bima',
      sender: data.creator || socket.data?.username || 'Bima',
      target: data.target || data.targetName || 'Pacar',
      targetName: data.target || data.targetName || 'Pacar',
      timeString: data.timeString || '06:30', // Format "HH:mm" misal "06:30"
      triggerTime: Number(data.triggerTime) || Date.now(), // Epoch millisecond
      volume: typeof data.volume === 'number' ? data.volume : 100,
      sound: data.sound || 'siren',
      message: String(data.message || 'Waktunya bangun!').slice(0, 200),
      voiceDataUrl: sanitizeVoiceDataUrl(data.voiceDataUrl), // AUD-04: Sanitasi Base64 Audio
      missionRequired: Boolean(data.missionRequired),
      fired: false,
      createdAt: Date.now()
    };

    rooms[roomId].scheduledAlarms.push(newAlarm);
    rooms[roomId].lastActivityAt = Date.now();
    console.log(`[JADWAL DIBUAT] Room ${roomId} oleh ${newAlarm.creator} untuk jam ${newAlarm.timeString}`);

    io.to(roomId).emit('scheduled_list_updated', rooms[roomId].scheduledAlarms);
  });

  // Menghapus alarm yang dijadwalkan
  socket.on('delete_scheduled_alarm', (data = {}) => {
    const alarmId = data.alarmId;
    const roomId = socket.data?.roomId;
    if (roomId && rooms[roomId] && alarmId) {
      rooms[roomId].scheduledAlarms = rooms[roomId].scheduledAlarms.filter(a => a.id !== alarmId);
      rooms[roomId].lastActivityAt = Date.now();
      io.to(roomId).emit('scheduled_list_updated', rooms[roomId].scheduledAlarms);
    }
  });

  // Mematikan alarm (tombol "Sudah Bangun")
  socket.on('stop_alarm', (data = {}) => {
    // Keamanan AUD-01: Wajib menggunakan roomId dari sesi socket yang terautentikasi
    const roomId = socket.data?.roomId;
    if (!roomId || !rooms[roomId]) return;

    rooms[roomId].isAlarmActive = false;
    rooms[roomId].currentAlarm = null;
    rooms[roomId].lastActivityAt = Date.now();

    const stopperName = data.stopper || socket.data?.username || 'Pacar';
    console.log(`[ALARM DIMATIKAN] Room ${roomId} oleh ${stopperName} (${socket.id})`);

    io.to(roomId).emit('alarm_stopped', {
      stopper: stopperName,
      stopperSocketId: socket.id,
      timestamp: Date.now()
    });
  });

  socket.on('disconnect', () => {
    const { roomId, username } = socket.data || {};
    if (roomId && rooms[roomId]) {
      delete rooms[roomId].users[socket.id];
      rooms[roomId].lastActivityAt = Date.now();
      io.to(roomId).emit('room_state', {
        roomId,
        users: Object.values(rooms[roomId].users),
        isAlarmActive: rooms[roomId].isAlarmActive,
        currentAlarm: rooms[roomId].currentAlarm,
        scheduledAlarms: rooms[roomId].scheduledAlarms
      });

      // PENTING: Kamar dan daftar jadwal alarm TETAP DISIMPAN di memori server!
      // Jangan hapus rooms[roomId] saat kedua HP tidur/offline agar jadwal alarm jam 06.30 pagi tetap aktif!
    }
  });
});

const PORT = process.env.PORT || 4000;
if (require.main === module) {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[SERVER BERJALAN] Server Alarm Pasangan aktif di port ${PORT}`);
  });
}

module.exports = {
  app,
  server,
  io,
  rooms,
  isRateLimited,
  sanitizeVoiceDataUrl,
  MAX_SCHEDULED_PER_ROOM,
  ROOM_IDLE_TTL_MS,
  SCHEDULE_CLEANUP_TTL_MS,
  hashPin
};
