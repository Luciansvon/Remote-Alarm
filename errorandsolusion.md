# Catatan Error dan Solusi: Wake-Mate (Remote Alarm)

## 1. Alarm Menyerang Balik Pengirim & Pembatalan Dobel
- **Masalah/Error**: Saat Bima memicu alarm darurat untuk pacar, HP Bima sendiri ikut berdering keras dan terkunci layar Misi 3x Ketuk. Ketika Bima mematikan alarm di tangannya, alarm di HP pacar seketika ikut mati.
- **Penyebab**: Event listener `socket.on('alarm_triggered')` di `frontend/src/App.jsx` membunyikan alarm ke siapa pun di dalam ruangan tanpa memeriksa siapa pengirimnya.
- **Solusi**: Tambahkan filter `isSender = data?.sender === myName`. Jika pengguna adalah pengirim, jangan bunyikan alarm lokal dan jangan kunci layar. Cukup tampilkan status bahwa alarm sedang berdering di HP pasangan.

## 2. Kamar Pasangan & Jadwal Alarm Lenyap Saat Ditinggal Tidur Semalaman
- **Masalah/Error**: Jadwal alarm jam 06.30 pagi tidak berbunyi jika HP Bima dan HP pacar sama-sama mengunci layar semalaman.
- **Penyebab**: Pada `backend/server.js` di dalam handler `disconnect`, terdapat kode `delete rooms[roomId]` saat tidak ada pengguna yang aktif.
- **Solusi**: Hapus perintah penghapusan kamar saat disconnect. Objek kamar dan seluruh daftar jadwal alarm di memori server tetap tersimpan meskipun kedua HP offline.

## 3. Server Crash Akibat Payload Kosong (Null Destructuring)
- **Masalah/Error**: Jika ada socket client yang mengirim pesan tanpa argumen (`null`/`undefined`), proses Node.js langsung mati mendadak dengan error `TypeError: Cannot destructure property`.
- **Penyebab**: Handler socket langsung melakukan destructuring tanpa nilai default fallback.
- **Solusi**: Tambahkan default fallback parameter `(data = {})` pada seluruh event listener Socket.io di `backend/server.js`.

## 4. Akumulasi Memori RAM Server dari File Audio Base64 (Memory Leak)
- **Masalah/Error**: Penggunaan RAM server terus membengkak setiap kali alarm berbunyi karena file audio TikTok/rekaman disimpan dalam bentuk teks Base64 besar (hingga 15-20MB).
- **Penyebab**: Jadwal alarm yang sudah berdering hanya ditandai `alarm.fired = true` tetapi teks Base64 `voiceDataUrl` tidak pernah dibersihkan dari memori.
- **Solusi**: Setel `alarm.voiceDataUrl = null` pada objek jadwal di server segera setelah alarm berbunyi, sehingga daftar riwayat jadwal tidak membebani memori server maupun bandwidth socket.

## 5. Saluran Suara WebView Android & Bypass Tombol Back
- **Masalah/Error**: Suara alarm WebView masuk ke saluran media biasa yang bisa bisu saat mode hening, dan pacar bisa mematikan alarm dengan sekali usap tombol Back tanpa menyelesaikan misi 3 ketukan.
- **Penyebab**: `MainActivity.java` masih kosong tanpa custom logic native Android.
- **Solusi**: Di `MainActivity.java`, pasang pemaksa volume maksimal pada `AudioManager.STREAM_MUSIC`, aktifkan `setShowWhenLocked(true)`, `setTurnScreenOn(true)`, dan `FLAG_KEEP_SCREEN_ON`. Override `onBackPressed()` dengan `moveTaskToBack(true)` agar usapan tombol kembali tidak membunuh proses alarm.

## 6. Kelengkapan Izin Android Modern (Android 13–15 / API 33–36)
- **Masalah/Error**: Alarm dilarang muncul di atas lockscreen pada Android 14+ tanpa izin resmi.
- **Penyebab**: `AndroidManifest.xml` belum mendeklarasikan izin `POST_NOTIFICATIONS`, `USE_FULL_SCREEN_INTENT`, dan `SCHEDULE_EXACT_ALARM`.
- **Solusi**: Tambahkan ketiga izin tersebut di `frontend/android/app/src/main/AndroidManifest.xml`.

