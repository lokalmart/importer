import 'server-only';
import { createOdooClient, ensureExternalId, resolveExternalId, OdooClient } from './odooXmlRpc';
import { parseWorkbookFromBase64, orderedSheets, normalizeAction, emptyToUndefined } from './xlsxWorkbook';
import { ImportLogEntry, ImportResult, WorkbookRow } from './types';
import { translateOdooError } from './errorTranslator';

const META_COLUMNS = new Set(['__action', '_external_id', '_model', '_note', '_comment']);
const ALWAYS_SKIP = new Set(['id', 'display_name', 'create_uid', 'create_date', 'write_uid', 'write_date', '__last_update']);

function relationBase(header: string): { field: string; kind: 'many2one' | 'many2many' } | null {
  if (header.endsWith('_external_ids')) return { field: header.replace(/_external_ids$/, ''), kind: 'many2many' };
  if (header.endsWith('_external_id')) return { field: header.replace(/_external_id$/, ''), kind: 'many2one' };
  return null;
}

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

async function resolveMany2One(client: OdooClient, xmlId: string): Promise<number | undefined> {
  if (isEmpty(xmlId)) return undefined;
  const found = await resolveExternalId(client, String(xmlId));
  return found?.res_id;
}

async function resolveMany2Many(client: OdooClient, xmlIds: string): Promise<number[]> {
  if (isEmpty(xmlIds)) return [];
  const parts = String(xmlIds).split(',').map((x) => x.trim()).filter(Boolean);
  const ids: number[] = [];
  for (const part of parts) {
    const found = await resolveExternalId(client, part);
    if (found?.res_id) ids.push(found.res_id);
  }
  return ids;
}

function shouldKeepReadonlyOnCreate(model: string, key: string): boolean {
  if (model === 'ir.model' && ['model', 'name', 'info'].includes(key)) return true;
  return false;
}

async function prepareValues(
  client: OdooClient,
  model: string,
  row: WorkbookRow,
  fields: Record<string, any>,
  isUpdate: boolean,
  logs: ImportLogEntry[],
  sheet: string,
  rowNumber: number
): Promise<Record<string, unknown>> {
  const values: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(row)) {
    if (!key || META_COLUMNS.has(key) || ALWAYS_SKIP.has(key)) continue;
    const rel = relationBase(key);
    const fieldName = rel?.field || key;
    const meta = fields[fieldName];

    if (!meta) {
      logs.push({ level: 'info', sheet, row: rowNumber, model, message: `Kolom ${key} dilewati karena tidak ada di schema ${model}.` });
      continue;
    }

    if (meta.readonly && (isUpdate || !shouldKeepReadonlyOnCreate(model, key))) {
      logs.push({ level: 'info', sheet, row: rowNumber, model, message: `Kolom ${key} dilewati karena readonly.` });
      continue;
    }

    if (rel?.kind === 'many2one') {
      const id = await resolveMany2One(client, String(value || ''));
      if (id) values[fieldName] = id;
      else if (!isEmpty(value)) logs.push({ level: 'warn', sheet, row: rowNumber, model, message: `External ID relation ${value} tidak ditemukan untuk ${fieldName}.` });
      continue;
    }

    if (rel?.kind === 'many2many') {
      const ids = await resolveMany2Many(client, String(value || ''));
      values[fieldName] = [[6, 0, ids]];
      continue;
    }

    const converted = convertScalar(value, meta.type);
    if (converted !== undefined) values[fieldName] = converted;
  }

  return values;
}

async function getFields(client: OdooClient, cache: Map<string, Record<string, any>>, model: string) {
  const cached = cache.get(model);
  if (cached) return cached;
  const fields = await client.fieldsGet(model);
  cache.set(model, fields);
  return fields;
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
        const fields = await getFields(client, fieldCache, model);
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
        const values = await prepareValues(client, model, row, fields, isUpdate, result.logs, sheet.name, rowNumber);

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
