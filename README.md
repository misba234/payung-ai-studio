# Payung AI Studio

Creative workspace untuk membuat storyboard iklan, prompt video, ide konten social-commerce, kalender 30 hari, dan Content Vault. Generator lokal dapat digunakan tanpa akun. Aplikasi ini menyusun teks dan prompt; aplikasi ini **tidak merender video** dan tidak mengambil data marketplace secara otomatis.

## Fitur dan batas penyimpanan

- Generator storyboard, template iklan, library teknik cinematic, ekspor TXT/print/PDF, serta proyek cinematic tersimpan di browser.
- Proyek/draft cinematic lokal dipisahkan berdasarkan akun Supabase yang sedang login; data Guest dipisah dari akun. `localStorage` bukan penyimpanan aman—jangan menyimpan password atau rahasia di dalamnya.
- Cache Vault/kalender/metrik juga dipisahkan per akun; saat sinkronisasi gagal, salinan lokal akun tetap dipertahankan. Data lama tanpa identitas akun dimigrasikan ke ruang Guest.
- Jika sesi tidak dapat diverifikasi, tampilan cache akun dikunci tanpa menghapus datanya; cache dapat ditampilkan lagi setelah sesi pulih.
- Content Vault, kalender, dan metrik performa manual dapat disinkronkan ke workspace Supabase saat login.
- Foto referensi produk hanya dipratinjau lokal. Jangan masukkan password atau data rahasia ke prompt.

## Status perubahan provider

Worker multi-provider CodeCraft sudah live pada Cloudflare version 37; migrasi provider dan cap token sudah diterapkan, dan key/admin email tersimpan hanya sebagai Worker Secrets. Rilis frontend ini menerbitkan panel admin provider dan warning hasil ke GitHub Pages. Gemini tetap nonaktif; tidak ada rotasi key atau provider alternatif.

Desainnya memakai pengaturan provider/model global yang hanya dapat dibaca/diubah oleh akun admin terverifikasi melalui Worker. Browser hanya mengirim nama provider dan model ID; tidak ada kolom untuk API key. Worker mengambil API key dari Cloudflare Worker Secrets dan tidak pernah mengembalikan nilainya. API key tidak boleh disimpan di HTML, Git, Supabase table, atau browser storage.

Konfigurasi aktif disimpan pada tabel `public.ai_provider_settings`; akses tabel dicabut dari `anon` dan `authenticated`, dan hanya Worker `service_role` yang mengaksesnya. Panel admin tampil hanya jika endpoint Worker memverifikasi email login terhadap Worker Secret `PAYUNG_ADMIN_EMAIL`. Provider yang dapat dipilih harus terdaftar secara eksplisit di `worker.js`; base URL tidak dapat dikirim dari browser. Untuk menambah provider resmi berikutnya, tambahkan adapter/endpoint yang diizinkan, secret binding khusus, dan validasi modelnya—jangan mengizinkan URL arbitrer.