## 7. Kenyamanan Animasi Layar di Kamar Gelap
- **Masalah/Error**: Kedipan merah-kuning 0.5 detik (2 Hz) sangat menyilaukan mata bagi orang yang baru melek di kamar tidur gelap.
- **Penyebab**: Durasi animasi `@keyframes alarmFlashBg` terlalu singkat dan kontras ekstrem.
- **Solusi**: Di `frontend/src/index.css`, perpanjang durasi siklus kedip menjadi 1.6 detik dengan transisi warna merah-oranye yang lebih ramah mata.

## 8. Celah Kamar Tanpa PIN & Pembajakan Aksi Lintas Kamar (AUD-01)
- **Masalah/Error**: Siapa pun di internet yang menebak atau mengetahui nama kamar bisa masuk tanpa izin, mematikan alarm, atau memicu alarm orang lain lewat injeksi parameter `data.roomId`.
- **Penyebab**: `join_room` tidak memvalidasi PIN rahasia dan handler aksi mengambil `data.roomId` dari payload klien yang belum tentu anggota kamar.
- **Solusi**: Terapkan enkripsi hash SHA-256 pada PIN kamar di `backend/server.js`, tolak sambungan dengan event `auth_error` jika PIN salah, dan kunci semua aksi (`trigger_alarm`, `schedule_alarm`, `stop_alarm`) hanya menggunakan `socket.data.roomId` sesi resmi. Tambahkan input PIN di tab Pengaturan UI `frontend/src/App.jsx`.

## 9. Deteksi Pengirim Alarm Berbasis Nama Peran Statis Rawan Tabrakan (AUD-07)
- **Masalah/Error**: Jika HP Bima dan HP Pacar sama-sama memilih peran 'Bima' (atau keduanya 'Pacar'), HP penerima salah mengevaluasi dirinya sebagai pengirim sehingga alarm tidak berbunyi.
- **Penyebab**: Logika frontend hanya membandingkan `data?.sender === myName`.
- **Solusi**: Tambahkan `senderSocketId: socket.id` pada payload alarm instan di `backend/server.js`. Di `frontend/src/App.jsx`, periksa kecocokan ID koneksi fisik `data?.senderSocketId === socket.id` agar perangkat penerima dijamin tetap berdering terlepas dari pilihan tab peran.

## 10. Kebocoran Memori Residu Audio & Kuota Jadwal Tak Terbatas (AUD-02)
- **Masalah/Error**: Audio rekaman Base64 berukuran megabyte disimpan terus-menerus di `currentAlarm`, jadwal di masa depan bisa dibuat tanpa batas, dan kamar pasif menumpuk di RAM.
- **Penyebab**: Tidak ada kuota jadwal per kamar, string Base64 tidak di-null-kan di `currentAlarm`, dan tidak ada mekanisme pembersihan berkala (*garbage collection*).
- **Solusi**: Terapkan batas maksimal 10 jadwal aktif per kamar dengan penolakan `alarm_error`. Bersihkan `voiceDataUrl = null` dari `rooms[roomId].currentAlarm` setelah sinyal dipancarkan. Tambahkan pembersihan otomatis di `setInterval` untuk membuang jadwal fired > 1 jam dan kamar kosong > 48 jam.

## 11. Ketiadaan Rate Limiting & Perlindungan DoS Socket (AUD-03)
- **Masalah/Error**: Klien dapat membanjiri server dengan puluhan permintaan alarm instan atau jadwal berukuran besar dalam hitungan detik.
- **Penyebab**: Event listener Socket.io tidak memeriksa interval jeda antar pesan dari klien yang sama.
- **Solusi**: Tambahkan fungsi `isRateLimited(socket, 2000)` di `backend/server.js`. Jika aksi dilakukan kurang dari 2 detik sejak aksi terakhir, server menolak permintaan dan mengirimkan event `rate_limit_error`.

