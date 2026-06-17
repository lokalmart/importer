import 'server-only';
import JSZip from 'jszip';
import * as XLSX from 'xlsx';
import { createOdooClient, OdooClient } from './odooXmlRpc';
import { buildSchemaSnapshot } from './schemaScanner';
import { workbookToBase64, makeWorkbookFromSheets } from './xlsxWorkbook';
import { WorkbookRow } from './types';

export type BackupRecipeId =
  | 'backup_project_bundle'
  | 'backup_product_catalog_bundle'
  | 'backup_partner_umkm_bundle'
  | 'backup_knowledge_bundle'
  | 'backup_important_all';

export type BackupScope = {
  projectIds?: number[];
  productIds?: number[];
  partnerIds?: number[];
  knowledgeIds?: number[];
  limit?: number;
  includeSchema?: boolean;
  includeRawJson?: boolean;
};

export type BackupRecipe = {
  id: BackupRecipeId;
  title: string;
  description: string;
  rootModel?: string;
  models: string[];
  importable: boolean;
};

export type BackupSummary = {
  recipeId: BackupRecipeId;
  recipeTitle: string;
  exportedAt: string;
  target?: { url_host: string; db: string; username: string };
  counts: Record<string, number>;
  sheets: string[];
  generatedExternalIds: number;
  warnings: string[];
};

export type BackupRunResult = {
  ok: boolean;
  filename: string;
  zipBase64: string;
  xlsxFilename: string;
  xlsxBase64: string;
  summary: BackupSummary;
};

export const BACKUP_RECIPES: BackupRecipe[] = [
  {
    id: 'backup_project_bundle',
    title: 'Project Bundle',
    description: 'Project, milestone, stage, task, subtask, tags, dan knowledge terkait bila bisa ditemukan.',
    rootModel: 'project.project',
    models: ['project.project', 'project.milestone', 'project.task.type', 'project.tags', 'project.task', 'knowledge.article'],
    importable: true,
  },
  {
    id: 'backup_product_catalog_bundle',
    title: 'Product Catalog Bundle',
    description: 'Kategori teknis, kategori eCommerce, produk, vendor, supplier info, harga, barcode, dan foto base64.',
    rootModel: 'product.template',
    models: ['product.category', 'product.public.category', 'res.partner', 'product.template', 'product.supplierinfo'],
    importable: true,
  },
  {
    id: 'backup_partner_umkm_bundle',
    title: 'Partner / UMKM Bundle',
    description: 'Kontak vendor, UMKM, agen, anggota, customer, area, role Lokalmart, dan kategori kontak.',
    rootModel: 'res.partner',
    models: ['res.partner.category', 'res.partner'],
    importable: true,
  },
  {
    id: 'backup_knowledge_bundle',
    title: 'Knowledge Bundle',
    description: 'Artikel knowledge, body HTML, parent-child, icon, permission, dan urutan artikel.',
    rootModel: 'knowledge.article',
    models: ['knowledge.article'],
    importable: true,
  },
  {
    id: 'backup_important_all',
    title: 'Full Important Backup',
    description: 'Gabungan project, product, partner/UMKM, dan knowledge dalam satu restore-ready bundle.',
    models: ['project.project', 'project.milestone', 'project.task.type', 'project.tags', 'project.task', 'product.category', 'product.public.category', 'res.partner.category', 'res.partner', 'product.template', 'product.supplierinfo', 'knowledge.article'],
    importable: true,
  },
];

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 2000;

