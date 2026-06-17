import { ImportIssue } from './types';

export function normalizeError(error: unknown): string {
  if (!error) return 'Unknown error';
  if (error instanceof Error) return error.message;
  return String(error);
}

export function translateOdooError(error: unknown, context?: Partial<ImportIssue>): ImportIssue {
  const raw = normalizeError(error);
  const lower = raw.toLowerCase();

  if (lower.includes('mandatory field') || lower.includes('a mandatory field is not set')) {
    return {
      level: 'error',
      code: 'mandatory_field_missing',
      ...context,
      message: 'Ada field wajib yang belum terisi.',
      suggestion: 'Cek kolom required pada schema. Untuk ir.model.fields biasanya model_id_external_id wajib valid.',
    };
  }

  if (lower.includes('readonly') || lower.includes('cannot be modified')) {
    return {
      level: 'error',
      code: 'readonly_field',
      ...context,
      message: 'Ada field readonly/computed yang tidak boleh dibuat atau diubah lewat import.',
      suggestion: 'Hapus kolom readonly dari XLSX atau biarkan Odoo mengisinya otomatis.',
    };
  }

  if (lower.includes('external id') && lower.includes('already')) {
    return {
      level: 'error',
      code: 'external_id_conflict',
      ...context,
      message: 'External ID sudah dipakai record lain.',
      suggestion: 'Gunakan external ID baru yang unik, atau ubah mode menjadi update bila memang ingin memperbarui record lama.',
    };
  }

  if (lower.includes('ondelete') || lower.includes('on delete') || lower.includes('set null')) {
    return {
      level: 'error',
      code: 'many2one_ondelete',
      ...context,
      message: 'Konfigurasi Many2one tidak aman: required Many2one tidak cocok dengan ondelete set null.',
      suggestion: 'Untuk Many2one required gunakan ondelete restrict/cascade, atau jadikan required=false.',
    };
  }

  if (lower.includes('access') || lower.includes('not allowed')) {
    return {
      level: 'error',
      code: 'access_rights',
      ...context,
      message: 'User Odoo tidak punya akses untuk operasi ini.',
      suggestion: 'Pastikan access rule sudah dibuat dan user importer punya hak create/write pada model target.',
    };
  }

  if (lower.includes('foreign key') || lower.includes('another model requires')) {
    return {
      level: 'error',
      code: 'foreign_key_constraint',
      ...context,
      message: 'Record ini sedang dipakai oleh record lain sehingga tidak aman dihapus/diubah.',
      suggestion: 'Gunakan archive/deactivate, bukan delete fisik. Buat patch baru daripada menghapus record teknis lama.',
    };
  }

  return {
    level: 'error',
    code: 'odoo_rpc_error',
    ...context,
    message: raw.slice(0, 900),
    suggestion: 'Buka log detail, lalu perbaiki sheet/baris terkait sebelum retry.',
  };
}
