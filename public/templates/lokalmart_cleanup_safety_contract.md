# Lokalmart Audit & Safe Cleanup Contract

Cleanup di Lokalmart tidak boleh berbentuk delete massal. Setiap AI atau operator harus mengikuti pipeline:

1. Scan kandidat cleanup.
2. Backup audit report.
3. Dry-run selected items.
4. Eksekusi hanya item SAFE_DELETE atau SAFE_ARCHIVE.
5. Download cleanup execution report.

## Status

- SAFE_DELETE: boleh unlink via XML-RPC setelah backup dan dry-run.
- SAFE_ARCHIVE: boleh dinonaktifkan/archived, bukan unlink fisik.
- REVIEW_REQUIRED: perlu keputusan manusia, tidak boleh dieksekusi otomatis.
- BLOCKED: tidak boleh dieksekusi otomatis.
- CORE_PROTECTED: model/field bawaan Odoo atau bukan custom manual; jangan disentuh.

## Aturan Model

Model boleh SAFE_DELETE hanya jika:

- `state = manual`.
- technical model diawali `x_`.
- record_count = 0.
- tidak punya field relasi masuk.
- tidak punya access rule aktif.
- tidak punya view aktif.

## Aturan Field

Field boleh SAFE_DELETE hanya jika:

- `state = manual`.
- field name diawali `x_` atau `x_studio_`.
- bukan required.
- tidak ada record yang berisi nilai field tersebut.
- tidak ditemukan di view/arch.

## Aturan Access Rule

Access rule tidak di-unlink secara default. Untuk menghindari foreign key error, rekomendasi aman adalah `active = false`.

## Larangan

- Jangan menghapus core model atau base field.
- Jangan menghapus field yang masih punya data.
- Jangan menghapus model yang masih punya record.
- Jangan menjalankan cleanup tanpa backup audit.
