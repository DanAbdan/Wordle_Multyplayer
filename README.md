# Tebak Kata KBBI (Wordle multiplayer)

Game tebak kata 5 huruf berbahasa Indonesia, bisa dimainkan bareng teman (maks. 12 pemain per room).

- Gabung lewat **link undangan** atau **kode room** (5 huruf)
- Semua pemain menebak **kata yang sama secara bersamaan**, skor berdasarkan kecepatan
- Host mengatur **jumlah ronde** (1-20) dan **waktu per ronde** (30 dtk - 10 menit)
- Leaderboard per room + podium di akhir game
- Tampilan terang + dark mode, responsif di HP dan desktop
- Kata tebakan harus ada di daftar KBBI (9.015 kata 5 huruf), kata jawaban dipilih dari ±780 kata umum

---

## Cara deploy gratis (tanpa coding, ±10 menit)

Kamu butuh 2 akun gratis: **GitHub** dan **Render**.

### 1. Taruh kode di GitHub
1. Ekstrak file zip ini di komputermu.
2. Buka https://github.com, login/daftar, lalu klik **New repository**. Beri nama `tebak-kata-kbbi`, pilih **Public**, klik **Create repository**.
3. Di halaman repo klik **uploading an existing file**, lalu **seret semua isi folder hasil ekstrak** (`server.js`, `package.json`, `render.yaml`, folder `public`, folder `data`, dll.) ke halaman itu. Pastikan folder `public` dan `data` ikut terupload.
4. Klik **Commit changes**.

### 2. Deploy di Render
1. Buka https://render.com dan **Sign up dengan akun GitHub**.
2. Klik **New +** lalu **Blueprint**, pilih repo `tebak-kata-kbbi`, klik **Apply**.
   (Kalau tidak ada menu Blueprint: **New + > Web Service**, pilih repo, isi *Build Command* `npm install`, *Start Command* `npm start`, *Instance Type* **Free**.)
3. Tunggu 2-5 menit sampai statusnya **Live**. Link game ada di bagian atas halaman, bentuknya `https://tebak-kata-kbbi-xxxx.onrender.com`.
4. Buka link itu, buat room, lalu kirim link undangan ke teman-temanmu.

### Hal yang perlu diketahui (paket gratis Render)
- Kalau tidak ada yang membuka game selama ±15 menit, server "tidur". Pembukaan pertama setelah itu butuh ±30-60 detik. **Buka link-nya 1 menit sebelum mulai main.**
- Room disimpan di memori server, jadi kalau server tidur/restart, room yang sedang berjalan hilang (buat room baru saja).
- Selama game berjalan dan ada pemain tersambung, server tetap aktif.

---

## Coba di komputer sendiri (opsional)

Butuh Node.js 18+.

```
npm install
npm start
```

Buka http://localhost:3000. Teman di WiFi yang sama bisa gabung lewat `http://IP-KOMPUTERMU:3000`.

## Mengubah daftar kata

- `data/valid.txt`: semua kata yang boleh ditebak (satu kata per baris, 5 huruf, huruf kecil)
- `data/answers.txt`: kata yang bisa jadi jawaban (harus ada juga di `valid.txt`)

Daftar kata berasal dari kompilasi komunitas (repo `damzaky/kumpulan-kata-bahasa-indonesia-KBBI`), bukan data resmi dari Badan Bahasa, jadi mungkin ada kata KBBI yang belum masuk atau ada entri yang kurang lazim.
