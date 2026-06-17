import 'server-only';

export const META_COLUMNS = new Set(['__action', '_external_id', '_model', '_note', '_comment']);
export const ALWAYS_SKIP = new Set(['id', 'display_name', 'create_uid', 'create_date', 'write_uid', 'write_date', '__last_update']);

export type RelationHeader = {
  original: string;
  field: string;
  kind: 'many2one' | 'many2many' | 'relation';
  normalizedHeader: string;
  source: 'external_id_suffix' | 'external_ids_suffix' | 'odoo_slash_id' | 'odoo_slash_ids';
};

export function normalizeHeader(header: string, fieldType?: string): { field: string; relation?: RelationHeader } {
  const key = String(header || '').trim();

  // Binary helper headers: image_1920_base64 is imported into image_1920.
  // This lets AI keep the template explicit while Odoo receives the real binary field.
  if (key.endsWith('_base64')) {
    return { field: key.replace(/_base64$/, '') };
  }

  if (key.endsWith('_external_ids')) {
    const field = key.replace(/_external_ids$/, '');
    return {
      field,
      relation: { original: key, field, kind: 'many2many', normalizedHeader: `${field}_external_ids`, source: 'external_ids_suffix' },
    };
  }

  if (key.endsWith('_external_id')) {
    const field = key.replace(/_external_id$/, '');
    return {
      field,
      relation: { original: key, field, kind: 'many2one', normalizedHeader: `${field}_external_id`, source: 'external_id_suffix' },
    };
  }

  // Odoo native import/export headers commonly use model_id/id or group_id/id.
  // The importer internally uses *_external_id(s), so we normalize these too.
  if (key.endsWith('/ids')) {
    const field = key.replace(/\/ids$/, '');
    return {
      field,
      relation: { original: key, field, kind: 'many2many', normalizedHeader: `${field}_external_ids`, source: 'odoo_slash_ids' },
    };
  }

  if (key.endsWith('/id')) {
    const field = key.replace(/\/id$/, '');
    const kind = fieldType === 'many2many' ? 'many2many' : 'many2one';
    return {
      field,
      relation: {
        original: key,
        field,
        kind,
        normalizedHeader: kind === 'many2many' ? `${field}_external_ids` : `${field}_external_id`,
        source: 'odoo_slash_id',
      },
    };
  }

  return { field: key };
}

export function isMetaColumn(header: string): boolean {
  const key = String(header || '').trim();
  return (
    META_COLUMNS.has(key) ||
    key.startsWith('_note') ||
    key.startsWith('_comment') ||
    key.startsWith('_ai') ||
    key.startsWith('_source')
  );
}
