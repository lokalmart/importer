import 'server-only';
import { buildSchemaSnapshot } from './schemaScanner';
import { parseWorkbookFromBase64, normalizeAction } from './xlsxWorkbook';
import { ImportIssue, PreflightResult, SchemaSnapshot, ModelSchema } from './types';
import { isMetaColumn, normalizeHeader } from './importHeaders';

function rowNum(index: number): number {
  return index + 2;
}

function looksTrue(value: unknown): boolean {
  const raw = String(value || '').toLowerCase().trim();
  return ['true', '1', 'yes', 'y', 'iya', 'ya'].includes(raw);
}

function looksEmpty(value: unknown): boolean {
  return value === undefined || value === null || String(value).trim() === '';
}

function emptySnapshot(): SchemaSnapshot {
  return {
    ok: false,
    exported_at: new Date().toISOString(),
    target: { url_host: 'offline', db: 'offline', username: 'offline' },
    models: {},
    modelList: [],
    externalIds: [],
  };
}

function cloneSchema(snapshot?: SchemaSnapshot): SchemaSnapshot {
  if (!snapshot) return emptySnapshot();
  return {
    ...snapshot,
    models: { ...(snapshot.models || {}) },
    modelList: [...(snapshot.modelList || [])],
    externalIds: [...(snapshot.externalIds || [])],
  };
}

function getOrCreateModel(snapshot: SchemaSnapshot, model: string, name?: string): ModelSchema {
  if (!snapshot.models[model]) {
    snapshot.models[model] = { model, name: name || model, state: model.startsWith('x_') ? 'manual' : undefined, fields: {} };
    snapshot.modelList.push({ model, name: name || model, state: model.startsWith('x_') ? 'manual' : undefined });
  }
  return snapshot.models[model];
}

function enrichSnapshotFromWorkbook(snapshot: SchemaSnapshot, parsed: ReturnType<typeof parseWorkbookFromBase64>) {
  const modelSheet = parsed.sheets.find((s) => s.inferredModel === 'ir.model' || s.name === 'ir.model');
  if (modelSheet) {
    for (const row of modelSheet.rows) {
      const model = String(row.model || '').trim();
      if (!model) continue;
      getOrCreateModel(snapshot, model, String(row.name || model));
    }
  }

  const fieldsSheet = parsed.sheets.find((s) => s.inferredModel === 'ir.model.fields' || s.name === 'ir.model.fields');
  if (fieldsSheet) {
    for (const row of fieldsSheet.rows) {
      const model = String(row.model || '').trim();
      const fieldName = String(row.name || '').trim();
      if (!model || !fieldName) continue;
      const target = getOrCreateModel(snapshot, model);
      target.fields[fieldName] = {
        name: fieldName,
        string: String(row.field_description || fieldName),
        type: String(row.ttype || 'char'),
        relation: looksEmpty(row.relation) ? undefined : String(row.relation),
        required: looksTrue(row.required),
        readonly: looksTrue(row.readonly),
        store: looksEmpty(row.store) ? true : looksTrue(row.store),
      };
    }
  }
}

async function getSnapshot(parsed: ReturnType<typeof parseWorkbookFromBase64>, providedSnapshot?: SchemaSnapshot, issues?: ImportIssue[]): Promise<SchemaSnapshot> {
  let snapshot = cloneSchema(providedSnapshot);
  if (!providedSnapshot) {
    try {
      snapshot = await buildSchemaSnapshot('custom');
    } catch (error) {
      issues?.push({
        level: 'warn',
        message: `Live schema scan gagal, preflight memakai schema minimal dari workbook. Detail: ${error instanceof Error ? error.message : String(error)}`,
        suggestion: 'Jalankan Schema Snapshot lagi bila ingin validasi field terhadap database nyata.',
        code: 'schema_scan_failed_fallback',
      });
      snapshot = emptySnapshot();
    }
  }
  enrichSnapshotFromWorkbook(snapshot, parsed);
  return snapshot;
}