const FIELD_SETS: Record<string, string[]> = {
  'project.project': ['name', 'active', 'sequence', 'partner_id', 'user_id', 'company_id', 'allow_milestones', 'description', 'label_tasks'],
  'project.milestone': ['name', 'project_id', 'deadline', 'is_reached', 'sequence'],
  'project.task.type': ['name', 'sequence', 'project_ids', 'fold'],
  'project.tags': ['name', 'color'],
  'project.task': ['name', 'active', 'project_id', 'parent_id', 'stage_id', 'milestone_id', 'sequence', 'priority', 'date_deadline', 'description', 'user_ids', 'tag_ids'],
  'product.category': ['name', 'parent_id', 'complete_name', 'property_cost_method', 'property_valuation'],
  'product.public.category': ['name', 'parent_id', 'sequence'],
  'product.template': ['name', 'active', 'default_code', 'barcode', 'categ_id', 'public_categ_ids', 'list_price', 'standard_price', 'sale_ok', 'purchase_ok', 'type', 'detailed_type', 'uom_id', 'uom_po_id', 'description_sale', 'website_description', 'image_1920'],
  'product.supplierinfo': ['partner_id', 'product_tmpl_id', 'min_qty', 'price', 'currency_id', 'delay', 'product_code', 'product_name'],
  'res.partner.category': ['name', 'parent_id', 'color', 'active'],
  'res.partner': ['name', 'active', 'is_company', 'parent_id', 'email', 'phone', 'mobile', 'street', 'street2', 'city', 'zip', 'state_id', 'country_id', 'category_id', 'supplier_rank', 'customer_rank', 'barcode', 'website', 'comment', 'image_1920', 'x_lokal_id', 'x_lokal_role', 'x_lokal_member_type', 'x_lokal_area', 'x_lokal_points', 'x_lm_vendor_type', 'x_lm_area', 'x_lm_koloni_code', 'x_lm_whatsapp', 'x_lm_verified', 'x_lm_is_umkm', 'x_lm_is_driver', 'x_lm_lokal_id', 'x_lm_lokal_code'],
  'knowledge.article': ['name', 'active', 'body', 'icon', 'parent_id', 'sequence', 'internal_permission', 'is_article_item', 'full_width', 'is_locked', 'to_delete'],
};

function safeLimit(scope?: BackupScope) {
  const raw = Number(scope?.limit || DEFAULT_LIMIT);
  if (!Number.isFinite(raw) || raw < 1) return DEFAULT_LIMIT;
  return Math.min(Math.floor(raw), MAX_LIMIT);
}

function dateSlug() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

function sanitizeName(value: string) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80) || 'record';
}

function sheetName(model: string) {
  return model.slice(0, 31);
}

function modelPrefix(model: string) {
  return model.replace(/[^a-zA-Z0-9_]+/g, '_');
}

function generatedXmlId(model: string, id: number, displayName?: unknown) {
  const readable = sanitizeName(String(displayName || ''));
  return `lokalmart_backup.${modelPrefix(model)}_${id}_${readable}`.slice(0, 180);
}

function relationId(value: unknown): number | null {
  if (Array.isArray(value) && typeof value[0] === 'number') return value[0];
  if (typeof value === 'number') return value;
  return null;
}

function relationIds(value: unknown): number[] {
  if (Array.isArray(value)) return value.filter((x) => typeof x === 'number') as number[];
  return [];
}

function hasValue(value: unknown) {
  return value !== undefined && value !== null && String(value).trim() !== '';
}

async function getAvailableFields(client: OdooClient, model: string, desired: string[]) {
  try {
    const fields = await client.fieldsGet(model);
    return desired.filter((f) => Boolean(fields[f]));
  } catch {
    return [];
  }
}

async function searchReadSafe(client: OdooClient, model: string, domain: unknown[], fields: string[], limit: number): Promise<Array<Record<string, any>>> {
  const available = await getAvailableFields(client, model, fields);
  const finalFields = Array.from(new Set(['id', 'display_name', ...available]));
  try {
    return await client.searchRead<Record<string, any>>(model, domain, finalFields, limit);
  } catch {
    return [];
  }
}

function uniqueNumbers(values: Array<number | null | undefined>) {
  return Array.from(new Set(values.filter((x): x is number => typeof x === 'number' && Number.isFinite(x) && x > 0)));
}

async function getExternalIdMap(client: OdooClient, modelToIds: Map<string, Set<number>>) {
  const map = new Map<string, string>();
  for (const [model, idsSet] of modelToIds.entries()) {
    const ids = Array.from(idsSet).filter(Boolean);
    if (!ids.length) continue;
    const chunks: number[][] = [];
    for (let i = 0; i < ids.length; i += 500) chunks.push(ids.slice(i, i + 500));
    for (const chunk of chunks) {
      try {
        const found = await client.searchRead<{ module: string; name: string; model: string; res_id: number }>(
          'ir.model.data',
          [['model', '=', model], ['res_id', 'in', chunk]],
          ['module', 'name', 'model', 'res_id'],
          1000
        );
        for (const row of found) {
          const key = `${row.model}:${row.res_id}`;
          if (!map.has(key)) map.set(key, `${row.module}.${row.name}`);
        }
      } catch {
        // Keep generated fallback IDs below.
      }
    }
  }
  return map;
}

