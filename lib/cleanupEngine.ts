import 'server-only';
import JSZip from 'jszip';
import * as XLSX from 'xlsx';
import { createOdooClient, OdooClient } from './odooXmlRpc';
import { buildSchemaSnapshot } from './schemaScanner';
import { makeWorkbookFromSheets, workbookToBase64 } from './xlsxWorkbook';
import { WorkbookRow } from './types';

export type CleanupStatus = 'SAFE_DELETE' | 'SAFE_ARCHIVE' | 'REVIEW_REQUIRED' | 'BLOCKED' | 'CORE_PROTECTED';
export type CleanupItemType = 'custom_model' | 'custom_field' | 'external_id' | 'access_rule' | 'view_reference' | 'menu_action';
export type CleanupMode = 'all' | 'models' | 'fields' | 'external_ids' | 'access';

export type CleanupScope = {
  mode?: CleanupMode;
  limit?: number;
  includeCore?: boolean;
};

export type CleanupItem = {
  key: string;
  type: CleanupItemType;
  status: CleanupStatus;
  model?: string;
  recordId?: number;
  fieldName?: string;
  externalId?: string;
  name?: string;
  recordCount?: number;
  valueCount?: number;
  relationRefCount?: number;
  viewRefCount?: number;
  accessRefCount?: number;
  reasons: string[];
  suggestedAction: 'delete' | 'archive' | 'review' | 'none';
  danger: 'low' | 'medium' | 'high' | 'protected';
};

export type CleanupScanResult = {
  ok: boolean;
  scannedAt: string;
  target: { url_host: string; db: string; username: string };
  scope: Required<CleanupScope>;
  summary: Record<CleanupStatus, number> & { total: number };
  items: CleanupItem[];
  warnings: string[];
};

export type CleanupDryRunResult = {
  ok: boolean;
  dryRun: true;
  selected: number;
  executable: number;
  blocked: number;
  logs: Array<{ level: 'info' | 'warn' | 'error' | 'success'; key: string; message: string }>;
};

export type CleanupRunResult = {
  ok: boolean;
  dryRun: false;
  processed: number;
  deleted: number;
  archived: number;
  skipped: number;
  errors: number;
  logs: Array<{ level: 'info' | 'warn' | 'error' | 'success'; key: string; message: string }>;
};

export type CleanupBackupResult = {
  ok: boolean;
  filename: string;
  zipBase64: string;
  reportFilename: string;
  reportBase64: string;
  summary: CleanupScanResult['summary'];
};

const DEFAULT_LIMIT = 80;
const MAX_LIMIT = 500;

function safeLimit(scope?: CleanupScope) {
  const raw = Number(scope?.limit || DEFAULT_LIMIT);
  if (!Number.isFinite(raw) || raw < 1) return DEFAULT_LIMIT;
  return Math.min(Math.floor(raw), MAX_LIMIT);
}

function normalizeScope(scope?: CleanupScope): Required<CleanupScope> {
  return {
    mode: scope?.mode || 'all',
    limit: safeLimit(scope),
    includeCore: Boolean(scope?.includeCore),
  };
}

function dateSlug() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

function isCustomModel(model?: string) {
  return Boolean(model && model.startsWith('x_'));
}

function isCustomField(name?: string) {
  return Boolean(name && (name.startsWith('x_') || name.startsWith('x_studio_')));
}

function relationId(value: unknown): number | null {
  if (Array.isArray(value) && typeof value[0] === 'number') return value[0];
  if (typeof value === 'number') return value;
  return null;
}

function relationName(value: unknown): string {
  if (Array.isArray(value) && typeof value[1] === 'string') return value[1];
  return '';
}

async function searchCountSafe(client: OdooClient, model: string, domain: unknown[] = []): Promise<number> {
  try {
    return await client.searchCount(model, domain);
  } catch {
    return 0;
  }
}

async function searchReadSafe<T = Record<string, any>>(client: OdooClient, model: string, domain: unknown[] = [], fields: string[] = [], limit = 100): Promise<T[]> {
  try {
    return await client.searchRead<T>(model, domain, fields, limit);
  } catch {
    return [];
  }
}

async function modelExists(client: OdooClient, model: string, id: number): Promise<boolean> {
  try {
    const ids = await client.search(model, [['id', '=', id]], 1);
    return ids.length > 0;
  } catch {
    return false;
  }
}

async function countNonEmptyField(client: OdooClient, model: string, fieldName: string): Promise<number> {
  try {
    return await client.searchCount(model, [[fieldName, '!=', false]]);
  } catch {
    return 0;
  }
}

