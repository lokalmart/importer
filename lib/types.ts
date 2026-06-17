export type IssueLevel = 'error' | 'warn' | 'info';

export type ImportIssue = {
  level: IssueLevel;
  sheet?: string;
  row?: number;
  model?: string;
  field?: string;
  message: string;
  suggestion?: string;
  code?: string;
};

export type WorkbookRow = Record<string, unknown>;

export type SheetPreview = {
  name: string;
  inferredModel: string | null;
  rows: number;
  headers: string[];
  sample: WorkbookRow[];
};

export type WorkbookAnalysis = {
  filename?: string;
  sheets: SheetPreview[];
  totals: {
    sheets: number;
    rows: number;
    models: number;
  };
  models: string[];
};

export type FieldMeta = {
  name: string;
  string?: string;
  type?: string;
  relation?: string;
  required?: boolean;
  readonly?: boolean;
  store?: boolean;
  selection?: unknown;
};

export type ModelSchema = {
  model: string;
  name?: string;
  state?: string;
  fields: Record<string, FieldMeta>;
};

export type SchemaSnapshot = {
  ok: boolean;
  exported_at: string;
  target: {
    url_host: string;
    db: string;
    username: string;
  };
  models: Record<string, ModelSchema>;
  modelList: Array<{ id?: number; model: string; name?: string; state?: string; modules?: string }>;
  externalIds?: Array<{ module: string; name: string; model: string; res_id: number; complete_name: string }>;
};

export type PreflightResult = {
  ok: boolean;
  status: 'safe' | 'conditional' | 'blocked' | 'needs_schema';
  rows_checked: number;
  errors: number;
  warnings: number;
  issues: ImportIssue[];
  analysis: WorkbookAnalysis;
};

export type ImportLogEntry = {
  level: IssueLevel | 'success';
  sheet: string;
  row?: number;
  model?: string;
  external_id?: string;
  action?: string;
  message: string;
};

export type ImportResult = {
  ok: boolean;
  dryRun: boolean;
  processed: number;
  created: number;
  updated: number;
  archived: number;
  skipped: number;
  errors: number;
  logs: ImportLogEntry[];
};
