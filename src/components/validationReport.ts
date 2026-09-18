import { documentLabelKey, isActive } from '../config/documentConfig';
import { formatDateLocalized, formatDateTimeLocalized, t, tm } from '../i18n';
import { parseDate } from '../services/claimValidator';
import type {
  ClaimValidationResult,
  DocumentKey,
  DocumentSummary,
  DocumentSummaryStatus,
  ReportContext,
  ValidationStatus,
  VehicleType,
} from '../types';
import { FAIL, PASS, REVIEW } from '../types';

/**
 * The validation report, laid out as a claim-file document.
 *
 * On screen it sits under step 04. In print it is the only thing on the page:
 * header with claim and docket numbers, particulars drawn from the documents,
 * the two tables, the verdict with every outstanding point listed, the
 * handler's remarks, and a sign-off block with room for two signatures.
 */

/** Status wording for a document's own state. */
const DOCUMENT_STATUS_KEY: Record<ValidationStatus, string> = {
  ok: 'status.valid',
  chk: 'status.needsReview',
  no: 'status.notValid',
};

/** Status wording for a cross-document check. */
const CHECK_STATUS_KEY: Record<ValidationStatus, string> = {
  ok: 'status.pass',
  chk: 'status.needsReview',
  no: 'status.fail',
};

const STAMP_KEY: Record<ValidationStatus, string> = {
  ok: 'stamp.ok',
  chk: 'stamp.chk',
  no: 'stamp.no',
};

function escapeHtml(value: unknown): string {
  return String(value).replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string
  );
}

function statusPill(status: DocumentSummaryStatus, keys: Record<ValidationStatus, string>): string {
  if (status === 'NONE') return `<span class="pill no">${escapeHtml(t('status.notProvided'))}</span>`;
  return `<span class="pill ${status}">${escapeHtml(t(keys[status]))}</span>`;
}

// ---------------------------------------------------------------------------
// Particulars
// ---------------------------------------------------------------------------

/**
 * Reads a value from a document, but only if that document is shown for the
 * vehicle type and has actually been read or entered. A stale value from a
 * hidden document must not appear on a signed report.
 */
function reader(vehicleType: VehicleType, ctx: ReportContext) {
  return (key: DocumentKey, field: string): string => {
    const state = ctx.documents[key];
    if (!isActive(vehicleType, key) || state?.status !== 'READ') return '';
    return (state.data[field] ?? '').trim();
  };
}

function asDate(value: string): string {
  if (!value) return '';
  const parsed = parseDate(value);
  return parsed ? formatDateLocalized(parsed) : value;
}

function particularsBlock(result: ClaimValidationResult, ctx: ReportContext): string {
  const read = reader(result.vehicleType, ctx);

  const from = asDate(read('POLICY', 'period_from'));
  const to = asDate(read('POLICY', 'period_to'));
  const rcVehicle = [read('RC', 'vehicle_make'), read('RC', 'vehicle_model')].filter(Boolean).join(' ');
  const policyVehicle = [read('POLICY', 'vehicle_make'), read('POLICY', 'vehicle_model')]
    .filter(Boolean)
    .join(' ');

  const rows: Array<[string, string]> = [
    ['report.policyNo', read('POLICY', 'policy_no')],
    ['report.insured', read('POLICY', 'insured_name') || read('RC', 'owner_name')],
    ['report.regNo', read('RC', 'reg_no') || read('POLICY', 'reg_no')],
    ['report.vehicle', rcVehicle || policyVehicle],
    ['report.vehicleType', t(`vehicle.${result.vehicleType}`)],
    ['report.policyPeriod', from || to ? `${from || '—'} – ${to || '—'}` : ''],
    ['report.idv', read('POLICY', 'idv')],
    ['report.driver', read('DL', 'holder_name')],
    ['report.dlNo', read('DL', 'dl_no')],
    ['report.dateOfLoss', formatDateLocalized(result.accidentDate)],
    ['report.placeOfLoss', result.place],
  ];

  return `<section class="rpt-sec">
      <h3>${escapeHtml(t('report.sectionParticulars'))}</h3>
      <dl class="rpt-dl">${rows
        .map(
          ([labelKey, value]) =>
            `<div><dt>${escapeHtml(t(labelKey))}</dt><dd>${escapeHtml(value && value !== '—' ? value : '—')}</dd></div>`
        )
        .join('')}</dl>
      <p class="rpt-fine">${escapeHtml(t('report.sourceNote'))}</p>
    </section>`;
}