function collectRecordIds(modelToIds: Map<string, Set<number>>, model: string, records: Array<Record<string, any>>) {
  if (!modelToIds.has(model)) modelToIds.set(model, new Set());
  for (const rec of records) {
    if (typeof rec.id === 'number') modelToIds.get(model)!.add(rec.id);
  }
}

function collectRelationIds(modelToIds: Map<string, Set<number>>, model: string, ids: number[]) {
  if (!modelToIds.has(model)) modelToIds.set(model, new Set());
  for (const id of ids) modelToIds.get(model)!.add(id);
}

function xmlFor(map: Map<string, string>, model: string, id: number | null | undefined, displayName?: unknown, missingCounter?: { value: number }) {
  if (!id) return '';
  const key = `${model}:${id}`;
  const existing = map.get(key);
  if (existing) return existing;
  missingCounter && (missingCounter.value += 1);
  return generatedXmlId(model, id, displayName);
}

async function readProjectBundle(client: OdooClient, scope: BackupScope) {
  const limit = safeLimit(scope);
  const projectDomain = scope.projectIds?.length ? [['id', 'in', scope.projectIds]] : [];
  const projects = await searchReadSafe(client, 'project.project', projectDomain, FIELD_SETS['project.project'], limit);
  const projectIds = projects.map((p) => p.id).filter(Boolean);
  const projectDomainForRelated = projectIds.length ? [['project_id', 'in', projectIds]] : [];
  const milestones = await searchReadSafe(client, 'project.milestone', projectDomainForRelated, FIELD_SETS['project.milestone'], limit);
  const tasks = await searchReadSafe(client, 'project.task', projectDomainForRelated, FIELD_SETS['project.task'], limit);
  const stageIds = uniqueNumbers(tasks.map((t) => relationId(t.stage_id)));
  const tagIds = uniqueNumbers(tasks.flatMap((t) => relationIds(t.tag_ids)));
  const stages = stageIds.length ? await searchReadSafe(client, 'project.task.type', [['id', 'in', stageIds]], FIELD_SETS['project.task.type'], limit) : [];
  const tags = tagIds.length ? await searchReadSafe(client, 'project.tags', [['id', 'in', tagIds]], FIELD_SETS['project.tags'], limit) : [];
  return { 'project.project': projects, 'project.milestone': milestones, 'project.task.type': stages, 'project.tags': tags, 'project.task': tasks };
}

async function readProductBundle(client: OdooClient, scope: BackupScope) {
  const limit = safeLimit(scope);
  const productDomain = scope.productIds?.length ? [['id', 'in', scope.productIds]] : [];
  const products = await searchReadSafe(client, 'product.template', productDomain, FIELD_SETS['product.template'], limit);
  const productIds = products.map((p) => p.id).filter(Boolean);
  const catIds = uniqueNumbers(products.map((p) => relationId(p.categ_id)));
  const publicCatIds = uniqueNumbers(products.flatMap((p) => relationIds(p.public_categ_ids)));
  const categories = catIds.length ? await searchReadSafe(client, 'product.category', [['id', 'in', catIds]], FIELD_SETS['product.category'], limit) : [];
  const publicCategories = publicCatIds.length ? await searchReadSafe(client, 'product.public.category', [['id', 'in', publicCatIds]], FIELD_SETS['product.public.category'], limit) : [];
  const supplierInfo = productIds.length ? await searchReadSafe(client, 'product.supplierinfo', [['product_tmpl_id', 'in', productIds]], FIELD_SETS['product.supplierinfo'], limit) : [];
  const vendorIds = uniqueNumbers(supplierInfo.map((s) => relationId(s.partner_id)));
  const vendors = vendorIds.length ? await searchReadSafe(client, 'res.partner', [['id', 'in', vendorIds]], FIELD_SETS['res.partner'], limit) : [];
  return { 'product.category': categories, 'product.public.category': publicCategories, 'res.partner': vendors, 'product.template': products, 'product.supplierinfo': supplierInfo };
}

