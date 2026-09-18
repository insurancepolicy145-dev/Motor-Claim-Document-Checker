import { formatBytes, t, tm } from '../i18n';
import { LOW_CONFIDENCE } from '../services/aiDocumentReader';
import { extractDocxText, DocxExtractionError } from '../services/docxExtractor';
import { ACCEPT_ATTRIBUTE, validateFile } from '../services/fileValidation';
import { preloadOpenCv } from '../services/opencvLoader';
import { type ScanOutcome, type ScanSource, openDocumentScanner, openScanViewer } from './documentScanner';
import { cameraIcon } from './icons';
import type { AttachedFile, DocumentDefinition, DocumentState } from '../types';

export interface DocumentSlotHandle {
  element: HTMLElement;
  /** Re-render thumbnails, status line and readout from current state. */
  refresh: () => void;
}

/** Fresh, empty state for one document. */
export function blankDocumentState(def: DocumentDefinition): DocumentState {
  return {
    key: def.key,
    files: [],
    status: 'IDLE',
    error: null,
    data: {},
    confidence: null,
    warnings: [],
    documentType: '',
    originalText: '',
  };
}

/** Clears everything read so far, leaving attachments alone. */
export function clearExtraction(state: DocumentState): void {
  state.status = 'IDLE';
  state.error = null;
  state.data = {};
  state.confidence = null;
  state.warnings = [];
  state.documentType = '';
  state.originalText = '';
}

function escapeHtml(value: unknown): string {
  return String(value).replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string
  );
}

/**
 * Renders one document card.
 *
 * Reading is driven by the single "Read documents" control in step 03; this
 * card reports progress on its own status line. Both input methods live here
 * side by side, per the interface spec.
 */
