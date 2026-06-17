import 'server-only';
import * as XLSX from 'xlsx';
import { buildSchemaSnapshot } from './schemaScanner';
import { makeWorkbookFromSheets, parseWorkbookFromBase64, workbookToBase64 } from './xlsxWorkbook';
import { ImportIssue, WorkbookRow } from './types';

const META_COLUMNS = new Set(['__action', '_external_id', '_model', '_note', '_comment']);

function relationBase(header: string): string | null {
  if (header.endsWith('_external_ids')) return header.replace(/_external_ids$/, '');
  if (header.endsWith('_external_id')) return header.replace(/_external_id$/, '');
  return null;
}

export async function repairWorkbook(base64: string, filename?: string) {
  const parsed = parseWorkbookFromBase64(base64, filename);
  const snapshot = await buildSchemaSnapshot('custom');
  const issues: ImportIssue[] = [];
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
        if (META_COLUMNS.has(key)) {
          newRow[key] = value;
          continue;
        }

        if (!schema?.fields) {
          newRow[key] = value;
          continue;
        }

        const base = relationBase(key);
        const target = base || key;
        const meta = schema.fields[target];
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
        newRow[key] = value;
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
      notes: 'Safe Repair menghapus kolom unknown/readonly dan mempertahankan _model/_external_id/__action.'
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
