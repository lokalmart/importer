import 'server-only';
import { createOdooClient, ensureExternalId, resolveExternalId, OdooClient } from './odooXmlRpc';
import { parseWorkbookFromBase64, orderedSheets, normalizeAction, emptyToUndefined } from './xlsxWorkbook';
import { ImportLogEntry, ImportResult, WorkbookRow } from './types';
import { translateOdooError } from './errorTranslator';
import { ALWAYS_SKIP, isMetaColumn, normalizeHeader } from './importHeaders';

function asBoolean(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  const raw = String(value || '').toLowerCase().trim();
  return ['true', '1', 'yes', 'y', 'iya', 'ya'].includes(raw);
}

function isEmpty(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
}

function convertScalar(value: unknown, type?: string): unknown {
  const cleaned = emptyToUndefined(value);
  if (cleaned === undefined) return undefined;
  if (type === 'boolean') return asBoolean(cleaned);
  if (type === 'integer') {
    const n = Number.parseInt(String(cleaned).replace(/,/g, ''), 10);
    return Number.isFinite(n) ? n : undefined;
  }
  if (['float', 'monetary'].includes(String(type))) {
    const n = Number.parseFloat(String(cleaned).replace(/,/g, ''));
    return Number.isFinite(n) ? n : undefined;
  }
  if (type === 'many2one') {
    const n = Number.parseInt(String(cleaned), 10);
    return Number.isFinite(n) && String(cleaned).match(/^\d+$/) ? n : cleaned;
  }
  return cleaned;
}

async function resolveMany2One(client: OdooClient, xmlId: string, dryRun: boolean): Promise<number | undefined> {
  if (isEmpty(xmlId)) return undefined;
  const found = await resolveExternalId(client, String(xmlId));
  if (found?.res_id) return found.res_id;
  if (dryRun) return -1; // pseudo-id so dry run can continue and still report intent.
  return undefined;
}

async function resolveMany2Many(client: OdooClient, xmlIds: string, dryRun: boolean): Promise<number[]> {
  if (isEmpty(xmlIds)) return [];
  const parts = String(xmlIds).split(',').map((x) => x.trim()).filter(Boolean);
  const ids: number[] = [];
  for (const part of parts) {
    const found = await resolveExternalId(client, part);
    if (found?.res_id) ids.push(found.res_id);
    else if (dryRun) ids.push(-1);
  }
  return ids;
}

function shouldKeepReadonlyOnCreate(model: string, key: string): boolean {
  // `state` on ir.model is an intent column in XLSX but Odoo may reject updating it.
  // We only keep fields that are actually safe to create/write through XML-RPC.
  if (model === 'ir.model' && ['model', 'name', 'info', 'transient'].includes(key)) return true;
  return false;
}

function buildWorkbookFieldFallback(parsed: ReturnType<typeof parseWorkbookFromBase64>): Map<string, Record<string, any>> {
  const map = new Map<string, Record<string, any>>();
  const fieldsSheet = parsed.sheets.find((s) => s.inferredModel === 'ir.model.fields' || s.name === 'ir.model.fields');
  if (!fieldsSheet) return map;

  for (const row of fieldsSheet.rows) {
    const model = String(row.model || '').trim();
    const name = String(row.name || '').trim();
    if (!model || !name) continue;
    if (!map.has(model)) map.set(model, {});
    map.get(model)![name] = {
      name,
      string: String(row.field_description || name),
      type: String(row.ttype || 'char'),
      relation: isEmpty(row.relation) ? undefined : String(row.relation),
      required: asBoolean(row.required),
      readonly: asBoolean(row.readonly),
      store: isEmpty(row.store) ? true : asBoolean(row.store),
    };
  }
  return map;
}

