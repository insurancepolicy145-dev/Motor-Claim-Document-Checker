import './style.css';

import { DOCUMENTS, documentLabelKey } from './config/documentConfig';
import { applyDocumentLanguage, auditStrings, formatDateLocalized, t, tm } from './i18n';
import { createClaimParticulars } from './components/claimParticulars';
import { createAllStates, createDocumentUploader } from './components/documentUploader';
import type { DocumentUploaderHandle } from './components/documentUploader';
import { blankDocumentState } from './components/documentSlot';
import { renderValidationReport } from './components/validationReport';
import { ReaderError, hasReadingService, readDocument } from './services/aiDocumentReader';
import { logProviderStatus } from './services/aiProvider';
import { hasAnyAttachment, missingRequiredNames, validateClaim } from './services/claimValidator';
import { VEHICLE_TYPES } from './types';
import type { ClaimValidationResult, DocumentKey, DocumentStateMap, VehicleType } from './types';

const app = document.getElementById('app')!;

// ---------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------

const wrap = document.createElement('div');
wrap.className = 'wrap';
app.appendChild(wrap);

// ---------------------------------------------------------------------------
// Docket number
//
// One per claim, kept in sessionStorage so a reload of the same tab does not
// hand the claim a new number halfway through. "Clear claim" issues a fresh
// one. Nothing from the claim itself is stored, only this reference.
// ---------------------------------------------------------------------------

const DOCKET_KEY = 'mcdc.docket';

function issueDocket(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const serial = Math.floor(1000 + Math.random() * 9000);
  const docket = `MC/${now.getFullYear()}/${pad(now.getMonth() + 1)}${pad(now.getDate())}-${serial}`;
  try {
    sessionStorage.setItem(DOCKET_KEY, docket);
  } catch {
    // Storage blocked (private mode, policy): the number just won't survive a reload.
  }
  return docket;
}

function currentDocket(): string {
  try {
    const stored = sessionStorage.getItem(DOCKET_KEY);
    if (stored) return stored;
  } catch {
    // fall through
  }
  return issueDocket();
}

let docketNumber = currentDocket();


const masthead = document.createElement('div');
masthead.className = 'masthead noprint';
masthead.innerHTML = `
  <div>
    <h1></h1>
    <p class="lede"></p>
  </div>
  <div class="docket">
    <span class="dlabel"></span><b class="dnum"></b>
    <span class="ddate"></span>
  </div>`;
wrap.appendChild(masthead);

// 01 — claim particulars
const particulars = createClaimParticulars(
  (vehicleType) => requestVehicleTypeChange(vehicleType),
  () => markReportStale()
);
particulars.element.classList.add('noprint');
wrap.appendChild(particulars.element);

// 02 — documents (rebuilt whenever the vehicle type changes)
const uploaderMount = document.createElement('div');
wrap.appendChild(uploaderMount);

// 03 — read and validate
const actions = document.createElement('section');
actions.className = 'step noprint';
actions.innerHTML = `
  <div class="step-head"><span class="step-num">${t('step3.num')}</span><h2></h2></div>
  <div class="card">
    <div class="actbar">
      <button class="act" id="readBtn" type="button" disabled></button>
      <button class="act ghost" id="cancelBtn" type="button" hidden></button>
      <button class="act ghost" id="validateBtn" type="button"></button>
      <span class="status" id="status"></span>
    </div>
    <div class="uploadstatus" id="uploadStatus" role="status" aria-live="polite"></div>
    <div id="readErr"></div>
    <p class="fineprint"></p>
  </div>`;
wrap.appendChild(actions);

// 04 — report
const report = document.createElement('section');
report.className = 'step';
report.innerHTML = `
  <div class="step-head"><span class="step-num">${t('step4.num')}</span><h2></h2></div>
  <div class="stale noprint" id="staleNote" role="status" hidden></div>
  <div id="report"></div>
  <div class="actbar noprint" style="margin-top:14px">
    <button class="act ghost" id="printBtn" type="button"></button>
    <button class="act ghost" id="resetBtn" type="button"></button>
  </div>`;