async function readPartnerBundle(client: OdooClient, scope: BackupScope) {
  const limit = safeLimit(scope);
  const domain = scope.partnerIds?.length
    ? [['id', 'in', scope.partnerIds]]
    : ['|', '|', '|', ['supplier_rank', '>', 0], ['customer_rank', '>', 0], ['x_lm_is_umkm', '=', true], ['x_lokal_id', '!=', false]];
  const partners = await searchReadSafe(client, 'res.partner', domain, FIELD_SETS['res.partner'], limit);
  const categoryIds = uniqueNumbers(partners.flatMap((p) => relationIds(p.category_id)));
  const categories = categoryIds.length ? await searchReadSafe(client, 'res.partner.category', [['id', 'in', categoryIds]], FIELD_SETS['res.partner.category'], limit) : [];
  return { 'res.partner.category': categories, 'res.partner': partners };
}

async function readKnowledgeBundle(client: OdooClient, scope: BackupScope) {
  const limit = safeLimit(scope);
  const domain = scope.knowledgeIds?.length ? [['id', 'in', scope.knowledgeIds]] : [];
  const articles = await searchReadSafe(client, 'knowledge.article', domain, FIELD_SETS['knowledge.article'], limit);
  return { 'knowledge.article': articles };
}

async function readRecipeRecords(client: OdooClient, recipeId: BackupRecipeId, scope: BackupScope): Promise<Record<string, Array<Record<string, any>>>> {
  if (recipeId === 'backup_project_bundle') return readProjectBundle(client, scope);
  if (recipeId === 'backup_product_catalog_bundle') return readProductBundle(client, scope);
  if (recipeId === 'backup_partner_umkm_bundle') return readPartnerBundle(client, scope);
  if (recipeId === 'backup_knowledge_bundle') return readKnowledgeBundle(client, scope);
  if (recipeId === 'backup_important_all') {
    const parts = await Promise.all([
      readProjectBundle(client, scope),
      readProductBundle(client, scope),
      readPartnerBundle(client, scope),
      readKnowledgeBundle(client, scope),
    ]);
    const merged: Record<string, Array<Record<string, any>>> = {};
    for (const part of parts) {
      for (const [model, rows] of Object.entries(part)) {
        if (!merged[model]) merged[model] = [];
        const byId = new Map(merged[model].map((r) => [r.id, r]));
        for (const row of rows) byId.set(row.id, row);
        merged[model] = Array.from(byId.values());
      }
    }
    return merged;
  }
  throw new Error(`Unknown backup recipe: ${recipeId}`);
}

