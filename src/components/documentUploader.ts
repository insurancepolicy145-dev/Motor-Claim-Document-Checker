import { DOCUMENTS, activeKeys, getConfig } from '../config/documentConfig';
import { t } from '../i18n';
import { blankDocumentState, createDocumentSlot } from './documentSlot';
import type { DocumentSlotHandle } from './documentSlot';
import type {
  DocumentKey,
  DocumentState,
  DocumentStateMap,
  VehicleDocumentEntry,
  VehicleType,
} from '../types';

export interface DocumentUploaderHandle {
  element: HTMLElement;
  /** State for every document, keyed by document key. */
  getStates: () => DocumentStateMap;
  getState: (key: DocumentKey) => DocumentState;
  /** Keys shown for the current vehicle type, required first. */
  getActiveKeys: () => DocumentKey[];
  /** Re-render one card, e.g. while it is being read. */
  refresh: (key: DocumentKey) => void;
  refreshAll: () => void;
}

/**
 * State exists for every document key, not only the ones shown. The caller
 * keeps it across vehicle-type changes, so switching type and back does not
 * lose attachments; validation only ever looks at documents shown for the
 * selected type, so nothing from a hidden document leaks into the checks.
 */
function createAllStates(): DocumentStateMap {
  const states = {} as DocumentStateMap;
  for (const key of Object.keys(DOCUMENTS) as DocumentKey[]) {
    states[key] = blankDocumentState(DOCUMENTS[key]);
  }
  return states;
}

export function createDocumentUploader(
  vehicleType: VehicleType,
  states: DocumentStateMap | null,
  onAttachmentsChange: () => void
): DocumentUploaderHandle {
  const documentStates = states ?? createAllStates();
  const slots = new Map<DocumentKey, DocumentSlotHandle>();

  const section = document.createElement('section');
  section.className = 'step';
  section.id = 'docStep';
  section.innerHTML = `
    <div class="step-head"><span class="step-num">${t('step2.num')}</span><h2></h2>
      <span class="hint"></span></div>
    <p class="chooseinput"></p>
    <div class="vehiclehead">
      <span class="vehiclekicker"></span>
      <h3 class="vehiclename"></h3>
    </div>
    <div class="slotgroups"></div>`;

  const groups = section.querySelector<HTMLDivElement>('.slotgroups')!;
  const heading = section.querySelector<HTMLHeadingElement>('h2')!;
  const hint = section.querySelector<HTMLSpanElement>('.hint')!;
  const choose = section.querySelector<HTMLParagraphElement>('.chooseinput')!;
  const vehicleKicker = section.querySelector<HTMLSpanElement>('.vehiclekicker')!;
  const vehicleName = section.querySelector<HTMLHeadingElement>('.vehiclename')!;
  section.dataset.vehicle = vehicleType;
  const groupTitles: Array<{ el: HTMLElement; key: string }> = [];

  function buildGroup(
    titleKey: string,
    descKey: string,
    entries: VehicleDocumentEntry[],
    required: boolean
  ): HTMLElement {
    const group = document.createElement('div');
    group.className = 'slotgroup';
    group.dataset.group = required ? 'required' : 'optional';

    const groupHeading = document.createElement('h3');
    groupHeading.textContent = t(titleKey);
    groupTitles.push({ el: groupHeading, key: titleKey });
    group.appendChild(groupHeading);

    const groupDesc = document.createElement('p');
    groupDesc.className = 'groupdesc';
    groupDesc.textContent = t(descKey);
    groupTitles.push({ el: groupDesc, key: descKey });
    group.appendChild(groupDesc);

    if (entries.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = t('step2.none');
      groupTitles.push({ el: empty, key: 'step2.none' });
      group.appendChild(empty);
      return group;
    }

    const grid = document.createElement('div');
    grid.className = 'slots';
    for (const { key, labelKey } of entries) {
      const slot = createDocumentSlot(
        DOCUMENTS[key],
        documentStates[key],
        required,
        onAttachmentsChange,
        labelKey
      );
      slot.element.dataset.doc = key;
      slots.set(key, slot);
      grid.appendChild(slot.element);
    }
    group.appendChild(grid);
    return group;
  }

  const config = getConfig(vehicleType);
  groups.appendChild(buildGroup('step2.requiredTitle', 'step2.requiredDesc', config.required, true));
  groups.appendChild(buildGroup('step2.optionalTitle', 'step2.optionalDesc', config.optional, false));

  function paintLabels(): void {
    heading.textContent = t('step2.title');
    hint.textContent = t('step2.formats');
    choose.textContent = t('input.choose');
    // The selected category heads the checklist, above every document name.
    vehicleKicker.textContent = t('step2.vehicleCategory');
    vehicleName.textContent = t(`vehicle.${vehicleType}`);
    for (const entry of groupTitles) entry.el.textContent = t(entry.key);
  }

  paintLabels();

  return {
    element: section,
    getStates: () => documentStates,
    getState: (key) => documentStates[key],
    getActiveKeys: () => activeKeys(vehicleType),
    refresh: (key) => slots.get(key)?.refresh(),
    refreshAll: () => {
      paintLabels();
      slots.forEach((slot) => slot.refresh());
    },
  };
}

export { createAllStates };
