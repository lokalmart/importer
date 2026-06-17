# Lokalmart Studio Importer v4 — Template Center + Backup Center

Next.js/Vercel web app untuk import XLSX ke Odoo melalui XML-RPC, dengan kredensial Odoo disimpan di Vercel Environment Variables.

## Fitur utama

- Safe Import Cockpit
- Odoo credentials via ENV server-side
- Admin token protection
- XLSX analyzer
- Schema snapshot
- Preflight validation
- Auto Repair XLSX
- Dry Run dan Live Import
- Template Center untuk standar AI/XLSX Lokalmart
- Backup Center restore-ready

## Backup Center v4

Backup Center membuat backup yang dapat diimport kembali. Output backup berisi:

- `data/lokalmart_backup_importable.xlsx`
- `data/raw_records.json`
- `external_id_map.json`
- `schema_snapshot.json`
- `restore_plan.md`
- `manifest.json`

Flow restore paling aman:

1. Buka menu Backup.
2. Pilih recipe, misalnya `Project Bundle` atau `Product Catalog Bundle`.
3. Klik `Preview Backup`.
4. Klik `Run Backup ZIP`.
5. Download ZIP atau klik `Pakai XLSX Ini untuk Restore`.
6. Jalankan Preflight.
7. Jalankan Dry Run.
8. Live Import hanya setelah log aman.

### Backup recipes

- `backup_project_bundle` — project, milestone, stage, task, subtask, tags.
- `backup_product_catalog_bundle` — product category, ecommerce category, product template, vendor, supplierinfo, foto base64 bila tersedia.
- `backup_partner_umkm_bundle` — partner, vendor, UMKM, customer, role Lokalmart.
- `backup_knowledge_bundle` — knowledge article, body, parent-child.
- `backup_important_all` — gabungan data penting.

Catatan: backup ini adalah backup data aplikatif via XML-RPC, bukan dump PostgreSQL. Untuk backup besar, pecah per recipe agar aman di Vercel serverless.

## ENV Vercel

```bash
ODOO_URL=https://your-odoo-domain.odoo.com
ODOO_DB=edu-lokalmart
ODOO_USERNAME=your-user@example.com
ODOO_PASSWORD=your-password-or-api-key
IMPORTER_ADMIN_TOKEN=your-long-random-token
IMPORT_BATCH_SIZE=25
IMPORT_DEFAULT_MODULE=lokalmart_importer
```

## Deploy

1. Extract ZIP.
2. Push ke GitHub repo `lokalmart/importer`.
3. Import/deploy ke Vercel.
4. Isi ENV.
5. Redeploy dengan Clear Build Cache.

## Template Center

File statis ada di:

- `/templates/lokalmart_standard_import_template.xlsx`
- `/templates/lokalmart_ai_template_contract.md`
- `/templates/lokalmart_template_manifest.json`

Semua AI yang membuat XLSX untuk Lokalmart sebaiknya membaca contract dan template ini.