function collectAllIds(recordsByModel: Record<string, Array<Record<string, any>>>) {
  const modelToIds = new Map<string, Set<number>>();
  for (const [model, rows] of Object.entries(recordsByModel)) collectRecordIds(modelToIds, model, rows);
  for (const row of recordsByModel['project.project'] || []) collectRelationIds(modelToIds, 'res.partner', [relationId(row.partner_id)].filter(Boolean) as number[]);
  for (const row of recordsByModel['project.project'] || []) collectRelationIds(modelToIds, 'res.users', [relationId(row.user_id)].filter(Boolean) as number[]);
  for (const row of recordsByModel['project.project'] || []) collectRelationIds(modelToIds, 'res.company', [relationId(row.company_id)].filter(Boolean) as number[]);
  for (const row of recordsByModel['project.milestone'] || []) collectRelationIds(modelToIds, 'project.project', [relationId(row.project_id)].filter(Boolean) as number[]);
  for (const row of recordsByModel['project.task.type'] || []) collectRelationIds(modelToIds, 'project.project', relationIds(row.project_ids));
  for (const row of recordsByModel['project.task'] || []) {
    collectRelationIds(modelToIds, 'project.project', [relationId(row.project_id)].filter(Boolean) as number[]);
    collectRelationIds(modelToIds, 'project.task', [relationId(row.parent_id)].filter(Boolean) as number[]);
    collectRelationIds(modelToIds, 'project.task.type', [relationId(row.stage_id)].filter(Boolean) as number[]);
    collectRelationIds(modelToIds, 'project.milestone', [relationId(row.milestone_id)].filter(Boolean) as number[]);
    collectRelationIds(modelToIds, 'res.users', relationIds(row.user_ids));
    collectRelationIds(modelToIds, 'project.tags', relationIds(row.tag_ids));
  }
  for (const row of recordsByModel['product.category'] || []) collectRelationIds(modelToIds, 'product.category', [relationId(row.parent_id)].filter(Boolean) as number[]);
  for (const row of recordsByModel['product.public.category'] || []) collectRelationIds(modelToIds, 'product.public.category', [relationId(row.parent_id)].filter(Boolean) as number[]);
  for (const row of recordsByModel['product.template'] || []) {
    collectRelationIds(modelToIds, 'product.category', [relationId(row.categ_id)].filter(Boolean) as number[]);
    collectRelationIds(modelToIds, 'product.public.category', relationIds(row.public_categ_ids));
    collectRelationIds(modelToIds, 'uom.uom', [relationId(row.uom_id), relationId(row.uom_po_id)].filter(Boolean) as number[]);
  }
  for (const row of recordsByModel['product.supplierinfo'] || []) {
    collectRelationIds(modelToIds, 'res.partner', [relationId(row.partner_id)].filter(Boolean) as number[]);
    collectRelationIds(modelToIds, 'product.template', [relationId(row.product_tmpl_id)].filter(Boolean) as number[]);
    collectRelationIds(modelToIds, 'res.currency', [relationId(row.currency_id)].filter(Boolean) as number[]);
  }
  for (const row of recordsByModel['res.partner.category'] || []) collectRelationIds(modelToIds, 'res.partner.category', [relationId(row.parent_id)].filter(Boolean) as number[]);
  for (const row of recordsByModel['res.partner'] || []) {
    collectRelationIds(modelToIds, 'res.partner', [relationId(row.parent_id)].filter(Boolean) as number[]);
    collectRelationIds(modelToIds, 'res.country.state', [relationId(row.state_id)].filter(Boolean) as number[]);
    collectRelationIds(modelToIds, 'res.country', [relationId(row.country_id)].filter(Boolean) as number[]);
    collectRelationIds(modelToIds, 'res.partner.category', relationIds(row.category_id));
  }
  for (const row of recordsByModel['knowledge.article'] || []) collectRelationIds(modelToIds, 'knowledge.article', [relationId(row.parent_id)].filter(Boolean) as number[]);
  return modelToIds;
}

function baseRow(model: string, row: Record<string, any>, extMap: Map<string, string>, counter: { value: number }): WorkbookRow {
  return {
    __action: 'upsert',
    _external_id: xmlFor(extMap, model, row.id, row.display_name || row.name, counter),
    _model: model,
  };
}

function directCopy(target: WorkbookRow, source: Record<string, any>, fields: string[]) {
  for (const field of fields) {
    if (field in source && !Array.isArray(source[field]) && hasValue(source[field])) target[field] = source[field];
  }
}

