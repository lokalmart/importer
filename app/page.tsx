'use client';

import { useEffect, useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Archive, BookOpen, Bug, Database, Download, FileSpreadsheet, FileText, KeyRound, Loader2, ShieldCheck, Sparkles, Trash2, UploadCloud, Wrench } from 'lucide-react';

type Tab = 'home' | 'templates' | 'import' | 'backup' | 'cleanup' | 'schema' | 'repair' | 'logs' | 'settings';

type ApiState<T> = { loading: boolean; data?: T; error?: string };

type Config = {
  ok: boolean;
  requiresToken: boolean;
  target?: { url_host: string; db: string; username: string };
  error?: string;
};

type Analysis = {
  filename?: string;
  sheets: Array<{ name: string; inferredModel: string | null; rows: number; headers: string[]; sample: Record<string, unknown>[] }>;
  totals: { sheets: number; rows: number; models: number };
  models: string[];
};

type Issue = {
  level: 'error' | 'warn' | 'info';
  sheet?: string;
  row?: number;
  model?: string;
  field?: string;
  message: string;
  suggestion?: string;
  code?: string;
};

type Preflight = {
  ok: boolean;
  status: 'safe' | 'conditional' | 'blocked' | 'needs_schema';
  rows_checked: number;
  errors: number;
  warnings: number;
  issues: Issue[];
  analysis: Analysis;
};

type RepairResult = {
  ok: boolean;
  filename: string;
  base64: string;
  changes: number;
  issues: Issue[];
};

type ImportResult = {
  ok: boolean;
  dryRun: boolean;
  processed: number;
  created: number;
  updated: number;
  archived: number;
  skipped: number;
  errors: number;
  logs: Array<{ level: 'error' | 'warn' | 'info' | 'success'; sheet: string; row?: number; model?: string; action?: string; external_id?: string; message: string }>;
};

type HistoryEntry = {
  id: string;
  at: string;
  filename: string;
  result: ImportResult;
};


type BackupRecipe = {
  id: string;
  title: string;
  description: string;
  rootModel?: string;
  models: string[];
  importable: boolean;
};

type BackupPreview = {
  ok: boolean;
  recipe: BackupRecipe;
  target: { url_host: string; db: string; username: string };
  counts: Record<string, number>;
  total: number;
  limit: number;
  warnings: string[];
};

type BackupRun = {
  ok: boolean;
  filename: string;
  zipBase64: string;
  xlsxFilename: string;
  xlsxBase64: string;
  summary: {
    recipeId: string;
    recipeTitle: string;
    exportedAt: string;
    counts: Record<string, number>;
    sheets: string[];
    generatedExternalIds: number;
    warnings: string[];
  };
};


type CleanupStatus = 'SAFE_DELETE' | 'SAFE_ARCHIVE' | 'REVIEW_REQUIRED' | 'BLOCKED' | 'CORE_PROTECTED';
type CleanupMode = 'all' | 'models' | 'fields' | 'external_ids' | 'access';

