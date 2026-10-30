# Tebak Kata KBBI (Wordle multiplayer)

Game tebak kata 5 huruf berbahasa Indonesia, bisa dimainkan bareng teman (maks. **24 pemain** per room).

## Fitur
- Gabung lewat **link undangan** atau **kode room** (5 huruf)
- Semua pemain menebak **kata yang sama secara bersamaan**, skor berdasarkan kecepatan
- Host mengatur **jumlah ronde** (1-20) dan **waktu per ronde** (30 dtk - 10 menit)
- **2 mode**: Normal dan Skill (dipilih saat membuat room, host bisa mengganti di lobi)
- **Stiker**: maks. 5 foto yang kamu upload lewat panel admin; pemain mengirimnya lewat tombol 🙂
- **Warna ramah buta warna** (biru, oranye, abu-abu) plus tanda di ubin; tidak lagi hijau-kuning
- Leaderboard per room + podium di akhir game, dark mode, responsif HP dan desktop
- **Akun pemain** (👤): daftar/masuk dengan username + password, nama dan **foto profil** tetap sama setiap main. Tamu tetap bisa main tanpa akun.
- **Peringkat mingguan** (🏆, di kanan atas sebelum tombol ?): 2 papan, yaitu **jumlah jawaban benar** dan **streak benar terbanyak**. Dihitung dari semua game (solo atau berapa pun pemainnya), hanya untuk pemain yang login. Minggu = Senin 00:00 sampai Minggu 23:59 WIB, data tiap minggu tersimpan permanen dan minggu lalu bisa dilihat lagi.
- **Batalkan game** (host): kalau salah setting waktu/mode, tekan *Batalkan game*, semua kembali ke lobi dan hasilnya tidak dihitung ke peringkat.
- **Panel admin**: kelola stiker dan pengguna (reset password, hapus foto, hapus akun).
- Kata tebakan harus ada di daftar KBBI (9.015 kata 5 huruf), jawaban dipilih dari ±780 kata umum

## Mode Skill
Tiap **3 ronde** (ronde 1, 4, 7, ...) setiap pemain dapat **1 skill acak**, selalu beda dari skill sebelumnya. Skill sekali pakai selama 3 ronde itu.

| Skill | Efek |
|---|---|
| 🔍 Intip | Menampilkan 1 huruf jawaban di posisinya |
| 🚫 Coret | Mencoret 3 huruf yang pasti tidak ada di jawaban |
| ❄️ Bekukan | Membekukan pemain peringkat teratas selama 6 detik (tidak bisa mengetik) |
| 🛡️ Perisai | Otomatis menangkal 1 serangan Bekukan |
| ⚡ Skor Ganda | Poin ronde itu ×2 kalau benar, tetapi −100 kalau gagal |

## Hemat bandwidth
Server hanya mengirim perubahan kecil saat ada tebakan, bukan seluruh data room. Hasil ukur: **1 game 24 pemain (4 ronde) ≈ 3,2 MB** total. Jatah gratis Render 5 GB/bulan cukup untuk ribuan game. Room yang isinya lebih sedikit memakai lebih sedikit lagi.

---