export async function runPreflight(base64: string, filename?: string, providedSnapshot?: SchemaSnapshot): Promise<PreflightResult> {
  const parsed = parseWorkbookFromBase64(base64, filename);
  const issues: ImportIssue[] = [];
  const snapshot = await getSnapshot(parsed, providedSnapshot, issues);
  let rowsChecked = 0;

  for (const sheet of parsed.sheets) {
    if (!sheet.inferredModel) continue;
    const model = sheet.inferredModel;
    const modelSchema = snapshot.models[model];

    if (!modelSchema && model !== 'ir.model') {
      issues.push({
        level: model.startsWith('x_') ? 'warn' : 'error',
        sheet: sheet.name,
        model,
        message: `Model ${model} belum ditemukan di schema snapshot.`,
        suggestion: model.startsWith('x_')
          ? 'Jika model dibuat di sheet ir.model file yang sama, ini boleh lanjut sebagai import bertahap.'
          : 'Periksa nama sheet/_model. Model core yang salah ketik harus diperbaiki sebelum import.',
        code: 'model_not_found'
      });
    }

    for (const [i, row] of sheet.rows.entries()) {
      rowsChecked++;
      const action = normalizeAction(row.__action);
      const rowModel = String(row._model || model || '').trim();

      if (!rowModel) {
        issues.push({
          level: 'error',
          sheet: sheet.name,
          row: rowNum(i),
          message: 'Model kosong. Isi _model atau gunakan nama sheet sebagai model target.',
          suggestion: 'Contoh: _model = product.template atau nama sheet = product.template.',
          code: 'missing_model'
        });
        continue;
      }

      if (action === 'delete') {
        issues.push({
          level: 'error',
          sheet: sheet.name,
          row: rowNum(i),
          model: rowModel,
          message: 'Delete fisik diblokir oleh importer Lokalmart.',
          suggestion: 'Gunakan __action = archive bila model memiliki field active.',
          code: 'delete_blocked'
        });
      }

      if ((action === 'update' || action === 'upsert' || action === 'archive') && !String(row._external_id || '').trim()) {
        issues.push({
          level: action === 'update' ? 'error' : 'warn',
          sheet: sheet.name,
          row: rowNum(i),
          model: rowModel,
          field: '_external_id',
          message: `Action ${action} sebaiknya memakai _external_id agar aman dan idempotent.`,
          suggestion: 'Tambahkan external ID stabil, misalnya lm_project.ground_zero_root.',
          code: 'missing_external_id'
        });
      }

      const schema = snapshot.models[rowModel] || modelSchema;
      if (schema?.fields) {
        for (const header of sheet.headers) {
          if (!header || isMetaColumn(header)) continue;
          const normalized = normalizeHeader(header, schema.fields[header]?.type);
          const fieldMeta = schema.fields[normalized.field];

          if (!fieldMeta) {
            // ir.model creates custom models; state is readonly in schema but accepted as intent in workbook and skipped at runtime.
            const isSafeIrModelIntent = rowModel === 'ir.model' && ['state', 'transient'].includes(header);
            issues.push({
              level: isSafeIrModelIntent ? 'info' : 'warn',
              sheet: sheet.name,
              row: rowNum(i),
              model: rowModel,
              field: header,
              message: `Field ${header} tidak ditemukan di model ${rowModel}.`,
              suggestion: isSafeIrModelIntent ? 'Importer akan melewati field ini saat update/create bila Odoo tidak mengizinkan.' : 'Kolom ini akan dihapus/dinormalisasi oleh Safe Repair, atau perbaiki nama field.',
              code: 'unknown_field'
            });
            continue;
          }

          if (fieldMeta.readonly && row[header] !== '') {
            const keepAsIntent = rowModel === 'ir.model' && header === 'state';
            issues.push({
              level: keepAsIntent ? 'info' : 'warn',
              sheet: sheet.name,
              row: rowNum(i),
              model: rowModel,
              field: header,
              message: `Field ${header} readonly/computed.`,
              suggestion: keepAsIntent ? 'Untuk ir.model, importer akan menghindari update field readonly ini.' : 'Kolom ini sebaiknya dihapus dari XLSX agar Odoo mengisinya otomatis.',
              code: 'readonly_field'
            });
          }

          if (normalized.relation && !['many2one', 'many2many'].includes(String(fieldMeta.type))) {
            issues.push({
              level: 'warn',
              sheet: sheet.name,
              row: rowNum(i),
              model: rowModel,
              field: header,
              message: `Kolom ${header} terlihat seperti external ID relation, tetapi ${normalized.field} bukan many2one/many2many.`,
              suggestion: 'Pastikan suffix _external_id atau /id hanya dipakai untuk field relasi.',
              code: 'relation_suffix_mismatch'
            });
          }
        }
      }

      if (rowModel === 'ir.model.fields') {
        const ttype = String(row.ttype || '').trim();
        const required = String(row.required || '').toLowerCase();
        const ondelete = String(row.on_delete || row.ondelete || '').toLowerCase();
        if (ttype === 'many2one' && ['true', '1', 'yes'].includes(required) && (!ondelete || ondelete === 'set null' || ondelete === 'set_null')) {
          issues.push({
            level: 'error',
            sheet: sheet.name,
            row: rowNum(i),
            model: rowModel,
            field: 'on_delete',
            message: 'Many2one required tidak boleh memakai on_delete set null/kosong.',
            suggestion: 'Isi on_delete = restrict atau jadikan required = false.',
            code: 'many2one_required_ondelete'
          });
        }
      }
    }
  }

  const seen = new Set<string>();
  const compacted: ImportIssue[] = [];
  for (const issue of issues) {
    const key = `${issue.code}|${issue.sheet}|${issue.model}|${issue.field}|${issue.message}`;
    if ((issue.code === 'unknown_field' || issue.code === 'readonly_field') && seen.has(key)) continue;
    seen.add(key);
    compacted.push(issue);
  }

  const errors = compacted.filter((x) => x.level === 'error').length;
  const warnings = compacted.filter((x) => x.level === 'warn').length;
  const status: PreflightResult['status'] = errors > 0 ? 'blocked' : warnings > 0 ? 'conditional' : 'safe';

  return {
    ok: errors === 0,
    status,
    rows_checked: rowsChecked,
    errors,
    warnings,
    issues: compacted,
    analysis: parsed.analysis,
  };
}
