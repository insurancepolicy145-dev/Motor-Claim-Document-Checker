import {
  activeKeys,
  documentLabelKey,
  isActive,
  isRequired,
  optionalKeys,
  requiredKeys,
} from '../config/documentConfig';
import { LOW_CONFIDENCE } from './aiDocumentReader';
import { msg } from '../i18n/types';
import { formatDateLocalized, t } from '../i18n';
import type {
  ClaimParticulars,
  ClaimValidationResult,
  CrossCheck,
  DocumentKey,
  DocumentStateMap,
  DocumentSummary,
  ValidationStatus,
  VehicleType,
} from '../types';
import { FAIL, PASS, REVIEW } from '../types';

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

/**
 * Code points of the digit zero in the Indian scripts, plus Arabic-Indic.
 * Each script's digits 0–9 are contiguous from its zero.
 */
const DIGIT_ZEROS = [
  0x0660, // Arabic-Indic
  0x06f0, // Extended Arabic-Indic (Urdu)
  0x0966, // Devanagari
  0x09e6, // Bengali
  0x0a66, // Gurmukhi
  0x0ae6, // Gujarati
  0x0b66, // Oriya
  0x0be6, // Tamil
  0x0c66, // Telugu
  0x0ce6, // Kannada
  0x0d66, // Malayalam
];

/** Replaces regional digits with 0–9 and leaves every other character alone. */
export function latinizeDigits(value: string): string {
  let out = '';
  for (const ch of value) {
    const code = ch.codePointAt(0)!;
    const zero = DIGIT_ZEROS.find((z) => code >= z && code <= z + 9);
    out += zero === undefined ? ch : String(code - zero);
  }
  return out;
}

/**
 * For registration, chassis and engine numbers: regional digits latinized,
 * then punctuation and spacing stripped. Regional letters are not
 * transliterated, so a number printed wholly in a regional script will not
 * match its English form and falls to review or fail rather than a false pass.
 */
export function normalizeAlphaNumeric(value: string | null | undefined): string {
  if (!value) return '';
  return latinizeDigits(value).toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** Splits a person's name into upper-case tokens. */
export function nameTokens(value: string | null | undefined): string[] {
  if (!value) return [];
  return value
    .toUpperCase()
    .replace(/[.,]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
}

/**
 * Compares two names, tolerating initials, missing middle names and
 * reordering, so "POCHITHREDDY VENKATA KRISHNA REDDY" and "P V KRISHNA REDDY"
 * come back as the same person. A genuinely different name is not waved
 * through; anything in between returns REVIEW rather than guessing.
 */
export function compareNames(a: string | null, b: string | null): ValidationStatus {
  const tokensA = nameTokens(a);
  const tokensB = nameTokens(b);

  if (tokensA.length === 0 || tokensB.length === 0) return REVIEW;
  if (tokensA.join(' ') === tokensB.join(' ')) return PASS;

  const [shorter, longer] =
    tokensA.length <= tokensB.length ? [tokensA, tokensB] : [tokensB, tokensA];

  const used = new Set<number>();
  let matched = 0;

  for (const short of shorter) {
    let found = false;

    for (let i = 0; i < longer.length; i++) {
      if (used.has(i)) continue;
      const long = longer[i];
      if (
        short === long ||
        (short.length === 1 && long.startsWith(short)) ||
        (long.length === 1 && short.startsWith(long))
      ) {
        used.add(i);
        matched++;
        found = true;
        break;
      }
    }
    if (found) continue;

    for (let i = 0; i < longer.length; i++) {
      if (used.has(i)) continue;
      const long = longer[i];
      const n = Math.min(4, short.length, long.length);
      if (n >= 3 && short.slice(0, n) === long.slice(0, n)) {
        used.add(i);
        matched++;
        break;
      }
    }
  }

  const ratio = matched / shorter.length;
  if (ratio === 1) return PASS;
  if (ratio >= 0.5) return REVIEW;
  return FAIL;
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

/**
 * Accepts yyyy-mm-dd, dd/mm/yyyy, dd-mm-yy and dd Mon yyyy. Returns null for
 * anything else, including dates that do not exist.
 */
export function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const trimmed = String(value).trim();

  const iso = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return exactDate(+iso[1], +iso[2], +iso[3]);

  const dmy = trimmed.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2}|\d{4})$/);
  if (dmy) {
    let year = +dmy[3];
    if (year < 100) year += 2000;
    return exactDate(year, +dmy[2], +dmy[1]);
  }

  // Month written out, e.g. "17 Sep 2026" or "17-September-2026". Nothing
  // looser is accepted: `new Date("12")` is a date in 2001, and a value like
  // that must come back unreadable, not silently wrong.
  const named = trimmed.match(/^(\d{1,2})[\s/\-.,]+([A-Za-z]{3,9})[\s/\-.,]+(\d{4})$/);
  if (named) {
    const month = MONTHS.indexOf(named[2].slice(0, 3).toLowerCase());
    if (month === -1) return null;
    return exactDate(+named[3], month + 1, +named[1]);
  }

  return null;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/**
 * Builds a date only if it exists. `new Date(2025, 1, 31)` quietly becomes
 * 3 March; here it is rejected, so 31/02/2025 is treated as unreadable.
 */