async function countViewRefs(client: OdooClient, model: string | undefined, needle: string): Promise<number> {
  if (!needle) return 0;
  const domains: unknown[][] = [];
  if (model) domains.push([['model', '=', model], ['arch_db', 'ilike', needle]]);
  domains.push([['arch_db', 'ilike', needle]]);
  for (const domain of domains) {
    try {
      return await client.searchCount('ir.ui.view', domain);
    } catch {
      // try next domain, because some Odoo fields can be protected by edition/version
    }
  }
  return 0;
}

async function scanCustomModels(client: OdooClient, limit: number, includeCore: boolean): Promise<CleanupItem[]> {
  const domain = includeCore ? [] : [['model', '=like', 'x_%']];
  const models = await searchReadSafe<any>(client, 'ir.model', domain, ['id', 'model', 'name', 'state', 'modules'], limit);
  const out: CleanupItem[] = [];

  for (const row of models) {
    const model = String(row.model || '');
    const state = String(row.state || '');
    const reasons: string[] = [];
    const custom = state === 'manual' && isCustomModel(model);
    const recordCount = await searchCountSafe(client, model, []);
    const relationRefCount = await searchCountSafe(client, 'ir.model.fields', [['relation', '=', model]]);
    const accessRefCount = row.id ? await searchCountSafe(client, 'ir.model.access', [['model_id', '=', row.id]]) : 0;
    const viewRefCount = await searchCountSafe(client, 'ir.ui.view', [['model', '=', model]]);

    if (!custom) reasons.push('Bukan custom manual model x_*; dilindungi dari cleanup otomatis.');
    if (recordCount > 0) reasons.push(`Masih memiliki ${recordCount} record.`);
    if (relationRefCount > 0) reasons.push(`Masih direferensikan oleh ${relationRefCount} field relasi.`);
    if (accessRefCount > 0) reasons.push(`Masih memiliki ${accessRefCount} access rule.`);
    if (viewRefCount > 0) reasons.push(`Masih memiliki ${viewRefCount} view aktif.`);

    let status: CleanupStatus = 'REVIEW_REQUIRED';
    let suggestedAction: CleanupItem['suggestedAction'] = 'review';
    let danger: CleanupItem['danger'] = 'medium';
    if (!custom) {
      status = 'CORE_PROTECTED';
      suggestedAction = 'none';
      danger = 'protected';
    } else if (recordCount === 0 && relationRefCount === 0 && accessRefCount === 0 && viewRefCount === 0) {
      status = 'SAFE_DELETE';
      suggestedAction = 'delete';
      danger = 'low';
      reasons.push('Model custom manual kosong dan tidak punya dependensi yang terdeteksi.');
    } else if (recordCount > 0 || relationRefCount > 0) {
      status = 'BLOCKED';
      suggestedAction = 'none';
      danger = 'high';
    }

    out.push({
      key: `custom_model:${row.id}`,
      type: 'custom_model',
      status,
      model,
      recordId: row.id,
      name: row.name || model,
      recordCount,
      relationRefCount,
      viewRefCount,
      accessRefCount,
      reasons,
      suggestedAction,
      danger,
    });
  }
  return out;
}

async function scanCustomFields(client: OdooClient, limit: number, includeCore: boolean): Promise<CleanupItem[]> {
  const domain = includeCore ? [] : [['name', '=like', 'x_%']];
  const fields = await searchReadSafe<any>(client, 'ir.model.fields', domain, ['id', 'name', 'field_description', 'model', 'model_id', 'state', 'ttype', 'required', 'readonly', 'store', 'relation'], limit);
  const out: CleanupItem[] = [];

  for (const row of fields) {
    const fieldName = String(row.name || '');
    const model = String(row.model || relationName(row.model_id) || '');
    const state = String(row.state || '');
    const reasons: string[] = [];
    const custom = state === 'manual' && isCustomField(fieldName);
    const valueCount = custom && model ? await countNonEmptyField(client, model, fieldName) : 0;
    const viewRefCount = custom && model ? await countViewRefs(client, model, fieldName) : 0;
    const relationRefCount = await searchCountSafe(client, 'ir.model.fields', [['relation', '=', model], ['name', '!=', fieldName]]);

    if (!custom) reasons.push('Bukan custom manual field x_*; dilindungi dari cleanup otomatis.');
    if (row.required) reasons.push('Field required; tidak aman dihapus otomatis.');
    if (valueCount > 0) reasons.push(`Masih terisi pada ${valueCount} record.`);
    if (viewRefCount > 0) reasons.push(`Masih muncul di ${viewRefCount} view/arch.`);
    if (!model) reasons.push('Model target field tidak terbaca.');

    let status: CleanupStatus = 'REVIEW_REQUIRED';
    let suggestedAction: CleanupItem['suggestedAction'] = 'review';
    let danger: CleanupItem['danger'] = 'medium';
    if (!custom) {
      status = 'CORE_PROTECTED';
      suggestedAction = 'none';
      danger = 'protected';
    } else if (row.required || valueCount > 0) {
      status = 'BLOCKED';
      suggestedAction = 'none';
      danger = 'high';
    } else if (viewRefCount === 0) {
      status = 'SAFE_DELETE';
      suggestedAction = 'delete';
      danger = 'low';
      reasons.push('Field custom manual kosong dan tidak ditemukan di view.');
    } else {
      status = 'REVIEW_REQUIRED';
      suggestedAction = 'review';
      danger = 'medium';
    }

    out.push({
      key: `custom_field:${row.id}`,
      type: 'custom_field',
      status,
      model,
      fieldName,
      recordId: row.id,
      name: row.field_description || fieldName,
      valueCount,
      relationRefCount,
      viewRefCount,
      reasons,
      suggestedAction,
      danger,
    });
  }
  return out;
}