// ---------------------------------------------------------------------------
// Documents and checks
// ---------------------------------------------------------------------------

/** Whether the document was supplied, and whether it had to be. */
function provisionKey(summary: DocumentSummary): string {
  const provided = summary.status !== 'NONE';
  if (summary.required) return provided ? 'provision.providedRequired' : 'provision.missingRequired';
  return provided ? 'provision.providedOptional' : 'provision.notProvidedOptional';
}

/**
 * Status cell for a document row. An optional document that was not supplied
 * has nothing to assess, so it gets no pill rather than a red "missing" one.
 */
function documentStatusCell(summary: DocumentSummary): string {
  if (summary.status === 'NONE' && !summary.required) return '<span class="val">—</span>';
  return statusPill(summary.status, DOCUMENT_STATUS_KEY);
}

/** Builds the remark for one document row: the sentence, then any reader warnings. */
function documentRemark(summary: DocumentSummary): string {
  const parts: string[] = [];
  if (summary.message) parts.push(tm(summary.message));
  for (const warning of summary.rawWarnings ?? []) parts.push(warning);
  return parts.filter(Boolean).join(' ');
}

function documentRows(vehicleType: VehicleType, summaries: DocumentSummary[], required: boolean): string {
  const rows = summaries.filter((s) => s.required === required);
  if (rows.length === 0) return '';

  const heading = `<tr class="head"><td colspan="4">${escapeHtml(
    t(required ? 'step2.requiredTitle' : 'step2.optionalTitle')
  )}</td></tr>`;

  const body = rows
    .map(
      (summary) => `<tr data-doc="${escapeHtml(summary.key)}">
        <td>${escapeHtml(t(documentLabelKey(vehicleType, summary.key)))}</td>
        <td class="val">${escapeHtml(t(provisionKey(summary)))}</td>
        <td>${documentStatusCell(summary)}</td>
        <td class="remark">${escapeHtml(documentRemark(summary))}</td>
      </tr>`
    )
    .join('');

  return heading + body;
}

function documentsBlock(result: ClaimValidationResult): string {
  let html = '';
  if (result.missingRequired.length > 0) {
    const names = result.missingRequired.map((key) => t(key)).join(', ');
    html += `<div class="missing">${escapeHtml(
      t(result.missingRequired.length === 1 ? 'step4.missingOne' : 'step4.missingMany', { list: names })
    )}</div>`;
  }

  return `<section class="rpt-sec">
      <h3>${escapeHtml(t('report.sectionDocuments'))}</h3>
      ${html}
      <div class="tablewrap"><table>
        <thead><tr>
          <th style="width:28%">${escapeHtml(t('table.document'))}</th>
          <th style="width:18%">${escapeHtml(t('table.provided'))}</th>
          <th style="width:14%">${escapeHtml(t('table.status'))}</th>
          <th>${escapeHtml(t('table.remark'))}</th>
        </tr></thead>
        <tbody>${documentRows(result.vehicleType, result.documentSummaries, true)}${documentRows(
          result.vehicleType,
          result.documentSummaries,
          false
        )}</tbody>
      </table></div>
    </section>`;
}

function checksBlock(result: ClaimValidationResult): string {
  const body =
    result.crossChecks.length === 0
      ? `<tr><td colspan="5" class="empty">${escapeHtml(t('step4.noChecks'))}</td></tr>`
      : result.crossChecks
          .map(
            // `a` and `b` are values copied off the documents, shown as printed.
            (check) => `<tr>
              <td>${escapeHtml(t(check.labelKey))}</td>
              <td class="val">${escapeHtml(check.a || '—')}</td>
              <td class="val">${escapeHtml(check.b || '—')}</td>
              <td>${statusPill(check.status, CHECK_STATUS_KEY)}</td>
              <td class="remark">${escapeHtml(tm(check.message))}</td>
            </tr>`
          )
          .join('');

  return `<section class="rpt-sec">
      <h3>${escapeHtml(t('report.sectionChecks'))}</h3>
      <div class="tablewrap"><table>
        <thead><tr>
          <th style="width:25%">${escapeHtml(t('table.check'))}</th>
          <th style="width:18%">${escapeHtml(t('table.docSays'))}</th>
          <th style="width:15%">${escapeHtml(t('table.comparedWith'))}</th>
          <th style="width:12%">${escapeHtml(t('table.status'))}</th>
          <th>${escapeHtml(t('table.remark'))}</th>
        </tr></thead>
        <tbody>${body}</tbody>
      </table></div>
    </section>`;
}

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------