type CleanupItem = {
  key: string;
  type: 'custom_model' | 'custom_field' | 'external_id' | 'access_rule' | 'view_reference' | 'menu_action';
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

type CleanupScan = {
  ok: boolean;
  scannedAt: string;
  target: { url_host: string; db: string; username: string };
  scope: { mode: CleanupMode; limit: number; includeCore: boolean };
  summary: Record<CleanupStatus, number> & { total: number };
  items: CleanupItem[];
  warnings: string[];
};

type CleanupBackup = {
  ok: boolean;
  filename: string;
  zipBase64: string;
  reportFilename: string;
  reportBase64: string;
  summary: CleanupScan['summary'];
};

type CleanupExec = {
  ok: boolean;
  dryRun: boolean;
  selected?: number;
  executable?: number;
  blocked?: number;
  processed?: number;
  deleted?: number;
  archived?: number;
  skipped?: number;
  errors?: number;
  logs: Array<{ level: 'info' | 'warn' | 'error' | 'success'; key: string; message: string }>;
};

function cls(...items: Array<string | false | null | undefined>) {
  return items.filter(Boolean).join(' ');
}

async function fileToBase64(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function downloadBase64Xlsx(base64: string, filename: string) {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const blob = new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}


function downloadBase64File(base64: string, filename: string, type = 'application/octet-stream') {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const blob = new Blob([bytes], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function downloadJson(obj: unknown, filename: string) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function EmptyState({ icon: Icon, title, text }: { icon: any; title: string; text: string }) {
  return (
    <div className="box" style={{ textAlign: 'center', padding: 28 }}>
      <Icon size={34} color="var(--green)" />
      <h3 style={{ marginTop: 12 }}>{title}</h3>
      <p style={{ color: 'var(--muted)', margin: 0, lineHeight: 1.6 }}>{text}</p>
    </div>
  );
}

export default function Page() {
  const [tab, setTab] = useState<Tab>('home');
  const [config, setConfig] = useState<Config | null>(null);
  const [token, setToken] = useState('');
  const [fileName, setFileName] = useState('');
  const [base64, setBase64] = useState('');
  const [analysis, setAnalysis] = useState<ApiState<Analysis>>({ loading: false });
  const [preflight, setPreflight] = useState<ApiState<Preflight>>({ loading: false });
  const [repair, setRepair] = useState<ApiState<RepairResult>>({ loading: false });
  const [importResult, setImportResult] = useState<ApiState<ImportResult>>({ loading: false });
  const [schema, setSchema] = useState<ApiState<any>>({ loading: false });
  const [health, setHealth] = useState<ApiState<any>>({ loading: false });
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [recipes, setRecipes] = useState<ApiState<BackupRecipe[]>>({ loading: false });
  const [backupRecipeId, setBackupRecipeId] = useState('backup_project_bundle');
  const [backupLimit, setBackupLimit] = useState(100);
  const [backupPreview, setBackupPreview] = useState<ApiState<BackupPreview>>({ loading: false });
  const [backupRun, setBackupRun] = useState<ApiState<BackupRun>>({ loading: false });
  const [cleanupMode, setCleanupMode] = useState<CleanupMode>('all');
  const [cleanupLimit, setCleanupLimit] = useState(120);
  const [cleanupScan, setCleanupScan] = useState<ApiState<CleanupScan>>({ loading: false });
  const [cleanupBackup, setCleanupBackup] = useState<ApiState<CleanupBackup>>({ loading: false });
  const [cleanupExec, setCleanupExec] = useState<ApiState<CleanupExec>>({ loading: false });
  const [selectedCleanupKeys, setSelectedCleanupKeys] = useState<string[]>([]);

  const headers = useMemo(() => ({ 'Content-Type': 'application/json', 'x-importer-token': token }), [token]);

  useEffect(() => {
    const saved = localStorage.getItem('lokalmart_importer_token') || '';
    setToken(saved);
    try {
      const rawHistory = localStorage.getItem('lokalmart_importer_history');
      if (rawHistory) setHistory(JSON.parse(rawHistory).slice(0, 20));
    } catch {
      localStorage.removeItem('lokalmart_importer_history');
    }
    fetch('/api/config')
      .then((r) => r.json())
      .then(setConfig)
      .catch((e) => setConfig({ ok: false, requiresToken: true, error: String(e) }));
    setRecipes({ loading: true });
    fetch('/api/backup/recipes', { headers: { 'x-importer-token': saved } })
      .then((r) => r.json())
      .then((j) => setRecipes({ loading: false, data: j.recipes || [] }))
      .catch((e) => setRecipes({ loading: false, error: String(e) }));
  }, []);

  useEffect(() => {
    if (token) localStorage.setItem('lokalmart_importer_token', token);
  }, [token]);

  async function apiPost<T>(url: string, body: unknown): Promise<T> {
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
    const json = await res.json();
    // `ok:false` can be a valid business result, for example blocked preflight or dry-run with row errors.
    // Only HTTP failures or explicit `error` payloads should become request failures.
    if (!res.ok || json.error) throw new Error(json.error || 'Request gagal');
    return json as T;
  }

  function rememberImportResult(result: ImportResult) {
    const entry: HistoryEntry = { id: `${Date.now()}-${Math.random().toString(16).slice(2)}`, at: new Date().toISOString(), filename: fileName || 'workbook.xlsx', result };
    setHistory((prev) => {
      const next = [entry, ...prev].slice(0, 20);
      localStorage.setItem('lokalmart_importer_history', JSON.stringify(next));
      return next;
    });
  }

  function makeFailedRequestResult(message: string, dryRun: boolean): ImportResult {
    return {
      ok: false,
      dryRun,
      processed: 0,
      created: 0,
      updated: 0,
      archived: 0,
      skipped: 0,
      errors: 1,
      logs: [{ level: 'error', sheet: '-', message }],
    };
  }

  async function analyzeFile(file: File) {
    setFileName(file.name);
    setAnalysis({ loading: true });
    setPreflight({ loading: false });
    setRepair({ loading: false });
    setImportResult({ loading: false });
    try {
      const b64 = await fileToBase64(file);
      setBase64(b64);
      const data = await apiPost<{ ok: true; analysis: Analysis }>('/api/xlsx/analyze', { base64: b64, filename: file.name });
      setAnalysis({ loading: false, data: data.analysis });
      setTab('import');
    } catch (e) {
      setAnalysis({ loading: false, error: e instanceof Error ? e.message : String(e) });
    }
  }

  async function runHealth() {
    setHealth({ loading: true });
    try {
      const res = await fetch('/api/odoo/health', { headers: { 'x-importer-token': token } });
      const json = await res.json();
      if (!res.ok || json.ok === false) throw new Error(json.error || 'Connection failed');
      setHealth({ loading: false, data: json });
    } catch (e) {
      setHealth({ loading: false, error: e instanceof Error ? e.message : String(e) });
    }
  }

  async function runSchema() {
    setSchema({ loading: true });
    try {
      const res = await fetch('/api/schema/snapshot?mode=custom', { headers: { 'x-importer-token': token } });
      const json = await res.json();
      if (!res.ok || json.ok === false) throw new Error(json.error || 'Schema scan failed');
      setSchema({ loading: false, data: json });
    } catch (e) {
      setSchema({ loading: false, error: e instanceof Error ? e.message : String(e) });
    }
  }

  async function runPreflightClick() {
    if (!base64) return;
    setPreflight({ loading: true });
    try {
      const data = await apiPost<Preflight>('/api/xlsx/preflight', { base64, filename: fileName, schemaSnapshot: schema.data });
      setPreflight({ loading: false, data });
    } catch (e) {
      setPreflight({ loading: false, error: e instanceof Error ? e.message : String(e) });
    }
  }

  async function runRepairClick() {
    if (!base64) return;
    setRepair({ loading: true });
    try {
      const data = await apiPost<RepairResult>('/api/xlsx/repair', { base64, filename: fileName });
      setRepair({ loading: false, data });
      setBase64(data.base64);
      setFileName(data.filename);
      setPreflight({ loading: false });
      setImportResult({ loading: false });
      setTab('repair');
    } catch (e) {
      setRepair({ loading: false, error: e instanceof Error ? e.message : String(e) });
    }
  }

  async function runImportClick(dryRun: boolean) {
    if (!base64) return;
    setImportResult({ loading: true });
    try {
      const data = await apiPost<ImportResult>('/api/xlsx/import', { base64, filename: fileName, dryRun, confirm: dryRun ? undefined : 'IMPORT_TO_ODOO' });
      setImportResult({ loading: false, data });
      rememberImportResult(data);
      setTab('logs');
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const data = makeFailedRequestResult(message, dryRun);
      setImportResult({ loading: false, error: message, data });
      rememberImportResult(data);
      setTab('logs');
    }
  }


  async function loadRecipes() {
    setRecipes({ loading: true });
    try {
      const res = await fetch('/api/backup/recipes', { headers: { 'x-importer-token': token } });
      const json = await res.json();
      if (!res.ok || json.error) throw new Error(json.error || 'Gagal membaca backup recipes');
      setRecipes({ loading: false, data: json.recipes || [] });
    } catch (e) {
      setRecipes({ loading: false, error: e instanceof Error ? e.message : String(e) });
    }
  }

  async function runBackupPreview() {
    setBackupPreview({ loading: true });
    setBackupRun({ loading: false });
    try {
      const data = await apiPost<BackupPreview>('/api/backup/preview', {
        recipeId: backupRecipeId,
        scope: { limit: backupLimit, includeSchema: true, includeRawJson: true },
      });
      setBackupPreview({ loading: false, data });
    } catch (e) {
      setBackupPreview({ loading: false, error: e instanceof Error ? e.message : String(e) });
    }
  }

  async function runBackupNow() {
    setBackupRun({ loading: true });
    try {
      const data = await apiPost<BackupRun>('/api/backup/run', {
        recipeId: backupRecipeId,
        scope: { limit: backupLimit, includeSchema: true, includeRawJson: true },
      });
      setBackupRun({ loading: false, data });
    } catch (e) {
      setBackupRun({ loading: false, error: e instanceof Error ? e.message : String(e) });
    }
  }


  function cleanupScope() {
    return { mode: cleanupMode, limit: cleanupLimit, includeCore: false };
  }

  function toggleCleanupKey(key: string) {
    setSelectedCleanupKeys((prev) => prev.includes(key) ? prev.filter((x) => x !== key) : [...prev, key]);
  }

  function selectSafeCleanupItems() {
    const safe = (cleanupScan.data?.items || []).filter((item) => item.status === 'SAFE_DELETE' || item.status === 'SAFE_ARCHIVE').map((item) => item.key);
    setSelectedCleanupKeys(safe);
  }

  async function runCleanupScan() {
    setCleanupScan({ loading: true });
    setCleanupBackup({ loading: false });
    setCleanupExec({ loading: false });
    setSelectedCleanupKeys([]);
    try {
      const data = await apiPost<CleanupScan>('/api/cleanup/scan', { scope: cleanupScope() });
      setCleanupScan({ loading: false, data });
    } catch (e) {
      setCleanupScan({ loading: false, error: e instanceof Error ? e.message : String(e) });
    }
  }

  async function runCleanupBackup() {
    setCleanupBackup({ loading: true });
    try {
      const data = await apiPost<CleanupBackup>('/api/cleanup/backup', { scope: cleanupScope() });
      setCleanupBackup({ loading: false, data });
    } catch (e) {
      setCleanupBackup({ loading: false, error: e instanceof Error ? e.message : String(e) });
    }
  }

  async function runCleanupDryRun() {
    setCleanupExec({ loading: true });
    try {
      const data = await apiPost<CleanupExec>('/api/cleanup/dry-run', { keys: selectedCleanupKeys, scope: cleanupScope() });
      setCleanupExec({ loading: false, data });
    } catch (e) {
      setCleanupExec({ loading: false, error: e instanceof Error ? e.message : String(e) });
    }
  }

  async function runCleanupNow() {
    setCleanupExec({ loading: true });
    try {
      const data = await apiPost<CleanupExec>('/api/cleanup/run', { keys: selectedCleanupKeys, confirm: 'CLEANUP_SELECTED_SAFE_ITEMS', scope: cleanupScope() });
      setCleanupExec({ loading: false, data });
    } catch (e) {
      setCleanupExec({ loading: false, error: e instanceof Error ? e.message : String(e) });
    }
  }

  const nav = [
    { id: 'home' as const, title: 'Cockpit', text: 'Ringkasan aman', icon: ShieldCheck },
    { id: 'templates' as const, title: 'Templates', text: 'Standar AI', icon: BookOpen },
    { id: 'import' as const, title: 'Import XLSX', text: 'Upload dan preflight', icon: FileSpreadsheet },
    { id: 'backup' as const, title: 'Backup', text: 'Restore-ready ZIP', icon: Archive },
    { id: 'cleanup' as const, title: 'Cleanup', text: 'Audit aman', icon: Trash2 },
    { id: 'schema' as const, title: 'Schema', text: 'Snapshot Odoo', icon: Database },
    { id: 'repair' as const, title: 'Repair', text: 'Buat patch aman', icon: Wrench },
    { id: 'logs' as const, title: 'Logs', text: 'Dry run & import', icon: Bug },
    { id: 'settings' as const, title: 'Access', text: 'Token admin', icon: KeyRound },
  ];

  const connected = health.data?.ok;

  return (
    <main className="app-shell">
      <div className="topbar">
        <div className="brand">
          <div className="logo"><Sparkles size={22} /></div>
          <div>
            <h1>Lokalmart Studio Importer</h1>
            <p>Safe Import Cockpit — Odoo credentials via Vercel ENV</p>
          </div>
        </div>
        <div className="status-pill"><span className={cls('dot', connected && 'ok', health.error && 'bad')} /> {connected ? 'Odoo connected' : health.error ? 'Connection failed' : 'Ready to test'}</div>
      </div>

      <div className="grid">
        <aside className="panel sidebar">
          {nav.map((n) => {
            const Icon = n.icon;
            return <button key={n.id} className={cls('nav-card', tab === n.id && 'active')} onClick={() => setTab(n.id)}><Icon size={20} /><div>{n.title}<span>{n.text}</span></div></button>;
          })}
        </aside>

        <section className="panel main">
          <AnimatePresence mode="wait">
            {tab === 'home' && (
              <motion.div key="home" initial={{ opacity: 0, x: 24 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -24 }}>
                <div className="hero">
                  <span className="badge safe">mandor semut data</span>
                  <h2>Importer yang tidak asal upload.</h2>
                  <p>File XLSX dibaca, dicocokkan dengan schema Odoo nyata, diberi preflight, bisa dibuat patch aman, lalu baru dry-run atau import live.</p>
                  <div className="cards">
                    <div className="metric"><strong>{analysis.data?.totals.sheets ?? 0}</strong><span>sheet terbaca</span></div>
                    <div className="metric"><strong>{preflight.data?.errors ?? 0}</strong><span>error preflight</span></div>
                    <div className="metric"><strong>{importResult.data?.processed ?? 0}</strong><span>row diproses</span></div>
                  </div>
                </div>
                <div className="screen">
                  <div className="cards">
                    <div className="box"><h3>Target Odoo</h3><p style={{ color: 'var(--muted)', lineHeight: 1.6 }}>{config?.target ? `${config.target.db} · ${config.target.url_host}` : config?.error || 'Memuat config...'}</p><button className="btn secondary" onClick={runHealth}>{health.loading ? 'Testing...' : 'Tes Koneksi'}</button></div>
                    <div className="box"><h3>Template Resmi</h3><p style={{ color: 'var(--muted)' }}>Download standar XLSX untuk semua AI.</p><button className="btn" onClick={() => setTab('templates')}>Buka Templates</button></div>
                    <div className="box"><h3>Backup Center</h3><p style={{ color: 'var(--muted)' }}>Export project, product, partner, knowledge sebagai ZIP restore-ready.</p><button className="btn" onClick={() => { setTab('backup'); loadRecipes(); }}>Buka Backup</button></div>
                    <div className="box"><h3>Audit & Cleanup</h3><p style={{ color: 'var(--muted)' }}>Scan model, field, external ID, dan access rule kotor tanpa delete brutal.</p><button className="btn secondary" onClick={() => setTab('cleanup')}>Buka Cleanup</button></div>
                    <div className="box"><h3>Upload Cepat</h3><p style={{ color: 'var(--muted)' }}>Mulai dari file XLSX Lokalmart.</p><button className="btn" onClick={() => setTab('import')}>Buka Import</button></div>
                    <div className="box"><h3>Schema Snapshot</h3><p style={{ color: 'var(--muted)' }}>Baca model, field, dan external ID.</p><button className="btn secondary" onClick={() => { setTab('schema'); runSchema(); }}>Scan Schema</button></div>
                  </div>
                </div>
              </motion.div>
            )}

            {tab === 'templates' && (
              <motion.div key="templates" initial={{ opacity: 0, x: 24 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -24 }}>
                <div className="hero">
                  <span className="badge safe">ai contract</span>
                  <h2>Template Center Lokalmart</h2>
                  <p>Standar statis yang harus diikuti semua AI saat membuat XLSX import. Download template, baca kontraknya, lalu gunakan sebagai acuan sebelum upload ke importer.</p>
                </div>
                <div className="screen">
                  <div className="cards">
                    <div className="box template-card">
                      <FileSpreadsheet size={30} color="var(--green)" />
                      <h3>Standard Import Template</h3>
                      <p>Workbook utama berisi produk + foto, vendor, project, milestone, task/subtask, stage, dan knowledge article.</p>
                      <a className="btn link-btn" href="/templates/lokalmart_standard_import_template.xlsx" download><Download size={16} /> Download XLSX</a>
                    </div>
                    <div className="box template-card">
                      <FileText size={30} color="var(--blue)" />
                      <h3>AI Template Contract</h3>
                      <p>Instruksi markdown untuk ChatGPT/AI lain: aturan kolom, relasi, external ID, foto produk, dan larangan delete.</p>
                      <a className="btn secondary link-btn" href="/templates/lokalmart_ai_template_contract.md" download><Download size={16} /> Download MD</a>
                    </div>
                    <div className="box template-card">
                      <Database size={30} color="var(--yellow)" />
                      <h3>Template Manifest</h3>
                      <p>Daftar sheet, model, dependency, dan path file agar web app/AI bisa membaca standar secara mesin.</p>
                      <a className="btn secondary link-btn" href="/templates/lokalmart_template_manifest.json" download><Download size={16} /> Download JSON</a>
                    </div>
                    <div className="box template-card">
                      <Archive size={30} color="var(--green)" />
                      <h3>Backup Recipes</h3>
                      <p>Manifest recipe backup agar AI tahu model apa saja yang masuk bundle project, product, partner, dan knowledge.</p>
                      <a className="btn secondary link-btn" href="/templates/lokalmart_backup_recipes.json" download><Download size={16} /> Download JSON</a>
                    </div>
                    <div className="box template-card">
                      <Trash2 size={30} color="var(--red)" />
                      <h3>Cleanup Safety Contract</h3>
                      <p>Aturan audit & cleanup agar AI tidak menyarankan delete brutal pada model, fields, dan access rule Odoo.</p>
                      <a className="btn secondary link-btn" href="/templates/lokalmart_cleanup_safety_contract.md" download><Download size={16} /> Download MD</a>
                    </div>
                  </div>

                  <div className="box" style={{ marginTop: 14 }}>
                    <h3>Aturan singkat untuk AI</h3>
                    <div className="list">
                      <div className="item"><span>Identitas record</span><b>_external_id wajib untuk upsert</b></div>
                      <div className="item"><span>Model target</span><b>_model tetap diisi walau nama sheet sama</b></div>
                      <div className="item"><span>Many2one</span><b>field_name_external_id</b></div>
                      <div className="item"><span>Many2many</span><b>field_name_external_ids</b></div>
                      <div className="item"><span>Foto produk</span><b>image_1920_base64</b></div>
                      <div className="item"><span>Task bertingkat</span><b>parent_id_external_id</b></div>
                      <div className="item"><span>Larangan</span><b>delete fisik tidak boleh</b></div>
                    </div>
                  </div>
                </div>
              </motion.div>
            )}

            {tab === 'import' && (
              <motion.div key="import" initial={{ opacity: 0, x: 24 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -24 }}>
                <div className="hero">
                  <span className="badge">step 1</span>
                  <h2>Import XLSX Aman</h2>
                  <p>Upload file, baca struktur workbook, preflight, repair, dry-run, lalu live import hanya setelah siap.</p>
                </div>
                <div className="import-flow">
                  <div>
                    <label className="dropzone">
                      <input type="file" accept=".xlsx,.xls" onChange={(e) => e.target.files?.[0] && analyzeFile(e.target.files[0])} />
                      <div>
                        <UploadCloud size={42} color="var(--green)" />
                        <h3>{fileName || 'Drop / pilih file XLSX'}</h3>
                        <p>{analysis.loading ? 'Membaca workbook...' : 'File diproses di server, kredensial Odoo tetap di ENV.'}</p>
                      </div>
                    </label>
                    <div className="actions">
                      <button className="btn secondary" onClick={runPreflightClick} disabled={!base64 || preflight.loading}>{preflight.loading ? 'Preflight...' : 'Jalankan Preflight'}</button>
                      <button className="btn secondary" onClick={runRepairClick} disabled={!base64 || repair.loading}>{repair.loading ? 'Repair...' : 'Auto Repair'}</button>
                      <button className="btn warn" onClick={() => runImportClick(true)} disabled={!base64 || importResult.loading}>Dry Run</button>
                      <button className="btn danger" onClick={() => runImportClick(false)} disabled={!base64 || importResult.loading || preflight.data?.status === 'blocked'}>Live Import</button>
                    </div>
                    {analysis.error && <p style={{ color: 'var(--red)' }}>{analysis.error}</p>}
                    {preflight.error && <p style={{ color: 'var(--red)' }}>{preflight.error}</p>}
                  </div>

                  <div className="box">
                    <h3>Ringkasan File</h3>
                    {!analysis.data && <p style={{ color: 'var(--muted)' }}>Belum ada file.</p>}
                    {analysis.data && <div className="list">
                      <div className="item"><span>Sheets</span><b>{analysis.data.totals.sheets}</b></div>
                      <div className="item"><span>Rows</span><b>{analysis.data.totals.rows}</b></div>
                      <div className="item"><span>Models</span><b>{analysis.data.totals.models}</b></div>
                      {analysis.data.sheets.slice(0, 8).map((s) => <div className="item" key={s.name}><span>{s.name}</span><b>{s.rows}</b></div>)}
                    </div>}
                  </div>
                </div>

                <div className="screen" style={{ paddingTop: 0 }}>
                  <div className="box">
                    <h3>Preflight Result {preflight.data && <span className={cls('badge', preflight.data.status)}>{preflight.data.status}</span>}</h3>
                    {!preflight.data && !preflight.loading && <p style={{ color: 'var(--muted)' }}>Jalankan preflight untuk melihat blocker, warning, dan saran repair.</p>}
                    {preflight.loading && <p style={{ color: 'var(--muted)' }}><Loader2 size={14} className="spin" /> Memeriksa schema dan workbook...</p>}
                    {preflight.data && <>
                      <div className="cards">
                        <div className="metric"><strong>{preflight.data.rows_checked}</strong><span>rows checked</span></div>
                        <div className="metric"><strong>{preflight.data.errors}</strong><span>errors</span></div>
                        <div className="metric"><strong>{preflight.data.warnings}</strong><span>warnings</span></div>
                      </div>
                      <div className="issue-list" style={{ marginTop: 14 }}>
                        {preflight.data.issues.slice(0, 60).map((issue, i) => <div className={cls('issue', issue.level)} key={i}><h4>{issue.level.toUpperCase()} · {issue.sheet || '-'} {issue.row ? `row ${issue.row}` : ''} {issue.field ? `· ${issue.field}` : ''}</h4><p>{issue.message}</p>{issue.suggestion && <p><b>Saran:</b> {issue.suggestion}</p>}</div>)}
                      </div>
                    </>}
                  </div>
                </div>
              </motion.div>
            )}

            {tab === 'backup' && (
              <motion.div key="backup" initial={{ opacity: 0, x: 24 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -24 }}>
                <div className="hero">
                  <span className="badge safe">backup center</span>
                  <h2>Backup restore-ready, bukan arsip mati.</h2>
                  <p>Pilih recipe, preview record yang akan diambil dari Odoo, lalu download ZIP berisi importable XLSX, raw JSON, external ID map, schema snapshot, dan restore plan.</p>
                </div>
                <div className="screen">
                  <div className="box">
                    <h3>Pilih Backup Recipe</h3>
                    <div className="field"><label>Recipe</label><select value={backupRecipeId} onChange={(e) => { setBackupRecipeId(e.target.value); setBackupPreview({ loading: false }); setBackupRun({ loading: false }); }}>{(recipes.data || []).map((r) => <option key={r.id} value={r.id}>{r.title}</option>)}</select></div>
                    <div className="field"><label>Batas record per model</label><input type="number" min={1} max={2000} value={backupLimit} onChange={(e) => setBackupLimit(Number(e.target.value || 100))} /></div>
                    {recipes.error && <p style={{ color: 'var(--red)' }}>{recipes.error}</p>}
                    <div className="list" style={{ marginTop: 12 }}>
                      {(recipes.data || []).filter((r) => r.id === backupRecipeId).map((r) => <div className="item" key={r.id}><span>{r.description}</span><b>{r.models.length} model</b></div>)}
                    </div>
                    <div className="actions"><button className="btn secondary" onClick={loadRecipes}>Refresh Recipes</button><button className="btn" onClick={runBackupPreview} disabled={backupPreview.loading}>{backupPreview.loading ? 'Preview...' : 'Preview Backup'}</button><button className="btn warn" onClick={runBackupNow} disabled={backupRun.loading}>{backupRun.loading ? 'Membuat backup...' : 'Run Backup ZIP'}</button></div>
                  </div>

                  {backupPreview.error && <p style={{ color: 'var(--red)' }}>{backupPreview.error}</p>}
                  {backupPreview.data && <div className="box" style={{ marginTop: 14 }}>
                    <h3>Preview</h3>
                    <div className="cards"><div className="metric"><strong>{backupPreview.data.total}</strong><span>total records</span></div><div className="metric"><strong>{backupPreview.data.limit}</strong><span>limit/model</span></div><div className="metric"><strong>{backupPreview.data.target?.db}</strong><span>database</span></div></div>
                    <div className="list" style={{ marginTop: 14 }}>{Object.entries(backupPreview.data.counts).map(([model, count]) => <div className="item" key={model}><span>{model}</span><b>{count} rows</b></div>)}</div>
                    <div className="issue-list" style={{ marginTop: 14 }}>{backupPreview.data.warnings.map((w, i) => <div className="issue warn" key={i}><h4>CATATAN</h4><p>{w}</p></div>)}</div>
                  </div>}

                  {backupRun.error && <p style={{ color: 'var(--red)' }}>{backupRun.error}</p>}
                  {backupRun.data ? <div className="box" style={{ marginTop: 14 }}>
                    <h3>Backup Siap</h3>
                    <div className="cards"><div className="metric"><strong>{Object.values(backupRun.data.summary.counts).reduce((a, b) => a + b, 0)}</strong><span>records</span></div><div className="metric"><strong>{backupRun.data.summary.sheets.length}</strong><span>sheets XLSX</span></div><div className="metric"><strong>{backupRun.data.summary.generatedExternalIds}</strong><span>generated xml ids</span></div></div>
                    <p style={{ color: 'var(--muted)', lineHeight: 1.6 }}>ZIP berisi <span className="code">data/lokalmart_backup_importable.xlsx</span>, <span className="code">raw_records.json</span>, <span className="code">external_id_map.json</span>, <span className="code">schema_snapshot.json</span>, dan <span className="code">restore_plan.md</span>.</p>
                    <div className="actions"><button className="btn" onClick={() => downloadBase64File(backupRun.data!.zipBase64, backupRun.data!.filename, 'application/zip')}>Download Backup ZIP</button><button className="btn secondary" onClick={() => downloadBase64Xlsx(backupRun.data!.xlsxBase64, backupRun.data!.xlsxFilename)}>Download Importable XLSX</button><button className="btn secondary" onClick={() => { setBase64(backupRun.data!.xlsxBase64); setFileName(backupRun.data!.xlsxFilename); setTab('import'); }}>Pakai XLSX Ini untuk Restore</button><button className="btn secondary" onClick={() => downloadJson(backupRun.data!.summary, 'backup_summary.json')}>Download Summary</button></div>
                    {backupRun.data.summary.warnings.length > 0 && <div className="issue-list" style={{ marginTop: 14 }}>{backupRun.data.summary.warnings.map((w, i) => <div className="issue warn" key={i}><h4>WARNING</h4><p>{w}</p></div>)}</div>}
                  </div> : !backupPreview.data && <EmptyState icon={Archive} title="Belum ada backup" text="Pilih recipe lalu preview. Setelah itu buat ZIP restore-ready." />}
                </div>
              </motion.div>
            )}


            {tab === 'cleanup' && (
              <motion.div key="cleanup" initial={{ opacity: 0, x: 24 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -24 }}>
                <div className="hero">
                  <span className="badge conditional">audit & safe cleanup</span>
                  <h2>Cleanup tanpa delete brutal.</h2>
                  <p>Scan model custom, field custom, external ID, dan access rule. Hanya item SAFE_DELETE / SAFE_ARCHIVE yang bisa dieksekusi. Sisanya jadi laporan audit.</p>
                </div>
                <div className="screen">
                  <div className="box">
                    <h3>Audit Scope</h3>
                    <div className="cards">
                      <div className="field"><label>Mode scan</label><select value={cleanupMode} onChange={(e) => { setCleanupMode(e.target.value as CleanupMode); setCleanupScan({ loading: false }); setCleanupExec({ loading: false }); setSelectedCleanupKeys([]); }}><option value="all">All safe audits</option><option value="models">Custom Models x_*</option><option value="fields">Custom Fields x_*</option><option value="external_ids">External ID Lokalmart/Studio</option><option value="access">Access Rules custom model</option></select></div>
                      <div className="field"><label>Batas item per kategori</label><input type="number" min={10} max={500} value={cleanupLimit} onChange={(e) => setCleanupLimit(Number(e.target.value || 120))} /></div>
                    </div>
                    <div className="actions"><button className="btn" onClick={runCleanupScan} disabled={cleanupScan.loading}>{cleanupScan.loading ? 'Scanning...' : 'Scan Cleanup Candidates'}</button><button className="btn secondary" onClick={runCleanupBackup} disabled={cleanupBackup.loading}>{cleanupBackup.loading ? 'Membuat backup...' : 'Backup Audit Report'}</button>{cleanupScan.data && <button className="btn secondary" onClick={selectSafeCleanupItems}>Select SAFE Items</button>}{cleanupScan.data && <button className="btn secondary" onClick={() => downloadJson(cleanupScan.data, `cleanup_scan_${cleanupScan.data!.target?.db || 'odoo'}.json`)}>Download Scan JSON</button>}</div>
                    <p style={{ color: 'var(--muted)', lineHeight: 1.6 }}>Default scan tidak memasukkan core model. Untuk Odoo Lokalmart, cleanup otomatis hanya menyentuh custom/manual item yang terdeteksi aman.</p>
                  </div>

                  {cleanupScan.error && <p style={{ color: 'var(--red)' }}>{cleanupScan.error}</p>}
                  {cleanupBackup.error && <p style={{ color: 'var(--red)' }}>{cleanupBackup.error}</p>}
                  {cleanupBackup.data && <div className="box" style={{ marginTop: 14 }}>
                    <h3>Backup Audit Siap</h3>
                    <div className="cards"><div className="metric"><strong>{cleanupBackup.data.summary.SAFE_DELETE}</strong><span>safe delete</span></div><div className="metric"><strong>{cleanupBackup.data.summary.SAFE_ARCHIVE}</strong><span>safe archive</span></div><div className="metric"><strong>{cleanupBackup.data.summary.BLOCKED}</strong><span>blocked</span></div></div>
                    <div className="actions"><button className="btn" onClick={() => downloadBase64File(cleanupBackup.data!.zipBase64, cleanupBackup.data!.filename, 'application/zip')}>Download Cleanup Backup ZIP</button><button className="btn secondary" onClick={() => downloadBase64Xlsx(cleanupBackup.data!.reportBase64, cleanupBackup.data!.reportFilename)}>Download Audit XLSX</button></div>
                  </div>}

                  {cleanupScan.data ? <div className="box" style={{ marginTop: 14 }}>
                    <h3>Cleanup Findings</h3>
                    <div className="cards"><div className="metric"><strong>{cleanupScan.data.summary.SAFE_DELETE}</strong><span>safe delete</span></div><div className="metric"><strong>{cleanupScan.data.summary.SAFE_ARCHIVE}</strong><span>safe archive</span></div><div className="metric"><strong>{cleanupScan.data.summary.REVIEW_REQUIRED}</strong><span>review</span></div><div className="metric"><strong>{cleanupScan.data.summary.BLOCKED}</strong><span>blocked</span></div><div className="metric"><strong>{cleanupScan.data.summary.CORE_PROTECTED}</strong><span>protected</span></div></div>
                    <div className="actions"><button className="btn warn" onClick={runCleanupDryRun} disabled={!selectedCleanupKeys.length || cleanupExec.loading}>Dry Run Selected ({selectedCleanupKeys.length})</button><button className="btn danger" onClick={runCleanupNow} disabled={!selectedCleanupKeys.length || cleanupExec.loading}>Run SAFE Cleanup</button></div>
                    <div className="issue-list" style={{ marginTop: 14 }}>{cleanupScan.data.warnings.map((w, i) => <div className="issue warn" key={i}><h4>SAFETY RULE</h4><p>{w}</p></div>)}</div>
                    <div className="list" style={{ marginTop: 14 }}>{cleanupScan.data.items.slice(0, 250).map((item) => {
                      const canSelect = item.status === 'SAFE_DELETE' || item.status === 'SAFE_ARCHIVE';
                      return <label className="item" key={item.key} style={{ alignItems: 'flex-start', gap: 10, opacity: canSelect ? 1 : 0.72 }}><input type="checkbox" checked={selectedCleanupKeys.includes(item.key)} disabled={!canSelect} onChange={() => toggleCleanupKey(item.key)} style={{ marginTop: 4 }} /><span><b>{item.status}</b> · {item.type} · {item.model || item.externalId || item.name || '-'}{item.fieldName ? ` · ${item.fieldName}` : ''}<br /><small style={{ color: 'var(--muted)' }}>{item.reasons.slice(0, 3).join(' ')}</small></span><b>{item.suggestedAction}</b></label>;
                    })}</div>
                  </div> : <EmptyState icon={Trash2} title="Belum ada audit cleanup" text="Jalankan scan dulu. Setelah itu backup kandidat, dry-run selected, baru cleanup item yang aman." />}

                  {cleanupExec.error && <p style={{ color: 'var(--red)' }}>{cleanupExec.error}</p>}
                  {cleanupExec.data && <div className="box" style={{ marginTop: 14 }}>
                    <h3>{cleanupExec.data.dryRun ? 'Dry Run Cleanup' : 'Cleanup Execution'}</h3>
                    <div className="cards"><div className="metric"><strong>{cleanupExec.data.executable ?? cleanupExec.data.processed ?? 0}</strong><span>{cleanupExec.data.dryRun ? 'executable' : 'processed'}</span></div><div className="metric"><strong>{cleanupExec.data.blocked ?? cleanupExec.data.skipped ?? 0}</strong><span>{cleanupExec.data.dryRun ? 'blocked' : 'skipped'}</span></div><div className="metric"><strong>{cleanupExec.data.errors ?? 0}</strong><span>errors</span></div></div>
                    <div className="log-list" style={{ marginTop: 14 }}>{cleanupExec.data.logs.map((log, i) => <div className={cls('log', log.level)} key={i}><h4>{log.level.toUpperCase()} · {log.key}</h4><p>{log.message}</p></div>)}</div>
                    <div className="actions"><button className="btn secondary" onClick={() => downloadJson(cleanupExec.data!, cleanupExec.data!.dryRun ? 'cleanup_dry_run_report.json' : 'cleanup_execution_report.json')}>Download Cleanup Report</button></div>
                  </div>}
                </div>
              </motion.div>
            )}

            {tab === 'schema' && (
              <motion.div key="schema" initial={{ opacity: 0, x: 24 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -24 }}>
                <div className="hero"><span className="badge">database eye</span><h2>Schema Snapshot</h2><p>Baca model core penting + custom x_* dari Odoo. Ini yang dipakai preflight agar importer tidak buta.</p></div>
                <div className="screen">
                  <div className="actions"><button className="btn" onClick={runSchema} disabled={schema.loading}>{schema.loading ? 'Scanning...' : 'Scan Custom + Core'}</button>{schema.data && <button className="btn secondary" onClick={() => downloadJson(schema.data, `schema_snapshot_${schema.data.target?.db || 'odoo'}.json`)}>Download JSON</button>}</div>
                  {schema.error && <p style={{ color: 'var(--red)' }}>{schema.error}</p>}
                  {schema.data ? <div className="cards"><div className="metric"><strong>{Object.keys(schema.data.models || {}).length}</strong><span>models</span></div><div className="metric"><strong>{schema.data.externalIds?.length || 0}</strong><span>external ids</span></div><div className="metric"><strong>{schema.data.target?.db}</strong><span>database</span></div></div> : <EmptyState icon={Database} title="Belum ada snapshot" text="Tekan scan untuk membaca schema Odoo sekarang." />}
                  {schema.data && <div className="box" style={{ marginTop: 14 }}><h3>Models</h3><div className="list">{Object.keys(schema.data.models || {}).slice(0, 80).map((m) => <div className="item" key={m}><span>{m}</span><b>{Object.keys(schema.data.models[m].fields || {}).length} fields</b></div>)}</div></div>}
                </div>
              </motion.div>
            )}

            {tab === 'repair' && (
              <motion.div key="repair" initial={{ opacity: 0, x: 24 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -24 }}>
                <div className="hero"><span className="badge conditional">safe patch</span><h2>Auto Repair XLSX</h2><p>Menghapus kolom unknown/readonly dan menambahkan manifest patch. Cocok untuk file yang kena warning sebelum import.</p></div>
                <div className="screen">
                  <div className="actions"><button className="btn" onClick={runRepairClick} disabled={!base64 || repair.loading}>{repair.loading ? 'Membuat patch...' : 'Buat Patch Aman'}</button>{repair.data && <button className="btn secondary" onClick={() => downloadBase64Xlsx(repair.data!.base64, repair.data!.filename)}>Download Patch XLSX</button>}</div>
                  {repair.error && <p style={{ color: 'var(--red)' }}>{repair.error}</p>}
                  {repair.data ? <><div className="cards"><div className="metric"><strong>{repair.data.changes}</strong><span>perubahan</span></div><div className="metric"><strong>{repair.data.filename}</strong><span>file patch aktif</span></div><div className="metric"><strong>safe</strong><span>mode</span></div></div><p style={{ color: 'var(--green)', lineHeight: 1.6 }}>Patch ini sekarang otomatis menjadi workbook aktif. Dry-run berikutnya memakai file patch, bukan file lama.</p><div className="issue-list" style={{ marginTop: 14 }}>{repair.data.issues.slice(0, 80).map((issue, i) => <div className={cls('issue', issue.level)} key={i}><h4>{issue.sheet || '-'} {issue.row ? `row ${issue.row}` : ''} {issue.field ? `· ${issue.field}` : ''}</h4><p>{issue.message}</p></div>)}</div></> : <EmptyState icon={Wrench} title="Belum ada patch" text="Upload XLSX dulu, lalu tekan Auto Repair untuk membuat file aman." />}
                </div>
              </motion.div>
            )}

            {tab === 'logs' && (
              <motion.div key="logs" initial={{ opacity: 0, x: 24 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -24 }}>
                <div className="hero"><span className="badge">audit trail</span><h2>Logs & Import Report</h2><p>Hasil dry-run dan live import tampil di sini. Download JSON untuk ditempelkan ke ChatGPT saat debugging.</p></div>
                <div className="screen">
                  <div className="actions"><button className="btn warn" onClick={() => runImportClick(true)} disabled={!base64 || importResult.loading}>Dry Run</button><button className="btn danger" onClick={() => runImportClick(false)} disabled={!base64 || importResult.loading || preflight.data?.status === 'blocked'}>Live Import</button>{importResult.data && <button className="btn secondary" onClick={() => downloadJson(importResult.data, `import_report_${fileName || 'lokalmart'}.json`)}>Download Report</button>}</div>
                  {importResult.error && <p style={{ color: 'var(--red)' }}>{importResult.error}</p>}
                  {importResult.data ? <><div className="cards"><div className="metric"><strong>{importResult.data.processed}</strong><span>processed</span></div><div className="metric"><strong>{importResult.data.created}/{importResult.data.updated}</strong><span>created/updated</span></div><div className="metric"><strong>{importResult.data.errors}</strong><span>errors</span></div></div><div className="log-list" style={{ marginTop: 14 }}>{importResult.data.logs.slice(0, 250).map((log, i) => <div className={cls('log', log.level)} key={i}><h4>{log.level.toUpperCase()} · {log.sheet} {log.row ? `row ${log.row}` : ''} {log.model ? `· ${log.model}` : ''}</h4><p>{log.message}</p>{log.external_id && <p className="code">{log.external_id}</p>}</div>)}</div></> : <EmptyState icon={Archive} title="Belum ada log" text="Jalankan dry-run dulu untuk melihat apa yang akan dibuat atau diupdate." />}
                  {history.length > 0 && <div className="box" style={{ marginTop: 14 }}><h3>Riwayat lokal browser</h3><div className="list">{history.slice(0, 8).map((h) => <div className="item" key={h.id}><span>{new Date(h.at).toLocaleString()} · {h.filename}</span><b>{h.result.dryRun ? 'dry-run' : 'live'} · {h.result.errors} error</b></div>)}</div><div className="actions"><button className="btn secondary" onClick={() => downloadJson(history, 'lokalmart_import_history.json')}>Download History</button><button className="btn secondary" onClick={() => { localStorage.removeItem('lokalmart_importer_history'); setHistory([]); }}>Hapus History</button></div></div>}
                </div>
              </motion.div>
            )}

            {tab === 'settings' && (
              <motion.div key="settings" initial={{ opacity: 0, x: 24 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -24 }}>
                <div className="hero"><span className="badge">server env</span><h2>Access & Target</h2><p>Kredensial Odoo berada di Vercel Environment Variables. Browser hanya menyimpan access key untuk memanggil API importer.</p></div>
                <div className="screen">
                  <div className="box">
                    <h3>Importer Admin Token</h3>
                    <p style={{ color: 'var(--muted)', lineHeight: 1.6 }}>Status token env: {config?.requiresToken ? 'aktif' : 'belum aktif'}. Untuk deployment publik, aktifkan <span className="code">IMPORTER_ADMIN_TOKEN</span>.</p>
                    <div className="field"><label>Access key</label><input type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="Masukkan IMPORTER_ADMIN_TOKEN" /></div>
                    <div className="actions"><button className="btn" onClick={runHealth}>{health.loading ? 'Testing...' : 'Tes Koneksi Odoo'}</button><button className="btn secondary" onClick={() => { localStorage.removeItem('lokalmart_importer_token'); setToken(''); }}>Hapus Token Browser</button></div>
                  </div>
                  <div className="box" style={{ marginTop: 14 }}>
                    <h3>Target dari ENV</h3>
                    <div className="list">
                      <div className="item"><span>Host</span><b>{config?.target?.url_host || '-'}</b></div>
                      <div className="item"><span>Database</span><b>{config?.target?.db || '-'}</b></div>
                      <div className="item"><span>Username</span><b>{config?.target?.username || '-'}</b></div>
                    </div>
                    {health.error && <p style={{ color: 'var(--red)' }}>{health.error}</p>}
                    {health.data && <p style={{ color: 'var(--green)' }}>Koneksi berhasil. UID Odoo: {health.data.uid}</p>}
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
          <div className="footer-note">Live import menulis langsung ke Odoo melalui XML-RPC. Biasakan dry-run dan download report sebelum import besar.</div>
        </section>
      </div>
    </main>
  );
}
