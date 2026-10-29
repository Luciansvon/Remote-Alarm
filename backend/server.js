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
const AUDIO_ID_REGEX = /^aud_[a-zA-Z0-9_-]{6,64}$/;

function sanitizeVoiceDataUrl(rawUrl) {
  if (typeof rawUrl !== 'string') return null;
  const trimmed = rawUrl.trim();
  if (!trimmed) return null;
  return AUDIO_DATA_URL_REGEX.test(trimmed) ? trimmed : null;
}

function computeAudioId(dataUrl) {
  return 'aud_' + crypto.createHash('sha256').update(String(dataUrl)).digest('hex').slice(0, 16);
}

// Payload daftar jadwal tidak boleh membawa audio Base64
function publicAlarms(list = []) {
  return list.map(({ voiceDataUrl, ...alarm }) => alarm);
}

// Helper pembatas frekuensi aksi per socket (AUD-03)
function isRateLimited(socket, minIntervalMs = 2000) {
  const now = Date.now();
  if (!socket || typeof socket !== 'object') return false;
  if (!socket.data) socket.data = {};
  const lastActionAt = socket.data.lastActionAt || 0;
  if (now - lastActionAt < minIntervalMs) {
    return true;
  }
  socket.data.lastActionAt = now;
  return false;
}

const CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

function sendJson(res, status, payload) {
  res.writeHead(status, CORS_HEADERS);
  res.end(JSON.stringify(payload));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://localhost');
  const pathname = url.pathname;

  if (req.method === 'OPTIONS' && (pathname === '/health' || pathname.startsWith('/api/'))) {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }

  if (req.method === 'GET' && pathname === '/health') {
    sendJson(res, 200, {
      status: 'online',
      activeRooms: Object.keys(rooms).length,
      timestamp: new Date().toISOString()
    });
    return;
  }

  if (pathname === '/api/poll' && req.method === 'GET') {
    const roomId = String(url.searchParams.get('roomId') || '').trim().toUpperCase().slice(0, MAX_ROOM_ID_LENGTH);
    const pin = String(url.searchParams.get('pin') ?? '').trim();
    if (!roomId || !pin) {
      sendJson(res, 403, { ok: false, error: 'PIN salah' });
      return;
    }
    const pinHash = hashPin(pin);
    if (!rooms[roomId]) {
      if (pin.length < MIN_NEW_ROOM_PIN_LENGTH || Object.keys(rooms).length >= MAX_ROOMS) {
        sendJson(res, 403, { ok: false, error: 'PIN salah' });
        return;
      }
      rooms[roomId] = {
        pinHash,
        users: {},
        isAlarmActive: false,
        currentAlarm: null,
        scheduledAlarms: [],
        deletedScheduleIds: [],
        customAudios: [],
        lastCustomText: null,
        lastActivityAt: Date.now()
      };
      saveRooms(true);
    } else if (rooms[roomId].pinHash && rooms[roomId].pinHash !== pinHash) {
      sendJson(res, 403, { ok: false, error: 'PIN salah' });
      return;
    }
    const room = rooms[roomId];
    room.lastActivityAt = Date.now();
    sendJson(res, 200, {
      ok: true,
      serverTime: Date.now(),
      isAlarmActive: room.isAlarmActive,
      currentAlarm: room.currentAlarm,
      lastCustomText: room.lastCustomText || null,
      scheduledAlarms: publicAlarms(room.scheduledAlarms),
      customAudios: room.customAudios || []
    });
    return;
  }

  if (pathname === '/api/audio' && req.method === 'GET') {
    const roomId = String(url.searchParams.get('roomId') || '').trim().toUpperCase().slice(0, MAX_ROOM_ID_LENGTH);
    const pin = String(url.searchParams.get('pin') ?? '').trim();
    const audioId = String(url.searchParams.get('audioId') || '').trim();
    const room = rooms[roomId];
    if (!roomId || !pin || !room || room.pinHash !== hashPin(pin)) {
      sendJson(res, 403, { ok: false, error: 'PIN salah' });
      return;
    }
    const voiceDataUrl = getAudioFromDisk(audioId);
    if (!voiceDataUrl) {
      sendJson(res, 404, { ok: false });
      return;
    }
    sendJson(res, 200, { ok: true, audioId, voiceDataUrl });
    return;
  }

  if (pathname === '/api/stop' && (req.method === 'POST' || req.method === 'GET')) {
    const roomId = String(url.searchParams.get('roomId') || '').trim().toUpperCase().slice(0, MAX_ROOM_ID_LENGTH);
    const pin = String(url.searchParams.get('pin') ?? '').trim();
    const stopper = String(url.searchParams.get('stopper') || 'Pasangan').trim().slice(0, 50) || 'Pasangan';
    const room = rooms[roomId];
    if (!roomId || !pin || !room || room.pinHash !== hashPin(pin)) {
      sendJson(res, 403, { ok: false, error: 'PIN salah' });
      return;
    }
    room.isAlarmActive = false;
    room.currentAlarm = null;
    room.lastActivityAt = Date.now();
    io.to(roomId).emit('alarm_stopped', { stopper, timestamp: Date.now() });
    saveRooms(true);
    sendJson(res, 200, { ok: true });
    return;
  }

  sendJson(res, 404, { error: 'Not found' });
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

// Persistensi PIN, jadwal & audio cache
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'rooms.json');
const PERSIST = process.env.NO_PERSIST !== '1';
const AUDIO_DIR = process.env.AUDIO_DIR || path.join(__dirname, 'audio_cache');
const memoryAudioCache = new Map();

