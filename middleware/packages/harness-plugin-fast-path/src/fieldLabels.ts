/**
 * Human column headers for a deterministic chat answer whose planner gave no
 * label for a column: the catalog field label (FAST_PATH_TOOL_SPECS' field
 * catalog) in the user's language, else the humanised fieldKey — never the
 * raw snake_case key.
 */

type Labels = Readonly<{ de: string; en: string }>;

/** Odoo model → record attribute → label. Mirrors the field catalog. */
const CATALOG_LABELS: Readonly<Record<string, Readonly<Record<string, Labels>>>> = {
  'hr.employee': {
    name: { de: 'Name', en: 'Name' },
    job_title: { de: 'Position', en: 'Job title' },
    department_id: { de: 'Abteilung', en: 'Department' },
    parent_id: { de: 'Vorgesetzte(r)', en: 'Manager' },
    work_email: { de: 'E-Mail', en: 'Email' },
    work_phone: { de: 'Telefon', en: 'Phone' },
    active: { de: 'Aktiv', en: 'Active' },
    birthday: { de: 'Geburtstag', en: 'Birthday' },
  },
  'res.partner': {
    name: { de: 'Name', en: 'Name' },
    email: { de: 'E-Mail', en: 'Email' },
    phone: { de: 'Telefon', en: 'Phone' },
    city: { de: 'Ort', en: 'City' },
    is_company: { de: 'Firma', en: 'Company' },
    customer_rank: { de: 'Kundenrang', en: 'Customer rank' },
    supplier_rank: { de: 'Lieferantenrang', en: 'Supplier rank' },
  },
  'account.move': {
    name: { de: 'Nummer', en: 'Number' },
    partner_id: { de: 'Partner', en: 'Partner' },
    invoice_date: { de: 'Rechnungsdatum', en: 'Invoice date' },
    invoice_date_due: { de: 'Fällig am', en: 'Due date' },
    amount_total: { de: 'Gesamtbetrag', en: 'Total amount' },
    amount_residual: { de: 'Offener Betrag', en: 'Open amount' },
    currency_id: { de: 'Währung', en: 'Currency' },
    state: { de: 'Status', en: 'Status' },
    payment_state: { de: 'Zahlungsstatus', en: 'Payment status' },
    move_type: { de: 'Belegart', en: 'Document type' },
  },
};

/** `due_date` / `dueDate` → "Due date". */
export function humanizeKey(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_.\-\s]+/g, ' ')
    .trim()
    .toLowerCase();
  return words.length === 0 ? key : words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Header for `fieldKey` mapped to record attribute `attr` (a dot-path like
 * `partner_id.1` resolves on its first segment) of Odoo `model`.
 */
export function catalogColumnLabel(opts: {
  fieldKey: string;
  attr: string | undefined;
  model: string | undefined;
  lang: 'de' | 'en';
}): string {
  const base = opts.attr?.split('.')[0];
  const entry = opts.model !== undefined && base !== undefined ? CATALOG_LABELS[opts.model]?.[base] : undefined;
  return entry?.[opts.lang] ?? humanizeKey(opts.fieldKey);
}
