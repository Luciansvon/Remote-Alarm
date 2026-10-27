const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '20mb' }));

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  },
  maxHttpBufferSize: 2e7 // 20 MB untuk transmisi rekaman suara
});

// Menyimpan data ruangan pasangan, status alarm, dan jadwal alarm
const rooms = {};

// Cek otomatis setiap 1 detik untuk alarm yang dijadwalkan
setInterval(() => {
  const now = Date.now();
  for (const roomId in rooms) {
    const room = rooms[roomId];
    if (!room || !room.scheduledAlarms) continue;

    let scheduleUpdated = false;
    for (let i = room.scheduledAlarms.length - 1; i >= 0; i--) {
      const alarm = room.scheduledAlarms[i];
      if (alarm.triggerTime <= now && !alarm.fired) {
        alarm.fired = true;
        room.isAlarmActive = true;
        room.currentAlarm = { ...alarm };

        const alarmTitle = alarm.message || alarm.sound || 'Alarm Terjadwal';
        console.log(`[JADWAL TIBA] Alarm '${alarmTitle}' di Room ${roomId} berdering sekarang!`);
        io.to(roomId).emit('alarm_triggered', room.currentAlarm);
        
        // Hapus Base64 dari riwayat setelah berdering agar memori RAM tidak bengkak
        alarm.voiceDataUrl = null;
        scheduleUpdated = true;
      }
    }

    if (scheduleUpdated) {
      io.to(roomId).emit('scheduled_list_updated', room.scheduledAlarms);
    }
  }
}, 1000);

app.get('/health', (req, res) => {
  res.json({
    status: 'online',
    activeRooms: Object.keys(rooms).length,
    timestamp: new Date().toISOString()
  });
});

io.on('connection', (socket) => {
  console.log(`[Koneksi Baru] ID Klien: ${socket.id}`);

  // Bergabung ke ruangan pasangan
  socket.on('join_room', (data = {}) => {
    const { roomId, username } = data;
    if (!roomId) return;

    socket.join(roomId);
    socket.data = { roomId, username: username || 'Pasangan' };

    if (!rooms[roomId]) {
      rooms[roomId] = {
        users: {},
        isAlarmActive: false,
        currentAlarm: null,
        scheduledAlarms: []
      };
    }

    rooms[roomId].users[socket.id] = { 
      username: username || 'Pasangan', 
      joinedAt: Date.now() 
    };

    console.log(`[Room ${roomId}] ${username || 'Pasangan'} bergabung.`);
    
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
    const roomId = data.roomId || socket.data?.roomId;
    if (!roomId || !rooms[roomId]) return;

    const alarmPayload = {
      id: 'instan_' + Date.now(),
      sender: data.sender || socket.data?.username || 'Bima',
      target: data.target || data.targetName || 'Pacar',
      volume: typeof data.volume === 'number' ? data.volume : 100,
      sound: data.sound || 'siren',
      message: String(data.message || 'Waktunya bangun!').slice(0, 200),
      voiceDataUrl: data.voiceDataUrl || null,
      missionRequired: Boolean(data.missionRequired),
      timestamp: Date.now()
    };

    rooms[roomId].isAlarmActive = true;
    rooms[roomId].currentAlarm = alarmPayload;

    console.log(`[ALARM INSTAN] Room ${roomId} dari ${alarmPayload.sender} ke ${alarmPayload.target} vol: ${alarmPayload.volume}%`);
    io.to(roomId).emit('alarm_triggered', alarmPayload);
  });

  // Menjadwalkan alarm jarak jauh (Custom Jam & Pesan)
  socket.on('schedule_alarm', (data = {}) => {
    const roomId = data.roomId || socket.data?.roomId;
    if (!roomId || !rooms[roomId]) return;

    const newAlarm = {
      id: 'sch_' + Date.now(),
      creator: data.creator || socket.data?.username || 'Bima',
      sender: data.creator || socket.data?.username || 'Bima',
      target: data.target || data.targetName || 'Pacar',
      targetName: data.target || data.targetName || 'Pacar',
      timeString: data.timeString || '06:30', // Format "HH:mm" misal "06:30"
      triggerTime: Number(data.triggerTime) || Date.now(), // Epoch millisecond
      volume: typeof data.volume === 'number' ? data.volume : 100,
      sound: data.sound || 'siren',
      message: String(data.message || 'Waktunya bangun!').slice(0, 200),
      voiceDataUrl: data.voiceDataUrl || null,
      missionRequired: Boolean(data.missionRequired),
      fired: false,
      createdAt: Date.now()
    };

    rooms[roomId].scheduledAlarms.push(newAlarm);
    console.log(`[JADWAL DIBUAT] Room ${roomId} oleh ${newAlarm.creator} untuk jam ${newAlarm.timeString}`);

    io.to(roomId).emit('scheduled_list_updated', rooms[roomId].scheduledAlarms);
  });

  // Menghapus alarm yang dijadwalkan
  socket.on('delete_scheduled_alarm', (data = {}) => {
    const alarmId = data.alarmId;
    const roomId = socket.data?.roomId;
    if (roomId && rooms[roomId] && alarmId) {
      rooms[roomId].scheduledAlarms = rooms[roomId].scheduledAlarms.filter(a => a.id !== alarmId);
      io.to(roomId).emit('scheduled_list_updated', rooms[roomId].scheduledAlarms);
    }
  });

  // Mematikan alarm (tombol "Sudah Bangun")
  socket.on('stop_alarm', (data = {}) => {
    const roomId = data.roomId || socket.data?.roomId;
    if (!roomId) return;

    if (rooms[roomId]) {
      rooms[roomId].isAlarmActive = false;
      rooms[roomId].currentAlarm = null;
    }

    const stopperName = data.stopper || socket.data?.username || 'Pacar';
    console.log(`[ALARM DIMATIKAN] Room ${roomId} oleh ${stopperName}`);

    io.to(roomId).emit('alarm_stopped', {
      stopper: stopperName,
      timestamp: Date.now()
    });
  });

  socket.on('disconnect', () => {
    const { roomId, username } = socket.data || {};
    if (roomId && rooms[roomId]) {
      delete rooms[roomId].users[socket.id];
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
server.listen(PORT, '0.0.0.0', () => {
  console.log(`[SERVER BERJALAN] Server Alarm Pasangan aktif di port ${PORT}`);
});