if (PERSIST) {
  try {
    fs.mkdirSync(AUDIO_DIR, { recursive: true });
  } catch (err) {
    console.error(`[AUDIO CACHE] Gagal membuat direktori: ${err.message}`);
  }
}

function saveAudioToDisk(audioId, dataUrl) {
  if (!AUDIO_ID_REGEX.test(audioId)) return false;
  const clean = sanitizeVoiceDataUrl(dataUrl);
  if (!clean) return false;

  if (memoryAudioCache.has(audioId)) memoryAudioCache.delete(audioId);
  memoryAudioCache.set(audioId, clean);
  while (memoryAudioCache.size > 30) {
    const oldestKey = memoryAudioCache.keys().next().value;
    memoryAudioCache.delete(oldestKey);
  }

  if (PERSIST) {
    try {
      fs.mkdirSync(AUDIO_DIR, { recursive: true });
      fs.writeFileSync(path.join(AUDIO_DIR, audioId + '.dat'), clean, 'utf8');
      const files = fs.readdirSync(AUDIO_DIR)
        .filter(f => f.endsWith('.dat'))
        .map(f => {
          const p = path.join(AUDIO_DIR, f);
          return { p, mtime: fs.statSync(p).mtimeMs };
        })
        .sort((a, b) => a.mtime - b.mtime);
      while (files.length > 30) {
        const oldest = files.shift();
        try { fs.unlinkSync(oldest.p); } catch {}
      }
    } catch (err) {
      console.error(`[AUDIO CACHE] Gagal menyimpan audio ${audioId}: ${err.message}`);
    }
  }
  return true;
}

function getAudioFromDisk(audioId) {
  if (!audioId || !AUDIO_ID_REGEX.test(audioId)) return null;
  if (memoryAudioCache.has(audioId)) return memoryAudioCache.get(audioId);
  if (PERSIST) {
    const filePath = path.join(AUDIO_DIR, audioId + '.dat');
    if (fs.existsSync(filePath)) {
      try {
        const clean = sanitizeVoiceDataUrl(fs.readFileSync(filePath, 'utf8'));
        if (clean) {
          memoryAudioCache.set(audioId, clean);
          return clean;
        }
      } catch {}
    }
  }
  return null;
}

