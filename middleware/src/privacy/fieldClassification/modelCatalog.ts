/**
 * Field classification (#1556 follow-up) — the built-in verdicts on Odoo
 * models a masked field can point to.
 *
 * `PERSON_MODELS` is deliberately generous: anything that describes, or
 * belongs to, one individual (a partner, a user, an employee, their bank
 * account, contract, leave, attendance, payslip, message, chat membership,
 * survey answer, web visit …). A field whose relation target is in this set
 * is `personal` outright: never suggested, never sent to the schema LLM.
 *
 * `KNOWN_NON_PERSONAL_MODELS` holds organisational master data whose display
 * names are not people: departments, job positions, companies, stages, tags,
 * journals, products, currencies, countries, locations. A field pointing only
 * there can be SUGGESTED — an admin still confirms every entry.
 *
 * Everything else is `unknown` and goes to the schema-only model verdict.
 */

const PERSON_MODEL_LIST = [
  // Partners, users, employees and their projections.
  'res.partner',
  'res.users',
  'res.users.log',
  'res.users.settings',
  'res.users.apikeys',
  'hr.employee',
  'hr.employee.public',
  'hr.employee.base',
  'hr.employee.skill',
  'hr.resume.line',
  'res.partner.bank',
  // Recruitment.
  'hr.applicant',
  'hr.candidate',
  // Employment records about one person.
  'hr.contract',
  'hr.contract.history',
  'hr.version',
  'hr.leave',
  'hr.leave.allocation',
  'hr.attendance',
  'hr.expense',
  'hr.expense.sheet',
  'hr.payslip',
  'hr.payslip.line',
  'hr.payslip.run',
  'hr.timesheet',
  'hr.appraisal',
  'hr.departure.wizard',
  'resource.resource',
  // Calendar, messaging, followers, activity.
  'calendar.attendee',
  'calendar.event',
  'mail.followers',
  'mail.message',
  'mail.mail',
  'mail.activity',
  'mail.notification',
  'mail.channel.member',
  'mail.channel.partner',
  'discuss.channel.member',
  'mail.guest',
  'bus.presence',
  // Surveys, website, events, portal.
  'survey.user_input',
  'survey.user_input.line',
  'website.visitor',
  'event.registration',
  'slide.channel.partner',
  'portal.wizard.user',
  // Contacts in CRM / helpdesk that are individual people.
  'crm.lead',
  'helpdesk.ticket',
  'membership.membership_line',
] as const;

const KNOWN_NON_PERSONAL_MODEL_LIST = [
  // Organisation structure.
  'hr.department',
  'hr.job',
  'hr.work.location',
  'hr.leave.type',
  'hr.contract.type',
  'hr.employee.category',
  'hr.skill',
  'hr.skill.type',
  'hr.skill.level',
  'res.company',
  'resource.calendar',
  // CRM / sales master data.
  'crm.stage',
  'crm.team',
  'crm.tag',
  'crm.lost.reason',
  'sale.order.template',
  'product.product',
  'product.template',
  'product.category',
  'product.pricelist',
  'uom.uom',
  'uom.category',
  // Accounting master data.
  'account.journal',
  'account.account',
  'account.tax',
  'account.payment.term',
  'account.fiscal.position',
  'account.analytic.account',
  'account.analytic.plan',
  'res.currency',
  // Projects (structure only — a task can name a person, a stage cannot).
  'project.project',
  'project.task.type',
  'project.tags',
  'project.milestone',
  // Geography and logistics.
  'res.country',
  'res.country.state',
  'res.country.group',
  'res.lang',
  'stock.warehouse',
  'stock.location',
  'stock.picking.type',
  'delivery.carrier',
  // Partner tags and titles are not people themselves.
  'res.partner.category',
  'res.partner.industry',
  'res.partner.title',
  'utm.source',
  'utm.medium',
  'utm.campaign',
  'helpdesk.team',
  'helpdesk.stage',
] as const;

export const PERSON_MODELS: ReadonlySet<string> = new Set(PERSON_MODEL_LIST);
export const KNOWN_NON_PERSONAL_MODELS: ReadonlySet<string> = new Set(
  KNOWN_NON_PERSONAL_MODEL_LIST,
);

export type CatalogVerdict = 'personal' | 'non-personal' | 'unknown';

/** The built-in verdict for one Odoo model name. */
export function catalogVerdictOf(model: string): CatalogVerdict {
  if (PERSON_MODELS.has(model)) return 'personal';
  if (KNOWN_NON_PERSONAL_MODELS.has(model)) return 'non-personal';
  return 'unknown';
}

export function isPersonModel(model: string): boolean {
  return PERSON_MODELS.has(model);
}