function verdictNote(result: ClaimValidationResult): string {
  if (result.verdict === FAIL) {
    const reasons: string[] = [];
    const missing = result.missingRequired.length;
    if (missing > 0) {
      reasons.push(t(missing === 1 ? 'verdict.missingCount' : 'verdict.missingCountPlural', { count: missing }));
    }
    if (result.failCount > 0) {
      reasons.push(
        t(result.failCount === 1 ? 'verdict.failCount' : 'verdict.failCountPlural', { count: result.failCount })
      );
    }
    return t('verdict.failNote', { reasons: reasons.join('; ') });
  }

  if (result.verdict === REVIEW) {
    const count = result.reviewCount || 1;
    return t(count === 1 ? 'verdict.reviewNote' : 'verdict.reviewNotePlural', { count });
  }

  return result.accidentDate
    ? t('verdict.validNoteWhen', { date: formatDateLocalized(result.accidentDate) })
    : t('verdict.validNote');
}

interface Point {
  title: string;
  detail: string;
}

/** Every outstanding point, split by severity, so the reader need not scan the tables. */
function outstandingPoints(result: ClaimValidationResult): { fail: Point[]; review: Point[] } {
  const fail: Point[] = [];
  const review: Point[] = [];

  for (const summary of result.documentSummaries) {
    const title = t(documentLabelKey(result.vehicleType, summary.key));
    if (summary.status === 'NONE' && summary.required) {
      fail.push({ title, detail: t('msg.doc.missing') });
    } else if (summary.status === FAIL) {
      fail.push({ title, detail: documentRemark(summary) });
    } else if (summary.status === REVIEW) {
      review.push({ title, detail: documentRemark(summary) });
    }
  }

  for (const check of result.crossChecks) {
    const point = { title: t(check.labelKey), detail: tm(check.message) };
    if (check.status === FAIL) fail.push(point);
    else if (check.status === REVIEW) review.push(point);
  }

  return { fail, review };
}

function pointList(titleKey: string, points: Point[], tone: 'no' | 'chk'): string {
  if (points.length === 0) return '';
  return `<div class="rpt-points ${tone}">
      <h4>${escapeHtml(t(titleKey))} (${points.length})</h4>
      <ol>${points
        .map((p) => `<li><b>${escapeHtml(p.title)}.</b> ${escapeHtml(p.detail)}</li>`)
        .join('')}</ol>
    </div>`;
}

function findingsBlock(result: ClaimValidationResult): string {
  const requiredTotal = result.documentSummaries.filter((s) => s.required).length;
  const requiredProvided = requiredTotal - result.missingRequired.length;
  const passCount = result.crossChecks.filter((c) => c.status === PASS).length;
  const { fail, review } = outstandingPoints(result);

  const tally: Array<[string, string, string]> = [
    ['report.tallyDocs', `${requiredProvided}/${requiredTotal}`, result.missingRequired.length ? 'no' : 'ok'],
    ['report.tallyPass', String(passCount), 'ok'],
    ['report.tallyReview', String(result.reviewCount), result.reviewCount ? 'chk' : ''],
    ['report.tallyFail', String(result.failCount), result.failCount ? 'no' : ''],
  ];

  return `<section class="rpt-sec rpt-findings">
      <h3>${escapeHtml(t('report.sectionFindings'))}</h3>
      <div class="rpt-tally">${tally
        .map(
          ([labelKey, value, tone]) =>
            `<div class="${tone}"><b>${escapeHtml(value)}</b><span>${escapeHtml(t(labelKey))}</span></div>`
        )
        .join('')}</div>
      <div class="verdict">
        <div class="stamp ${result.verdict} press">
          <span class="big">${escapeHtml(t(STAMP_KEY[result.verdict]))}</span>
          ${result.place ? `<span class="sm">${escapeHtml(result.place)}</span>` : ''}
          <span class="sm">${escapeHtml(t('stamp.dateOfLoss', { date: formatDateLocalized(result.accidentDate) }))}</span>
        </div>
        <p class="note">${escapeHtml(verdictNote(result))}</p>
      </div>
      ${pointList('report.pointsFail', fail, 'no')}
      ${pointList('report.pointsReview', review, 'chk')}
      ${fail.length + review.length === 0 ? `<p class="rpt-fine">${escapeHtml(t('report.noPoints'))}</p>` : ''}
    </section>`;
}