function mapRows(model: string, rows: Array<Record<string, any>>, extMap: Map<string, string>, counter: { value: number }): WorkbookRow[] {
  return rows.map((row) => {
    const out = baseRow(model, row, extMap, counter);
    if (model === 'project.project') {
      directCopy(out, row, ['name', 'active', 'sequence', 'allow_milestones', 'description', 'label_tasks']);
      out.partner_id_external_id = xmlFor(extMap, 'res.partner', relationId(row.partner_id), row.partner_id?.[1], counter);
      out.user_id_external_id = xmlFor(extMap, 'res.users', relationId(row.user_id), row.user_id?.[1], counter);
      out.company_id_external_id = xmlFor(extMap, 'res.company', relationId(row.company_id), row.company_id?.[1], counter);
    } else if (model === 'project.milestone') {
      directCopy(out, row, ['name', 'deadline', 'is_reached', 'sequence']);
      out.project_id_external_id = xmlFor(extMap, 'project.project', relationId(row.project_id), row.project_id?.[1], counter);
    } else if (model === 'project.task.type') {
      directCopy(out, row, ['name', 'sequence', 'fold']);
      out.project_ids_external_ids = relationIds(row.project_ids).map((id) => xmlFor(extMap, 'project.project', id, '', counter)).filter(Boolean).join(',');
    } else if (model === 'project.tags') {
      directCopy(out, row, ['name', 'color']);
    } else if (model === 'project.task') {
      directCopy(out, row, ['name', 'active', 'sequence', 'priority', 'date_deadline', 'description']);
      out.project_id_external_id = xmlFor(extMap, 'project.project', relationId(row.project_id), row.project_id?.[1], counter);
      out.parent_id_external_id = xmlFor(extMap, 'project.task', relationId(row.parent_id), row.parent_id?.[1], counter);
      out.stage_id_external_id = xmlFor(extMap, 'project.task.type', relationId(row.stage_id), row.stage_id?.[1], counter);
      out.milestone_id_external_id = xmlFor(extMap, 'project.milestone', relationId(row.milestone_id), row.milestone_id?.[1], counter);
      out.user_ids_external_ids = relationIds(row.user_ids).map((id) => xmlFor(extMap, 'res.users', id, '', counter)).filter(Boolean).join(',');
      out.tag_ids_external_ids = relationIds(row.tag_ids).map((id) => xmlFor(extMap, 'project.tags', id, '', counter)).filter(Boolean).join(',');
    } else if (model === 'product.category') {
      directCopy(out, row, ['name', 'property_cost_method', 'property_valuation']);
      out.parent_id_external_id = xmlFor(extMap, 'product.category', relationId(row.parent_id), row.parent_id?.[1], counter);
    } else if (model === 'product.public.category') {
      directCopy(out, row, ['name', 'sequence']);
      out.parent_id_external_id = xmlFor(extMap, 'product.public.category', relationId(row.parent_id), row.parent_id?.[1], counter);
    } else if (model === 'product.template') {
      directCopy(out, row, ['name', 'active', 'default_code', 'barcode', 'list_price', 'standard_price', 'sale_ok', 'purchase_ok', 'type', 'detailed_type', 'description_sale', 'website_description']);
      out.categ_id_external_id = xmlFor(extMap, 'product.category', relationId(row.categ_id), row.categ_id?.[1], counter);
      out.public_categ_ids_external_ids = relationIds(row.public_categ_ids).map((id) => xmlFor(extMap, 'product.public.category', id, '', counter)).filter(Boolean).join(',');
      out.uom_id_external_id = xmlFor(extMap, 'uom.uom', relationId(row.uom_id), row.uom_id?.[1], counter);
      out.uom_po_id_external_id = xmlFor(extMap, 'uom.uom', relationId(row.uom_po_id), row.uom_po_id?.[1], counter);
      if (hasValue(row.image_1920)) out.image_1920_base64 = row.image_1920;
    } else if (model === 'product.supplierinfo') {
      directCopy(out, row, ['min_qty', 'price', 'delay', 'product_code', 'product_name']);
      out.partner_id_external_id = xmlFor(extMap, 'res.partner', relationId(row.partner_id), row.partner_id?.[1], counter);
      out.product_tmpl_id_external_id = xmlFor(extMap, 'product.template', relationId(row.product_tmpl_id), row.product_tmpl_id?.[1], counter);
      out.currency_id_external_id = xmlFor(extMap, 'res.currency', relationId(row.currency_id), row.currency_id?.[1], counter);
    } else if (model === 'res.partner.category') {
      directCopy(out, row, ['name', 'color', 'active']);
      out.parent_id_external_id = xmlFor(extMap, 'res.partner.category', relationId(row.parent_id), row.parent_id?.[1], counter);
    } else if (model === 'res.partner') {
      directCopy(out, row, ['name', 'active', 'is_company', 'email', 'phone', 'mobile', 'street', 'street2', 'city', 'zip', 'supplier_rank', 'customer_rank', 'barcode', 'website', 'comment', 'x_lokal_id', 'x_lokal_role', 'x_lokal_member_type', 'x_lokal_area', 'x_lokal_points', 'x_lm_vendor_type', 'x_lm_area', 'x_lm_koloni_code', 'x_lm_whatsapp', 'x_lm_verified', 'x_lm_is_umkm', 'x_lm_is_driver', 'x_lm_lokal_id', 'x_lm_lokal_code']);
      out.parent_id_external_id = xmlFor(extMap, 'res.partner', relationId(row.parent_id), row.parent_id?.[1], counter);
      out.state_id_external_id = xmlFor(extMap, 'res.country.state', relationId(row.state_id), row.state_id?.[1], counter);
      out.country_id_external_id = xmlFor(extMap, 'res.country', relationId(row.country_id), row.country_id?.[1], counter);
      out.category_id_external_ids = relationIds(row.category_id).map((id) => xmlFor(extMap, 'res.partner.category', id, '', counter)).filter(Boolean).join(',');
      if (hasValue(row.image_1920)) out.image_1920_base64 = row.image_1920;
    } else if (model === 'knowledge.article') {
      directCopy(out, row, ['name', 'active', 'body', 'icon', 'sequence', 'internal_permission', 'is_article_item', 'full_width', 'is_locked', 'to_delete']);
      out.parent_id_external_id = xmlFor(extMap, 'knowledge.article', relationId(row.parent_id), row.parent_id?.[1], counter);
    } else {
      directCopy(out, row, Object.keys(row).filter((k) => !['id', 'display_name'].includes(k)));
    }
    return out;
  });
}

