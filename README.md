# Payung AI Studio

Creative workspace untuk membuat storyboard iklan, prompt video, ide konten social-commerce, kalender 30 hari, dan Content Vault. Generator lokal dapat digunakan tanpa akun. Aplikasi ini menyusun teks dan prompt; aplikasi ini **tidak merender video** dan tidak mengambil data marketplace secara otomatis.

## Fitur dan batas penyimpanan

- Generator storyboard, template iklan, library teknik cinematic, ekspor TXT/print/PDF, serta proyek cinematic tersimpan di browser.
- Proyek/draft cinematic lokal dipisahkan berdasarkan akun Supabase yang sedang login; data Guest dipisah dari akun. `localStorage` bukan penyimpanan aman—jangan menyimpan password atau rahasia di dalamnya.
- Cache Vault/kalender/metrik juga dipisahkan per akun; saat sinkronisasi gagal, salinan lokal akun tetap dipertahankan. Data lama tanpa identitas akun dimigrasikan ke ruang Guest.
- Jika sesi tidak dapat diverifikasi, tampilan cache akun dikunci tanpa menghapus datanya; cache dapat ditampilkan lagi setelah sesi pulih.
- Content Vault, kalender, dan metrik performa manual dapat disinkronkan ke workspace Supabase saat login.
- Foto referensi produk hanya dipratinjau lokal. Jangan masukkan password atau data rahasia ke prompt.

## Status provider dan rilis

Cloudflare Worker `payung-ai-studio` versi **42** sudah aktif untuk 100% trafik; endpoint health merespons HTTP 200. Frontend GitHub Pages dari branch `main` juga merespons HTTP 200. CodeCraft tetap menjadi provider default dengan model `deepseek-v4-flash-0731`. Google Gemini tersedia sebagai pilihan opsional untuk admin melalui provider selector, dengan model `gemini-3.8-flash`; pemilihan Gemini tidak mengubah default CodeCraft.

Kunci CodeCraft dan Gemini hanya disimpan sebagai Cloudflare Worker Secrets (`CODECRAFT_API_KEY` dan `GEMINI_API_KEY`). Nilainya tidak ada di source code, frontend, Git, respons admin, maupun database pengaturan provider. Panel admin hanya dapat dibaca/diubah oleh akun yang telah terverifikasi terhadap Worker Secret `PAYUNG_ADMIN_EMAIL`.

Gemini diverifikasi hanya lewat request katalog non-generatif `GET /v1beta/models` (HTTP 200; katalog menampilkan `gemini-3.8-flash`). Tidak ada request generasi ke Gemini atau CodeCraft untuk menguji rilis ini, dan tidak ada token model yang dihabiskan oleh proses publikasi.

## Keamanan provider dan batas token

Pengaturan provider/model global disimpan pada `public.ai_provider_settings`; tabel tersebut tidak menyimpan API key. Browser hanya mengirim provider dan model ID yang diizinkan. Base URL ditetapkan di Worker dan tidak dapat dikirim dari browser. Untuk menambah provider lain, tambahkan adapter, endpoint resmi, secret binding, dan validasi model secara eksplisit.

Setiap provider memiliki cap Payung **kumulatif 500.000 token** yang terpisah di `public.ai_provider_token_budget`; cap tidak direset otomatis. Worker mereservasi budget secara atomik sebelum menghubungi provider, dengan estimasi konservatif berupa byte UTF-8 prompt, maksimum 6.000 token output, dan margin 8.192. Pemakaian aktual diselesaikan dari laporan token provider. Jika laporan token tidak tersedia atau settlement ambigu, reservasi tetap dihitung agar cap tidak terlampaui. Reservasi serentak diserialisasi per provider.

Cap hanya menghitung pemakaian yang melewati Payung; saldo dan free allowance provider, termasuk pemakaian di luar Payung, tidak dibaca atau diverifikasi. Provider yang menolak karena kredensial, kuota/saldo, billing, atau rate limit dihentikan—tidak ada perpindahan otomatis ke provider berbayar, rotasi key, ataupun top-up otomatis. Batas rate Gemini memblokir jalur Gemini setidaknya 24 jam; cooldown itu tidak mengatur ulang cap token kumulatif. Failover antar-provider saat ini tidak dikonfigurasi.

Untuk CodeCraft, dokumentasi publik menyebut base URL `https://codecraftapi.com/v1`, autentikasi `Authorization: Bearer …`, dan endpoint Chat Completions `POST /chat/completions`; model ID dikirim dalam body. Lihat [Getting Started](https://codecraftapi.com/docs/getting-started) dan [model catalog](https://codecraftapi.com/models). Cap Payung tidak membuktikan allowance atau saldo di akun CodeCraft. Pemilik proyek menyatakan menggunakan allowance gratis dan memiliki izin tertulis CodeCraft untuk pemakaian publik; aplikasi tidak mengatur top-up. Ikuti [Acceptable Use Policy](https://codecraftapi.com/acceptable-use), yang melarang pembuatan banyak akun untuk mengumpulkan free allowance serta berbagi/menjual akses API tanpa izin.

## Arsitektur hosting

Frontend dan API dipublikasikan terpisah:

1. **Frontend:** GitHub Pages dari branch `main`, root `/`. URL: <https://misba234.github.io/payung-ai-studio/>.
2. **API:** Cloudflare Worker `payung-ai-studio`, dengan endpoint `/generate` dan `/health`. Pengaturan admin menggunakan `/admin/provider-settings`. `wrangler.jsonc` mengonfigurasi Worker API, bukan aset statis; menjalankan `wrangler deploy` saja **tidak** menerbitkan halaman HTML.

`index.html` dan `public/index.html` harus identik; setiap perubahan UI perlu disalin ke keduanya. Redirect email Supabase dan `ALLOWED_ORIGINS` di `worker.js` harus cocok dengan domain frontend.

## Persyaratan backend dan pengembangan

Supabase Auth, tabel `ai_credits`/`user_workspace`, dan RPC `refund_ai_credit` serta `finalize_ai_credit` tetap diperlukan. AI cloud meminta login dan kredit akun; Guest hanya dapat menggunakan fitur lokal. Migrasi `20261114_ai_credit_idempotency.sql`, pengaturan provider, cap token, dan budget Gemini sudah diterapkan. Kebijakan RLS/ownership workspace yang lebih lama tidak diaudit ulang secara menyeluruh dalam rilis ini.

Jalankan server statis dari root repo:

```sh
python3 -m http.server 8000
```

Buka <http://localhost:8000>. Login dan AI cloud memerlukan konfigurasi Supabase/Worker dan origin lokal yang diizinkan.

Tes provider dan endpoint admin:

```sh
node tests/provider-settings.test.mjs
node tests/provider-failover.test.mjs
```

Tes memakai mock lokal dan tidak memanggil Supabase live, CodeCraft, maupun Gemini. Suite memeriksa reservasi/settlement budget, cap keras, provider settings, serta kebijakan failover konservatif. Uji UI manual di desktop/perangkat seluler tidak dilakukan pada rilis ini.

## Catatan batasan

Cap 500.000 token berlaku untuk penggunaan melalui Payung, bukan untuk penggunaan API key di luar situs. Tidak ada pemantauan saldo/allowance CodeCraft atau pengaturan billing provider. Belum ada CI, rate-limit menyeluruh per pengguna/IP, panduan rollback formal, atau audit RLS penuh. Uji generasi langsung sengaja tidak dilakukan agar tidak memakai token.
