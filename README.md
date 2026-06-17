# Lokalmart Importer — Vercel Safe Import Cockpit

A mobile-first Next.js app for importing XLSX files into Odoo through server-side XML-RPC. Odoo credentials are read from Vercel environment variables, never from the browser.

## Features

- Server-side Odoo XML-RPC connection using env credentials
- Admin access token guard through `IMPORTER_ADMIN_TOKEN`
- XLSX analyzer
- Schema snapshot for Odoo models/fields/external IDs
- Preflight validation before import
- Safe patch XLSX generator
- Dry-run mode
- Sheet-by-sheet XML-RPC import with external ID upsert support
- Error translator for common Odoo import failures

## Deploy to Vercel

1. Upload this folder to a GitHub repository.
2. Import the repository into Vercel.
3. Add these environment variables in Vercel Project Settings:

```bash
ODOO_URL=https://your-odoo-domain.odoo.com
ODOO_DB=edu-lokalmart
ODOO_USERNAME=importer@lokalmart.example
ODOO_PASSWORD=your-odoo-password-or-api-key
IMPORTER_ADMIN_TOKEN=change-this-long-random-token
IMPORT_BATCH_SIZE=25
IMPORT_DEFAULT_MODULE=lokalmart_importer
```

4. Deploy.
5. Open the app, enter the admin token, then test the Odoo connection.

## Local development

```bash
cp .env.example .env.local
npm install
npm run dev
```

## XLSX conventions

Each data sheet should use:

- `_model` for model name, or use the sheet name as the model name
- `_external_id` for stable upsert ID
- `__action` with `create`, `update`, `upsert`, `archive`, or `skip`
- `field_name_external_id` for Many2one relations
- `field_name_external_ids` for Many2many relations, comma-separated

Examples:

```text
__action | _external_id                | _model         | name
upsert   | lm_roles.role_surveyor       | x_lokal_role_id| Surveyor
```

```text
x_partner_id_external_id = base.res_partner_1
x_role_ids_external_ids = lm_roles.role_surveyor,lm_roles.role_kasir
```

## Safety notes

- This importer does not physically delete records. `delete` is converted to a blocked issue; use `archive` where the model has an `active` field.
- The importer strips readonly fields and unknown fields during safe repair.
- Use dry-run before live import.
- Keep `IMPORTER_ADMIN_TOKEN` enabled on every public Vercel deployment.
