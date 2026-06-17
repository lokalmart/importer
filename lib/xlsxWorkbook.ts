import 'server-only';
import * as XLSX from 'xlsx';
import { SheetPreview, WorkbookAnalysis, WorkbookRow } from './types';

export type ParsedWorkbook = {
  workbook: XLSX.WorkBook;
  sheets: Array<{ name: string; headers: string[]; rows: WorkbookRow[]; inferredModel: string | null }>;
  analysis: WorkbookAnalysis;
};

export function base64ToBuffer(base64: string): Buffer {
  const cleaned = base64.includes(',') ? base64.split(',').pop() || '' : base64;
  return Buffer.from(cleaned, 'base64');
}

export function inferModelFromSheet(sheetName: string, firstRow?: WorkbookRow): string | null {
  const rowModel = typeof firstRow?._model === 'string' && firstRow._model.trim() ? firstRow._model.trim() : null;
  if (rowModel) return rowModel;

  const lower = sheetName.toLowerCase().trim();
  if (lower.startsWith('__')) return null;
  if (lower.startsWith('schema.')) return null;
  if (lower.startsWith('seed.')) return sheetName.slice(5);
  if (lower.includes('.')) return sheetName;
  if (lower.startsWith('x_')) return sheetName;
  return sheetName;
}

export function parseWorkbookFromBase64(base64: string, filename?: string): ParsedWorkbook {
  const buffer = base64ToBuffer(base64);
  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const sheets = workbook.SheetNames.map((name) => {
    const ws = workbook.Sheets[name];
    const matrix = XLSX.utils.sheet_to_json<string[]>(ws, { header: 1, defval: '' });
    const headers = (matrix[0] || []).map((h) => String(h || '').trim()).filter(Boolean);
    const rows = XLSX.utils.sheet_to_json<WorkbookRow>(ws, { defval: '', raw: false });
    const inferredModel = inferModelFromSheet(name, rows[0]);
    return { name, headers, rows, inferredModel };
  });

  const previews: SheetPreview[] = sheets.map((s) => ({
    name: s.name,
    inferredModel: s.inferredModel,
    rows: s.rows.length,
    headers: s.headers,
    sample: s.rows.slice(0, 5),
  }));

  const models = Array.from(new Set(sheets.map((s) => s.inferredModel).filter(Boolean) as string[]));
  const analysis: WorkbookAnalysis = {
    filename,
    sheets: previews,
    totals: {
      sheets: sheets.length,
      rows: sheets.reduce((sum, s) => sum + s.rows.length, 0),
      models: models.length,
    },
    models,
  };

  return { workbook, sheets, analysis };
}

export function workbookToBase64(workbook: XLSX.WorkBook): string {
  const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
  return buffer.toString('base64');
}

export function makeWorkbookFromSheets(sheets: Array<{ name: string; rows: WorkbookRow[] }>): XLSX.WorkBook {
  const wb = XLSX.utils.book_new();
  for (const sheet of sheets) {
    const ws = XLSX.utils.json_to_sheet(sheet.rows);
    XLSX.utils.book_append_sheet(wb, ws, sheet.name.slice(0, 31));
  }
  return wb;
}

export function emptyToUndefined(value: unknown): unknown {
  if (value === '') return undefined;
  if (typeof value === 'string' && value.trim() === '') return undefined;
  return value;
}

export function normalizeAction(value: unknown): 'create' | 'update' | 'upsert' | 'archive' | 'skip' | 'delete' {
  const raw = String(value || 'upsert').toLowerCase().trim();
  if (raw === 'delete' || raw === 'unlink') return 'delete';
  if (raw === 'delete_soft' || raw === 'deactivate' || raw === 'archive') return 'archive';
  if (raw === 'create' || raw === 'update' || raw === 'upsert' || raw === 'skip') return raw;
  return 'upsert';
}

export function orderedSheets<T extends { name: string; inferredModel: string | null }>(sheets: T[]): T[] {
  const priority = ['ir.model', 'ir.model.fields', 'ir.model.access', 'ir.model.data'];
  return [...sheets].sort((a, b) => {
    const ai = priority.indexOf(a.inferredModel || a.name);
    const bi = priority.indexOf(b.inferredModel || b.name);
    const aw = ai === -1 ? 999 : ai;
    const bw = bi === -1 ? 999 : bi;
    return aw - bw;
  });
}
