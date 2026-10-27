# Laporan Audit Teknis, Keamanan & UI/UX: Wake-Mate (Remote-Alarm)

**Repositori Target:** [Luciansvon/Remote-Alarm](https://github.com/Luciansvon/Remote-Alarm)  
**Nama Aplikasi:** Wake-Mate (`com.bima.wakemate`)  
**Stack Teknologi:** React 19 (Vite) + Node.js / Express / Socket.io + Capacitor 8 Android  
**Tanggal Audit:** 27 Oktober 2026  
**Sumber:** Audit Eksternal (Argon)

## 1. Ringkasan Eksekutif & Kartu Skor Audit

Audit menyeluruh terhadap seluruh kode sumber di repositori [Luciansvon/Remote-Alarm](https://github.com/Luciansvon/Remote-Alarm) menunjukkan bahwa arsitektur dasar komunikasi *real-time* dan desain antarmuka **Neubrutalism** sudah terbangun dengan baik, namun terdapat beberapa **bug logika kritis** pada pemutaran suara serta **celah arsitektur native Android** yang menyebabkan fitur utama (*Tembus Mode Hening / Silent Mode Bypass* dan *Bangun Saat Layar Terkunci*) belum dapat berjalan optimal di perangkat fisik.

| Domain Audit | Tingkat Keparahan | Temuan Utama | Berkas Terdampak |
| :--- | :--- | :--- | :--- |
| **Logika Audio & Alarm** | **Kritis** | Ketidakcocokan skala volume (`100` vs `1.0`), bug routing suara `'alarm_clock'` vs `'beep'`, dan ketidakcocokan properti `target` vs `targetName` | [`App.jsx`](https://github.com/Luciansvon/Remote-Alarm/blob/main/frontend/src/App.jsx), [`soundManager.js`](https://github.com/Luciansvon/Remote-Alarm/blob/main/frontend/src/soundManager.js), [`server.js`](https://github.com/Luciansvon/Remote-Alarm/blob/main/backend/server.js) |
| **Android Native & Bypass Silent Mode** | **Kritis** | Audio WebView berjalan di jalur `STREAM_MUSIC` (bukan `STREAM_ALARM`), tanpa *Foreground Service* atau FCM *Wake-Up* saat HP terkunci lama | [`AndroidManifest.xml`](https://github.com/Luciansvon/Remote-Alarm/blob/main/frontend/android/app/src/main/AndroidManifest.xml), [`MainActivity.java`](https://github.com/Luciansvon/Remote-Alarm/blob/main/frontend/android/app/src/main/java/com/bima/wakemate/MainActivity.java) |
| **Keamanan & Stabilitas Backend** | **Tinggi** | Potensi *crash* server akibat *null destructuring*, kebocoran memori RAM (*Memory Leak*) dari rekaman Base64 20 MB, dan absennya skrip `"start"` | [`backend/server.js`](https://github.com/Luciansvon/Remote-Alarm/blob/main/backend/server.js), [`backend/package.json`](https://github.com/Luciansvon/Remote-Alarm/blob/main/backend/package.json) |
| **Jaringan & Konektivitas** | **Tinggi** | IP lokal statis (`192.168.0.23:4000`) tidak bisa diakses lintas jaringan Wi-Fi/seluler; *cleartext HTTP* aktif secara global | [`App.jsx`](https://github.com/Luciansvon/Remote-Alarm/blob/main/frontend/src/App.jsx), [`AndroidManifest.xml`](https://github.com/Luciansvon/Remote-Alarm/blob/main/frontend/android/app/src/main/AndroidManifest.xml) |
| **UI/UX, Aksesibilitas & CI/CD** | **Sedang** | Pengaturan suara rekaman/misi absen di tab Jadwal, kedipan layar penuh `0.5s` terlalu ekstrem di ruang gelap, dan modifikasi manual di `node_modules` | [`App.jsx`](https://github.com/Luciansvon/Remote-Alarm/blob/main/frontend/src/App.jsx), [`index.css`](https://github.com/Luciansvon/Remote-Alarm/blob/main/frontend/src/index.css), [`INCIDENTS.md`](https://github.com/Luciansvon/Remote-Alarm/blob/main/INCIDENTS.md), [`build-apk.yml`](https://github.com/Luciansvon/Remote-Alarm/blob/main/.github/workflows/build-apk.yml) |

## 2. Temuan Bug Fungsional & Logika Kode (Prioritas Kritis)

### 2.1. Skala Volume Tidak Sinkron (`50–100` vs `0.0–1.0`) Memicu Distorsi Suara
* **Lokasi Berkas:** [`frontend/src/App.jsx`](https://github.com/Luciansvon/Remote-Alarm/blob/main/frontend/src/App.jsx) dan [`frontend/src/soundManager.js`](https://github.com/Luciansvon/Remote-Alarm/blob/main/frontend/src/soundManager.js)
* **Akar Masalah:** Di [`frontend/src/App.jsx`](https://github.com/Luciansvon/Remote-Alarm/blob/main/frontend/src/App.jsx), state `selectedVolume` bernilai angka bulat `50` hingga `100` (dari *slider* volume) dan dikirim apa adanya ke server. Namun, di [`frontend/src/soundManager.js`](https://github.com/Luciansvon/Remote-Alarm/blob/main/frontend/src/soundManager.js), fungsi `playSiren(volume = 1.0)` dan `playBeep(volume = 1.0)` mengalikan nilai tersebut secara langsung pada Web Audio API `GainNode` (`gainNode.gain.setValueAtTime(volume * 0.8, ...)`).
* **Dampak:** Mengirim nilai `100` membuat penguatan suara (*gain*) menjadi **80 kali lipat (+38 dB overdrive)** sehingga gelombang suara pecah (*clipping* ekstrem). Sebaliknya, pada pemutaran audio TikTok/rekaman suara (`Math.min(Math.max(volume, 0.1), 1.0)`), angka `50` sampai `100` semuanya tertahan di `1.0` (100%), sehingga *slider* pengatur volume sama sekali tidak berfungsi.

### 2.2. Salah Nama Kunci Suara (`'alarm_clock'` vs `'beep'`)
* **Lokasi Berkas:** [`frontend/src/App.jsx`](https://github.com/Luciansvon/Remote-Alarm/blob/main/frontend/src/App.jsx) dan [`frontend/src/soundManager.js`](https://github.com/Luciansvon/Remote-Alarm/blob/main/frontend/src/soundManager.js)
* **Akar Masalah:** Saat pengguna memilih kartu suara **"⏰ Jam Beker Bip"** di [`frontend/src/App.jsx`](https://github.com/Luciansvon/Remote-Alarm/blob/main/frontend/src/App.jsx), nilai state yang disimpan adalah `'alarm_clock'`. Akan tetapi, fungsi `startAlarm()` di [`frontend/src/soundManager.js`](https://github.com/Luciansvon/Remote-Alarm/blob/main/frontend/src/soundManager.js) memeriksa kondisi `if (sound === 'beep')` dan `else if (sound === 'nuclear')`.
* **Dampak:** Karena `'alarm_clock'` tidak cocok dengan `'beep'`, pilihan "Jam Beker Bip" selalu jatuh ke cabang `else` dan memutar suara **Sirine Polisi (`playSiren`)**. Selain itu, fungsi `playNuclear()` di [`frontend/src/soundManager.js`](https://github.com/Luciansvon/Remote-Alarm/blob/main/frontend/src/soundManager.js) tidak pernah terpanggil karena tidak ada tombol pilihannya di antarmuka.

### 2.3. Ketidakcocokan Nama Properti `target` vs `targetName` & Alarm Berbunyi di HP Sendiri
* **Lokasi Berkas:** [`frontend/src/App.jsx`](https://github.com/Luciansvon/Remote-Alarm/blob/main/frontend/src/App.jsx) dan [`backend/server.js`](https://github.com/Luciansvon/Remote-Alarm/blob/main/backend/server.js)
* **Akar Masalah:** Pada `handleSendInstantAlarm()` di [`frontend/src/App.jsx`](https://github.com/Luciansvon/Remote-Alarm/blob/main/frontend/src/App.jsx), payload yang dikirim menggunakan properti `targetName`, sedangkan *listener* `socket.on('trigger_alarm')` di [`backend/server.js`](https://github.com/Luciansvon/Remote-Alarm/blob/main/backend/server.js) membaca properti `target` (`const { roomId, sender, target, ... } = alarmData`). Akibatnya, `alarmPayload.target` bernilai `undefined`.
* **Dampak:** Ketika [`backend/server.js`](https://github.com/Luciansvon/Remote-Alarm/blob/main/backend/server.js) memancarkan `io.to(roomId).emit('alarm_triggered', alarmPayload)` ke seluruh anggota ruangan, HP pengirim (misal HP Bima) juga ikut menyalakan alarm darurat dan terkunci oleh layar Misi 3x Ketuk jika tidak difilter berdasarkan peran penerima.

## 3. Audit Arsitektur Native Android & "Tembus Mode Hening"

Meskipun repositori ini menyertakan hasil bedah arsitektur (*reverse engineering*) dari aplikasi [Galarm (`laporan_galarm.md`)](https://github.com/Luciansvon/Remote-Alarm/blob/main/laporan_galarm.md), [MacroDroid (`laporan_macrodroid.md`)](https://github.com/Luciansvon/Remote-Alarm/blob/main/laporan_macrodroid.md), dan [PingPal (`laporan_pingpal.md`)](https://github.com/Luciansvon/Remote-Alarm/blob/main/laporan_pingpal.md), komponen native Android yang ditemukan di ketiga laporan tersebut belum diterapkan ke dalam folder `frontend/android`:

### 3.1. Jalur Suara WebView Terkunci di `STREAM_MUSIC` (Bukan `STREAM_ALARM`)
* **Lokasi Berkas:** [`MainActivity.java`](https://github.com/Luciansvon/Remote-Alarm/blob/main/frontend/android/app/src/main/java/com/bima/wakemate/MainActivity.java) dan [`AndroidManifest.xml`](https://github.com/Luciansvon/Remote-Alarm/blob/main/frontend/android/app/src/main/AndroidManifest.xml)
* **Akar Masalah:** Saat ini [`MainActivity.java`](https://github.com/Luciansvon/Remote-Alarm/blob/main/frontend/android/app/src/main/java/com/bima/wakemate/MainActivity.java) hanya berisi kelas kosong `public class MainActivity extends BridgeActivity {}`. Seluruh suara dari Web Audio API maupun elemen `<audio>` HTML5 di dalam Capacitor WebView diputar melalui jalur **Media (`AudioManager.STREAM_MUSIC`)**, bukan jalur **Alarm (`AudioManager.STREAM_ALARM`)**.
* **Dampak:** Jika HP pasangan mengecilkan volume Media (walaupun tidak di-silent) atau mengaktifkan *Do Not Disturb (DND)*, pengaturan `volume = 1.0` di JavaScript tidak mampu menaikkan volume sistem Android. Aplikasi membutuhkan kode Java di [`MainActivity.java`](https://github.com/Luciansvon/Remote-Alarm/blob/main/frontend/android/app/src/main/java/com/bima/wakemate/MainActivity.java) untuk memaksa `AudioManager.setStreamVolume(AudioManager.STREAM_MUSIC, maxVolume, 0)` saat alarm berbunyi.

### 3.2. Putusnya Koneksi Socket.io Saat Layar HP Mati (Android Doze Mode)
* **Lokasi Berkas:** [`AndroidManifest.xml`](https://github.com/Luciansvon/Remote-Alarm/blob/main/frontend/android/app/src/main/AndroidManifest.xml)
* **Akar Masalah:** Ketika HP pasangan diletakkan semalaman dengan layar terkunci, sistem operasi Android akan memasukkan WebView ke mode tidur (*Doze Mode*) dalam beberapa menit dan memutus koneksi WebSocket Socket.io.
* **Dampak:** Sinyal alarm jarak jauh maupun alarm terjadwal dari [`backend/server.js`](https://github.com/Luciansvon/Remote-Alarm/blob/main/backend/server.js) tidak akan diterima oleh HP pasangan sampai layar HP dibuka kembali, kecuali aplikasi dilengkapi **Android Foreground Service** (layanan latar belakang dengan notifikasi aktif) atau **Firebase Cloud Messaging (FCM)** berprioritas tinggi.

### 3.3. Blokir Autoplay Audio & Layar Terkunci pada Android WebView
* **Lokasi Berkas:** [`MainActivity.java`](https://github.com/Luciansvon/Remote-Alarm/blob/main/frontend/android/app/src/main/java/com/bima/wakemate/MainActivity.java)
* **Akar Masalah:** Secara bawaan, Android WebView memblokir pemutaran suara otomatis (`AudioContext` dan `HTMLAudioElement.play()`) jika pengguna belum menyentuh layar terlebih dahulu (`mediaPlaybackRequiresUserGesture = true`). Selain itu, aktivitas belum dikonfigurasi dengan `setShowWhenLocked(true)` dan `setTurnScreenOn(true)`.
* **Dampak:** Saat sinyal alarm tiba, suara berisiko diblokir oleh kebijakan *autoplay* WebView dan layar HP tidak menyala otomatis menembus *lockscreen*.

## 4. Audit Keamanan, Stabilitas & Infrastruktur Backend

### 4.1. Risiko Server Crash Akibat Payload Kosong (Null Destructuring)
* **Lokasi Berkas:** [`backend/server.js`](https://github.com/Luciansvon/Remote-Alarm/blob/main/backend/server.js)
* **Akar Masalah:** Event handler seperti `socket.on('join_room', ({ roomId, username }) => ...)` dan `socket.on('trigger_alarm', (alarmData) => { const { roomId, ... } = alarmData; })` langsung melakukan *destructuring* objek tanpa nilai *fallback* (`= {}`).
* **Dampak:** Jika ada klien yang mengirim event tanpa argumen (`null` atau `undefined`), proses Node.js di [`backend/server.js`](https://github.com/Luciansvon/Remote-Alarm/blob/main/backend/server.js) langsung berhenti total (*crash*) karena `TypeError: Cannot destructure property 'roomId'`.

### 4.2. Kebocoran Memori RAM (Memory Leak) dari Audio Base64 20 MB
* **Lokasi Berkas:** [`backend/server.js`](https://github.com/Luciansvon/Remote-Alarm/blob/main/backend/server.js)
* **Akar Masalah:** Server mengizinkan paket WebSocket hingga **20 MB** (`maxHttpBufferSize: 2e7`) untuk menampung file MP3/TikTok dalam bentuk teks Base64 (`voiceDataUrl`). Seluruh data audio tersebut disimpan di variabel memori `rooms[roomId].scheduledAlarms` dan `rooms[roomId].currentAlarm`. Ketika jadwal alarm sudah berbunyi (`alarm.fired = true`), objek beserta teks Base64 puluhan megabyte tersebut **tidak pernah dihapus** dari array `scheduledAlarms`.
* **Dampak:** Penggunaan RAM server akan terus membengkak setiap kali alarm berbunyi hingga memicu *Out-Of-Memory (OOM) crash*. Selain itu, karena semua jadwal hanya disimpan di variabel RAM (`const rooms = {}`), seluruh jadwal alarm akan hilang jika server di-*restart*.

### 4.3. Selisih Jam & Zona Waktu pada Penjadwalan (`setInterval`)
* **Lokasi Berkas:** [`frontend/src/App.jsx`](https://github.com/Luciansvon/Remote-Alarm/blob/main/frontend/src/App.jsx) dan [`backend/server.js`](https://github.com/Luciansvon/Remote-Alarm/blob/main/backend/server.js)
* **Akar Masalah:** Fungsi `handleScheduleAlarm()` di [`frontend/src/App.jsx`](https://github.com/Luciansvon/Remote-Alarm/blob/main/frontend/src/App.jsx) menghitung `triggerTime` (milidetik epoch) menggunakan jam lokal di HP pengirim, lalu [`backend/server.js`](https://github.com/Luciansvon/Remote-Alarm/blob/main/backend/server.js) membandingkannya dengan `Date.now()` milik server setiap 1 detik.
* **Dampak:** Jika jam di HP pengirim selisih 1–2 menit dengan jam server, alarm yang dipasang untuk beberapa menit ke depan dapat dianggap sudah lewat (`targetDate.getTime() <= Date.now()`) dan otomatis terlempar ke keesokan harinya (+24 jam).

### 4.4. Kesalahan Konfigurasi `backend/package.json` & IP Lokal Statis
* **Lokasi Berkas:** [`backend/package.json`](https://github.com/Luciansvon/Remote-Alarm/blob/main/backend/package.json) dan [`frontend/src/App.jsx`](https://github.com/Luciansvon/Remote-Alarm/blob/main/frontend/src/App.jsx)
* **Akar Masalah:**
  1. [`backend/package.json`](https://github.com/Luciansvon/Remote-Alarm/blob/main/backend/package.json) menunjuk ke `"main": "index.js"` (padahal nama berkasnya adalah [`backend/server.js`](https://github.com/Luciansvon/Remote-Alarm/blob/main/backend/server.js)) dan belum memiliki skrip `"start": "node server.js"`.
  2. [`frontend/src/App.jsx`](https://github.com/Luciansvon/Remote-Alarm/blob/main/frontend/src/App.jsx) menggunakan alamat bawaan `http://192.168.0.23:4000` (IP Wi-Fi lokal).
* **Dampak:** Backend tidak bisa langsung di-*deploy* ke layanan cloud (seperti Render, Railway, atau Fly.io) tanpa memperbaiki `package.json`. Selama masih memakai IP `192.168.0.23`, aplikasi hanya berfungsi jika HP Bima dan HP Pacar tersambung ke Wi-Fi rumah yang sama, dan akan gagal terhubung saat menggunakan kuota data seluler di tempat berbeda.

## 5. Audit UI/UX, Aksesibilitas & Pipeline Build (CI/CD)

### 5.1. Ketidakkonsistenan Kontrol di Tab "Jadwal" vs Tab "Kilat"
* **Lokasi Berkas:** [`frontend/src/App.jsx`](https://github.com/Luciansvon/Remote-Alarm/blob/main/frontend/src/App.jsx)
* **Masalah:** Di Tab 1 (**Kilat**), pengguna dapat memilih **Rekaman Suara Langsung**, mengatur **Slider Volume (50–100%)**, dan mencentang **Misi Bangun 3x Ketuk**. Namun di Tab 2 (**Jadwal**), ketiga kontrol tersebut tidak ditampilkan di layar, padahal fungsi `handleScheduleAlarm()` tetap mengambil nilai `selectedVolume`, `missionRequired`, dan `voiceDataUrl` secara tersembunyi dari state Tab 1.
* **Solusi:** Tampilkan opsi Rekaman Suara, Slider Volume, dan Checkbox Misi 3x Ketuk di dalam Tab 2 (**Jadwal**) agar pengguna tahu persis pengaturan jadwal yang sedang dikunci.

### 5.2. Keamanan Visual Animasi Kedip Layar Penuh (`0.5s` Strobe)
* **Lokasi Berkas:** [`frontend/src/index.css`](https://github.com/Luciansvon/Remote-Alarm/blob/main/frontend/src/index.css)
* **Masalah:** Kelas `.alarm-ringing-bg` menjalankan animasi `@keyframes alarmFlashBg` yang mengubah warna latar layar penuh dari merah terang (`#FF3B30`) ke kuning terang (`#FFE600`) setiap `0.5s` (2 kedipan per detik).
* **Solusi:** Di kamar tidur yang gelap saat baru bangun tidur, kedipan kontras tinggi secepat `0.5s` di seluruh layar sangat menyilaukan mata. Perlambat durasi animasi menjadi `1.5s–2.0s` atau terapkan efek kedip pada bingkai kartu saja.

### 5.3. Font Eksternal Render-Blocking & Patch `node_modules` yang Rapuh
* **Lokasi Berkas:** [`frontend/src/index.css`](https://github.com/Luciansvon/Remote-Alarm/blob/main/frontend/src/index.css), [`frontend/src/App.css`](https://github.com/Luciansvon/Remote-Alarm/blob/main/frontend/src/App.css), [`INCIDENTS.md`](https://github.com/Luciansvon/Remote-Alarm/blob/main/INCIDENTS.md), dan [`.github/workflows/build-apk.yml`](https://github.com/Luciansvon/Remote-Alarm/blob/main/.github/workflows/build-apk.yml)
* **Masalah:**
  1. [`frontend/src/index.css`](https://github.com/Luciansvon/Remote-Alarm/blob/main/frontend/src/index.css) memuat font dari `fonts.googleapis.com` secara online, dan [`frontend/src/App.css`](https://github.com/Luciansvon/Remote-Alarm/blob/main/frontend/src/App.css) berisi CSS `.slider-thumb` / `.slider-track` yang tidak dipakai di [`frontend/src/App.jsx`](https://github.com/Luciansvon/Remote-Alarm/blob/main/frontend/src/App.jsx).
  2. Berdasarkan catatan di [`INCIDENTS.md`](https://github.com/Luciansvon/Remote-Alarm/blob/main/INCIDENTS.md), perubahan `JavaVersion.VERSION_17` dilakukan di dalam folder `frontend/node_modules/@capacitor/...`. Setiap kali `npm install` dijalankan ulang, perubahan di `node_modules` akan terhapus otomatis.

## 6. Panduan Perbaikan Kode Siap Pakai (Remediasi)

### Langkah 1: Perbaiki Normalisasi Volume & Suara di `frontend/src/soundManager.js`

Ubah metode `startAlarm` di [`frontend/src/soundManager.js`](https://github.com/Luciansvon/Remote-Alarm/blob/main/frontend/src/soundManager.js) agar menerima rentang volume `50–100` sekaligus mengenali kunci `'alarm_clock'`:

```javascript
  startAlarm({ sound = 'siren', volume = 1.0, voiceDataUrl = null }) {
    this.initContext();
    this.stopAlarm();
    this.isRinging = true;

    // Normalisasi skala 0-100 menjadi 0.0-1.0 agar tidak pecah (clipping)
    const normalizedVol = volume > 1
      ? Math.min(volume / 100, 1.0)
      : Math.min(Math.max(volume, 0.1), 1.0);

    if ('vibrate' in navigator) {
      this.vibrationInterval = setInterval(() => {
        navigator.vibrate([500, 200, 500, 200, 800]);
      }, 2200);
    }

    if (voiceDataUrl) {
      this.currentVoiceAudio = new Audio(voiceDataUrl);
      this.currentVoiceAudio.loop = true;
      this.currentVoiceAudio.volume = normalizedVol;
      this.currentVoiceAudio.play().catch(err => console.log("Gagal memutar rekaman suara:", err));
      return;
    }

    const triggerSound = () => {
      if (!this.isRinging) return;
      if (sound === 'beep' || sound === 'alarm_clock') {
        this.playBeep(normalizedVol);
      } else if (sound === 'nuclear') {
        this.playNuclear(normalizedVol);
      } else {
        this.playSiren(normalizedVol);
      }
    };

    triggerSound();
    this.soundInterval = setInterval(triggerSound, (sound === 'beep' || sound === 'alarm_clock') ? 800 : 1000);
  }
```

### Langkah 2: Aktifkan Autoplay, Paksa Volume Maksimal & Bangunkan Layar di `MainActivity.java`

Perbarui [`frontend/android/app/src/main/java/com/bima/wakemate/MainActivity.java`](https://github.com/Luciansvon/Remote-Alarm/blob/main/frontend/android/app/src/main/java/com/bima/wakemate/MainActivity.java) agar WebView mengizinkan pemutaran suara otomatis tanpa ketukan layar, menyalakan layar saat terkunci, dan menaikkan volume media Android ke 100%:

```java
package com.bima.wakemate;

import android.content.Context;
import android.media.AudioManager;
import android.os.Build;
import android.os.Bundle;
import android.view.WindowManager;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // Nyalakan layar dan tampilkan di atas lockscreen saat alarm berbunyi
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true);
            setTurnScreenOn(true);
        }
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        // Izinkan Web Audio & HTML5 Audio berbunyi otomatis tanpa harus menyentuh layar
        if (getBridge() != null && getBridge().getWebView() != null) {
            getBridge().getWebView().getSettings().setMediaPlaybackRequiresUserGesture(false);
        }

        // Paksa volume STREAM_MUSIC ke level maksimal agar suara WebView terdengar kencang
        AudioManager audioManager = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
        if (audioManager != null) {
            int maxVolume = audioManager.getStreamMaxVolume(AudioManager.STREAM_MUSIC);
            audioManager.setStreamVolume(AudioManager.STREAM_MUSIC, maxVolume, 0);
        }
    }
}
```

### Langkah 3: Amankan Payload, Bersihkan Memori & Samakan Properti di `backend/server.js`

Perbarui bagian penjadwalan dan event `trigger_alarm` di [`backend/server.js`](https://github.com/Luciansvon/Remote-Alarm/blob/main/backend/server.js) untuk mencegah *server crash* dan membersihkan memori Base64 setelah alarm berbunyi:

```javascript
// Bersihkan data audio Base64 setelah jadwal alarm berbunyi agar RAM tidak penuh
setInterval(() => {
  const now = Date.now();
  for (const roomId in rooms) {
    const room = rooms[roomId];
    if (!room.scheduledAlarms) continue;

    let updated = false;
    for (let i = room.scheduledAlarms.length - 1; i >= 0; i--) {
      const alarm = room.scheduledAlarms[i];
      if (alarm.triggerTime <= now && !alarm.fired) {
        alarm.fired = true;
        room.isAlarmActive = true;
        room.currentAlarm = { ...alarm };

        io.to(roomId).emit('alarm_triggered', room.currentAlarm);

        // Hapus payload Base64 dari daftar riwayat jadwal setelah dieksekusi
        alarm.voiceDataUrl = null;
        updated = true;
      }
    }
    if (updated) {
      io.to(roomId).emit('scheduled_list_updated', room.scheduledAlarms);
    }
  }
}, 1000);

// Gunakan default parameter = {} agar server tidak crash jika menerima payload kosong
socket.on('trigger_alarm', (alarmData = {}) => {
  const { roomId, sender, target, targetName, title, volume, sound, message, voiceDataUrl, missionRequired } = alarmData;
  if (!roomId || !rooms[roomId]) return;

  const alarmPayload = {
    id: Date.now().toString(),
    sender: sender || 'Pasangan',
    target: target || targetName || 'Pasangan',
    title: title || 'ALARM DARURAT!',
    volume: typeof volume === 'number' ? volume : 100,
    sound: sound || 'siren',
    message: String(message || '').slice(0, 200),
    voiceDataUrl: voiceDataUrl || null,
    missionRequired: Boolean(missionRequired),
    timestamp: Date.now()
  };

  rooms[roomId].isAlarmActive = true;
  rooms[roomId].currentAlarm = alarmPayload;
  io.to(roomId).emit('alarm_triggered', alarmPayload);
});
```

### Langkah 4: Perbaiki `backend/package.json` untuk Deployment Cloud

Sesuaikan [`backend/package.json`](https://github.com/Luciansvon/Remote-Alarm/blob/main/backend/package.json) agar siap di-*deploy* ke layanan cloud publik:

```json
{
  "name": "wakemate-backend",
  "version": "1.0.0",
  "description": "Realtime Socket.io Backend Server for Wake-Mate Remote Alarm",
  "main": "server.js",
  "scripts": {
    "start": "node server.js",
    "dev": "node --watch server.js"
  },
  "license": "ISC",
  "type": "commonjs",
  "dependencies": {
    "cors": "^2.8.6",
    "express": "^5.3.0",
    "socket.io": "^4.8.4"
  }
}
```
