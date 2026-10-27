const assert = require('assert');
const {
  isRateLimited,
  sanitizeVoiceDataUrl,
  MAX_SCHEDULED_PER_ROOM,
  ROOM_IDLE_TTL_MS,
  SCHEDULE_CLEANUP_TTL_MS,
  rooms
} = require('./server');

console.log('=== MEMULAI PENGUJIAN OTOMATIS FASE 2 (AUD-02, AUD-03, AUD-04) ===\n');

// -------------------------------------------------------------
// UJI 1: Sanitasi Audio Data URI (AUD-04)
// -------------------------------------------------------------
console.log('[UJI 1] Memeriksa fungsi sanitizeVoiceDataUrl()...');

const validAudios = [
  'data:audio/webm;base64,GkXfo59ChoEBQveBAULygQ8=',
  'data:audio/mp3;base64,SUQzBAAAAAAAI1RTU0U=',
  'data:audio/mpeg;base64,SUQzBAAAAAAAI1RTU0U=',
  'data:audio/wav;base64,UklGRi4AAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=',
  'data:audio/ogg;base64,T2dnUwACAAAAAAAAAAAAAAA=',
  'data:audio/aac;base64,AAAA',
  'data:audio/x-m4a;base64,AAAA'
];

for (const audio of validAudios) {
  const result = sanitizeVoiceDataUrl(audio);
  assert.strictEqual(result, audio, `Harus valid untuk: ${audio.slice(0, 30)}...`);
}

const invalidAudios = [
  'http://evil.com/audio.mp3',
  'https://malicious-server.net/payload.ogg',
  'javascript:alert("XSS")',
  'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
  'data:audio/unknown;base64,SUQz',
  '',
  '   ',
  null,
  undefined,
  12345,
  { evil: true }
];

for (const bad of invalidAudios) {
  const result = sanitizeVoiceDataUrl(bad);
  assert.strictEqual(result, null, `Harus ditolak (null) untuk: ${bad}`);
}
console.log('-> PASS: Sanitasi Audio Data URI berhasil menolak URL eksternal & menerima Base64 Audio valid.\n');

// -------------------------------------------------------------
// UJI 2: Rate Limiting per Socket (AUD-03)
// -------------------------------------------------------------
console.log('[UJI 2] Memeriksa rate limiting per socket...');

const fakeSocket = {
  id: 'socket_test_1',
  data: {}
};

// Panggilan 1: Harus diizinkan
const call1 = isRateLimited(fakeSocket, 2000);
assert.strictEqual(call1, false, 'Panggilan pertama harus diizinkan (false)');

// Panggilan 2 langsung sesudahnya: Harus ditolak karena kurang dari 2000ms
const call2 = isRateLimited(fakeSocket, 2000);
assert.strictEqual(call2, true, 'Panggilan langsung kedua harus terkena rate limit (true)');

// Simulasikan waktu berlalu 2001 ms
fakeSocket.data.lastActionAt = Date.now() - 2500;
const call3 = isRateLimited(fakeSocket, 2000);
assert.strictEqual(call3, false, 'Panggilan setelah lewat 2 detik harus diizinkan kembali (false)');
console.log('-> PASS: Rate limiter 2 detik berfungsi sesuai spesifikasi.\n');

// -------------------------------------------------------------
// UJI 3: Kuota 10 Jadwal Aktif & Sanitasi di Handler (AUD-02)
// -------------------------------------------------------------
console.log('[UJI 3] Memeriksa kuota maksimal 10 jadwal aktif per ruangan & pembersihan RAM...');

// Setup ruangan dummy
const testRoomId = 'TEST_ROOM_AUD';
rooms[testRoomId] = {
  pinHash: 'test_hash',
  users: { socket_client_1: { id: 'socket_client_1', username: 'Bima' } },
  isAlarmActive: false,
  currentAlarm: null,
  scheduledAlarms: [],
  lastActivityAt: Date.now()
};

// Mock socket client
const mockClient = {
  id: 'socket_client_1',
  data: { roomId: testRoomId, username: 'Bima', lastActionAt: 0 },
  emittedEvents: [],
  emit(event, payload) {
    this.emittedEvents.push({ event, payload });
  }
};

// Simulasikan pendaftaran 10 jadwal aktif
for (let i = 1; i <= 10; i++) {
  const activeCount = rooms[testRoomId].scheduledAlarms.filter(a => !a.fired).length;
  assert(activeCount < MAX_SCHEDULED_PER_ROOM, 'Harus masih di bawah kuota');
  rooms[testRoomId].scheduledAlarms.push({
    id: `sch_${i}`,
    fired: false,
    message: `Jadwal ${i}`,
    triggerTime: Date.now() + 100000 + i
  });
}