function hasAudioOnServer(audioId) {
  if (!audioId || !AUDIO_ID_REGEX.test(audioId)) return false;
  if (memoryAudioCache.has(audioId)) return true;
  return PERSIST && fs.existsSync(path.join(AUDIO_DIR, audioId + '.dat'));
}

function upsertRoomAudio(room, audioId, audioName) {
  if (!room || !AUDIO_ID_REGEX.test(audioId)) return;
  if (!Array.isArray(room.customAudios)) room.customAudios = [];
  const existing = room.customAudios.find(a => a.audioId === audioId);
  const name = String(audioName || existing?.audioName || 'Audio Kustom').trim().slice(0, 80) || 'Audio Kustom';
  room.customAudios = [
    { audioId, audioName: name, updatedAt: Date.now() },
    ...room.customAudios.filter(a => a.audioId !== audioId)
  ].slice(0, 20);
}

function emitAlarmToRoom(roomId, alarmPayload) {
  const fullAudio = alarmPayload.voiceDataUrl || (alarmPayload.audioId ? getAudioFromDisk(alarmPayload.audioId) : null);
  const sids = io.sockets.adapter.rooms.get(roomId);
  if (!sids) return;
  for (const sid of sids) {
    const s = io.sockets.sockets.get(sid);
    if (!s) continue;
    if (alarmPayload.audioId && s.data?.cachedAudioIds?.has(alarmPayload.audioId)) {
      s.emit('alarm_triggered', { ...alarmPayload, voiceDataUrl: null });
    } else {
      s.emit('alarm_triggered', { ...alarmPayload, voiceDataUrl: fullAudio });
    }
  }
}

function serializeRooms() {
  const data = {};
  const now = Date.now();
  for (const roomId in rooms) {
    const r = rooms[roomId];
    data[roomId] = {
      pinHash: r.pinHash,
      scheduledAlarms: (r.scheduledAlarms || [])
        .filter(a => !a.fired || (now - (a.firedAt || a.triggerTime || 0)) <= 24 * 3600_000)
        .map(({ voiceDataUrl, ...alarm }) => alarm),
      deletedScheduleIds: (r.deletedScheduleIds || []).slice(-50),
      customAudios: (r.customAudios || []).slice(0, 20),
      lastCustomText: r.lastCustomText || null
    };
  }
  return data;
}

let saveTimer = null;
function writeRoomsSync() {
  if (!PERSIST) return;
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  const tmpFile = DATA_FILE + '.tmp';
  try {
    fs.writeFileSync(tmpFile, JSON.stringify(serializeRooms()));
    fs.renameSync(tmpFile, DATA_FILE);
  } catch (err) {
    console.error(`[PERSIST] Gagal menyimpan data rooms: ${err.message}`);
  }
}