function exactDate(year: number, month: number, day: number): Date | null {
  const date = new Date(year, month - 1, day);
  if (
    isNaN(date.getTime()) ||
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return null;
  }
  return date;
}

/** Date formatted as DD/MM/YYYY. */
export function formatDate(date: Date | null): string {
  return formatDateLocalized(date);
}

// ---------------------------------------------------------------------------
// Per-document summaries
// ---------------------------------------------------------------------------

function summarizeDocuments(
  vehicleType: VehicleType,
  docs: DocumentStateMap,
  missingRequired: string[]
): DocumentSummary[] {
  const summaries: DocumentSummary[] = [];

  for (const key of activeKeys(vehicleType)) {
    const state = docs[key];
    const required = isRequired(vehicleType, key);
    const attached = state.files.length > 0;

    if (!attached) {
      if (required) missingRequired.push(documentLabelKey(vehicleType, key));
      // An optional document that was never supplied contributes nothing and
      // is never reported as missing.
      summaries.push({
        key,
        required,
        status: 'NONE',
        message: required ? msg('msg.doc.missing') : msg('msg.doc.optionalNotProvided'),
      });
      continue;
    }

    if (state.status === 'ERROR') {
      summaries.push({
        key,
        required,
        status: REVIEW,
        message: state.error ?? msg('msg.doc.readError'),
      });
      continue;
    }

    if (state.status !== 'READ') {
      summaries.push({ key, required, status: REVIEW, message: msg('msg.doc.notRead') });
      continue;
    }

    const confidence = state.confidence ?? 0;
    if (confidence < LOW_CONFIDENCE) {
      summaries.push({
        key,
        required,
        status: REVIEW,
        message: msg('msg.doc.lowConfidence', {
          percent: Math.round(confidence * 100),
          warnings: '',
        }),
        rawWarnings: state.warnings,
      });
      continue;
    }

    if (state.warnings.length > 0) {
      summaries.push({ key, required, status: REVIEW, message: null, rawWarnings: state.warnings });
      continue;
    }

    summaries.push({ key, required, status: PASS, message: msg('msg.doc.clean') });
  }

  return summaries;
}

// ---------------------------------------------------------------------------
// Cross-document checks
// ---------------------------------------------------------------------------

interface CheckContext {
  vehicleType: VehicleType;
  accidentDate: Date | null;
  field: (key: DocumentKey, field: string) => string;
  wasRead: (key: DocumentKey) => boolean;
  push: (check: CrossCheck) => void;
}

function checkRegistrationNumbers(ctx: CheckContext): void {
  const policyReg = ctx.field('POLICY', 'reg_no');
  const rcReg = ctx.field('RC', 'reg_no');

  if (policyReg && rcReg) {
    const same = normalizeAlphaNumeric(policyReg) === normalizeAlphaNumeric(rcReg);
    ctx.push({
      labelKey: 'check.regPolicyRc',
      a: policyReg,
      b: rcReg,
      status: same ? PASS : FAIL,
      message: same
        ? msg('msg.reg.same', { reg: rcReg })
        : msg('msg.reg.differs', { a: policyReg, b: rcReg }),
    });
  } else if (ctx.wasRead('POLICY') && ctx.wasRead('RC')) {
    ctx.push({
      labelKey: 'check.regPolicyRc',
      a: policyReg || '—',
      b: rcReg || '—',
      status: REVIEW,
      message: msg('msg.reg.missing'),
    });
  }
}

