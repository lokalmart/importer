import 'server-only';
import { createOdooClient } from './odooXmlRpc';
import { FieldMeta, ModelSchema, SchemaSnapshot } from './types';

const CORE_MODELS = [
  'ir.model',
  'ir.model.fields',
  'ir.model.access',
  'ir.model.data',
  'res.partner',
  'product.template',
  'product.category',
  'project.project',
  'project.task',
  'project.milestone',
  'knowledge.article',
  'ir.attachment',
  'website.page',
  'ir.ui.view'
];

function mapFields(raw: Record<string, any>): Record<string, FieldMeta> {
  const result: Record<string, FieldMeta> = {};
  for (const [name, meta] of Object.entries(raw)) {
    result[name] = {
      name,
      string: meta.string,
      type: meta.type,
      relation: meta.relation,
      required: Boolean(meta.required),
      readonly: Boolean(meta.readonly),
      store: Boolean(meta.store),
      selection: meta.selection,
    };
  }
  return result;
}

export async function buildSchemaSnapshot(mode: 'custom' | 'all' | 'core' = 'custom'): Promise<SchemaSnapshot> {
  const client = await createOdooClient();

  let domain: unknown[];
  if (mode === 'all') domain = [];
  else if (mode === 'core') domain = [['model', 'in', CORE_MODELS]];
  else domain = ['|', ['model', 'like', 'x_%'], ['model', 'in', CORE_MODELS]];

  const modelList = await client.searchRead<{ id: number; model: string; name: string; state?: string; modules?: string }>(
    'ir.model',
    domain,
    ['id', 'model', 'name', 'state', 'modules'],
    mode === 'all' ? 10000 : 2000
  );

  const models: Record<string, ModelSchema> = {};
  for (const item of modelList) {
    try {
      const fields = await client.fieldsGet(item.model);
      models[item.model] = {
        model: item.model,
        name: item.name,
        state: item.state,
        fields: mapFields(fields),
      };
    } catch {
      models[item.model] = {
        model: item.model,
        name: item.name,
        state: item.state,
        fields: {},
      };
    }
  }

  let externalIds: SchemaSnapshot['externalIds'] = [];
  try {
    const ext = await client.searchRead<{ module: string; name: string; model: string; res_id: number }>(
      'ir.model.data',
      [['model', 'in', Object.keys(models)]],
      ['module', 'name', 'model', 'res_id'],
      10000
    );
    externalIds = ext.map((x) => ({ ...x, complete_name: `${x.module}.${x.name}` }));
  } catch {
    externalIds = [];
  }

  return {
    ok: true,
    exported_at: new Date().toISOString(),
    target: client.target,
    models,
    modelList,
    externalIds,
  };
}
