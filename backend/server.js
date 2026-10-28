const http = require('http');
const fs = require('fs');
const path = require('path');
const { Server } = require('socket.io');
const crypto = require('crypto');

// Konfigurasi CORS (AUD-03): Membaca process.env.ALLOWED_ORIGINS jika didefinisikan
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? (process.env.ALLOWED_ORIGINS.includes(',')
      ? process.env.ALLOWED_ORIGINS.split(',').map(s => s.trim()).filter(Boolean)
      : process.env.ALLOWED_ORIGINS.trim())
  : '*';

// Helper enkripsi hash PIN kamar (AUD-01)
function hashPin(pin) {
  return crypto.createHash('sha256').update(String(pin || '1234')).digest('hex');
}

// Konstanta AUD-02 (Manajemen Memori & Kuota)
const MAX_SCHEDULED_PER_ROOM = 10;
const ROOM_IDLE_TTL_MS = 48 * 60 * 60 * 1000; // 48 Jam
const SCHEDULE_CLEANUP_TTL_MS = 3600_000; // 1 Jam
const MAX_ROOMS = 1000;
const MAX_ROOM_ID_LENGTH = 32;
const MIN_NEW_ROOM_PIN_LENGTH = 6;
const JOIN_FAILURE_LIMIT = 5;
const JOIN_FAILURE_WINDOW_MS = 60000;
const ALARM_ACTIVE_TTL_MS = 3600_000; // 1 Jam

// Regex dan sanitasi Audio Data URI (AUD-04)
const AUDIO_DATA_URL_REGEX = /^data:audio\/(webm|ogg|mp3|mpeg|wav|mp4|aac|x-m4a);base64,[A-Za-z0-9+/=]+$/i;

function sanitizeVoiceDataUrl(rawUrl) {
  if (typeof rawUrl !== 'string') return null;
  const trimmed = rawUrl.trim();
  if (!trimmed) return null;
  return AUDIO_DATA_URL_REGEX.test(trimmed) ? trimmed : null;
}

// Payload daftar jadwal tidak boleh membawa audio Base64
function publicAlarms(list = []) {
  return list.map(({ voiceDataUrl, ...alarm }) => alarm);
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

const server = http.createServer((req, res) => {
  const pathname = (req.url || '').split('?')[0];
  if (req.method === 'GET' && pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'online',
      activeRooms: Object.keys(rooms).length,
      timestamp: new Date().toISOString()
    }));
    return;
  }
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    methods: ['GET', 'POST']
  },
  maxHttpBufferSize: 2e7 // 20 MB untuk transmisi rekaman suara
});

// Menyimpan data ruangan pasangan, status alarm, dan jadwal alarm
const rooms = {};

// Persistensi PIN & jadwal (users/status alarm tidak disimpan)
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'rooms.json');
const PERSIST = require.main === module;

// shortcut: custom alarm audio is not persisted, so after a server restart voice/TikTok schedules fall back to the siren; add a blob store if this matters.
function serializeRooms() {
  const data = {};
  for (const roomId in rooms) {
    data[roomId] = {
      pinHash: rooms[roomId].pinHash,
      scheduledAlarms: (rooms[roomId].scheduledAlarms || [])
        .filter(a => !a.fired)
        .map(({ voiceDataUrl, ...alarm }) => alarm)
    };
  }
  return data;
}

let saveTimer = null;
function saveRooms() {
  if (!PERSIST || saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const tmpFile = DATA_FILE + '.tmp';
    try {
      fs.writeFileSync(tmpFile, JSON.stringify(serializeRooms()));
      fs.renameSync(tmpFile, DATA_FILE);
    } catch (err) {
      console.error(`[PERSIST] Gagal menyimpan data rooms: ${err.message}`);
    }
  }, 250);
  if (saveTimer.unref) saveTimer.unref();
}

function loadRooms() {
  if (!PERSIST) return;
  try {
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    const now = Date.now();
    for (const roomId in parsed) {
      const saved = parsed[roomId] || {};
      rooms[roomId] = {
        pinHash: saved.pinHash,
        users: {},
        isAlarmActive: false,
        currentAlarm: null,
        scheduledAlarms: (Array.isArray(saved.scheduledAlarms) ? saved.scheduledAlarms : [])
          .filter(a => !a.fired)
          .map(({ voiceDataUrl, ...alarm }) => alarm),
        lastActivityAt: now
      };
    }
    console.log(`[PERSIST] ${Object.keys(rooms).length} room dimuat dari ${DATA_FILE}`);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error(`[PERSIST] Data rooms korup, mulai dengan state kosong: ${err.message}`);
    }
  }
}
loadRooms();

// Rate limit percobaan PIN gagal per alamat klien
const joinFailures = new Map();

function pruneJoinFailures(now) {
  for (const [address, record] of joinFailures) {
    if (now - record.windowStart > JOIN_FAILURE_WINDOW_MS) joinFailures.delete(address);
  }
}