wrap.appendChild(report);

const footer = document.createElement('footer');
footer.className = 'noprint';
wrap.appendChild(footer);

const readBtn = actions.querySelector<HTMLButtonElement>('#readBtn')!;
const cancelBtn = actions.querySelector<HTMLButtonElement>('#cancelBtn')!;
const validateBtn = actions.querySelector<HTMLButtonElement>('#validateBtn')!;
const statusLine = actions.querySelector<HTMLSpanElement>('#status')!;
const uploadStatus = actions.querySelector<HTMLDivElement>('#uploadStatus')!;
const readErr = actions.querySelector<HTMLDivElement>('#readErr')!;
const reportMount = report.querySelector<HTMLDivElement>('#report')!;
const staleNote = report.querySelector<HTMLDivElement>('#staleNote')!;
const printBtn = report.querySelector<HTMLButtonElement>('#printBtn')!;
const resetBtn = report.querySelector<HTMLButtonElement>('#resetBtn')!;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/**
 * Uploaded documents, kept separately for each vehicle category. Switching
 * category shows that category's own documents; nothing is copied, merged or
 * inherited between categories.
 */
const uploadedDocuments = Object.fromEntries(
  VEHICLE_TYPES.map((vehicleType) => [vehicleType, createAllStates()])
) as Record<VehicleType, DocumentStateMap>;

function escapeHtml(value: unknown): string {
  return String(value).replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string
  );
}

/** Always the selected category's own documents. */
function currentDocuments(): DocumentStateMap {
  return uploadedDocuments[particulars.getVehicleType()];
}
let uploader: DocumentUploaderHandle;
let lastResult: ClaimValidationResult | null = null;
/** True once anything changes after the report was produced. */
let reportStale = false;
/** Handler's remarks, kept here so re-validating does not wipe them. */
let remarks = '';
let readController: AbortController | null = null;

/**
 * Changing category shows that category's own checklist and uploads. Any read
 * in progress belongs to the category being left, so it is stopped.
 */
function requestVehicleTypeChange(vehicleType: VehicleType): boolean {
  readController?.abort();
  readErr.innerHTML = '';
  switchVehicleType(vehicleType);
  return true;
}

function switchVehicleType(vehicleType: VehicleType): void {
  // Only this category's document cards are built, bound to its own state.
  uploaderMount.innerHTML = '';
  uploader = createDocumentUploader(vehicleType, uploadedDocuments[vehicleType], () => {
    markReportStale();
    updateStatus();
  });
  uploaderMount.appendChild(uploader.element);
  clearReport();
  updateStatus();
}

function clearReport(): void {
  lastResult = null;
  reportStale = false;
  staleNote.hidden = true;
  reportMount.innerHTML = `<p class="empty">${t('step4.nothing')}</p>`;
}

/**
 * A printed report must match the values in the boxes. Rather than throw the
 * report away on every keystroke, flag it and refuse to print until the claim
 * is validated again.
 */
function markReportStale(): void {
  if (!lastResult || reportStale) return;
  reportStale = true;
  staleNote.textContent = t('step4.stale');
  staleNote.hidden = false;
  reportMount.classList.add('is-stale');
}

/**
 * Upload completeness, worked out from required documents only. Optional
 * documents never appear here and never hold anything up. This is separate
 * from the claim verdict, which only the validation report decides.
 */
