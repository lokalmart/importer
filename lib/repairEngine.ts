import 'server-only';
import * as XLSX from 'xlsx';
import { buildSchemaSnapshot } from './schemaScanner';
import { makeWorkbookFromSheets, parseWorkbookFromBase64, workbookToBase64 } from './xlsxWorkbook';
import { ImportIssue, WorkbookRow, SchemaSnapshot } from './types';
import { isMetaColumn, normalizeHeader } from './importHeaders';

function fallbackSnapshot(): SchemaSnapshot {
  return {
    ok: false,
    exported_at: new Date().toISOString(),
    target: { url_host: 'offline', db: 'offline', username: 'offline' },
    models: {},
    modelList: [],
    externalIds: [],
  };
}

async function loadSnapshot(issues: ImportIssue[]): Promise<SchemaSnapshot> {
  try {
    return await buildSchemaSnapshot('custom');
  } catch (error) {
    issues.push({
      level: 'warn',
      message: `Schema live gagal dibaca saat repair. Repair tetap lanjut dengan mode workbook-only. Detail: ${error instanceof Error ? error.message : String(error)}`,
      code: 'schema_scan_failed_fallback',
    });
    return fallbackSnapshot();
  }
}

export async function repairWorkbook(base64: string, filename?: string) {
  const parsed = parseWorkbookFromBase64(base64, filename);
  const issues: ImportIssue[] = [];
  const snapshot = await loadSnapshot(issues);
  const repairedSheets: Array<{ name: string; rows: WorkbookRow[] }> = [];

  for (const sheet of parsed.sheets) {
    const model = sheet.inferredModel;
    if (!model) {
      repairedSheets.push({ name: sheet.name, rows: sheet.rows });
      continue;
    }

    const repairedRows = sheet.rows.map((row, index) => {
      const rowModel = String(row._model || model).trim();
      const schema = snapshot.models[rowModel];
      const newRow: WorkbookRow = {};

      for (const [key, value] of Object.entries(row)) {
        if (!key) continue;
        if (isMetaColumn(key)) {
          newRow[key] = value;
          continue;
        }

        if (!schema?.fields) {
          newRow[key] = value;
          continue;
        }

        const directMeta = schema.fields[key];
        const normalized = normalizeHeader(key, directMeta?.type);
        const meta = schema.fields[normalized.field];
        if (!meta) {
          issues.push({
            level: 'info',
            sheet: sheet.name,
            row: index + 2,
            model: rowModel,
            field: key,
            message: `Kolom ${key} dihapus karena tidak ada di schema ${rowModel}.`,
            code: 'dropped_unknown_field'
          });
          continue;
        }
        if (meta.readonly) {
          issues.push({
            level: 'info',
            sheet: sheet.name,
            row: index + 2,
            model: rowModel,
            field: key,
            message: `Kolom ${key} dihapus karena readonly/computed.`,
            code: 'dropped_readonly_field'
          });
          continue;
        }

        const outKey = normalized.relation ? normalized.relation.normalizedHeader : key;
        if (outKey !== key) {
          issues.push({
            level: 'info',
            sheet: sheet.name,
            row: index + 2,
            model: rowModel,
            field: key,
            message: `Kolom ${key} dinormalisasi menjadi ${outKey}.`,
            code: 'normalized_relation_header'
          });
        }
        newRow[outKey] = value;
      }

      if (!newRow._model) newRow._model = rowModel;
      return newRow;
    });

    repairedSheets.push({ name: sheet.name, rows: repairedRows });
  }

  const workbook = makeWorkbookFromSheets(repairedSheets);

  const manifest = [
    {
      repaired_at: new Date().toISOString(),
      source_filename: filename || '',
      sheets: repairedSheets.length,
      changes: issues.length,
      notes: 'Safe Repair menghapus kolom unknown/readonly, menormalisasi model_id/id menjadi model_id_external_id, dan mempertahankan _model/_external_id/__action.'
    }
  ];
  const manifestWs = XLSX.utils.json_to_sheet(manifest);
  XLSX.utils.book_append_sheet(workbook, manifestWs, '__repair_manifest');

  return {
    ok: true,
    filename: `${(filename || 'lokalmart_import').replace(/\.xlsx$/i, '')}_safe_patch.xlsx`,
    base64: workbookToBase64(workbook),
    changes: issues.length,
    issues,
  };
}