async function scanExternalIds(client: OdooClient, limit: number): Promise<CleanupItem[]> {
  const domain = ['|', ['module', 'ilike', 'lokalmart'], ['module', 'ilike', 'studio']];
  const rows = await searchReadSafe<any>(client, 'ir.model.data', domain, ['id', 'module', 'name', 'model', 'res_id', 'noupdate'], limit);
  const out: CleanupItem[] = [];

  for (const row of rows) {
    const model = String(row.model || '');
    const resId = Number(row.res_id || 0);
    const externalId = `${row.module}.${row.name}`;
    const exists = model && resId ? await modelExists(client, model, resId) : false;
    const reasons: string[] = [];
    if (exists) reasons.push('External ID masih menunjuk record yang ada.');
    else reasons.push('Record target external ID tidak ditemukan atau model tidak bisa dibaca.');

    out.push({
      key: `external_id:${row.id}`,
      type: 'external_id',
      status: exists ? 'REVIEW_REQUIRED' : 'SAFE_DELETE',
      model,
      recordId: row.id,
      externalId,
      name: externalId,
      reasons,
      suggestedAction: exists ? 'review' : 'delete',
      danger: exists ? 'medium' : 'low',
    });
  }
  return out;
}


async function getTechnicalModelName(client: OdooClient, modelId: number | null): Promise<string> {
  if (!modelId) return '';
  try {
    const rows = await client.read<{ model?: string }>('ir.model', [modelId], ['model']);
    return String(rows?.[0]?.model || '');
  } catch {
    return '';
  }
}

async function scanAccessRules(client: OdooClient, limit: number): Promise<CleanupItem[]> {
  const rows = await searchReadSafe<any>(client, 'ir.model.access', [], ['id', 'name', 'active', 'model_id', 'group_id', 'perm_read', 'perm_write', 'perm_create', 'perm_unlink'], limit);
  const out: CleanupItem[] = [];
  for (const row of rows) {
    const modelId = relationId(row.model_id);
    const modelName = await getTechnicalModelName(client, modelId);
    if (!isCustomModel(modelName)) continue;
    const recordCount = await searchCountSafe(client, modelName, []);
    const reasons: string[] = [];
    if (recordCount > 0) reasons.push(`Model ${modelName} masih punya ${recordCount} record.`);
    if (row.active === false) reasons.push('Access rule sudah nonaktif.');
    if (!modelId) reasons.push('Model access tidak terbaca.');

    let status: CleanupStatus = 'REVIEW_REQUIRED';
    let suggestedAction: CleanupItem['suggestedAction'] = 'review';
    let danger: CleanupItem['danger'] = 'medium';
    if (row.active === false) {
      status = 'SAFE_ARCHIVE';
      suggestedAction = 'archive';
      danger = 'low';
      reasons.push('Sudah archived/nonaktif; tidak perlu unlink.');
    } else if (recordCount === 0) {
      status = 'SAFE_ARCHIVE';
      suggestedAction = 'archive';
      danger = 'low';
      reasons.push('Access rule custom model kosong; rekomendasi archive, bukan delete.');
    } else {
      status = 'REVIEW_REQUIRED';
    }

    out.push({
      key: `access_rule:${row.id}`,
      type: 'access_rule',
      status,
      model: modelName,
      recordId: row.id,
      name: row.name,
      recordCount,
      reasons,
      suggestedAction,
      danger,
    });
  }
  return out;
}