function renderUploadStatus(missingLabelKeys: string[]): void {
  if (missingLabelKeys.length > 0) {
    uploadStatus.className = 'uploadstatus missing';
    uploadStatus.innerHTML = `
      <p class="ustitle">${escapeHtml(t('upload.missingTitle'))}</p>
      <p class="usbody">${escapeHtml(t('upload.missingBody'))}</p>
      <p class="uslisttitle">${escapeHtml(t('upload.missingList'))}</p>
      <ul>${missingLabelKeys.map((key) => `<li>${escapeHtml(t(key))}</li>`).join('')}</ul>`;
  } else {
    uploadStatus.className = 'uploadstatus ready';
    uploadStatus.innerHTML = `
      <p class="ustitle">✅ ${escapeHtml(t('upload.readyTitle'))}</p>
      <p class="usbody">${escapeHtml(t('upload.readyBody'))}</p>`;
  }
}

function updateStatus(): void {
  const vehicleType = particulars.getVehicleType();
  const documents = currentDocuments();
  const missingKeys = missingRequiredNames(vehicleType, documents);

  renderUploadStatus(missingKeys);
  // Validation opens only once every required document is uploaded.
  validateBtn.disabled = missingKeys.length > 0;

  // Both buttons always stay on the page. With no reading service configured,
  // Read Documents could only produce one identical error per document, so it
  // is disabled and the reason is shown rather than the button disappearing.
  if (!hasReadingService()) {
    readBtn.hidden = false;
    readBtn.disabled = true;
    readBtn.title = t('step3.noService');
    statusLine.textContent = t('step3.noService');
    return;
  }

  readBtn.hidden = false;
  readBtn.title = '';
  readBtn.disabled = !hasAnyAttachment(vehicleType, documents) || readController !== null;
  if (readController === null) statusLine.textContent = '';
}

// ---------------------------------------------------------------------------
// Static labels, repainted on every locale change
// ---------------------------------------------------------------------------

