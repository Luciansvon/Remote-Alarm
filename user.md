# Profil Pengguna: Bima

## Karakteristik & Pemahaman Teknis
- **Latar Belakang**: Tidak memiliki pemahaman dasar tentang pemrograman (fundamental coding).
- **Gaya Komunikasi**:
  - Lebih suka penjelasan yang praktis, to-the-point, dan mudah dipahami (hindari jargon teknis seperti dependensi, arsitektur microservices, sintaks kode, hook, dll. Gunakan analogi sehari-hari).
  - Senang dengan aksi nyata dan pembuktian langsung (misalnya langsung lihat hasil di emulator / screenshot).
  - Berikan instruksi langkah-demi-langkah yang tinggal diikuti ("klik ini", "buka itu").

## Kebutuhan & Proyek
- **Tujuan Utama**: Aplikasi alarm jarak jauh (*remote alarm*) untuk membangunkan pacar yang susah bangun dan sering mengaktifkan mode hening (silent).
- **Perangkat**: Keduanya menggunakan HP Android.
- **Nama Aplikasi**: Wake-Mate (`com.bima.wakemate`).
- **Gaya Visual Favorit**: **Neubrutalism (Neo-Brutalism)** (garis pinggir hitam tebal, warna cerah mencolok, bayangan tegas tanpa blur, tombol chunky).

## Fitur Utama yang Diinginkan
1. **Tembus Mode Hening (Silent)**: Alarm harus bisa berbunyi kencang (volume 100% atau bisa diatur) meskipun HP penerima dalam mode senyap.
2. **Kendali Jarak Jauh (Remote Trigger)**: Bima bisa membunyikan alarm langsung dari HP miliknya ke HP pacar.
3. **Jadwal Jam Jarak Jauh**: Bima bisa mengatur jam alarm (misal besok pagi jam 06.30) dari HP-nya ke HP pacar.
4. **Misi Mematikan Alarm**: Pacar tidak bisa langsung mematikan alarm dengan sekali klik sengaja/tidak sengaja (harus tap 3x tombol bangun).
5. **Suara Kustom TikTok / File Audio**: Bima ingin bisa memasang suara alarm sendiri yang diambil dari TikTok (berkas audio MP3/WAV/rekaman dari HP) agar alarmnya bisa berbunyi suara viral TikTok tersebut.

## Aturan Keras & Preferensi Khusus
- **ATURAN KERAS: JANGAN PERNAH TES/BUNYIKAN ALARM TIBA-TIBA!**
  - Dilarang keras memicu bunyi alarm, menguji suara kencang, atau mengetes alarm di emulator/perangkat tanpa izin langsung atau aba-aba dari Bima.
- **Komunikasi**: Gunakan bahasa Indonesia penuh, sederhana, tanpa istilah koding yang rumit.

## Riwayat Sesi Penting
- **Sesi `30d0b758-10fc-4c87-aacc-8588967843f2`**:
  - Pembongkaran (Reverse Engineering / REA) 3 aplikasi contoh: PingPal, MacroDroid, dan Galarm.
  - Pembuatan aplikasi Wake-Mate (Frontend: React + Neubrutalism, Backend: Node.js + WebSocket Socket.io, Mobile Wrapper: Capacitor Android).
  - Berhasil diuji coba di Android Emulator.
  - Status terakhir: Siap untuk langkah pembuatan berkas instalasi fisik (.APK) ke HP masing-masing.
- **Sesi `c4b69001-d1f8-4b35-9e89-d88321c2cdb5`**:
  - Bima meminta audit menyeluruh berkas APK menggunakan 10 agen spesialis ditambah 1 agen verifikator independen untuk memastikan setiap temuan bug benar-benar nyata dan bukan kesalahan deteksi.
  - Sangat mementingkan kepastian fungsi alarm (keandalan tembus hening, jaringan, dan ketepatan waktu) sebelum dipasang di HP pacar.
  - Bima membawa masukan audit eksternal dari "Argon" (`audit_argon.md`) untuk dicatat dan digabungkan dengan temuan tim investigasi internal sebelum mengambil tindakan perbaikan.
  - Audit gabungan tuntas: membuktikan 3 klaim Argon ternyata aman/bukan bug, serta mengonfirmasi bug kritis nyata (alarm balik serang pengirim, kamar server terhapus otomatis, WebView terjebak saluran musik tanpa STREAM_ALARM, dan bypass tombol back). Laporan final tersimpan di `laporan_audit_final.md`.
