process.env.NO_PERSIST = '1';
const assert = require('assert');
const { io: createClient } = require('socket.io-client');
const { server, io, rooms } = require('./server');

const ROOM_ID = 'INTEGRATION_TEST';
const PIN = '123456';
const AUDIO = 'data:audio/mp3;base64,SUQzBAAAAAAAI1RTU0U=';
const GLOBAL_TIMEOUT_MS = 30000;

const globalTimer = setTimeout(() => {
  console.error('FAIL: tes integrasi melebihi batas waktu');
  process.exit(1);
}, GLOBAL_TIMEOUT_MS);

let URL;

function once(socket, event, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`Timeout menunggu event '${event}'`));
    }, timeoutMs);
    function handler(payload) {
      clearTimeout(timer);
      socket.off(event, handler);
      resolve(payload);
    }
    socket.on(event, handler);
  });
}

function connect() {
  return new Promise((resolve, reject) => {
    const socket = createClient(URL, {
      transports: ['websocket'],
      reconnection: false,
      timeout: 4000
    });
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error('Timeout koneksi socket'));
    }, 5000);
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once('connect_error', (err) => {
      clearTimeout(timer);
      socket.close();
      reject(err);
    });
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  URL = `http://127.0.0.1:${server.address().port}`;

  // Dua klien masuk room yang sama dengan PIN benar
  const a = await connect();
  const welcomeA = once(a, 'room_state');
  a.emit('join_room', { roomId: ROOM_ID, username: 'A', pin: PIN, deviceId: 'devA' });
  await welcomeA;

  const b = await connect();
  const stateOnAForB = once(a, 'room_state');
  const welcomeB = once(b, 'room_state');
  b.emit('join_room', { roomId: ROOM_ID, username: 'B', pin: PIN, deviceId: 'devB' });
  await Promise.all([stateOnAForB, welcomeB]);

  // PIN salah ditolak
  const c = await connect();
  const authError = once(c, 'auth_error');
  c.emit('join_room', { roomId: ROOM_ID, username: 'C', pin: '000000', deviceId: 'devC' });
  const authPayload = await authError;
  assert.ok(authPayload.message, 'auth_error harus membawa pesan');
  assert.strictEqual(rooms[ROOM_ID].users[c.id], undefined, 'Klien dengan PIN salah tidak boleh masuk room');
  c.close();

  // Alarm instan dari A diterima kedua klien dengan identitas perangkat pengirim
  const triggeredA = once(a, 'alarm_triggered');
  const triggeredB = once(b, 'alarm_triggered');
  a.emit('trigger_alarm', { message: 'Bangun!', voiceDataUrl: AUDIO });
  const [instantA, instantB] = await Promise.all([triggeredA, triggeredB]);
  assert.strictEqual(instantA.senderDeviceId, 'devA');
  assert.strictEqual(instantA.senderSocketId, a.id);
  assert.strictEqual(instantB.senderDeviceId, 'devA');
  assert.strictEqual(instantB.senderSocketId, a.id);

  // B mematikan alarm
  const stoppedA = once(a, 'alarm_stopped');
  const stoppedB = once(b, 'alarm_stopped');
  b.emit('stop_alarm', { stopper: 'B' });
  const [stopA, stopB] = await Promise.all([stoppedA, stoppedB]);
  assert.strictEqual(stopA.stopperSocketId, b.id);
  assert.strictEqual(stopB.stopperSocketId, b.id);

  // Beri jeda agar rate limiter socket A (2 detik) lewat
  await sleep(2200);

  const listA = once(a, 'scheduled_list_updated');
  const listB = once(b, 'scheduled_list_updated');
  const scheduledTriggerA = once(a, 'alarm_triggered', 8000);
  const scheduledTriggerB = once(b, 'alarm_triggered', 8000);
  a.emit('schedule_alarm', {
    creator: 'A',
    message: 'Alarm terjadwal',
    triggerTime: Date.now() + 1500,
    voiceDataUrl: AUDIO
  });

  const list = await listB;
  await listA;
  assert.ok(Array.isArray(list), 'scheduled_list_updated harus berupa array');
  for (const item of list) {
    assert.strictEqual('voiceDataUrl' in item, false, 'Daftar jadwal tidak boleh membawa voiceDataUrl');
  }
  const scheduled = list.find(item => item.message === 'Alarm terjadwal');
  assert.ok(scheduled, 'Jadwal baru harus muncul di daftar');
  assert.strictEqual(scheduled.senderDeviceId, 'devA');

  const [scheduledA, scheduledB] = await Promise.all([scheduledTriggerA, scheduledTriggerB]);
  assert.strictEqual(scheduledA.voiceDataUrl, AUDIO, 'alarm_triggered terjadwal harus membawa audio');
  assert.strictEqual(scheduledB.voiceDataUrl, AUDIO);
  assert.strictEqual(scheduledB.senderDeviceId, 'devA');
  assert.strictEqual(scheduledB.creatorSocketId, a.id);

  // A putus, lalu reconnect sebagai A2 dengan deviceId yang sama
  const afterDisconnect = once(b, 'room_state');
  a.close();
  const stateAfterDisconnect = await afterDisconnect;
  assert.strictEqual(stateAfterDisconnect.users.some(user => user.id === a.id), false);

  const a2 = await connect();
  const reconnectState = once(a2, 'room_state');
  a2.emit('join_room', { roomId: ROOM_ID, username: 'A', pin: PIN, deviceId: 'devA' });
  const roomState = await reconnectState;
  assert.strictEqual(roomState.isAlarmActive, true, 'Alarm harus tetap aktif setelah pengirim reconnect');
  assert.ok(roomState.currentAlarm, 'currentAlarm harus tersedia');
  assert.strictEqual(roomState.currentAlarm.senderDeviceId, 'devA');

  // A2 mematikan alarm
  const stoppedAfterReconnect = once(a2, 'alarm_stopped');
  a2.emit('stop_alarm', { stopper: 'A' });
  const stoppedPayload = await stoppedAfterReconnect;
  assert.strictEqual(stoppedPayload.stopper, 'A');

  // Pre-sync audio kustom: upload_audio mengirim audio_sync_payload ke B,
  // lalu setelah B emit client_audio_cached, trigger_alarm dengan audioId mengirim voiceDataUrl: null
  const uploadedA2 = once(a2, 'audio_uploaded');
  const catalogB = once(b, 'audio_catalog_updated');
  const syncB = once(b, 'audio_sync_payload');
  a2.emit('upload_audio', { audioName: 'Suara Pagi', voiceDataUrl: AUDIO });
  const [upRes, catRes, syncRes] = await Promise.all([uploadedA2, catalogB, syncB]);
  assert.ok(upRes.audioId && upRes.audioId.startsWith('aud_'), 'audioId harus berformat aud_*');
  assert.strictEqual(syncRes.audioId, upRes.audioId);
  assert.strictEqual(syncRes.voiceDataUrl, AUDIO);
  assert.ok(Array.isArray(catRes) && catRes.some(x => x.audioId === upRes.audioId));

  b.emit('client_audio_cached', { audioId: upRes.audioId });
  await sleep(100);

  const cachedTrigA = once(a2, 'alarm_triggered');
  const cachedTrigB = once(b, 'alarm_triggered');
  a2.emit('trigger_alarm', { message: 'Bangun Cepat!', audioId: upRes.audioId, audioName: 'Suara Pagi', voiceDataUrl: null });
  const [trigA2, trigB2] = await Promise.all([cachedTrigA, cachedTrigB]);
  assert.strictEqual(trigA2.audioId, upRes.audioId);
  assert.strictEqual(trigA2.voiceDataUrl, null, 'Pengirim sudah cache audioId, voiceDataUrl harus null');
  assert.strictEqual(trigB2.audioId, upRes.audioId);
  assert.strictEqual(trigB2.voiceDataUrl, null, 'Penerima B sudah cache audioId, voiceDataUrl harus null');

  // Uji HTTP /api/poll, /api/audio, dan POST /api/stop
  const pollRes = await fetch(`${URL}/api/poll?roomId=${ROOM_ID}&pin=${PIN}&deviceId=devB`).then(r => r.json());
  assert.strictEqual(pollRes.ok, true);
  assert.strictEqual(pollRes.isAlarmActive, true);
  assert.strictEqual(pollRes.currentAlarm.audioId, upRes.audioId);

  const audioRes = await fetch(`${URL}/api/audio?roomId=${ROOM_ID}&pin=${PIN}&audioId=${upRes.audioId}`).then(r => r.json());
  assert.strictEqual(audioRes.ok, true);
  assert.strictEqual(audioRes.voiceDataUrl, AUDIO);

  const httpStopB = once(b, 'alarm_stopped');
  const stopRes = await fetch(`${URL}/api/stop?roomId=${ROOM_ID}&pin=${PIN}&stopper=B_HTTP`, { method: 'POST' }).then(r => r.json());
  assert.strictEqual(stopRes.ok, true);
  const stopEvent = await httpStopB;
  assert.strictEqual(stopEvent.stopper, 'B_HTTP');
  assert.strictEqual(rooms[ROOM_ID].isAlarmActive, false);

  // Uji send_custom_text
  await sleep(2100);
  const textOnB = once(b, 'custom_text_received');
  a2.emit('send_custom_text', { sender: 'A', message: 'Jangan lupa sarapan ya!' });
  const textPayload = await textOnB;
  assert.strictEqual(textPayload.message, 'Jangan lupa sarapan ya!');
  assert.strictEqual(textPayload.senderDeviceId, 'devA');
  assert.strictEqual(rooms[ROOM_ID].lastCustomText.message, 'Jangan lupa sarapan ya!');

  // Uji clientSchedules merge saat join_room & delete_scheduled_alarm mencegah resurreksi
  const clientSchId = 'sch_local_999';
  const mergeState = once(b, 'room_state');
  b.emit('join_room', {
    roomId: ROOM_ID,
    username: 'B',
    pin: PIN,
    deviceId: 'devB',
    clientSchedules: [{ id: clientSchId, timeString: '07:00', triggerTime: Date.now() + 600000, message: 'Dari HP' }]
  });
  const mergedRoomState = await mergeState;
  assert.ok(mergedRoomState.scheduledAlarms.some(s => s.id === clientSchId), 'clientSchedules harus digabung ke jadwal room');

  const afterDelList = once(b, 'scheduled_list_updated');
  a2.emit('delete_scheduled_alarm', { alarmId: clientSchId });
  const updatedAfterDel = await afterDelList;
  assert.strictEqual(updatedAfterDel.some(s => s.id === clientSchId), false, 'Jadwal harus terhapus');

  const rejoinAfterDel = once(b, 'room_state');
  b.emit('join_room', {
    roomId: ROOM_ID,
    username: 'B',
    pin: PIN,
    deviceId: 'devB',
    clientSchedules: [{ id: clientSchId, timeString: '07:00', triggerTime: Date.now() + 600000, message: 'Dari HP' }]
  });
  const stateAfterDelRejoin = await rejoinAfterDel;
  assert.strictEqual(stateAfterDelRejoin.scheduledAlarms.some(s => s.id === clientSchId), false, 'Jadwal yang sudah dihapus tidak boleh hidup lagi saat rejoin');

  // Rate limit PIN: 5 percobaan gagal, percobaan ke-6 diblokir
  for (let i = 1; i <= 5; i++) {
    const failed = once(a2, 'auth_error');
    a2.emit('join_room', { roomId: ROOM_ID, username: 'A', pin: '999999', deviceId: 'devA' });
    await failed;
  }
  const blocked = once(a2, 'auth_error');
  a2.emit('join_room', { roomId: ROOM_ID, username: 'A', pin: '999999', deviceId: 'devA' });
  const blockedPayload = await blocked;
  assert.strictEqual(blockedPayload.message, 'Terlalu banyak percobaan PIN. Coba lagi nanti.');

  b.close();
  a2.close();

  await new Promise(resolve => io.close(resolve));
  await new Promise(resolve => server.close(resolve));

  clearTimeout(globalTimer);
  console.log('PASS');
  process.exit(0);
}

main().catch(err => {
  console.error('FAIL:', err);
  process.exit(1);
});