export function createDocumentSlot(
  def: DocumentDefinition,
  state: DocumentState,
  required: boolean,
  onAttachmentsChange: () => void,
  /** Display name as worded for the selected vehicle type. */
  labelKey: string = def.nameKey
): DocumentSlotHandle {
  const card = document.createElement('div');
  card.className = 'slot' + (required ? ' req' : '') + (def.multi ? ' multi' : '');

  card.innerHTML = `
    <span class="tag ${required ? '' : 'opt'}"></span>
    <h4><span class="docname"></span>${required ? '<span class="reqmark" aria-hidden="true"> *</span>' : ''}</h4>
    <p class="sub"></p>
    <div class="btns">
      <button type="button" class="camicon">${cameraIcon()}</button>
      <label class="inbtn upload">📄 <span></span>
        <input type="file" accept="${ACCEPT_ATTRIBUTE}" ${def.multi ? 'multiple' : ''}>
      </label>
      <input type="file" class="capinput" accept="image/*" capture="environment" hidden>
    </div>
    <p class="formats"></p>
    <div class="docpreview"></div>
    <p class="docstatus"><span class="docstatuslabel"></span> <b></b></p>
    <div class="files"></div>
    <div class="slotfoot"><span class="slotmsg"></span></div>
    <div class="readout" style="display:none"></div>`;

  const tag = card.querySelector<HTMLSpanElement>('.tag')!;
  const title = card.querySelector<HTMLSpanElement>('h4 .docname')!;
  const sub = card.querySelector<HTMLParagraphElement>('.sub')!;
  const photoBtn = card.querySelector<HTMLButtonElement>('.camicon')!;
  const uploadButton = card.querySelector<HTMLLabelElement>('.inbtn.upload')!;
  const uploadLabel = card.querySelector<HTMLSpanElement>('.inbtn.upload span')!;
  const captureInput = card.querySelector<HTMLInputElement>('.capinput')!;
  let preview: HTMLElement = card.querySelector<HTMLDivElement>('.docpreview')!;
  const docStatusLabel = card.querySelector<HTMLSpanElement>('.docstatuslabel')!;
  const docStatusValue = card.querySelector<HTMLElement>('.docstatus b')!;
  const formats = card.querySelector<HTMLParagraphElement>('.formats')!;
  const fileList = card.querySelector<HTMLDivElement>('.files')!;
  const message = card.querySelector<HTMLSpanElement>('.slotmsg')!;
  const readout = card.querySelector<HTMLDivElement>('.readout')!;
  const input = card.querySelector<HTMLInputElement>('input[type=file]')!;

  // ---- attaching ---------------------------------------------------------

  /** Lower-case stem for scan file names, e.g. POLICY → policy_scan.jpg. */
  const fileStem = def.key.toLowerCase();

  /**
   * When set, the next scan replaces the attachment at this index instead of
   * being added (Retake / Adjust on an existing scan).
   */
  let replaceIndex: number | null = null;

  function scannerRequest(source: ScanSource) {
    return {
      documentName: t(labelKey),
      fileStem,
      source,
      onUploadInstead: () => input.click(),
    };
  }

  input.addEventListener('change', () => {
    const picked = Array.from(input.files ?? []);
    input.value = '';
    const target = replaceIndex;
    replaceIndex = null;
    if (picked.length > 0) void addPicked(picked, target);
  });

  captureInput.addEventListener('change', () => {
    const picked = Array.from(captureInput.files ?? []);
    captureInput.value = '';
    if (picked.length > 0) void addPicked(picked, null, 'camera');
  });

  photoBtn.addEventListener('pointerenter', preloadOpenCv, { once: true });
  photoBtn.addEventListener('click', async () => {
    // Where the in-page camera cannot run (no camera API, or a plain-HTTP
    // address on a phone), hand over to the device's own camera or file
    // picker instead. This must happen inside the click to be allowed.
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      captureInput.click();
      return;
    }
    const outcome = await openDocumentScanner(scannerRequest('camera'));
    if (outcome) await addScan(outcome, null);
  });

  /**
   * Uploaded photos (JPG, PNG, WEBP) go through the same scanner as the camera:
   * edges detected, corners adjustable, perspective corrected, previewed. PDFs,
   * Word documents and anything invalid take the existing path unchanged.
   */
  async function addPicked(files: File[], target: number | null, source: ScanSource = 'upload'): Promise<void> {
    for (const file of files) {
      const outcome = await validateFile(file);
      if (!outcome.ok || outcome.kind !== 'image') {
        await addFiles([file], source);
        continue;
      }
      const scanned = await openDocumentScanner({ ...scannerRequest(source), image: file });
      if (scanned) await addScan(scanned, target);
      // A replacement applies to the first image only.
      target = null;
    }
  }

  /** Commits a scan to this document's own state, replacing or adding as appropriate. */
  async function addScan(outcome: ScanOutcome, target: number | null): Promise<void> {
    let name = outcome.file.name;
    if (def.multi) {
      const taken = new Set(state.files.filter((_, i) => i !== target).map((f) => f.name));
      for (let n = 2; taken.has(name); n++) name = `${fileStem}_scan_${n}.jpg`;
    }
    const file = name === outcome.file.name ? outcome.file : new File([outcome.file], name, { type: outcome.file.type });

    const attached: AttachedFile = {
      file,
      url: URL.createObjectURL(file),
      name,
      size: file.size,
      kind: 'image',
      source: outcome.source,
      status: 'CHECKING',
      scan: {
        original: outcome.original,
        quad: outcome.quad,
        mode: outcome.mode,
        output: outcome.output,
        detected: outcome.detected,
      },
    };

    if (target !== null && state.files[target]) {
      const previous = state.files[target];
      if (previous.url) URL.revokeObjectURL(previous.url);
      state.files[target] = attached;
    } else if (!def.multi) {
      releaseUrls();
      state.files = [attached];
    } else {
      state.files.push(attached);
    }
    render();

    const checked = await validateFile(file);
    attached.status = checked.ok ? 'READY' : 'ERROR';
    if (!checked.ok) attached.error = checked.error;

    // Any new attachment invalidates whatever was read before.
    clearExtraction(state);
    render();
    onAttachmentsChange();
  }

  function retakeAt(index: number): void {
    const attached = state.files[index];
    if (!attached) return;
    if (attached.source === 'camera') {
      void openDocumentScanner(scannerRequest('camera')).then((outcome) => {
        if (outcome) void addScan(outcome, index);
      });
    } else {
      // Opened inside the click so the browser allows the file picker.
      replaceIndex = index;
      input.click();
    }
  }

  function adjustAt(index: number): void {
    const attached = state.files[index];
    if (!attached?.scan) return;
    void openDocumentScanner({
      ...scannerRequest(attached.source),
      image: attached.scan.original,
      quad: attached.scan.quad,
      mode: attached.scan.mode,
      startInAdjust: true,
    }).then((outcome) => {
      // Re-adjusting keeps the original: it was the input, not a new capture.
      if (outcome) void addScan({ ...outcome, source: attached.source }, index);
    });
  }

  function viewAt(index: number): void {
    const attached = state.files[index];
    if (!attached?.url) return;
    openScanViewer({
      title: t(labelKey),
      imageUrl: attached.url,
      imageName: attached.name,
      scan: attached.scan
        ? { original: attached.scan.original, quad: attached.scan.quad, output: attached.scan.output }
        : undefined,
      onAdjust: attached.scan ? () => adjustAt(index) : undefined,
      onRetake: () => retakeAt(index),
      onRemove: () => removeAt(index),
    });
  }

  /**
   * Validates each file, extracts DOCX text up front, and only then commits it
   * to state. A rejected file is still shown, with its reason, rather than
   * silently dropped — the user needs to know why nothing happened.
   */
  async function addFiles(files: File[], source: 'upload' | 'camera'): Promise<void> {
    if (!def.multi) {
      releaseUrls();
      state.files = [];
    }

    for (const file of files) {
      const attached: AttachedFile = {
        file,
        url: null,
        name: file.name,
        size: file.size,
        kind: 'image',
        source,
        status: 'CHECKING',
      };
      state.files.push(attached);
      render();

      const outcome = await validateFile(file);
      if (!outcome.ok) {
        attached.status = 'ERROR';
        attached.error = outcome.error;
        attached.kind = outcome.kind ?? 'image';
        render();
        onAttachmentsChange();
        continue;
      }

      attached.kind = outcome.kind!;
      attached.pages = outcome.pages;
      if (attached.kind === 'image') attached.url = URL.createObjectURL(file);

      if (attached.kind === 'docx') {
        attached.status = 'EXTRACTING';
        render();
        try {
          const extraction = await extractDocxText(file);
          attached.extractedText = extraction.text;
          attached.status = 'READY';
        } catch (error) {
          attached.status = 'ERROR';
          attached.error =
            error instanceof DocxExtractionError ? error.message_ : { key: 'err.corrupt' };
        }
      } else {
        attached.status = 'READY';
      }

      render();
      onAttachmentsChange();
    }

    // Any new attachment invalidates whatever was read before.
    clearExtraction(state);
    render();
    onAttachmentsChange();
  }

  function releaseUrls(): void {
    for (const attached of state.files) {
      if (attached.url) URL.revokeObjectURL(attached.url);
    }
  }

  function removeAt(index: number): void {
    const attached = state.files[index];
    if (attached?.url) URL.revokeObjectURL(attached.url);
    state.files.splice(index, 1);
    clearExtraction(state);
    render();
    onAttachmentsChange();
  }

  // ---- rendering ---------------------------------------------------------

  function renderFiles(): void {
    fileList.innerHTML = '';

    state.files.forEach((attached, index) => {
      const row = document.createElement('div');
      row.className = 'filerow' + (attached.status === 'ERROR' ? ' bad' : '');

      // Images stay visible as a thumbnail; clicking opens a larger preview.
      const thumb = document.createElement(attached.url ? 'button' : 'div');
      thumb.className = 'thumb';
      if (attached.url) {
        (thumb as HTMLButtonElement).type = 'button';
        thumb.setAttribute('aria-label', `${t('scan.view')}: ${attached.name}`);
        thumb.addEventListener('click', () => viewAt(index));
      }
      thumb.innerHTML = attached.url
        ? `<img src="${attached.url}" alt="${escapeHtml(attached.name)}">`
        : `<div class="ficon">${attached.kind === 'pdf' ? 'PDF' : 'DOC'}</div>`;
      row.appendChild(thumb);

      const meta = document.createElement('div');
      meta.className = 'fmeta';

      const statusText =
        attached.status === 'ERROR'
          ? tm(attached.error)
          : attached.status === 'CHECKING'
          ? t('file.status.checking')
          : attached.status === 'EXTRACTING'
          ? t('file.status.extracting')
          : t('file.status.ready');

      const details = [
        attached.kind.toUpperCase(),
        formatBytes(attached.size),
        attached.pages ? t('file.pages', { count: attached.pages }) : '',
        attached.source === 'camera' ? t('file.fromCamera') : '',
        attached.scan ? t('scan.scanned') : '',
      ]
        .filter(Boolean)
        .join(' · ');

      meta.innerHTML = `
        <span class="fname" title="${escapeHtml(attached.name)}">${escapeHtml(attached.name)}</span>
        <span class="fdetail">${escapeHtml(details)}</span>
        <span class="fstatus ${attached.status === 'ERROR' ? 'bad' : ''}">${escapeHtml(statusText)}</span>`;

      if (attached.status === 'CHECKING' || attached.status === 'EXTRACTING') {
        const bar = document.createElement('div');
        bar.className = 'fprogress';
        bar.innerHTML = '<i></i>';
        meta.appendChild(bar);
      }

      if (attached.url && attached.status !== 'ERROR') {
        const links = document.createElement('span');
        links.className = 'factions';
        const link = (labelKey: string, action: () => void) => {
          const button = document.createElement('button');
          button.type = 'button';
          button.textContent = t(labelKey);
          button.setAttribute('aria-label', `${t(labelKey)}: ${attached.name}`);
          button.addEventListener('click', action);
          links.appendChild(button);
        };
        link('scan.view', () => viewAt(index));
        link('scan.retake', () => retakeAt(index));
        link('scan.remove', () => removeAt(index));
        meta.appendChild(links);
      }

      row.appendChild(meta);

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'fremove';
      remove.textContent = '×';
      remove.setAttribute('aria-label', `${t('file.remove')}: ${attached.name}`);
      remove.addEventListener('click', () => removeAt(index));
      row.appendChild(remove);

      fileList.appendChild(row);
    });
  }

  /**
   * The card's preview area: the attached image in full, at its own aspect
   * ratio (nothing cropped by the card), or an empty placeholder.
   */
  function renderPreview(): void {
    const usable = state.files.filter((f) => f.status !== 'ERROR');
    const firstImageIndex = state.files.findIndex((f) => f.url && f.status !== 'ERROR');
    let next: HTMLElement;

    if (usable.length === 0) {
      next = document.createElement('div');
      next.className = 'docpreview empty';
      next.innerHTML = `<span class="pvtitle">${escapeHtml(t('card.previewEmpty'))}</span>
        <span class="pvhint">${escapeHtml(t('card.previewEmptyHint'))}</span>`;
    } else if (firstImageIndex >= 0) {
      const attached = state.files[firstImageIndex];
      next = document.createElement('button');
      (next as HTMLButtonElement).type = 'button';
      next.className = 'docpreview filled';
      next.setAttribute('aria-label', `${t('scan.view')}: ${attached.name}`);
      next.innerHTML = `<img src="${attached.url}" alt="${escapeHtml(t('card.previewAlt', { doc: t(labelKey) }))}">`;
      next.addEventListener('click', () => viewAt(firstImageIndex));
      if (usable.length > 1) {
        const more = document.createElement('span');
        more.className = 'pvmore';
        more.textContent = t('card.previewMore', { count: usable.length - 1 });
        next.appendChild(more);
      }
    } else {
      const doc = usable[0];
      next = document.createElement('div');
      next.className = 'docpreview filled doc';
      next.innerHTML = `<div class="ficon">${doc.kind === 'pdf' ? 'PDF' : 'DOC'}</div>
        <span class="pvname">${escapeHtml(doc.name)}</span>`;
    }

    preview.replaceWith(next);
    preview = next;
  }

  /** "Status: Not Uploaded / Checking… / ✅ Uploaded / Upload failed" for this card. */
  function renderCardStatus(): void {
    const files = state.files;
    let key = 'card.status.notUploaded';
    let tone = '';
    if (files.some((f) => f.status === 'READY' || f.status === 'EXTRACTING')) {
      key = 'card.status.uploaded';
      tone = 'good';
    } else if (files.some((f) => f.status === 'CHECKING')) {
      key = 'card.status.checking';
    } else if (files.length > 0) {
      key = 'card.status.failed';
      tone = 'bad';
    }
    docStatusLabel.textContent = t('card.status');
    docStatusValue.textContent = t(key);
    docStatusValue.className = tone;
    card.dataset.upload = key.split('.').pop()!;

    // Camera icon: green once an image has been captured for this document;
    // disabled (grey) while the document is being read.
    const busy = state.status === 'READING';
    const captured = files.some((f) => f.kind === 'image' && f.status === 'READY');
    photoBtn.disabled = busy;
    photoBtn.classList.toggle('captured', captured && !busy);
    uploadButton.classList.toggle('disabled', busy);
    input.disabled = busy;

    uploadLabel.textContent =
      !def.multi && files.some((f) => f.status !== 'ERROR') ? t('input.replace') : t('input.upload');
  }

  function renderStatus(): void {
    if (state.status === 'READING') {
      message.className = 'slotmsg';
      message.textContent = t('file.status.reading');
      return;
    }
    if (state.status === 'ERROR') {
      message.className = 'slotmsg bad';
      message.textContent = tm(state.error);
      return;
    }
    if (state.status === 'READ') {
      // Hand-entered values are not a scan result and should not be reported
      // with a confidence percentage.
      if (state.documentType === 'MANUAL') {
        message.className = 'slotmsg good';
        message.textContent = t('manual.entered');
        return;
      }
      const confidence = state.confidence ?? 0;
      const percent = Math.round(confidence * 100);
      const low = confidence < LOW_CONFIDENCE;
      message.className = `slotmsg ${low ? 'bad' : 'good'}`;
      message.textContent = low
        ? t('ocr.confidenceLow', { percent })
        : t('ocr.confidence', { percent });
      return;
    }

    const count = state.files.filter((f) => f.status !== 'ERROR').length;
    message.className = 'slotmsg';
    message.textContent = count
      ? count === 1
        ? t('file.attached', { count })
        : t('file.attachedPlural', { count })
      : '';
  }


  /**
   * Populates the readout with blank fields so values can be typed in.
   *
   * The claim is marked READ at full confidence because a human transcribing
   * from the document in front of them is a better source than any scan. All
   * seven cross-checks then run exactly as they would after an automated read,
   * which is what lets the application work with no reading service at all.
   */
  function beginManualEntry(): void {
    const blank: Record<string, string> = {};
    for (const field of def.fields) blank[field] = '';
    state.data = blank;
    state.status = 'READ';
    state.confidence = 1;
    state.warnings = [];
    state.documentType = 'MANUAL';
    state.error = null;
    render();
    onAttachmentsChange();
  }

  function renderReadout(): void {
    if (Object.keys(state.data).length === 0) {
      // Nothing read yet. Once something is attached, offer to type the values
      // in rather than leaving the card with no way forward.
      const usable = state.files.some((f) => f.status === 'READY');
      if (!usable || state.status === 'READING') {
        readout.style.display = 'none';
        readout.innerHTML = '';
        return;
      }

      readout.style.display = 'block';
      readout.innerHTML = '';

      const hint = document.createElement('p');
      hint.className = 'manualhint';
      hint.textContent = t('manual.hint');

      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'manualbtn';
      button.textContent = t('manual.enter');
      button.addEventListener('click', beginManualEntry);

      readout.append(hint, button);
      return;
    }

    readout.style.display = 'block';
    readout.innerHTML =
      `<div class="rl">${escapeHtml(t('ocr.readoutTitle'))}</div>` +
      def.fields
        .map(
          (field) =>
            `<div class="frow"><span>${escapeHtml(t(`field.${field}`))}</span>
             <input type="text" data-field="${field}" value="${escapeHtml(
               state.data[field] ?? ''
             )}"></div>`
        )
        .join('') +
      (state.warnings.length
        ? `<ul class="warnlist">${state.warnings
            .map((w) => `<li>${escapeHtml(w)}</li>`)
            .join('')}</ul>`
        : '');

    // Edits go straight into state, so validation uses the corrected value.
    for (const box of Array.from(readout.querySelectorAll<HTMLInputElement>('input'))) {
      box.addEventListener('input', () => {
        state.data[box.dataset.field!] = box.value;
      });
    }

    // Original text, kept verbatim and collapsed by default.
    if (state.originalText) {
      const details = document.createElement('details');
      details.className = 'origtext';
      const summary = document.createElement('summary');
      summary.textContent = t('ocr.showOriginal');
      const pre = document.createElement('pre');
      pre.textContent = state.originalText;
      details.append(summary, pre);
      readout.appendChild(details);
    }
  }

  function renderLabels(): void {
    tag.textContent = required ? t('step2.required') : t('step2.optional');
    title.textContent = t(labelKey);
    sub.textContent = t(def.hintKey);
    // The camera button shows only an icon; its name is for screen readers.
    photoBtn.setAttribute('aria-label', t('input.photo'));
    photoBtn.title = t('input.cameraAlt');
    formats.textContent = t('input.supported');
  }

  function render(): void {
    renderLabels();
    renderFiles();
    renderPreview();
    renderCardStatus();
    renderStatus();
    renderReadout();
  }


  render();

  return { element: card, refresh: render };
}