function summarize(items: CleanupItem[]): CleanupScanResult['summary'] {
  const summary: CleanupScanResult['summary'] = {
    SAFE_DELETE: 0,
    SAFE_ARCHIVE: 0,
    REVIEW_REQUIRED: 0,
    BLOCKED: 0,
    CORE_PROTECTED: 0,
    total: items.length,
  };
  for (const item of items) summary[item.status] += 1;
  return summary;
}

export async function scanCleanup(scope: CleanupScope = {}): Promise<CleanupScanResult> {
  const normalized = normalizeScope(scope);
  const client = await createOdooClient();
  const items: CleanupItem[] = [];

  if (normalized.mode === 'all' || normalized.mode === 'models') items.push(...await scanCustomModels(client, normalized.limit, normalized.includeCore));
  if (normalized.mode === 'all' || normalized.mode === 'fields') items.push(...await scanCustomFields(client, normalized.limit, normalized.includeCore));
  if (normalized.mode === 'all' || normalized.mode === 'external_ids') items.push(...await scanExternalIds(client, normalized.limit));
  if (normalized.mode === 'all' || normalized.mode === 'access') items.push(...await scanAccessRules(client, normalized.limit));

  return {
    ok: true,
    scannedAt: new Date().toISOString(),
    target: client.target,
    scope: normalized,
    summary: summarize(items),
    items,
    warnings: [
      'Cleanup scanner bersifat konservatif. Item REVIEW_REQUIRED/BLOCKED/CORE_PROTECTED tidak akan dieksekusi oleh endpoint run.',
      'Custom model/field yang masih punya data atau referensi view tidak dianggap aman dihapus.',
      'Access rule direkomendasikan archive/nonaktif, bukan unlink fisik, untuk menghindari foreign key error.',
    ],
  };
}

function itemToRow(item: CleanupItem): WorkbookRow {
  return {
    key: item.key,
    type: item.type,
    status: item.status,
    suggested_action: item.suggestedAction,
    danger: item.danger,
    model: item.model || '',
    field_name: item.fieldName || '',
    external_id: item.externalId || '',
    record_id: item.recordId || '',
    name: item.name || '',
    record_count: item.recordCount ?? '',
    value_count: item.valueCount ?? '',
    relation_ref_count: item.relationRefCount ?? '',
    view_ref_count: item.viewRefCount ?? '',
    access_ref_count: item.accessRefCount ?? '',
    reasons: item.reasons.join(' | '),
  };
}

export async function backupCleanupCandidates(scope: CleanupScope = {}): Promise<CleanupBackupResult> {
  const scan = await scanCleanup(scope);
  const wb = makeWorkbookFromSheets([
    { name: '00_README', rows: [
      { key: 'title', value: 'Lokalmart Cleanup Audit Backup' },
      { key: 'scanned_at', value: scan.scannedAt },
      { key: 'target_db', value: scan.target.db },
      { key: 'rule', value: 'Jangan eksekusi cleanup tanpa dry-run dan backup.' },
    ] },
    { name: 'cleanup.audit', rows: scan.items.map(itemToRow) },
    { name: 'cleanup.safe_delete', rows: scan.items.filter((i) => i.status === 'SAFE_DELETE').map(itemToRow) },
    { name: 'cleanup.safe_archive', rows: scan.items.filter((i) => i.status === 'SAFE_ARCHIVE').map(itemToRow) },
    { name: 'cleanup.blocked', rows: scan.items.filter((i) => ['BLOCKED', 'CORE_PROTECTED', 'REVIEW_REQUIRED'].includes(i.status)).map(itemToRow) },
  ]);
  const reportBase64 = workbookToBase64(wb);
  const reportBuffer = Buffer.from(reportBase64, 'base64');
  const zip = new JSZip();
  const base = `lokalmart_cleanup_audit_${scan.target.db}_${dateSlug()}`;
  zip.file('cleanup_scan.json', JSON.stringify(scan, null, 2));
  zip.file('cleanup_audit.xlsx', reportBuffer);
  try {
    const schema = await buildSchemaSnapshot('custom');
    zip.file('schema_snapshot_before_cleanup.json', JSON.stringify(schema, null, 2));
  } catch (error) {
    zip.file('schema_snapshot_error.txt', error instanceof Error ? error.message : String(error));
  }
  zip.file('cleanup_restore_note.md', `# Cleanup Safety Note\n\nBackup ini dibuat sebelum menjalankan cleanup. Isi utama adalah audit report, bukan full database dump. Untuk backup data record gunakan menu Backup Center.\n\nStatus yang boleh dieksekusi otomatis hanya SAFE_DELETE dan SAFE_ARCHIVE.\n`);
  const zipBuffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  return {
    ok: true,
    filename: `${base}.zip`,
    zipBase64: zipBuffer.toString('base64'),
    reportFilename: `${base}.xlsx`,
    reportBase64,
    summary: scan.summary,
  };
}