function projectRelationMap(tasks: Array<Record<string, any>>, extMap: Map<string, string>, counter: { value: number }): WorkbookRow[] {
  return tasks.map((t) => ({
    task_external_id: xmlFor(extMap, 'project.task', t.id, t.display_name || t.name, counter),
    parent_external_id: xmlFor(extMap, 'project.task', relationId(t.parent_id), t.parent_id?.[1], counter),
    project_external_id: xmlFor(extMap, 'project.project', relationId(t.project_id), t.project_id?.[1], counter),
    milestone_external_id: xmlFor(extMap, 'project.milestone', relationId(t.milestone_id), t.milestone_id?.[1], counter),
    stage_external_id: xmlFor(extMap, 'project.task.type', relationId(t.stage_id), t.stage_id?.[1], counter),
    task_name: t.name,
  }));
}

function buildImportableWorkbook(recordsByModel: Record<string, Array<Record<string, any>>>, extMap: Map<string, string>, summary: BackupSummary): { workbook: XLSX.WorkBook; sheets: Array<{ name: string; rows: WorkbookRow[] }> } {
  const counter = { value: 0 };
  const sheets: Array<{ name: string; rows: WorkbookRow[] }> = [];
  sheets.push({
    name: '00_README',
    rows: [
      { key: 'backup_type', value: 'Lokalmart restore-ready importable XLSX' },
      { key: 'recipe', value: summary.recipeTitle },
      { key: 'exported_at', value: summary.exportedAt },
      { key: 'target_db', value: summary.target?.db || '' },
      { key: 'how_to_restore', value: 'Upload this XLSX to Lokalmart Importer → Preflight → Dry Run → Live Import.' },
    ],
  });
  sheets.push({
    name: '01_BACKUP_MANIFEST',
    rows: Object.entries(summary.counts).map(([model, count]) => ({ model, count })),
  });

  const modelOrder = ['product.category', 'product.public.category', 'res.partner.category', 'res.partner', 'project.project', 'project.milestone', 'project.task.type', 'project.tags', 'project.task', 'product.template', 'product.supplierinfo', 'knowledge.article'];
  for (const model of modelOrder) {
    const rows = recordsByModel[model] || [];
    if (!rows.length) continue;
    sheets.push({ name: sheetName(model), rows: mapRows(model, rows, extMap, counter) });
    if (model === 'project.task') sheets.push({ name: 'project.task.relation_map', rows: projectRelationMap(rows, extMap, counter) });
  }

  summary.generatedExternalIds = counter.value;
  summary.sheets = sheets.map((s) => s.name);
  return { workbook: makeWorkbookFromSheets(sheets), sheets };
}

function makeRestorePlan(summary: BackupSummary) {
  return `# Lokalmart Restore Plan\n\nBackup dibuat: ${summary.exportedAt}\nTarget asal: ${summary.target?.db || '-'} (${summary.target?.url_host || '-'})\nRecipe: ${summary.recipeTitle}\n\n## Cara restore paling aman\n\n1. Buka Lokalmart Importer.\n2. Upload file \`data/lokalmart_backup_importable.xlsx\`.\n3. Jalankan Schema Snapshot pada database target.\n4. Jalankan Preflight.\n5. Jika ada warning, jalankan Auto Repair.\n6. Jalankan Dry Run.\n7. Setelah log aman, baru Live Import.\n\n## Jumlah record\n\n${Object.entries(summary.counts).map(([model, count]) => `- ${model}: ${count}`).join('\n')}\n\n## Catatan\n\n- File XLSX memakai \`_external_id\`, \`_model\`, dan \`__action=upsert\`.\n- Relasi Many2one memakai \`field_name_external_id\`.\n- Relasi Many2many memakai \`field_name_external_ids\`.\n- Foto produk/kontak memakai \`image_1920_base64\` bila tersedia.\n- Backup ini tidak menghapus record di database target.\n`;
}