function checkNames(ctx: CheckContext): void {
  if (!ctx.wasRead('POLICY') || !ctx.wasRead('RC')) return;

  const insured = ctx.field('POLICY', 'insured_name');
  const owner = ctx.field('RC', 'owner_name');
  const status = compareNames(insured, owner);
  const params = { a: insured || '—', b: owner || '—' };

  ctx.push({
    labelKey: 'check.names',
    a: params.a,
    b: params.b,
    status,
    message:
      status === PASS
        ? msg('msg.name.same', params)
        : status === REVIEW
        ? msg('msg.name.unsure', params)
        : msg('msg.name.differs', params),
  });
}

function checkVehicleDetails(ctx: CheckContext): void {
  if (!ctx.wasRead('POLICY') || !ctx.wasRead('RC')) return;

  const policyMake = ctx.field('POLICY', 'vehicle_make');
  const rcMake = ctx.field('RC', 'vehicle_make');
  const policyModel = ctx.field('POLICY', 'vehicle_model');
  const rcModel = ctx.field('RC', 'vehicle_model');

  const makeKnown = Boolean(policyMake && rcMake);
  const modelKnown = Boolean(policyModel && rcModel);

  if (!makeKnown && !modelKnown) {
    ctx.push({
      labelKey: 'check.makeModel',
      a: '—',
      b: '—',
      status: REVIEW,
      message: msg('msg.vehicle.illegible'),
    });
    return;
  }

  const makeStatus = makeKnown ? compareVehicleText(policyMake, rcMake) : PASS;
  const modelStatus = modelKnown ? compareVehicleText(policyModel, rcModel) : PASS;
  const status = worstOf(makeStatus, modelStatus);

  ctx.push({
    labelKey: 'check.makeModel',
    a: [policyMake, policyModel].filter(Boolean).join(' ') || '—',
    b: [rcMake, rcModel].filter(Boolean).join(' ') || '—',
    status,
    message:
      status === PASS
        ? msg('msg.vehicle.same')
        : status === REVIEW
        ? msg('msg.vehicle.partial')
        : msg('msg.vehicle.differs'),
  });
}

/** Words that describe the company rather than the vehicle, dropped before comparing. */
const MAKER_NOISE = /\b(INDIA|LTD|LIMITED|PVT|PRIVATE|MOTORS?|CORP(ORATION)?|CO|COMPANY|INC|AUTOMOBILES?|AUTO)\b/g;

/**
 * Make and model are worded differently by insurers and RTOs all the time
 * ("MARUTI SUZUKI INDIA LTD" vs "MARUTI SUZUKI", "SWIFT VXI" vs "SWIFT").
 * Same after tidying → pass. One wholly inside the other → review. Otherwise
 * → fail, because a different vehicle is a real finding.
 */
