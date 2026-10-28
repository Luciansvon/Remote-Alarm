# Wake-Mate ⚡ (Remote Alarm untuk Pasangan)

Aplikasi alarm jarak jauh untuk pasangan: satu HP mengirim sinyal, HP lainnya berbunyi kencang lewat server realtime. Tampilan web React, dibungkus Capacitor menjadi APK Android.

## Fitur

- **Alarm kilat**: bunyikan alarm di HP pasangan secara instan.
- **Jadwal jam**: pasang alarm pada jam tertentu dari jarak jauh.
- **Tembus mode senyap**: mode native Android menaikkan volume alarm ke maksimal.
- **Suara kustom**: MP3/TikTok yang diunggah atau rekaman suara sendiri.
- **Misi bangun**: alarm baru mati setelah tombol diketuk 3 kali.
- **Kamar + PIN**: kedua HP memakai Kode & PIN kamar yang sama.

## Teknologi

- **Frontend**: React 19, Vite, Lucide Icons, Canvas Confetti, Socket.io Client
- **Backend**: Node.js, Socket.io (WebSocket realtime)
- **Android**: Capacitor 8, Java 17/Gradle (CI memakai Java 21)

## Menjalankan

### Backend

```bash
cd backend
npm install
npm start
```

Cek dengan membuka `http://localhost:4000/health`; respons berisi `"status": "online"`. Port default 4000 dan bisa diubah lewat variabel lingkungan `PORT`.

Opsional: salin `backend/.env.example` menjadi `backend/.env` untuk mengubah `PORT`, `ALLOWED_ORIGINS`, atau lokasi `DATA_FILE`.

### Frontend

```bash
cd frontend
npm install
npm run dev
npm run lint
npm run build
```

## Menghubungkan HP

1. Jalankan backend di komputer.
2. Buka tab **Profil** di aplikasi, isi alamat server dengan `http://IP-KOMPUTER:4000`. Ganti `IP-KOMPUTER` dengan IP LAN komputer (contoh format saja; cek lewat `ipconfig`).
3. Izinkan port 4000 masuk di Windows Firewall (Firewall → Advanced settings → Inbound Rules → New Rule → Port).
4. Isi Kode & PIN kamar yang sama di kedua HP, lalu pilih peran **Bima** atau **Pacar**.
5. Kedua HP harus berada di Wi-Fi yang sama. Untuk jarak jauh, pasang backend di server publik dan pakai URL publiknya.

## APK

- **GitHub Actions**: buka [Actions](https://github.com/Luciansvon/Remote-Alarm/actions), jalankan workflow **Build Android APK**, lalu unduh artifact `WakeMate-RemoteAlarm-Debug-APK` (perlu login GitHub). Rilis tersedia di [Releases](https://github.com/Luciansvon/Remote-Alarm/releases).
- **Lokal**:

  ```bash
  cd frontend
  npm run build
  npx cap sync android
  cd android
  .\gradlew.bat assembleDebug
  ```

  Hasil: `frontend/android/app/build/outputs/apk/debug/app-debug.apk`.

## Batas yang diketahui

- Jam jadwal mengikuti jam HP pengirim, bukan HP penerima.
- Audio alarm tetap diputar lewat Android WebView; mode DND/Total Silence dapat membuat suara tidak terdengar.
- Backend harus tetap berjalan. Kalau server mati, alarm jarak jauh tidak terkirim.

## Dokumen

- [Arsitektur sistem](ARCHITECTURE.md)
- [Catatan insiden & solusi](INCIDENTS.md)
