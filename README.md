# Payung AI Studio

Creative workspace untuk membuat storyboard iklan, prompt video, ide konten social-commerce, kalender 30 hari, dan Content Vault. Generator lokal dapat digunakan tanpa akun. Aplikasi ini menyusun teks dan prompt; aplikasi ini **tidak merender video** dan tidak mengambil data marketplace secara otomatis.

## Fitur dan batas penyimpanan

- Generator storyboard, template iklan, library teknik cinematic, ekspor TXT/print/PDF, dan proyek cinematic tersimpan di browser.
- Proyek/draft cinematic lokal dipisahkan berdasarkan akun Supabase yang sedang login; data Guest dipisah dari akun. `localStorage` tetap bukan penyimpanan aman—jangan menyimpan password atau rahasia di dalamnya.
- Cache Vault/kalender/metrik juga dipisahkan per akun; saat sinkronisasi gagal, salinan lokal akun tetap dipertahankan. Data lama yang belum memiliki identitas akun dimigrasikan ke ruang Guest, bukan ditempelkan ke akun yang sedang login.
- Jika sesi akun tidak dapat diverifikasi, tampilan cache akun dikunci tanpa menghapus datanya; cache dapat ditampilkan lagi setelah sesi pulih. Cache Guest hanya dimuat bila tidak ada token sesi Supabase tersimpan.
- Content Vault, kalender, dan metrik performa manual dapat disinkronkan ke workspace Supabase saat login.
- Tombol Gemini mengirim prompt teks ke backend Payung AI Studio, lalu backend meneruskannya ke Google Gemini. Foto referensi hanya dipratinjau lokal dan tidak dikirim.
- Masukkan fakta produk yang benar dan tinjau output AI sebelum digunakan atau dipublikasikan.

## Arsitektur hosting

Frontend dan API dipublikasikan terpisah:

1. **Frontend:** GitHub Pages dari branch `main`, root `/`. URL saat ini: <https://misba234.github.io/payung-ai-studio/>.
2. **API:** Cloudflare Worker `payung-ai-studio`, dengan endpoint `/generate` dan `/health`. `wrangler.jsonc` saat ini hanya mengonfigurasi Worker API dan tidak mengikat aset statis. Menjalankan `wrangler deploy` saja **tidak** menerbitkan halaman HTML.

`index.html` dan `public/index.html` adalah salinan identik; jika mengubah UI, sinkronkan keduanya. Redirect email Supabase dan `ALLOWED_ORIGINS` di `worker.js` harus cocok dengan domain frontend yang benar.

## Persyaratan backend AI/cloud

Sebelum mengaktifkan fitur akun/Gemini di lingkungan produksi, administrator perlu memverifikasi konfigurasi proyek Supabase yang digunakan aplikasi:

- Supabase Auth dengan URL redirect yang mengizinkan URL frontend.
- Tabel `ai_credits` dan `user_workspace`, kebijakan RLS/ownership, serta RPC `consume_ai_credit`, `refund_ai_credit`, dan `finalize_ai_credit`. Definisi SQL/migrasi belum disertakan dalam repositori ini; audit skema dan kebijakannya wajib dilakukan di proyek Supabase.
- Secret Cloudflare Worker `GEMINI_API_KEY` dan `SUPABASE_SERVICE_ROLE_KEY`. Masukkan melalui secret manager/CLI Cloudflare; jangan menulis nilainya ke file, HTML, Git, atau log.
- Uji lengkap setelah konfigurasi: login, pembacaan saldo, sinkronisasi workspace, satu permintaan Gemini, serta alur refund/finalisasi kredit.

Worker mengembalikan `503` untuk fitur AI jika `GEMINI_API_KEY` belum tersedia. Secret `SUPABASE_SERVICE_ROLE_KEY` juga diperlukan untuk operasi kredit, tetapi keberadaannya tidak dapat diverifikasi dari file publik.

## Pengembangan lokal

Jalankan server statis dari root repo:

```sh
python3 -m http.server 8000
```

Lalu buka <http://localhost:8000>. Fitur lokal dapat diuji di sana. Login dan AI cloud memerlukan konfigurasi Supabase/Worker untuk origin lokal, sehingga tidak otomatis berfungsi pada server lokal.

Pemeriksaan sintaks JavaScript inline HTML dan Worker dapat dilakukan dengan Node.js. Perubahan pada UI harus diuji di desktop dan perangkat seluler serta pada kedua salinan HTML.

## Catatan rilis

Repo ini belum menyediakan migrasi/database policy Supabase, suite tes otomatis, CI, panduan rollback, atau aturan rate-limit produksi. Jangan menyatakan layanan akun/Gemini siap produksi sebelum semua dependency tersebut diuji pada konfigurasi yang sebenarnya. Periksa kembali notifikasi privasi di UI dan dokumentasi retensi data provider sebelum membuka pendaftaran publik.
