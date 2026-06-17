import 'server-only';
import { buildSchemaSnapshot } from './schemaScanner';
import { parseWorkbookFromBase64, normalizeAction } from './xlsxWorkbook';
import { ImportIssue, PreflightResult } from './types';

const META_COLUMNS = new Set(['__action', '_external_id', '_model', '_note', '_comment']);

function baseRelationField(header: string): string | null {
  if (header.endsWith('_external_ids')) return header.replace(/_external_ids$/, '');
  if (header.endsWith('_external_id')) return header.replace(/_external_id$/, '');
  return null;
}

function rowNum(index: number): number {
  return index + 2;
}

export async function runPreflight(base64: string, filename?: string): Promise<PreflightResult> {
  const parsed = parseWorkbookFromBase64(base64, filename);
  const snapshot = await buildSchemaSnapshot('custom');
  const issues: ImportIssue[] = [];
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
          ? 'Pastikan sheet ir.model dan ir.model.fields berada sebelum data custom model, atau import model terlebih dahulu.'
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
          if (!header || META_COLUMNS.has(header)) continue;
          const relationBase = baseRelationField(header);
          const targetField = relationBase || header;
          const fieldMeta = schema.fields[targetField];

          if (!fieldMeta) {
            issues.push({
              level: 'warn',
              sheet: sheet.name,
              row: rowNum(i),
              model: rowModel,
              field: header,
              message: `Field ${header} tidak ditemukan di model ${rowModel}.`,
              suggestion: 'Kolom ini akan dihapus oleh Safe Repair, atau perbaiki nama field.',
              code: 'unknown_field'
            });
            continue;
          }

          if (fieldMeta.readonly && row[header] !== '') {
            issues.push({
              level: 'warn',
              sheet: sheet.name,
              row: rowNum(i),
              model: rowModel,
              field: header,
              message: `Field ${header} readonly/computed.`,
              suggestion: 'Kolom ini sebaiknya dihapus dari XLSX agar Odoo mengisinya otomatis.',
              code: 'readonly_field'
            });
          }

          if (relationBase && !['many2one', 'many2many'].includes(String(fieldMeta.type))) {
            issues.push({
              level: 'warn',
              sheet: sheet.name,
              row: rowNum(i),
              model: rowModel,
              field: header,
              message: `Kolom ${header} terlihat seperti external ID relation, tetapi ${targetField} bukan many2one/many2many.`,
              suggestion: 'Pastikan suffix _external_id hanya untuk many2one dan _external_ids hanya untuk many2many.',
              code: 'relation_suffix_mismatch'
            });
          }
        }
      }

      if (rowModel === 'ir.model.fields') {
        const ttype = String(row.ttype || '').trim();
        const required = String(row.required || '').toLowerCase();
        const ondelete = String(row.ondelete || row.on_delete || '').toLowerCase();
        if (ttype === 'many2one' && ['true', '1', 'yes'].includes(required) && (!ondelete || ondelete === 'set null' || ondelete === 'set_null')) {
          issues.push({
            level: 'error',
            sheet: sheet.name,
            row: rowNum(i),
            model: rowModel,
            field: 'ondelete',
            message: 'Many2one required tidak boleh memakai ondelete set null/kosong.',
            suggestion: 'Isi ondelete/on_delete = restrict atau jadikan required = false.',
            code: 'many2one_required_ondelete'
          });
        }
      }
    }
  }

  // Collapse repeated unknown/readonly warnings a bit for readability in UI.
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