## Cara kerja (singkat, buat belajar)
- **Login**: password tidak disimpan polos, tapi di-*hash* dengan `scrypt` (satu arah, lambat sengaja supaya sulit ditebak). Setelah login, server memberi *cookie* bertanda tangan (HMAC) yang berlaku 30 hari. Cookie itu `HttpOnly`, jadi tidak bisa dibaca script di halaman.
- **Keamanan**: permintaan yang mengubah data wajib membawa header khusus + Origin yang sama (anti-CSRF), login dibatasi percobaannya, foto dicek isi file aslinya (bukan cuma nama).
- **Foto profil**: dikecilkan di browser jadi 128x128 px (≤55 KB), disimpan di Upstash, dan dikirim ke pemain lain lewat alamat `/av/username?v=N` (N naik tiap ganti foto, jadi browser selalu dapat foto terbaru dan boleh menyimpan cache lama).
- **Peringkat**: tiap ronde dicatat (benar/salah). Saat game selesai, server menulis hasil pemain yang login ke Upstash dalam **satu** permintaan. Streak dihitung berurutan lintas ronde dan lintas game dalam minggu yang sama, dan reset ke 0 kalau salah atau waktu habis. Pemain yang keluar di tengah game tetap dihitung untuk ronde yang sudah selesai. Game yang dibatalkan tidak dihitung sama sekali.
- **Hemat kuota Upstash**: akun, foto, dan papan peringkat disalin di memori server, jadi login, buka peringkat, dan kirim foto **tidak** memakai perintah Upstash. Perkiraan: 1 game ≈ 3 perintah per pemain yang login (diukur: 12 perintah untuk game 3 pemain 2 ronde). Kuota gratis 500.000 perintah/bulan, jadi aman walau main ratusan game per minggu. Angka perintah sejak server menyala terlihat di panel admin; angka resmi ada di dashboard Upstash.
- **Kalau Upstash sedang error**: game tetap jalan; hasil peringkat masuk antrean dan dicoba lagi otomatis tiap 30 detik. Login dan pendaftaran baru memberi pesan "penyimpanan belum tersambung" sampai pulih.

---

# Update dari versi lama (kamu sudah punya game di Render)

## A. Ganti file di GitHub
1. Ekstrak zip ini di komputermu.
2. Buka repo `tebak-kata-kbbi` di GitHub, klik **Add file → Upload files**.
3. Seret **semua isi folder hasil ekstrak** (`server.js`, `package.json`, `README.md`, folder `public`, folder `data`, dll.) ke halaman itu. File lama dengan nama sama akan tertimpa.
4. Klik **Commit changes**. Render otomatis deploy ulang (2-5 menit).

## B. Siapkan penyimpanan permanen gratis (Upstash)
Tanpa langkah ini panel admin tetap jalan, tapi stiker **hilang setiap server restart/tidur** (paket gratis Render tidak punya disk permanen).

1. Buka https://upstash.com, klik **Sign up** (bisa pakai akun Google atau GitHub). Paket gratis, tanpa kartu kredit.
2. Di Console, buka tab **Redis**, klik **Create Database**.
3. Isi nama `tebak-kata`, pilih region terdekat (mis. **Singapore**), pilih paket **Free**, klik **Create**.
4. Di halaman database, cari bagian **REST API** (tab `.env`). Salin dua nilai: `UPSTASH_REDIS_REST_URL` dan `UPSTASH_REDIS_REST_TOKEN`. (Tampilan Upstash bisa sedikit berbeda dari ini, tapi dua nilai itu selalu ada.)

## C. Isi Environment di Render
1. Buka https://dashboard.render.com, pilih service `tebak-kata-kbbi`, buka menu **Environment**.
2. Klik **Add Environment Variable** dan isi variabel ini (kalau dulu sudah mengisi 4 yang pertama, **tidak perlu diubah**; update ini tidak butuh variabel baru):

| Key | Isi |
|---|---|
| `ADMIN_USER` | username pilihanmu (min. 3 huruf) |
| `ADMIN_PASSWORD` | password panjang dan sulit ditebak (min. 8 karakter, makin panjang makin aman) |
| `SESSION_SECRET` | *(opsional)* teks acak panjang (30+ karakter). Kalau kosong, server membuat kuncinya sendiri dan menyimpannya di Upstash, jadi pemain tetap login walau server restart |
| `UPSTASH_REDIS_REST_URL` | nilai dari Upstash langkah B.4 |
| `UPSTASH_REDIS_REST_TOKEN` | nilai dari Upstash langkah B.4 |

3. Klik **Save Changes**. Render deploy ulang otomatis.
4. Jangan bagikan username/password ke siapa pun, dan jangan menulisnya di GitHub.

