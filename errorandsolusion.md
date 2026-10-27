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