export function compareVehicleText(a: string, b: string): ValidationStatus {
  const tidy = (v: string) =>
    normalizeAlphaNumeric(latinizeDigits(v).toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').replace(MAKER_NOISE, ' '));
  const x = tidy(a);
  const y = tidy(b);
  if (!x || !y) {
    // Nothing left but company words: fall back to the raw strings.
    return normalizeAlphaNumeric(a) === normalizeAlphaNumeric(b) ? PASS : REVIEW;
  }
  if (x === y) return PASS;
  const [shorter, longer] = x.length <= y.length ? [x, y] : [y, x];
  if (shorter.length >= 3 && longer.includes(shorter)) return REVIEW;
  return FAIL;
}

function worstOf(...statuses: ValidationStatus[]): ValidationStatus {
  if (statuses.includes(FAIL)) return FAIL;
  if (statuses.includes(REVIEW)) return REVIEW;
  return PASS;
}

function checkVehicleClassVsLicence(ctx: CheckContext): void {
  if (!ctx.wasRead('RC') || !ctx.wasRead('DL')) return;

  const rcClass = ctx.field('RC', 'vehicle_class');
  const dlClass = ctx.field('DL', 'vehicle_class');

  if (!rcClass || !dlClass) {
    ctx.push({
      labelKey: 'check.classDl',
      a: rcClass || '—',
      b: dlClass || '—',
      status: REVIEW,
      message: msg('msg.class.illegible'),
    });
    return;
  }

  const rc = normalizeAlphaNumeric(rcClass);
  const dl = normalizeAlphaNumeric(dlClass);
  const ok = rc === dl || dl.includes(rc) || rc.includes(dl);

  ctx.push({
    labelKey: 'check.classDl',
    a: rcClass,
    b: dlClass,
    status: ok ? PASS : REVIEW,
    message: ok
      ? msg('msg.class.covers', { dl: dlClass, rc: rcClass })
      : msg('msg.class.unclear', { rc: rcClass, dl: dlClass }),
  });
}

// ---- Permits, certificates and tax -------------------------------------

/** Display name of a document as worded for the vehicle type being checked. */
function documentName(ctx: CheckContext, key: DocumentKey): string {
  return t(documentLabelKey(ctx.vehicleType, key));
}

interface InForceRule {
  key: DocumentKey;
  labelKey: string;
  /** Field holding the start of validity, if the document has one. */
  fromField?: string;
  /** Field holding the end of validity. */
  toField: string;
  /** Name used in the remark; defaults to the document's name. */
  nameKey?: string;
}

/**
 * Dated documents that must be in force on the date of accident. A rule runs
 * only when its document is shown for the vehicle type and has been read.
 */
const IN_FORCE_RULES: InForceRule[] = [
  { key: 'PERMIT', labelKey: 'check.inForce.PERMIT', fromField: 'valid_from', toField: 'valid_upto' },
  { key: 'FITNESS', labelKey: 'check.inForce.FITNESS', toField: 'valid_upto' },
  { key: 'FC_VALIDITY', labelKey: 'check.inForce.FC_VALIDITY', fromField: 'valid_from', toField: 'valid_upto' },
  { key: 'QUARTERLY_TAX', labelKey: 'check.inForce.QUARTERLY_TAX', fromField: 'valid_from', toField: 'valid_upto' },
  {
    key: 'NATIONAL_PERMIT_AUTH',
    labelKey: 'check.inForce.NATIONAL_PERMIT_AUTH',
    fromField: 'valid_from',
    toField: 'valid_upto',
  },
  {
    key: 'NATIONAL_PERMIT_AUTH',
    labelKey: 'check.inForce.NATIONAL_PERMIT_AUTH.authorization',
    fromField: 'authorization_valid_from',
    toField: 'authorization_valid_upto',
    nameKey: 'doc.NATIONAL_PERMIT_AUTH.authorization',
  },
  { key: 'AITC', labelKey: 'check.inForce.AITC', fromField: 'valid_from', toField: 'valid_upto' },
];

function checkDocumentInForce(ctx: CheckContext, rule: InForceRule): void {
  if (!ctx.wasRead(rule.key)) return;

  const { labelKey } = rule;
  const doc = rule.nameKey ? t(rule.nameKey) : documentName(ctx, rule.key);
  const accident = ctx.accidentDate;
  const validTo = ctx.field(rule.key, rule.toField);
  const expiry = parseDate(validTo);

  if (!validTo) {
    ctx.push({
      labelKey,
      a: '—',
      b: formatDate(accident),
      status: REVIEW,
      message: msg('msg.inForce.illegible', { doc }),
    });
    return;
  }

  // A value is present but is not a real date ("31/13/2025", "Life time").
  // Before this guard it fell through every FAIL branch and came out as a pass.
  if (!expiry) {
    ctx.push({
      labelKey,
      a: validTo,
      b: formatDate(accident),
      status: REVIEW,
      message: msg('msg.inForce.unparseable', { doc, value: validTo }),
    });
    return;
  }

  const shown = formatDate(expiry);

  // Only documents that carry a start date (e.g. the tax quarter) can fail
  // for starting after the accident.
  const fromValue = rule.fromField ? ctx.field(rule.key, rule.fromField) : '';
  const start = parseDate(fromValue);

  if (fromValue && !start) {
    ctx.push({
      labelKey,
      a: `${fromValue} – ${shown}`,
      b: formatDate(accident),
      status: REVIEW,
      message: msg('msg.inForce.unparseable', { doc, value: fromValue }),
    });
    return;
  }

  if (start && accident && accident < start) {
    const startShown = formatDate(start);
    ctx.push({
      labelKey,
      a: `${startShown} – ${shown}`,
      b: formatDate(accident),
      status: FAIL,
      message: msg('msg.inForce.notStarted', { doc, date: startShown }),
    });
    return;
  }

  if (accident && expiry < accident) {
    ctx.push({
      labelKey,
      a: shown,
      b: formatDate(accident),
      status: FAIL,
      message: msg('msg.inForce.expiredBefore', { doc, date: shown }),
    });
    return;
  }

  if (!accident && expiry.getTime() < Date.now()) {
    ctx.push({
      labelKey,
      a: shown,
      b: '—',
      status: FAIL,
      message: msg('msg.inForce.expired', { doc, date: shown }),
    });
    return;
  }

  ctx.push({
    labelKey,
    a: shown,
    b: formatDate(accident),
    status: PASS,
    message: msg('msg.inForce.ok', { doc, date: shown }),
  });
}

function checkDocumentsInForce(ctx: CheckContext): void {
  for (const rule of IN_FORCE_RULES) checkDocumentInForce(ctx, rule);
}

/** Documents whose registration number is compared against the RC. */
const REG_VS_RC_DOCUMENTS: DocumentKey[] = [
  'PERMIT',
  'NATIONAL_PERMIT_AUTH',
  'FITNESS',
  'FC_VALIDITY',
  'QUARTERLY_TAX',
  'PASSENGER_LIST',
  'AITC',
];

/**
 * The RC is the reference for the vehicle's registration number, so each of
 * these documents shown for the vehicle type is held to it.
 */
function checkDocumentRegistrationNumbers(ctx: CheckContext): void {
  const rcReg = ctx.field('RC', 'reg_no');
  if (!rcReg) return;

  for (const key of REG_VS_RC_DOCUMENTS) {
    const docReg = ctx.field(key, 'reg_no');
    if (!docReg) continue;

    const same = normalizeAlphaNumeric(docReg) === normalizeAlphaNumeric(rcReg);
    ctx.push({
      labelKey: `check.reg.${key}`,
      a: docReg,
      b: rcReg,
      status: same ? PASS : FAIL,
      message: same
        ? msg('msg.reg.same', { reg: rcReg })
        : msg('msg.reg.docDiffers', { doc: documentName(ctx, key), a: docReg, b: rcReg }),
    });
  }
}

function checkPolicyPeriod(ctx: CheckContext): void {
  if (!ctx.wasRead('POLICY') || !ctx.accidentDate) return;

  const fromRaw = ctx.field('POLICY', 'period_from');
  const toRaw = ctx.field('POLICY', 'period_to');
  const from = parseDate(fromRaw);
  const to = parseDate(toRaw);
  // Show what was printed when it could not be read as a date, so the
  // reviewer sees the actual problem rather than a pair of dashes.
  const range = `${from ? formatDate(from) : fromRaw || '—'} – ${to ? formatDate(to) : toRaw || '—'}`;

  if (!from || !to) {
    ctx.push({
      labelKey: 'check.policyPeriod',
      a: range,
      b: formatDate(ctx.accidentDate),
      status: REVIEW,
      message: msg('msg.policy.illegible'),
    });
    return;
  }

  const inside = ctx.accidentDate >= from && ctx.accidentDate <= to;
  ctx.push({
    labelKey: 'check.policyPeriod',
    a: range,
    b: formatDate(ctx.accidentDate),
    status: inside ? PASS : FAIL,
    message: inside
      ? msg('msg.policy.inside')
      : ctx.accidentDate < from
      ? msg('msg.policy.before')
      : msg('msg.policy.after'),
  });
}

function checkLicenceCurrency(ctx: CheckContext): void {
  if (!ctx.wasRead('DL') || !ctx.accidentDate) return;

  const toRaw = ctx.field('DL', 'valid_upto');
  const to = parseDate(toRaw);
  if (!to) {
    ctx.push({
      labelKey: 'check.licence',
      a: toRaw || '—',
      b: formatDate(ctx.accidentDate),
      status: REVIEW,
      message: msg('msg.licence.illegible'),
    });
    return;
  }

  const ok = ctx.accidentDate <= to;
  ctx.push({
    labelKey: 'check.licence',
    a: formatDate(to),
    b: formatDate(ctx.accidentDate),
    status: ok ? PASS : FAIL,
    message: ok ? msg('msg.licence.ok') : msg('msg.licence.expired'),
  });
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function validateClaim(
  vehicleType: VehicleType,
  docs: DocumentStateMap,
  particulars: ClaimParticulars
): ClaimValidationResult {
  const accidentDate = parseDate(particulars.accidentDate);
  const place = [particulars.place, particulars.state]
    .map((s) => s.trim())
    .filter(Boolean)
    .join(', ');

  const missingRequired: string[] = [];
  const documentSummaries = summarizeDocuments(vehicleType, docs, missingRequired);

  const crossChecks: CrossCheck[] = [];
  const ctx: CheckContext = {
    vehicleType,
    accidentDate,
    // Only documents shown for the selected vehicle type may take part in its
    // checks. (Documents are also cleared whenever the vehicle type changes.)
    field: (key, field) =>
      isActive(vehicleType, key) ? (docs[key]?.data[field] ?? '').trim() : '',
    wasRead: (key) => isActive(vehicleType, key) && docs[key]?.status === 'READ',
    push: (check) => crossChecks.push(check),
  };

  checkRegistrationNumbers(ctx);
  checkNames(ctx);
  checkVehicleDetails(ctx);
  checkVehicleClassVsLicence(ctx);
  checkPolicyPeriod(ctx);
  checkLicenceCurrency(ctx);
  checkDocumentRegistrationNumbers(ctx);
  checkDocumentsInForce(ctx);

  // ---- Final verdict ------------------------------------------------------
  //
  // Anything missing or outright wrong makes the claim not valid. Anything
  // merely uncertain makes it need review. Only a clean sweep is valid.
  // An absent optional document never reaches this calculation.

  const requiredSummaries = documentSummaries.filter((s) => s.required);
  const failCount = crossChecks.filter((c) => c.status === FAIL).length;
  const reviewCount = crossChecks.filter((c) => c.status === REVIEW).length;

  const anyRequiredFail = requiredSummaries.some((s) => s.status === FAIL);
  const anyRequiredReview = requiredSummaries.some((s) => s.status === REVIEW);

  let verdict: ValidationStatus;
  if (missingRequired.length > 0 || anyRequiredFail || failCount > 0) {
    verdict = FAIL;
  } else if (anyRequiredReview || reviewCount > 0) {
    verdict = REVIEW;
  } else {
    verdict = PASS;
  }

  return {
    vehicleType,
    verdict,
    documentSummaries,
    crossChecks,
    missingRequired,
    accidentDate,
    place,
    failCount,
    reviewCount,
  };
}

/**
 * String-table label keys of required documents with nothing attached, worded
 * for the vehicle type. Presence is decided by document key, never by label.
 */
export function missingRequiredNames(vehicleType: VehicleType, docs: DocumentStateMap): string[] {
  return requiredKeys(vehicleType)
    .filter((key) => docs[key].files.length === 0)
    .map((key) => documentLabelKey(vehicleType, key));
}

/** True when at least one document of any kind has a file attached. */
export function hasAnyAttachment(vehicleType: VehicleType, docs: DocumentStateMap): boolean {
  return [...requiredKeys(vehicleType), ...optionalKeys(vehicleType)].some(
    (key) => docs[key].files.length > 0
  );
}