Untuk CodeCraft, dokumentasi publik menyebut base URL `https://codecraftapi.com/v1`, autentikasi `Authorization: Bearer …`, dan endpoint Chat Completions `POST /chat/completions`; model ID dikirim dalam body. Lihat [Getting Started](https://codecraftapi.com/docs/getting-started) dan [model catalog](https://codecraftapi.com/models). Model awal `deepseek-v4-flash-0731` diisi pada migrasi dari katalog model; aplikasi tidak memanggil daftar model saat halaman dibuka. Secret yang diperlukan adalah `CODECRAFT_API_KEY` dan `PAYUNG_ADMIN_EMAIL`, di samping `SUPABASE_SERVICE_ROLE_KEY`. Nilainya hanya dipasang lewat secret manager Cloudflare.

Worker tidak melakukan retry atau rotasi key. Untuk semua provider request, termasuk error jaringan/timeout yang ambigu, ia tidak mengirim request kedua. Bila transport tepercaya suatu saat membuktikan request belum terkirim, failover tetap nonaktif sampai provider lain diotorisasi; saat ini registri hanya memiliki CodeCraft.

Cap Payung adalah kumulatif **500.000 token** dan tidak direset otomatis. Worker mereservasi batas konservatif sebelum menghubungi provider (byte UTF-8 prompt + maksimum 6.000 token output + margin 8.192), lalu mencatat `usage.total_tokens` jika provider mengembalikannya; bila tidak ada usage atau hasil request ambigu, seluruh reservasi tetap dihitung. Permintaan baru ditolak jika reservasi tidak muat, cap habis, reservasi terlampaui, atau CodeCraft memberi sinyal kuota/saldo/billing/rate-limit. Cap ini hanya menghitung pemakaian yang melalui Payung; saldo dan allowance CodeCraft, termasuk pemakaian di luar Payung, tidak dibaca atau diverifikasi. Payung tidak mengatur top-up provider.

Gunakan hanya key yang memang berhak dipakai dan sesuai ketentuan masing-masing layanan. CodeCraft menampilkan paket Basic mulai $3.50/bulan di [halaman harga](https://codecraftapi.com/pricing); halaman publik tersebut tidak menunjukkan allowance yang tersisa di akun. Pemilik proyek menyatakan menggunakan allowance gratis dan memiliki izin tertulis CodeCraft untuk pemakaian publik. Kebijakan CodeCraft melarang pembuatan banyak akun untuk mengumpulkan free allowance serta berbagi/menjual akses API tanpa izin sesuai [Acceptable Use Policy](https://codecraftapi.com/acceptable-use).

## Arsitektur hosting

Frontend dan API dipublikasikan terpisah:

1. **Frontend:** GitHub Pages dari branch `main`, root `/`. URL saat ini: <https://misba234.github.io/payung-ai-studio/>.
2. **API:** Cloudflare Worker `payung-ai-studio`, dengan endpoint `/generate` dan `/health`. Pengaturan admin lokal menggunakan `/admin/provider-settings`. `wrangler.jsonc` hanya mengonfigurasi Worker API dan tidak mengikat aset statis; menjalankan `wrangler deploy` saja **tidak** menerbitkan halaman HTML.

`index.html` dan `public/index.html` harus identik; setiap perubahan UI perlu disalin ke keduanya. Redirect email Supabase dan `ALLOWED_ORIGINS` di `worker.js` harus cocok dengan domain frontend.

## Persyaratan backend dan urutan rilis

Supabase Auth, tabel `ai_credits`/`user_workspace`, dan RPC `refund_ai_credit` serta `finalize_ai_credit` tetap diperlukan. AI Cloud meminta login dan kredit akun; Guest hanya dapat menggunakan fitur lokal. Tabel provider/token baru sudah diverifikasi privat, tetapi kebijakan RLS/ownership workspace yang sudah ada tidak diaudit ulang secara menyeluruh dalam rilis ini.

Perlindungan reservasi kredit ganda memakai migrasi `migrations/20261114_ai_credit_idempotency.sql`; migrasi ini sudah live sejak rilis anti-duplikasi sebelumnya. `migrations/20261114_ai_provider_settings.sql` dan `migrations/20261114_ai_provider_token_cap.sql` juga sudah diterapkan. Tabel pengaturan provider tidak menyimpan key; tabel quota dan fungsi reservasi/settlement tidak dapat diakses langsung oleh `anon`/`authenticated`, dan RPC hanya dapat dipanggil oleh `service_role`.

Deploy Worker dilakukan setelah migrasi dan pemasangan secret; commit rilis ini menerbitkan panel admin/warning ke `main`. Tidak ada request generasi atau uji model yang dilakukan; tes lokal memakai mock. Belum diverifikasi bahwa key diterima oleh endpoint generasi CodeCraft.

## Pengembangan dan tes lokal

Jalankan server statis dari root repo:

```sh
python3 -m http.server 8000
```

Buka <http://localhost:8000>. Fitur lokal dapat diuji di sana; login dan AI cloud memerlukan konfigurasi Supabase/Worker dan origin lokal yang diizinkan.

Tes adapter/provider dan endpoint admin yang disiapkan dapat dijalankan dengan:

```sh
node tests/provider-settings.test.mjs
node tests/provider-failover.test.mjs
```

Tes tersebut memakai mock lokal dan tidak memanggil Supabase live, CodeCraft, maupun Gemini. Suite failover mencakup sinyal pre-send tersertifikasi, error jaringan ambigu, timeout/abort, seluruh kelas HTTP response, kuota/billing, rotasi key/provider terlarang, serta batas satu alternate. Pemeriksaan sintaks Worker dan JavaScript inline HTML dapat dilakukan dengan Node.js. Uji UI manual di desktop/perangkat seluler tidak dilakukan dalam rilis ini; periksa responsivitas setelah publikasi jika diperlukan.

## Catatan rilis

Belum ada CI, rate-limit per pengguna/IP yang menyeluruh, panduan rollback, atau audit lengkap RLS. Cap 500.000 token membatasi pemakaian melalui Payung, bukan pemakaian key di luar situs, dan tidak memantau saldo/allowance CodeCraft. Aplikasi tidak mengatur top-up; status billing provider belum diverifikasi. Generasi langsung belum diuji agar tidak memakai token.