// ---------------------------------------------------------------------------
// Header, remarks and sign-off
// ---------------------------------------------------------------------------

function headerBlock(ctx: ReportContext): string {
  const claimNo = ctx.particulars.claimNumber;
  return `<header class="rpt-head">
      <div>
        <p class="rpt-kind">${escapeHtml(t('report.title'))}</p>
        <p class="rpt-claim">
          <span>${escapeHtml(t('report.claimNo'))}</span>
          <b class="${claimNo ? '' : 'blank'}">${escapeHtml(claimNo || t('report.notEntered'))}</b>
        </p>
      </div>
      <dl class="rpt-meta">
        <div><dt>${escapeHtml(t('report.docket'))}</dt><dd>${escapeHtml(ctx.docketNumber)}</dd></div>
        <div><dt>${escapeHtml(t('report.generated'))}</dt><dd>${escapeHtml(formatDateTimeLocalized(ctx.generatedAt))}</dd></div>
      </dl>
    </header>`;
}

function signoffBlock(ctx: ReportContext): string {
  const { handlerName, handlerDesignation } = ctx.particulars;
  const party = (titleKey: string, name: string, designation: string, date: string) => `
      <div class="rpt-party">
        <h4>${escapeHtml(t(titleKey))}</h4>
        <div class="rpt-line"><span>${escapeHtml(t('report.name'))}</span><b>${escapeHtml(name)}</b></div>
        <div class="rpt-line"><span>${escapeHtml(t('report.designation'))}</span><b>${escapeHtml(designation)}</b></div>
        <div class="rpt-line sig"><span>${escapeHtml(t('report.signature'))}</span><b></b></div>
        <div class="rpt-line"><span>${escapeHtml(t('report.date'))}</span><b>${escapeHtml(date)}</b></div>
      </div>`;

  return `<section class="rpt-sec rpt-signoff">
      <h3>${escapeHtml(t('report.sectionSignoff'))}</h3>
      <div class="rpt-parties">
        ${party('report.preparedBy', handlerName, handlerDesignation, formatDateLocalized(ctx.generatedAt))}
        ${party('report.reviewedBy', '', '', '')}
      </div>
    </section>`;
}

/** Remarks: a textarea on screen, plain paragraphs in print (textareas clip on paper). */
function remarksBlock(ctx: ReportContext): HTMLElement {
  const section = document.createElement('section');
  section.className = 'rpt-sec rpt-remarks';

  const heading = document.createElement('h3');
  heading.textContent = t('report.sectionRemarks');

  const box = document.createElement('textarea');
  box.className = 'noprint';
  box.rows = 4;
  box.value = ctx.remarks;
  box.placeholder = t('report.remarksPlaceholder');
  box.setAttribute('aria-label', t('report.sectionRemarks'));

  const printed = document.createElement('div');
  printed.className = 'printonly rpt-remarks-text';

  const paint = () => {
    const text = box.value.trim();
    printed.textContent = text || t('report.remarksNone');
    printed.classList.toggle('blank', !text);
  };
  box.addEventListener('input', () => {
    ctx.onRemarksChange(box.value);
    paint();
  });
  paint();

  section.append(heading, box, printed);
  return section;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function renderValidationReport(result: ClaimValidationResult, ctx: ReportContext): HTMLElement {
  const container = document.createElement('article');
  container.className = 'claimreport';
  container.innerHTML =
    headerBlock(ctx) +
    particularsBlock(result, ctx) +
    documentsBlock(result) +
    checksBlock(result) +
    findingsBlock(result);

  container.appendChild(remarksBlock(ctx));
  container.insertAdjacentHTML(
    'beforeend',
    signoffBlock(ctx) + `<p class="rpt-disclaimer">${escapeHtml(t('report.disclaimer'))}</p>`
  );
  return container;
}

export { PASS, REVIEW, FAIL };
