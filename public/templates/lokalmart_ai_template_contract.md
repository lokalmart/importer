# Lokalmart AI Template Contract

File ini adalah kontrak resmi untuk AI yang ingin membuat XLSX import untuk Lokalmart Importer.

## Prinsip wajib

1. Setiap sheet data harus memiliki kolom `__action`, `_external_id`, dan `_model`.
2. Gunakan `__action = upsert` sebagai default agar file aman dijalankan ulang.
3. Jangan gunakan delete fisik. Gunakan `archive` bila model memiliki field `active`.
4. Relasi Many2one memakai `field_name_external_id`, contoh `project_id_external_id`.
5. Relasi Many2many memakai `field_name_external_ids`, dipisah koma, contoh `public_categ_ids_external_ids`.
6. Untuk foto produk, isi `image_1920_base64` dengan string base64 gambar tanpa prefix `data:image/...`.
7. URL gambar hanya boleh dijadikan catatan di kolom `_note_image_url_for_ai`; importer akan melewati kolom meta `_note*`.
8. Untuk project/task, gunakan `project.project`, `project.milestone`, `project.task.type`, dan `project.task`.
9. Untuk task bertingkat, gunakan `parent_id_external_id`. Root task boleh kosong; subtask wajib punya parent.
10. Untuk knowledge, gunakan `knowledge.article` dengan `parent_id_external_id` dan `body` HTML sederhana.
11. Jangan mengisi field readonly seperti `id`, `display_name`, `create_date`, `write_date`, `create_uid`, `write_uid`.
12. Bila membuat custom model, urutannya adalah `ir.model` → `ir.model.fields` → `ir.model.access` → data seed.

## Urutan sheet standar

1. `product.category`
2. `product.public.category`
3. `res.partner`
4. `product.template`
5. `product.supplierinfo`
6. `project.project`
7. `project.milestone`
8. `project.task.type`
9. `project.task`
10. `knowledge.article`

## Kolom minimal contoh

```text
__action | _external_id | _model | name
upsert   | lm_product.demo | product.template | Produk Demo
```

## Contoh relasi

```text
categ_id_external_id = lm_cat.sembako
public_categ_ids_external_ids = lm_public.market,lm_public.sembako
project_id_external_id = lm_project.ground_zero
parent_id_external_id = lm_task.parent
```

## Catatan untuk AI

Sebelum membuat XLSX baru, baca template `lokalmart_standard_import_template.xlsx` dan pertahankan nama sheet serta pola kolomnya. Tambahkan baris, bukan mengganti kontrak kolom inti. Jika butuh field baru, pastikan field itu ada di schema snapshot terbaru dari importer.