function selectedItemsFromScan(scan: CleanupScanResult, keys: string[]) {
  const selected = new Set(keys);
  return scan.items.filter((item) => selected.has(item.key));
}

export async function dryRunCleanup(keys: string[], scope: CleanupScope = {}): Promise<CleanupDryRunResult> {
  const scan = await scanCleanup(scope);
  const items = selectedItemsFromScan(scan, keys);
  const logs: CleanupDryRunResult['logs'] = [];
  let executable = 0;
  let blocked = 0;

  for (const item of items) {
    if (item.status === 'SAFE_DELETE' || item.status === 'SAFE_ARCHIVE') {
      executable += 1;
      logs.push({ level: 'success', key: item.key, message: `Akan menjalankan ${item.suggestedAction} pada ${item.type} ${item.name || item.model || item.fieldName || ''}.` });
    } else {
      blocked += 1;
      logs.push({ level: 'warn', key: item.key, message: `Diblokir: status ${item.status}. ${item.reasons.join(' ')}` });
    }
  }

  return { ok: blocked === 0, dryRun: true, selected: items.length, executable, blocked, logs };
}

async function executeCleanupItem(client: OdooClient, item: CleanupItem): Promise<{ level: 'success' | 'warn' | 'error' | 'info'; message: string; deleted?: boolean; archived?: boolean; skipped?: boolean }> {
  if (!(item.status === 'SAFE_DELETE' || item.status === 'SAFE_ARCHIVE')) {
    return { level: 'warn', message: `Skip: status ${item.status} tidak boleh dieksekusi otomatis.`, skipped: true };
  }
  if (!item.recordId) return { level: 'warn', message: 'Skip: record_id kosong.', skipped: true };

  try {
    if (item.type === 'custom_field' && item.status === 'SAFE_DELETE') {
      await client.unlink('ir.model.fields', [item.recordId]);
      return { level: 'success', message: `Field ${item.fieldName} dihapus dari ir.model.fields.`, deleted: true };
    }
    if (item.type === 'custom_model' && item.status === 'SAFE_DELETE') {
      await client.unlink('ir.model', [item.recordId]);
      return { level: 'success', message: `Model ${item.model} dihapus dari ir.model.`, deleted: true };
    }
    if (item.type === 'external_id' && item.status === 'SAFE_DELETE') {
      await client.unlink('ir.model.data', [item.recordId]);
      return { level: 'success', message: `External ID ${item.externalId} dihapus.`, deleted: true };
    }
    if (item.type === 'access_rule' && item.status === 'SAFE_ARCHIVE') {
      await client.write('ir.model.access', [item.recordId], { active: false });
      return { level: 'success', message: `Access rule ${item.name || item.recordId} dinonaktifkan.`, archived: true };
    }
    return { level: 'warn', message: `Skip: kombinasi ${item.type}/${item.status} belum didukung untuk eksekusi.`, skipped: true };
  } catch (error) {
    return { level: 'error', message: error instanceof Error ? error.message : String(error) };
  }
}

export async function runCleanup(keys: string[], confirm: string, scope: CleanupScope = {}): Promise<CleanupRunResult> {
  if (confirm !== 'CLEANUP_SELECTED_SAFE_ITEMS') throw new Error('Konfirmasi cleanup salah. Gunakan CLEANUP_SELECTED_SAFE_ITEMS.');
  const scan = await scanCleanup(scope);
  const items = selectedItemsFromScan(scan, keys);
  const client = await createOdooClient();
  const logs: CleanupRunResult['logs'] = [];
  let processed = 0;
  let deleted = 0;
  let archived = 0;
  let skipped = 0;
  let errors = 0;

  for (const item of items) {
    processed += 1;
    const result = await executeCleanupItem(client, item);
    if (result.deleted) deleted += 1;
    if (result.archived) archived += 1;
    if (result.skipped) skipped += 1;
    if (result.level === 'error') errors += 1;
    logs.push({ level: result.level, key: item.key, message: result.message });
  }

  return { ok: errors === 0, dryRun: false, processed, deleted, archived, skipped, errors, logs };
}