async function prepareValues(
  client: OdooClient,
  model: string,
  row: WorkbookRow,
  fields: Record<string, any>,
  isUpdate: boolean,
  dryRun: boolean,
  logs: ImportLogEntry[],
  sheet: string,
  rowNumber: number
): Promise<Record<string, unknown>> {
  const values: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(row)) {
    if (!key || isMetaColumn(key) || ALWAYS_SKIP.has(key)) continue;
    const directMeta = fields[key];
    const normalized = normalizeHeader(key, directMeta?.type);
    const fieldName = normalized.field;
    const meta = fields[fieldName];

    if (!meta) {
      logs.push({ level: 'info', sheet, row: rowNumber, model, message: `Kolom ${key} dilewati karena tidak ada di schema ${model}.` });
      continue;
    }

    if (meta.readonly && (isUpdate || !shouldKeepReadonlyOnCreate(model, fieldName))) {
      logs.push({ level: 'info', sheet, row: rowNumber, model, message: `Kolom ${key} dilewati karena readonly.` });
      continue;
    }

    if (normalized.relation || ['many2one', 'many2many'].includes(String(meta.type))) {
      const kind = normalized.relation?.kind === 'many2many' || meta.type === 'many2many' ? 'many2many' : 'many2one';
      if (kind === 'many2one') {
        const id = await resolveMany2One(client, String(value || ''), dryRun);
        if (id) values[fieldName] = id;
        else if (!isEmpty(value)) logs.push({ level: 'warn', sheet, row: rowNumber, model, message: `External ID relation ${value} tidak ditemukan untuk ${fieldName}.` });
        continue;
      }
      if (kind === 'many2many') {
        const ids = await resolveMany2Many(client, String(value || ''), dryRun);
        values[fieldName] = [[6, 0, ids.filter((x) => x > 0)]];
        if (dryRun && ids.some((x) => x < 0)) {
          logs.push({ level: 'warn', sheet, row: rowNumber, model, message: `Sebagian external ID many2many untuk ${fieldName} belum ditemukan; dry-run tetap lanjut.` });
        }
        continue;
      }
    }

    const converted = convertScalar(value, meta.type);
    if (converted !== undefined) values[fieldName] = converted;
  }

  return values;
}

async function getFields(client: OdooClient, cache: Map<string, Record<string, any>>, fallback: Map<string, Record<string, any>>, model: string, dryRun: boolean, logs: ImportLogEntry[], sheet: string) {
  const cached = cache.get(model);
  if (cached) return cached;
  try {
    const fields = await client.fieldsGet(model);
    cache.set(model, fields);
    return fields;
  } catch (error) {
    const fb = fallback.get(model);
    if (dryRun && fb) {
      logs.push({ level: 'info', sheet, model, message: `Schema live untuk ${model} belum tersedia; dry-run memakai field dari workbook.` });
      cache.set(model, fb);
      return fb;
    }
    throw error;
  }
}

