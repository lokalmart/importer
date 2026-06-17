'use client';

import { useEffect, useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Archive, Bug, CheckCircle2, Database, FileSpreadsheet, KeyRound, Loader2, ShieldCheck, Sparkles, UploadCloud, Wrench } from 'lucide-react';

type Tab = 'home' | 'import' | 'schema' | 'repair' | 'logs' | 'settings';

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

  const headers = useMemo(() => ({ 'Content-Type': 'application/json', 'x-importer-token': token }), [token]);

  useEffect(() => {
    const saved = localStorage.getItem('lokalmart_importer_token') || '';
    setToken(saved);
    fetch('/api/config')
      .then((r) => r.json())
      .then(setConfig)
      .catch((e) => setConfig({ ok: false, requiresToken: true, error: String(e) }));
  }, []);

  useEffect(() => {
    if (token) localStorage.setItem('lokalmart_importer_token', token);
  }, [token]);

  async function apiPost<T>(url: string, body: unknown): Promise<T> {
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
    const json = await res.json();
    if (!res.ok || json.ok === false) throw new Error(json.error || 'Request gagal');
    return json as T;
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
      const data = await apiPost<Preflight>('/api/xlsx/preflight', { base64, filename: fileName });
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
      setTab('logs');
    } catch (e) {
      setImportResult({ loading: false, error: e instanceof Error ? e.message : String(e) });
      setTab('logs');
    }
  }

  const nav = [
    { id: 'home' as const, title: 'Cockpit', text: 'Ringkasan aman', icon: ShieldCheck },
    { id: 'import' as const, title: 'Import XLSX', text: 'Upload dan preflight', icon: FileSpreadsheet },
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
                    <div className="box"><h3>Upload Cepat</h3><p style={{ color: 'var(--muted)' }}>Mulai dari file XLSX Lokalmart.</p><button className="btn" onClick={() => setTab('import')}>Buka Import</button></div>
                    <div className="box"><h3>Schema Snapshot</h3><p style={{ color: 'var(--muted)' }}>Baca model, field, dan external ID.</p><button className="btn secondary" onClick={() => { setTab('schema'); runSchema(); }}>Scan Schema</button></div>
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
                  {repair.data ? <><div className="cards"><div className="metric"><strong>{repair.data.changes}</strong><span>perubahan</span></div><div className="metric"><strong>{repair.data.filename}</strong><span>file patch</span></div><div className="metric"><strong>safe</strong><span>mode</span></div></div><div className="issue-list" style={{ marginTop: 14 }}>{repair.data.issues.slice(0, 80).map((issue, i) => <div className={cls('issue', issue.level)} key={i}><h4>{issue.sheet} row {issue.row} · {issue.field}</h4><p>{issue.message}</p></div>)}</div></> : <EmptyState icon={Wrench} title="Belum ada patch" text="Upload XLSX dulu, lalu tekan Auto Repair untuk membuat file aman." />}
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
