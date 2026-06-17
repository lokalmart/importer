# Lokalmart Studio Importer — v5 Audit & Safe Cleanup Center

Next.js/Vercel web app untuk Import XLSX, Template Center, Backup Center, dan Audit & Safe Cleanup Odoo Lokalmart via XML-RPC.

## Fitur v5

- Import XLSX aman: analyze, preflight, repair, dry-run, live import.
- Template Center: template XLSX resmi, AI contract, manifest, backup recipes.
- Backup Center: export project/product/partner/knowledge sebagai ZIP restore-ready.
- Audit & Safe Cleanup Center:
  - scan custom model `x_*`;
  - scan custom field `x_*` / `x_studio_*`;
  - scan external ID Lokalmart/Studio orphan;
  - scan access rule custom model;
  - backup audit ZIP/XLSX sebelum cleanup;
  - dry-run selected items;
  - run hanya item `SAFE_DELETE` dan `SAFE_ARCHIVE`.

## ENV Vercel

```bash
ODOO_URL=https://your-odoo-domain.odoo.com
ODOO_DB=edu-lokalmart
ODOO_USERNAME=your-admin-or-importer-user@example.com
ODOO_PASSWORD=your-password-or-api-key
IMPORTER_ADMIN_TOKEN=token-panjang-random
IMPORT_BATCH_SIZE=25
IMPORT_DEFAULT_MODULE=lokalmart_importer
```

## Cara deploy

1. Upload semua file ke repo GitHub `lokalmart/importer`.
2. Import/deploy ke Vercel.
3. Pastikan Framework Preset = Next.js.
4. Kosongkan Output Directory.
5. Isi ENV.
6. Redeploy dengan Clear Build Cache.

## Cleanup Safety

Cleanup tidak menjalankan delete massal. Pipeline yang benar:

```text
Scan Cleanup Candidates
→ Backup Audit Report
→ Select SAFE Items
→ Dry Run Selected
→ Run SAFE Cleanup
→ Download Execution Report
```

Status yang boleh dieksekusi otomatis:

- `SAFE_DELETE`: unlink hanya untuk item custom/manual kosong tanpa dependensi.
- `SAFE_ARCHIVE`: nonaktifkan/arsip, bukan unlink fisik.

Status yang tidak boleh dieksekusi otomatis:

- `REVIEW_REQUIRED`
- `BLOCKED`
- `CORE_PROTECTED`

## API Cleanup

```text
POST /api/cleanup/scan
POST /api/cleanup/backup
POST /api/cleanup/dry-run
POST /api/cleanup/run
```

Body contoh:

```json
{
  "scope": {
    "mode": "all",
    "limit": 120,
    "includeCore": false
  }
}
```

Dry-run/run:

```json
{
  "keys": ["custom_field:123"],
  "scope": { "mode": "all", "limit": 120 },
  "confirm": "CLEANUP_SELECTED_SAFE_ITEMS"
}
```

## Static contracts

- `/templates/lokalmart_standard_import_template.xlsx`
- `/templates/lokalmart_ai_template_contract.md`
- `/templates/lokalmart_template_manifest.json`
- `/templates/lokalmart_backup_recipes.json`
- `/templates/lokalmart_cleanup_safety_contract.md`
- `/templates/lokalmart_cleanup_safety_manifest.json`

## Validasi lokal

Sudah dicek dengan:

```bash
npx tsc --noEmit
```

Catatan: `npm run build` di sandbox lokal sempat melewati compile/type-check/page generation, lalu timeout saat `Collecting build traces`. Di Vercel proses ini biasanya lanjut normal; bila Vercel memberi build log spesifik, patch file terkait.