function paintChrome(): void {
  masthead.querySelector('h1')!.textContent = t('app.title');
  masthead.querySelector('.lede')!.textContent = t('app.subtitle');
  masthead.querySelector('.dlabel')!.textContent = t('app.docket');
  masthead.querySelector('.ddate')!.textContent = formatDateLocalized(new Date());
  masthead.querySelector('.dnum')!.textContent = docketNumber;

  actions.querySelector('h2')!.textContent = t('step3.title');
  actions.querySelector('.fineprint')!.textContent = t('step3.fineprint');
  readBtn.textContent = t('step3.read');
  cancelBtn.textContent = t('step3.cancel');
  validateBtn.textContent = t('step3.validate');

  report.querySelector('h2')!.textContent = t('step4.title');
  printBtn.textContent = t('step4.print');
  resetBtn.textContent = t('step4.reset');

  footer.textContent = t('app.footer');
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

async function readOne(
  documents: DocumentStateMap,
  key: DocumentKey,
  signal: AbortSignal
): Promise<boolean> {
  const state = documents[key];
  const usable = state.files.filter((file) => file.status === 'READY');
  if (usable.length === 0) return false;

  state.status = 'READING';
  state.error = null;
  // The user may have moved to another category meanwhile; only refresh the
  // cards if these documents are still the ones on screen.
  if (documents === currentDocuments()) uploader.refresh(key);

  try {
    const extracted = await readDocument(usable, DOCUMENTS[key], { signal });
    state.data = extracted.fields;
    state.confidence = extracted.confidence;
    state.warnings = extracted.warnings;
    state.documentType = extracted.documentType;
    state.originalText = extracted.originalText;
    state.status = 'READ';
    state.error = null;
  } catch (error) {
    state.status = 'ERROR';
    state.error = error instanceof ReaderError ? error.localized : { key: 'err.readFailed' };
    state.data = {};
  }

  // The user may have moved to another category meanwhile; only refresh the
  // cards if these documents are still the ones on screen.
  if (documents === currentDocuments()) uploader.refresh(key);
  return state.status === 'READ';
}

readBtn.addEventListener('click', async () => {
  markReportStale();
  readController = new AbortController();
  readBtn.disabled = true;
  cancelBtn.hidden = false;
  readErr.innerHTML = '';

  // Read the documents of the category that was selected when reading began.
  const documents = currentDocuments();
  const keys = uploader
    .getActiveKeys()
    .filter((key) => documents[key].files.some((file) => file.status === 'READY'));

  const errors: string[] = [];
  let done = 0;

  for (const key of keys) {
    if (readController.signal.aborted) break;
    statusLine.textContent = t('step3.readingDoc', {
      name: t(documentLabelKey(particulars.getVehicleType(), key)),
    });
    const ok = await readOne(documents, key, readController.signal);
    if (ok) done++;
    else if (documents[key].error) errors.push(tm(documents[key].error));
  }

  const aborted = readController.signal.aborted;
  readController = null;
  cancelBtn.hidden = true;

  statusLine.textContent = aborted
    ? t('err.cancelled')
    : t('step3.readSummary', { done, total: keys.length });

  if (errors.length > 0 && !aborted) {
    readErr.innerHTML = `<div class="err">${errors
      .map((e) =>
        e.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string)
      )
      .join('<br>')}</div>`;
  }
  readBtn.disabled = false;
});

cancelBtn.addEventListener('click', () => {
  readController?.abort();
});

// ---------------------------------------------------------------------------
// Validating
// ---------------------------------------------------------------------------

validateBtn.addEventListener('click', () => {
  const vehicleType = particulars.getVehicleType();
  const documents = currentDocuments();

  // Required documents gate validation; optional documents never do. The
  // button is disabled while any are missing, so this is a safeguard.
  if (missingRequiredNames(vehicleType, documents).length > 0) {
    clearReport();
    updateStatus();
    uploadStatus.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return;
  }

  lastResult = validateClaim(vehicleType, documents, particulars.getParticulars());
  reportStale = false;
  staleNote.hidden = true;
  reportMount.classList.remove('is-stale');
  reportMount.innerHTML = '';
  reportMount.appendChild(
    renderValidationReport(lastResult, {
      docketNumber,
      generatedAt: new Date(),
      particulars: particulars.getParticulars(),
      documents,
      remarks,
      onRemarksChange: (value) => {
        remarks = value;
      },
    })
  );
  reportMount.scrollIntoView({ behavior: 'smooth', block: 'start' });
});

// ---------------------------------------------------------------------------
// Print and reset
// ---------------------------------------------------------------------------

printBtn.addEventListener('click', () => {
  if (!lastResult) {
    alert(t('step4.printFirst'));
    return;
  }
  if (reportStale) {
    alert(t('step4.printStale'));
    return;
  }
  // Browsers use the page title as the default PDF file name.
  const previousTitle = document.title;
  const { claimNumber } = particulars.getParticulars();
  document.title = `${t('report.title')} - ${claimNumber || docketNumber}`.replace(/[\\/:*?"<>|]/g, '-');
  window.addEventListener('afterprint', () => (document.title = previousTitle), { once: true });
  requestAnimationFrame(() => setTimeout(() => window.print(), 30));
});

resetBtn.addEventListener('click', () => {
  readController?.abort();
  // A new claim starts empty in every category.
  for (const vehicleType of VEHICLE_TYPES) {
    const documents = uploadedDocuments[vehicleType];
    for (const key of Object.keys(DOCUMENTS) as DocumentKey[]) {
      for (const attached of documents[key].files) {
        if (attached.url) URL.revokeObjectURL(attached.url);
      }
      documents[key] = blankDocumentState(DOCUMENTS[key]);
    }
  }
  readErr.innerHTML = '';
  remarks = '';
  particulars.clearClaimNumber();
  docketNumber = issueDocket();
  paintChrome();
  switchVehicleType(particulars.getVehicleType());
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

applyDocumentLanguage();
paintChrome();
switchVehicleType(particulars.getVehicleType());

// Reports any string-table gap to the console in development; a no-op in a
// production build.
auditStrings();
logProviderStatus();