function recordJoinFailure(address) {
  const now = Date.now();
  let record = joinFailures.get(address);
  if (!record || now - record.windowStart > JOIN_FAILURE_WINDOW_MS) {
    record = { count: 0, windowStart: now };
  }
  record.count += 1;
  joinFailures.set(address, record);
}

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
        io.to(roomId).emit('scheduled_list_updated', publicAlarms(room.scheduledAlarms));
        saveRooms();
      }
    }

    // 2. Batalkan alarm aktif yang menggantung lebih dari 1 jam
    if (room.isAlarmActive) {
      const alarmAt = (room.currentAlarm && (room.currentAlarm.timestamp || room.currentAlarm.firedAt)) || 0;
      if (now - alarmAt > ALARM_ACTIVE_TTL_MS) {
        room.isAlarmActive = false;
        room.currentAlarm = null;
        console.log(`[ALARM TIMEOUT] Alarm Room ${roomId} dihentikan server karena aktif > 1 jam.`);
        io.to(roomId).emit('alarm_stopped', { stopper: 'Server (timeout)', timestamp: now });
        saveRooms();
      }
    }

    // 3. Pembersihan kamar pasif jika tidak ada user, tidak ada jadwal tertunda, tidak ada alarm aktif, dan > 48 jam idle
    const hasUsers = room.users && Object.keys(room.users).length > 0;
    const hasPendingSchedules = room.scheduledAlarms && room.scheduledAlarms.some(a => !a.fired);
    const hasActiveAlarm = room.isAlarmActive || !!room.currentAlarm;
    const isIdleExpired = (now - (room.lastActivityAt || now)) > ROOM_IDLE_TTL_MS;

    if (!hasUsers && !hasPendingSchedules && !hasActiveAlarm && isIdleExpired) {
      console.log(`[CLEANUP] Room ${roomId} dihapus karena tidak aktif melebihi 48 jam.`);
      delete rooms[roomId];
      saveRooms();
    }
  }
}, 1000);
if (maintenanceInterval.unref) maintenanceInterval.unref();

io.on('connection', (socket) => {
  console.log(`[Koneksi Baru] ID Klien: ${socket.id}`);

  // Bergabung ke ruangan pasangan dengan verifikasi PIN rahasia (AUD-01)
  socket.on('join_room', (data = {}) => {
    const address = socket.handshake?.address || 'unknown';
    pruneJoinFailures(Date.now());

    const failure = joinFailures.get(address);
    if (failure && failure.count >= JOIN_FAILURE_LIMIT) {
      socket.emit('auth_error', { message: 'Terlalu banyak percobaan PIN. Coba lagi nanti.' });
      return;
    }

    const roomId = String(data.roomId || '').trim().toUpperCase().slice(0, MAX_ROOM_ID_LENGTH);
    const username = String(data.username || 'Pasangan').trim().slice(0, 50);
    const pin = String(data.pin ?? '').trim();

    if (!roomId || !pin) {
      recordJoinFailure(address);
      socket.emit('auth_error', { message: 'Room ID dan PIN wajib diisi.' });
      return;
    }

    const pinHash = hashPin(pin);

    if (!rooms[roomId]) {
      // Buat kamar baru dengan kunci PIN yang didaftarkan pertama kali
      if (pin.length < MIN_NEW_ROOM_PIN_LENGTH) {
        recordJoinFailure(address);
        socket.emit('auth_error', { message: `PIN kamar baru minimal ${MIN_NEW_ROOM_PIN_LENGTH} karakter.` });
        return;
      }
      if (Object.keys(rooms).length >= MAX_ROOMS) {
        recordJoinFailure(address);
        socket.emit('auth_error', { message: 'Server penuh. Coba lagi nanti.' });
        return;
      }
      rooms[roomId] = {
        pinHash,
        users: {},
        isAlarmActive: false,
        currentAlarm: null,
        scheduledAlarms: [],
        lastActivityAt: Date.now()
      };
      saveRooms();
    } else if (rooms[roomId].pinHash && rooms[roomId].pinHash !== pinHash) {
      // Tolak jika PIN tidak cocok dengan kamar yang sudah ada
      recordJoinFailure(address);
      console.log(`[AUTH DITOLAK] PIN salah untuk Room ${roomId} dari ${username} (${socket.id})`);
      socket.emit('auth_error', { 
        message: 'PIN kamar salah! Pastikan PIN di HP Bima dan HP Pacar sama persis.' 
      });
      return;
    }

    joinFailures.delete(address);

    socket.join(roomId);
    socket.data = {
      ...(socket.data || {}),
      roomId,
      username,
      deviceId: String(data.deviceId || socket.id).slice(0, 64)
    };

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
      scheduledAlarms: publicAlarms(rooms[roomId].scheduledAlarms)
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
      senderDeviceId: socket.data.deviceId, // Identitas perangkat dari sesi join, bukan dari klien
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
      senderDeviceId: socket.data.deviceId, // Identitas perangkat dari sesi join
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

    io.to(roomId).emit('scheduled_list_updated', publicAlarms(rooms[roomId].scheduledAlarms));
    saveRooms();
  });

  // Menghapus alarm yang dijadwalkan
  socket.on('delete_scheduled_alarm', (data = {}) => {
    const alarmId = data.alarmId;
    const roomId = socket.data?.roomId;
    if (roomId && rooms[roomId] && alarmId) {
      rooms[roomId].scheduledAlarms = rooms[roomId].scheduledAlarms.filter(a => a.id !== alarmId);
      rooms[roomId].lastActivityAt = Date.now();
      io.to(roomId).emit('scheduled_list_updated', publicAlarms(rooms[roomId].scheduledAlarms));
      saveRooms();
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
    saveRooms();
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
        scheduledAlarms: publicAlarms(rooms[roomId].scheduledAlarms)
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
  server,
  io,
  rooms,
  isRateLimited,
  sanitizeVoiceDataUrl,
  publicAlarms,
  MAX_SCHEDULED_PER_ROOM,
  ROOM_IDLE_TTL_MS,
  SCHEDULE_CLEANUP_TTL_MS,
  MAX_ROOMS,
  MAX_ROOM_ID_LENGTH,
  MIN_NEW_ROOM_PIN_LENGTH,
  JOIN_FAILURE_LIMIT,
  JOIN_FAILURE_WINDOW_MS,
  ALARM_ACTIVE_TTL_MS,
  hashPin
};
