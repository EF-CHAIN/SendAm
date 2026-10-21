// Structured rejection reason codes required by compliance audit guidelines.
// The operator must pick one of these (or "Other" plus free-text detail)
// before a rejection can be submitted.
export const REJECTION_REASONS = [
  { code: 'document_expired', label: 'Document Expired' },
  { code: 'name_mismatch', label: 'Name Mismatch' },
  { code: 'unclear_photo', label: 'Unclear Photo' },
  { code: 'sanctions_flag', label: 'Sanctions Flag' },
  { code: 'other', label: 'Other' },
];