## 12. Ketiadaan Validasi Format Data URI Audio & Privasi Perangkat (AUD-04)
- **Masalah/Error**: Pengguna dapat menyisipkan tautan HTTP/HTTPS eksternal pada `voiceDataUrl`, yang dapat membocorkan alamat IP dan User-Agent penerima saat audio dimuat.
- **Penyebab**: Backend dan frontend langsung menerima string tanpa memeriksa skema Data URI Base64 audio murni.
- **Solusi**: Terapkan ekspresi reguler `AUDIO_DATA_URL_REGEX` di `backend/server.js` dan `frontend/src/soundManager.js`. Jika format tidak valid, server menolaknya menjadi `null`, dan pemutar audio frontend otomatis beralih (*fallback*) ke nada dering sirine Web Audio API bawaan agar alarm tetap berbunyi keras dan aman.

## 13. Koneksi Socket Terputus Saat Android Doze Mode Semalaman (AUD-06)
- **Masalah/Error**: Saat layar HP pacar dimatikan semalaman sebelum tidur, sistem operasi Android memasuki mode hemat daya mendalam (*Doze Mode*) dan memutus soket WebView sehingga alarm jarak jauh gagal sampai.
- **Penyebab**: Belum ada `ForegroundService` dengan penahan daya CPU (*PARTIAL_WAKE_LOCK*) dan penahan koneksi Wi-Fi (*WifiLock*).
- **Solusi**: Buat layanan `WakeMateKeeperService.java` berstatus Foreground Service dengan notifikasi persisten berprioritas siaga ("WakeMate Siaga"), didukung izin `FOREGROUND_SERVICE` dan `FOREGROUND_SERVICE_DATA_SYNC` di `AndroidManifest.xml`.

## 14. Penguncian Volume Statis Hanya di `onCreate()` (AUD-06)
- **Masalah/Error**: Jika pengguna menurunkan volume media HP setelah aplikasi dibuka, alarm yang berdering beberapa jam kemudian bersuara pelan karena volume maksimal hanya dipasang sekali di `onCreate()`.
- **Penyebab**: Tidak ada jembatan dari web UI ke audio manager Android untuk memicu penguatan volume secara dinamis saat alarm aktif.
- **Solusi**: Buat `@CapacitorPlugin` bernama `WakeMateNativePlugin.java` dengan method `maximizeVolume()` yang memaksa `STREAM_MUSIC` dan `STREAM_ALARM` naik ke level maksimal pada detik `triggerLocalAlarm()` dipanggil di `frontend/src/App.jsx`.

## 15. Keamanan Transpor HTTP Cleartext & Konfigurasi Fleksibel (AUD-05)
- **Masalah/Error**: Pengaturan lalu lintas HTTP tanpa enkripsi diterapkan secara global tanpa batas domain dan URL server default terkunci kaku (*hardcoded*).
- **Penyebab**: `AndroidManifest.xml` tidak menggunakan `networkSecurityConfig` dan `App.jsx` mengunci alamat IP lokal statis.
- **Solusi**: Buat `res/xml/network_security_config.xml` untuk membatasi izin HTTP cleartext hanya untuk domain/subnet lokal dan emulator. Di `App.jsx`, dukung variabel lingkungan `VITE_DEFAULT_SERVER_URL` yang fleksibel.

## 16. Standarisasi Kompilasi Java 17 dan Linting di CI/CD (AUD-08)
- **Masalah/Error**: Modifikasi Java 17 di `node_modules` dapat hilang saat dependensi diperbarui ulang, serta tidak ada pengujian linting otomatis sebelum build APK.
- **Penyebab**: Konfigurasi `sourceCompatibility` tidak dikunci di berkas build root dan GitHub Actions belum menjalankan oxlint.
- **Solusi**: Kunci `sourceCompatibility` dan `targetCompatibility` ke `JavaVersion.VERSION_17` pada blok `tasks.withType(JavaCompile)` di `frontend/android/build.gradle`. Tambahkan langkah `npx oxlint` pada alur kerja `.github/workflows/build-apk.yml`.