export function listBackupRecipes() {
  return BACKUP_RECIPES;
}

export async function previewBackup(recipeId: BackupRecipeId, scope: BackupScope = {}) {
  const recipe = BACKUP_RECIPES.find((r) => r.id === recipeId);
  if (!recipe) throw new Error(`Recipe tidak dikenal: ${recipeId}`);
  const client = await createOdooClient();
  const recordsByModel = await readRecipeRecords(client, recipeId, scope);
  const counts = Object.fromEntries(Object.entries(recordsByModel).map(([model, rows]) => [model, rows.length]));
  return {
    ok: true,
    recipe,
    target: client.target,
    counts,
    total: Object.values(counts).reduce((a, b) => a + b, 0),
    limit: safeLimit(scope),
    warnings: [
      'Preview hanya menghitung record yang masuk recipe. Default limit dibuat konservatif agar Vercel tidak timeout. Untuk backup besar, pecah per bundle.',
      'Restore-ready XLSX tidak melakukan delete fisik; semua row memakai __action=upsert.',
    ],
  };
}

export async function runBackup(recipeId: BackupRecipeId, scope: BackupScope = {}): Promise<BackupRunResult> {
  const recipe = BACKUP_RECIPES.find((r) => r.id === recipeId);
  if (!recipe) throw new Error(`Recipe tidak dikenal: ${recipeId}`);
  const client = await createOdooClient();
  const recordsByModel = await readRecipeRecords(client, recipeId, scope);
  const modelToIds = collectAllIds(recordsByModel);
  const extMap = await getExternalIdMap(client, modelToIds);
  const exportedAt = new Date().toISOString();
  const summary: BackupSummary = {
    recipeId,
    recipeTitle: recipe.title,
    exportedAt,
    target: client.target,
    counts: Object.fromEntries(Object.entries(recordsByModel).map(([model, rows]) => [model, rows.length])),
    sheets: [],
    generatedExternalIds: 0,
    warnings: [],
  };

  const { workbook } = buildImportableWorkbook(recordsByModel, extMap, summary);
  const xlsxBase64 = workbookToBase64(workbook);
  const xlsxBuffer = Buffer.from(xlsxBase64, 'base64');

  let schemaSnapshot: unknown = null;
  if (scope.includeSchema !== false) {
    try {
      schemaSnapshot = await buildSchemaSnapshot('custom');
    } catch (error) {
      summary.warnings.push(`Schema snapshot gagal dimasukkan ke ZIP: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const externalIdObject = Array.from(extMap.entries()).map(([key, external_id]) => {
    const [model, id] = key.split(':');
    return { model, id: Number(id), external_id };
  });

  const zip = new JSZip();
  const base = `lokalmart_backup_${client.target.db}_${dateSlug()}`;
  zip.file('manifest.json', JSON.stringify({ ...summary, recipe, generated_at: exportedAt }, null, 2));
  zip.file('restore_plan.md', makeRestorePlan(summary));
  zip.file('external_id_map.json', JSON.stringify(externalIdObject, null, 2));
  if (schemaSnapshot) zip.file('schema_snapshot.json', JSON.stringify(schemaSnapshot, null, 2));
  if (scope.includeRawJson !== false) zip.file('data/raw_records.json', JSON.stringify(recordsByModel, null, 2));
  zip.file('data/lokalmart_backup_importable.xlsx', xlsxBuffer);

  const zipBuffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  return {
    ok: true,
    filename: `${base}_${recipeId}.zip`,
    zipBase64: zipBuffer.toString('base64'),
    xlsxFilename: `${base}_${recipeId}_importable.xlsx`,
    xlsxBase64,
    summary,
  };
}