function saveRooms(immediate = false) {
  if (!PERSIST) return;
  if (immediate) {
    writeRoomsSync();
    return;
  }
  if (saveTimer) return;
  saveTimer = setTimeout(writeRoomsSync, 250);
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
          .filter(a => !a.fired || (now - (a.firedAt || a.triggerTime || 0)) <= 24 * 3600_000)
          .map(({ voiceDataUrl, ...alarm }) => alarm),
        deletedScheduleIds: Array.isArray(saved.deletedScheduleIds) ? saved.deletedScheduleIds.slice(-50) : [],
        customAudios: Array.isArray(saved.customAudios) ? saved.customAudios.slice(0, 20) : [],
        lastCustomText: saved.lastCustomText || null,
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

if (PERSIST) {
  const flushAndExit = () => {
    writeRoomsSync();
    process.exit(0);
  };
  process.on('SIGINT', flushAndExit);
  process.on('SIGTERM', flushAndExit);
}

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

function buildRoomState(roomId) {
  const room = rooms[roomId];
  return {
    roomId,
    users: Object.values(room.users || {}),
    isAlarmActive: room.isAlarmActive,
    currentAlarm: room.currentAlarm,
    customAudios: room.customAudios || [],
    cachedAudioIds: (room.customAudios || []).map(a => a.audioId).filter(hasAudioOnServer),
    lastCustomText: room.lastCustomText || null,
    scheduledAlarms: publicAlarms(room.scheduledAlarms)
  };
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
          emitAlarmToRoom(roomId, alarm);

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
    let shouldPersistImmediate = false;

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
        deletedScheduleIds: [],
        customAudios: [],
        lastCustomText: null,
        lastActivityAt: Date.now()
      };
      shouldPersistImmediate = true;
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

    const room = rooms[roomId];
    if (!Array.isArray(room.scheduledAlarms)) room.scheduledAlarms = [];
    if (!Array.isArray(room.deletedScheduleIds)) room.deletedScheduleIds = [];
    if (!Array.isArray(room.customAudios)) room.customAudios = [];
    if (room.lastCustomText === undefined) room.lastCustomText = null;

    socket.join(roomId);
    socket.data = {
      ...(socket.data || {}),
      roomId,
      username,
      deviceId: String(data.deviceId || socket.id).slice(0, 64),
      cachedAudioIds: new Set(
        Array.isArray(data.cachedAudioIds)
          ? data.cachedAudioIds.filter(id => AUDIO_ID_REGEX.test(id))
          : []
      )
    };

    if (Array.isArray(data.clientSchedules)) {
      const existingIds = new Set(room.scheduledAlarms.map(a => a.id));
      const deletedIds = new Set(room.deletedScheduleIds);
      for (const item of data.clientSchedules) {
        if (!item || typeof item !== 'object') continue;
        const id = String(item.id || '').trim().slice(0, 64);
        const triggerTime = Number(item.triggerTime);
        if (!id || !Number.isFinite(triggerTime)) continue;
        if (existingIds.has(id) || deletedIds.has(id)) continue;
        const activeCount = room.scheduledAlarms.filter(a => !a.fired).length;
        if (!item.fired && activeCount >= MAX_SCHEDULED_PER_ROOM) continue;
        const audioId = AUDIO_ID_REGEX.test(item.audioId) ? item.audioId : null;
        const audioName = audioId ? String(item.audioName || 'Audio Kustom').trim().slice(0, 80) : null;
        room.scheduledAlarms.push({
          id,
          creatorSocketId: item.creatorSocketId || socket.id,
          senderDeviceId: String(item.senderDeviceId || socket.data.deviceId).slice(0, 64),
          creator: String(item.creator || item.sender || username).slice(0, 50),
          sender: String(item.sender || item.creator || username).slice(0, 50),
          target: String(item.target || item.targetName || 'Pacar').slice(0, 50),
          targetName: String(item.targetName || item.target || 'Pacar').slice(0, 50),
          timeString: String(item.timeString || '06:30').slice(0, 10),
          triggerTime,
          volume: typeof item.volume === 'number' ? item.volume : 100,
          sound: String(item.sound || 'siren').slice(0, 32),
          message: String(item.message || 'Waktunya bangun!').slice(0, 200),
          voiceDataUrl: null,
          audioId,
          audioName,
          missionRequired: Boolean(item.missionRequired),
          fired: Boolean(item.fired),
          createdAt: Number(item.createdAt) || Date.now()
        });
        existingIds.add(id);
        shouldPersistImmediate = true;
      }
    }

    if (shouldPersistImmediate) {
      saveRooms(true);
    }

    room.users[socket.id] = {
      id: socket.id,
      username,
      joinedAt: Date.now()
    };
    room.lastActivityAt = Date.now();

    console.log(`[Room ${roomId}] ${username} (${socket.id}) berhasil masuk kamar dengan PIN valid.`);

    io.to(roomId).emit('room_state', buildRoomState(roomId));
  });

  socket.on('client_audio_cached', (data = {}) => {
    if (data.audioId && AUDIO_ID_REGEX.test(data.audioId) && socket.data?.cachedAudioIds) {
      socket.data.cachedAudioIds.add(data.audioId);
    }
  });

  socket.on('upload_audio', (data = {}) => {
    const roomId = socket.data?.roomId;
    if (!roomId || !rooms[roomId]) return;
    const voiceDataUrl = sanitizeVoiceDataUrl(data.voiceDataUrl);
    if (!voiceDataUrl) return;
    const audioId = AUDIO_ID_REGEX.test(data.audioId) ? data.audioId : computeAudioId(voiceDataUrl);
    const audioName = String(data.audioName || 'Audio Kustom').trim().slice(0, 80) || 'Audio Kustom';

    saveAudioToDisk(audioId, voiceDataUrl);
    if (!socket.data.cachedAudioIds) socket.data.cachedAudioIds = new Set();
    socket.data.cachedAudioIds.add(audioId);
    upsertRoomAudio(rooms[roomId], audioId, audioName);
    rooms[roomId].lastActivityAt = Date.now();

    socket.emit('audio_uploaded', { audioId, audioName });
    io.to(roomId).emit('audio_catalog_updated', rooms[roomId].customAudios);

    const sids = io.sockets.adapter.rooms.get(roomId) || new Set();
    for (const sid of sids) {
      if (sid === socket.id) continue;
      const s = io.sockets.sockets.get(sid);
      if (s && !s.data?.cachedAudioIds?.has(audioId)) {
        s.emit('audio_sync_payload', { audioId, audioName, voiceDataUrl });
      }
    }
    saveRooms(true);
  });

  socket.on('get_audio', (data = {}) => {
    const roomId = socket.data?.roomId;
    if (!roomId || !rooms[roomId]) return;
    const voiceDataUrl = getAudioFromDisk(data.audioId);
    if (!voiceDataUrl) return;
    if (!socket.data.cachedAudioIds) socket.data.cachedAudioIds = new Set();
    socket.data.cachedAudioIds.add(data.audioId);
    const catalogEntry = (rooms[roomId].customAudios || []).find(a => a.audioId === data.audioId);
    const audioName = String(data.audioName || catalogEntry?.audioName || 'Audio Kustom').trim().slice(0, 80);
    socket.emit('audio_sync_payload', { audioId: data.audioId, audioName, voiceDataUrl });
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

    const cleanVoice = sanitizeVoiceDataUrl(data.voiceDataUrl);
    let audioId = AUDIO_ID_REGEX.test(data.audioId) ? data.audioId : null;
    let audioName = data.audioName ? String(data.audioName).trim().slice(0, 80) : null;
    if (cleanVoice) {
      if (!audioId) audioId = computeAudioId(cleanVoice);
      audioName = audioName || 'Audio Kustom';
      saveAudioToDisk(audioId, cleanVoice);
      upsertRoomAudio(rooms[roomId], audioId, audioName);
      if (AUDIO_ID_REGEX.test(data.audioId)) {
        socket.data.cachedAudioIds?.add(audioId);
      }
    } else if (audioId) {
      const catalogEntry = (rooms[roomId].customAudios || []).find(a => a.audioId === audioId);
      audioName = audioName || catalogEntry?.audioName || '';
      socket.data.cachedAudioIds?.add(audioId);
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
      voiceDataUrl: cleanVoice, // AUD-04: Sanitasi Base64 Audio
      audioId,
      audioName,
      missionRequired: Boolean(data.missionRequired),
      timestamp: Date.now()
    };

    rooms[roomId].isAlarmActive = true;
    rooms[roomId].currentAlarm = { ...alarmPayload, voiceDataUrl: null };
    rooms[roomId].lastActivityAt = Date.now();

    console.log(`[ALARM INSTAN] Room ${roomId} dari ${alarmPayload.sender} (${socket.id}) ke ${alarmPayload.target} vol: ${alarmPayload.volume}%`);
    emitAlarmToRoom(roomId, alarmPayload);
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

    const cleanVoice = sanitizeVoiceDataUrl(data.voiceDataUrl);
    let audioId = AUDIO_ID_REGEX.test(data.audioId) ? data.audioId : null;
    let audioName = data.audioName ? String(data.audioName).trim().slice(0, 80) : null;
    if (cleanVoice) {
      if (!audioId) audioId = computeAudioId(cleanVoice);
      audioName = audioName || 'Audio Kustom';
      saveAudioToDisk(audioId, cleanVoice);
      upsertRoomAudio(rooms[roomId], audioId, audioName);
      if (AUDIO_ID_REGEX.test(data.audioId)) {
        socket.data.cachedAudioIds?.add(audioId);
      }
    } else if (audioId) {
      const catalogEntry = (rooms[roomId].customAudios || []).find(a => a.audioId === audioId);
      audioName = audioName || catalogEntry?.audioName || '';
      socket.data.cachedAudioIds?.add(audioId);
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
      voiceDataUrl: cleanVoice, // AUD-04: Sanitasi Base64 Audio
      audioId,
      audioName,
      missionRequired: Boolean(data.missionRequired),
      fired: false,
      createdAt: Date.now()
    };

    rooms[roomId].scheduledAlarms.push(newAlarm);
    rooms[roomId].lastActivityAt = Date.now();
    console.log(`[JADWAL DIBUAT] Room ${roomId} oleh ${newAlarm.creator} untuk jam ${newAlarm.timeString}`);

    io.to(roomId).emit('scheduled_list_updated', publicAlarms(rooms[roomId].scheduledAlarms));
    saveRooms(true);
  });

  // Menghapus alarm yang dijadwalkan
  socket.on('delete_scheduled_alarm', (data = {}) => {
    const alarmId = data.alarmId;
    const roomId = socket.data?.roomId;
    if (roomId && rooms[roomId] && alarmId) {
      const room = rooms[roomId];
      room.scheduledAlarms = room.scheduledAlarms.filter(a => a.id !== alarmId);
      if (!Array.isArray(room.deletedScheduleIds)) room.deletedScheduleIds = [];
      if (!room.deletedScheduleIds.includes(alarmId)) {
        room.deletedScheduleIds.push(String(alarmId));
        if (room.deletedScheduleIds.length > 50) {
          room.deletedScheduleIds = room.deletedScheduleIds.slice(-50);
        }
      }
      room.lastActivityAt = Date.now();
      io.to(roomId).emit('scheduled_list_updated', publicAlarms(room.scheduledAlarms));
      saveRooms(true);
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
    saveRooms(true);
  });

  // Mengirim teks kustom jarak jauh
  socket.on('send_custom_text', (data = {}) => {
    const roomId = socket.data?.roomId;
    if (!roomId || !rooms[roomId]) return;
    if (isRateLimited(socket, 2000)) {
      socket.emit('rate_limit_error', { message: 'Harap tunggu 2 detik sebelum mengirim perintah lagi.' });
      return;
    }
    const message = String(data.message || '').trim().slice(0, 300);
    if (!message) return;
    const textPayload = {
      id: Date.now().toString(),
      roomId,
      sender: data.sender || socket.data.username || 'Pasangan',
      senderDeviceId: socket.data.deviceId,
      message,
      timestamp: Date.now()
    };
    rooms[roomId].lastCustomText = textPayload;
    rooms[roomId].lastActivityAt = Date.now();
    io.to(roomId).emit('custom_text_received', textPayload);
    saveRooms(true);
  });

  socket.on('disconnect', () => {
    const { roomId } = socket.data || {};
    if (roomId && rooms[roomId]) {
      delete rooms[roomId].users[socket.id];
      rooms[roomId].lastActivityAt = Date.now();
      io.to(roomId).emit('room_state', buildRoomState(roomId));

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
  hashPin,
  AUDIO_ID_REGEX,
  computeAudioId,
  saveAudioToDisk,
  getAudioFromDisk,
  hasAudioOnServer
};