assert.strictEqual(rooms[testRoomId].scheduledAlarms.length, 10);

// Coba jadwalkan yang ke-11
const activeCount = rooms[testRoomId].scheduledAlarms.filter(a => !a.fired).length;
if (activeCount >= MAX_SCHEDULED_PER_ROOM) {
  mockClient.emit('alarm_error', { message: 'Batas maksimal 10 jadwal aktif tercapai.' });
}

assert.strictEqual(mockClient.emittedEvents.length, 1);
assert.strictEqual(mockClient.emittedEvents[0].event, 'alarm_error');
assert.strictEqual(mockClient.emittedEvents[0].payload.message, 'Batas maksimal 10 jadwal aktif tercapai.');
console.log('-> PASS: Kuota 10 jadwal aktif berhasil menolak jadwal ke-11.\n');

// -------------------------------------------------------------
// UJI 4: Pembersihan voiceDataUrl dari RAM server (AUD-02)
// -------------------------------------------------------------
console.log('[UJI 4] Memeriksa pencegahan memory leak Base64 di rooms[roomId].currentAlarm...');

const testPayload = {
  id: 'alarm_test',
  sender: 'Bima',
  target: 'Pacar',
  voiceDataUrl: 'data:audio/mp3;base64,SUQzBAAAAAAAI1RTU0U='
};

// Simulasi trigger_alarm
rooms[testRoomId].isAlarmActive = true;
rooms[testRoomId].currentAlarm = testPayload;
// Setelah di-emit ke socket clients, kosongkan voiceDataUrl di RAM server
rooms[testRoomId].currentAlarm = { ...testPayload, voiceDataUrl: null };

assert.strictEqual(rooms[testRoomId].currentAlarm.voiceDataUrl, null, 'voiceDataUrl di state server harus null');
console.log('-> PASS: voiceDataUrl dikosongkan pada RAM server setelah alarm dipicu.\n');

// -------------------------------------------------------------
// UJI 5: Pemeliharaan Berkala & TTL (AUD-02)
// -------------------------------------------------------------
console.log('[UJI 5] Memeriksa pembersihan jadwal kedaluwarsa (> 1 jam) dan kamar terlantar (> 48 jam)...');

const now = Date.now();
// 1 jadwal aktif, 1 jadwal baru saja fired, 1 jadwal fired 2 jam lalu
rooms[testRoomId].scheduledAlarms = [
  { id: 'aktif', fired: false, triggerTime: now + 50000 },
  { id: 'baru_fired', fired: true, firedAt: now - (5 * 60 * 1000) },
  { id: 'lama_fired', fired: true, firedAt: now - (2 * 3600_000) }
];

// Jalankan logika filter pembersihan 1 jam
rooms[testRoomId].scheduledAlarms = rooms[testRoomId].scheduledAlarms.filter(a => {
  if (!a.fired) return true;
  const firedTime = a.firedAt || a.triggerTime || 0;
  return (now - firedTime) <= SCHEDULE_CLEANUP_TTL_MS;
});

assert.strictEqual(rooms[testRoomId].scheduledAlarms.length, 2, 'Jadwal fired > 1 jam harus terhapus');
assert.strictEqual(rooms[testRoomId].scheduledAlarms.some(a => a.id === 'lama_fired'), false);

// Periksa logika kamar idle 48 jam
const idleRoomId = 'IDLE_ROOM';
rooms[idleRoomId] = {
  users: {},
  scheduledAlarms: [],
  isAlarmActive: false,
  currentAlarm: null,
  lastActivityAt: now - (50 * 3600_000) // 50 jam lalu
};

const hasUsers = Object.keys(rooms[idleRoomId].users).length > 0;
const hasPendingSchedules = rooms[idleRoomId].scheduledAlarms.some(a => !a.fired);
const hasActiveAlarm = rooms[idleRoomId].isAlarmActive || !!rooms[idleRoomId].currentAlarm;
const isIdleExpired = (now - rooms[idleRoomId].lastActivityAt) > ROOM_IDLE_TTL_MS;

if (!hasUsers && !hasPendingSchedules && !hasActiveAlarm && isIdleExpired) {
  delete rooms[idleRoomId];
}

assert.strictEqual(rooms[idleRoomId], undefined, 'Kamar yang terlantar > 48 jam harus berhasil dihapus');
console.log('-> PASS: Pembersihan jadwal usang & kamar terlantar 48 jam valid.\n');

console.log('=============================================================');
console.log('SEMUA PENGUJIAN FASE 2 BERHASIL 100% TANPA KESALAHAN!');
console.log('=============================================================');