## C2. Cek update berhasil (setelah deploy selesai)
1. Buka game: di kanan atas harus ada tombol 👤 dan 🏆 sebelum tombol ?.
2. Klik 👤, daftar akun, lalu pilih foto. Buat room dan lihat fotomu muncul di lobi.
3. Main 1 ronde, lalu klik 🏆: namamu muncul di papan minggu ini.
4. Buka `/admin`: harus ada kartu **Pengguna terdaftar** berisi akunmu.
5. Tes batalkan: mulai game, klik **Batalkan game** di atas papan, pilih Ya.

## D. Pakai panel admin
1. Buka `https://NAMA-SERVICEMU.onrender.com/admin` lalu login.
2. Pilih foto, cek pratinjau, klik tambah. Foto otomatis dikecilkan agar hemat. Maksimal **5 stiker**; hapus salah satu kalau mau ganti.
3. Di bagian atas panel ada status penyimpanan. Harus tertulis **"Tersimpan permanen (Upstash)"**. Kalau muncul peringatan, cek lagi dua nilai Upstash di Render.
4. Perubahan langsung muncul di pemain yang sedang online, tanpa deploy.
5. Kartu **Pengguna terdaftar**: *Reset password* membuat password sementara 10 karakter (tampil sekali, kirim ke pemainnya), *Hapus foto* kalau fotonya tidak pantas, *Hapus akun* menghapus akun, foto, dan datanya di peringkat. Di situ juga ada jumlah perintah Upstash sejak server menyala.
6. Pemain lupa password: minta mereka chat kamu, lalu reset dari panel.

Keamanan panel: password hanya ada di Environment Render (bukan di kode), login dibatasi 5 percobaan lalu dikunci sementara, cookie sesi aman, dan hanya file foto yang diterima (GIF dan SVG ditolak).

---

# Deploy dari nol (belum pernah deploy)
1. Taruh semua isi zip ke repo GitHub baru (Public) lewat **Add file → Upload files**.
2. Di https://render.com daftar dengan akun GitHub, klik **New + → Blueprint**, pilih repo, klik **Apply**. (Kalau tidak ada Blueprint: **New + → Web Service**, Build Command `npm install`, Start Command `npm start`, Instance Type **Free**.)
3. Lanjut ke langkah **B**, **C**, dan **D** di atas.

## Hal yang perlu diketahui (paket gratis Render)
- Server "tidur" kalau 15 menit tidak ada pengunjung; buka pertama setelah itu butuh ±30-60 detik. **Buka link 1 menit sebelum mulai main.**
- Room disimpan di memori server, jadi kalau server restart, room yang sedang berjalan hilang (dan hasilnya tidak masuk peringkat). Stiker, akun, foto, dan peringkat aman karena disimpan di Upstash.
- Tamu (tanpa akun) tidak masuk peringkat dan nama tamu tidak boleh sama dengan nama akun terdaftar.
- Akun tidak punya email, jadi tidak ada "lupa password" otomatis; admin yang mereset.
- Streak dan jawaban benar bisa "dikejar" dengan main solo berkali-kali. Itu sengaja diperbolehkan (dihitung dari semua game).
- Render bisa me-restart server kapan saja, jadi jangan menjadwalkan acara penting tanpa cadangan.

## Coba di komputer sendiri (opsional)
Butuh Node.js 18+.

```
npm install
npm start
```

Buka http://localhost:3000. Panel admin di `/admin` aktif kalau `ADMIN_USER` dan `ADMIN_PASSWORD` diisi.

## Mengubah daftar kata
- `data/valid.txt`: semua kata yang boleh ditebak (satu per baris, 5 huruf, huruf kecil)
- `data/answers.txt`: kata yang bisa jadi jawaban (harus ada juga di `valid.txt`)

Daftar kata berasal dari kompilasi komunitas (repo `damzaky/kumpulan-kata-bahasa-indonesia-KBBI`), bukan data resmi Badan Bahasa, jadi mungkin ada kata KBBI yang belum masuk.