export async function runImport(base64: string, options: { filename?: string; dryRun?: boolean; confirm?: string }): Promise<ImportResult> {
  const dryRun = Boolean(options.dryRun);
  if (!dryRun && options.confirm !== 'IMPORT_TO_ODOO') {
    return {
      ok: false,
      dryRun,
      processed: 0,
      created: 0,
      updated: 0,
      archived: 0,
      skipped: 0,
      errors: 1,
      logs: [{ level: 'error', sheet: '-', message: 'Live import diblokir karena confirm bukan IMPORT_TO_ODOO.' }]
    };
  }

  const client = await createOdooClient();
  const parsed = parseWorkbookFromBase64(base64, options.filename);
  const fallbackFields = buildWorkbookFieldFallback(parsed);
  const sheets = orderedSheets(parsed.sheets);
  const fieldCache = new Map<string, Record<string, any>>();
  const result: ImportResult = {
    ok: true,
    dryRun,
    processed: 0,
    created: 0,
    updated: 0,
    archived: 0,
    skipped: 0,
    errors: 0,
    logs: []
  };

  for (const sheet of sheets) {
    if (!sheet.inferredModel) {
      result.logs.push({ level: 'info', sheet: sheet.name, message: 'Sheet dilewati karena bukan data import.' });
      continue;
    }

    for (const [index, row] of sheet.rows.entries()) {
      const rowNumber = index + 2;
      const model = String(row._model || sheet.inferredModel).trim();
      const action = normalizeAction(row.__action);
      const externalId = String(row._external_id || '').trim();

      if (!model || action === 'skip') {
        result.skipped++;
        continue;
      }

      result.processed++;

      if (action === 'delete') {
        result.errors++;
        result.ok = false;
        result.logs.push({ level: 'error', sheet: sheet.name, row: rowNumber, model, action, external_id: externalId, message: 'Delete fisik diblokir. Gunakan archive.' });
        continue;
      }

      try {
        const fields = await getFields(client, fieldCache, fallbackFields, model, dryRun, result.logs, sheet.name);
        const existing = externalId ? await resolveExternalId(client, externalId) : null;
        const hasExistingForModel = existing && existing.model === model && existing.res_id;

        if (action === 'archive') {
          if (!hasExistingForModel) {
            result.skipped++;
            result.logs.push({ level: 'warn', sheet: sheet.name, row: rowNumber, model, action, external_id: externalId, message: 'Archive dilewati karena external ID belum ditemukan.' });
            continue;
          }
          if (!fields.active) {
            result.skipped++;
            result.logs.push({ level: 'warn', sheet: sheet.name, row: rowNumber, model, action, external_id: externalId, message: 'Model tidak punya field active; archive dilewati.' });
            continue;
          }
          if (!dryRun) await client.write(model, [existing.res_id], { active: false });
          result.archived++;
          result.logs.push({ level: 'success', sheet: sheet.name, row: rowNumber, model, action, external_id: externalId, message: dryRun ? 'DRY RUN: akan di-archive.' : 'Record di-archive.' });
          continue;
        }

        const isUpdate = action === 'update' || (action === 'upsert' && Boolean(hasExistingForModel));
        const values = await prepareValues(client, model, row, fields, isUpdate, dryRun, result.logs, sheet.name, rowNumber);

        if (action === 'update') {
          if (!hasExistingForModel) {
            result.errors++;
            result.ok = false;
            result.logs.push({ level: 'error', sheet: sheet.name, row: rowNumber, model, action, external_id: externalId, message: 'Update gagal: external ID tidak ditemukan untuk model ini.' });
            continue;
          }
          if (!dryRun) await client.write(model, [existing.res_id], values);
          result.updated++;
          result.logs.push({ level: 'success', sheet: sheet.name, row: rowNumber, model, action, external_id: externalId, message: dryRun ? 'DRY RUN: akan update record.' : 'Record diupdate.' });
          continue;
        }

        if (action === 'create' && hasExistingForModel) {
          result.skipped++;
          result.logs.push({ level: 'warn', sheet: sheet.name, row: rowNumber, model, action, external_id: externalId, message: 'Create dilewati karena external ID sudah ada.' });
          continue;
        }

        if (action === 'upsert' && hasExistingForModel) {
          if (!dryRun) await client.write(model, [existing.res_id], values);
          result.updated++;
          result.logs.push({ level: 'success', sheet: sheet.name, row: rowNumber, model, action, external_id: externalId, message: dryRun ? 'DRY RUN: akan upsert sebagai update.' : 'Upsert update selesai.' });
          continue;
        }

        if (!dryRun) {
          const createdId = await client.create(model, values);
          if (externalId) await ensureExternalId(client, externalId, model, createdId);
        }
        result.created++;
        result.logs.push({ level: 'success', sheet: sheet.name, row: rowNumber, model, action, external_id: externalId, message: dryRun ? 'DRY RUN: akan create record.' : 'Record dibuat.' });
      } catch (error) {
        const issue = translateOdooError(error, { sheet: sheet.name, row: rowNumber, model, field: undefined });
        result.errors++;
        result.ok = false;
        result.logs.push({
          level: 'error',
          sheet: sheet.name,
          row: rowNumber,
          model,
          action,
          external_id: externalId,
          message: `${issue.message}${issue.suggestion ? ` Saran: ${issue.suggestion}` : ''}`
        });
      }
    }
  }

  return result;
}
