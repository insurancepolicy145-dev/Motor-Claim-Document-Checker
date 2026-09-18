import { t } from '../i18n';
import { VEHICLE_TYPES } from '../types';
import type { ClaimParticulars, VehicleType } from '../types';

export interface ClaimParticularsHandle {
  element: HTMLElement;
  getVehicleType: () => VehicleType;
  getParticulars: () => ClaimParticulars;
  /** Re-label everything after a locale change. */
  refresh: () => void;
  /** Empties the claim number for a new claim; handler details are kept. */
  clearClaimNumber: () => void;
}

const REVERSE_GEOCODE = 'https://nominatim.openstreetmap.org/reverse';

interface NominatimAddress {
  town?: string;
  city?: string;
  village?: string;
  suburb?: string;
  county?: string;
  state?: string;
  country?: string;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export function createClaimParticulars(
  /** Called before the type changes; return false to keep the current type. */
  onVehicleTypeChange: (vehicleType: VehicleType) => boolean | void,
  /** Called whenever any typed particular changes. */
  onChange: () => void = () => undefined
): ClaimParticularsHandle {
  let vehicleType: VehicleType = 'PRIVATE_CAR';

  const section = document.createElement('section');
  section.className = 'step';
  section.innerHTML = `
    <div class="step-head"><span class="step-num">${t('step1.num')}</span><h2></h2></div>
    <div class="card">
      <div class="grid3">
        <label class="fld"><span class="lbl-claimno"></span>
          <input type="text" id="claimNo" autocomplete="off"></label>
        <label class="fld"><span class="lbl-handler"></span>
          <input type="text" id="handlerName" autocomplete="name"></label>
        <label class="fld"><span class="lbl-designation"></span>
          <input type="text" id="handlerDesignation" autocomplete="organization-title"></label>
      </div>
      <label class="fld"><span class="lbl-vtype"></span></label>
      <div class="seg noprint" id="vehicleSeg" style="margin-bottom:14px"></div>
      <div class="grid3">
        <label class="fld"><span class="lbl-date"></span>
          <input type="date" id="accDate" value="${todayIso()}"></label>
        <label class="fld"><span class="lbl-place"></span>
          <input type="text" id="accPlace" dir="auto"></label>
        <label class="fld"><span class="lbl-state"></span>
          <input type="text" id="accState" dir="auto"></label>
      </div>
      <div class="locrow noprint">
        <button type="button" class="locbtn" id="locBtn"></button>
        <span class="locstatus" id="locStatus"></span>
      </div>
    </div>`;

  const heading = section.querySelector<HTMLHeadingElement>('h2')!;
  const seg = section.querySelector<HTMLDivElement>('#vehicleSeg')!;
  const accDate = section.querySelector<HTMLInputElement>('#accDate')!;
  const accPlace = section.querySelector<HTMLInputElement>('#accPlace')!;
  const accState = section.querySelector<HTMLInputElement>('#accState')!;
  const claimNo = section.querySelector<HTMLInputElement>('#claimNo')!;
  const handlerName = section.querySelector<HTMLInputElement>('#handlerName')!;
  const handlerDesignation = section.querySelector<HTMLInputElement>('#handlerDesignation')!;
  const locBtn = section.querySelector<HTMLButtonElement>('#locBtn')!;

  for (const box of [claimNo, handlerName, handlerDesignation, accDate, accPlace, accState]) {
    box.addEventListener('input', onChange);
  }
  const locStatus = section.querySelector<HTMLSpanElement>('#locStatus')!;

  // ---- vehicle type -------------------------------------------------------

  for (const type of VEHICLE_TYPES) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.type = type;
    button.setAttribute('aria-pressed', String(type === vehicleType));
    button.innerHTML = '<b></b><small></small>';
    seg.appendChild(button);
  }

  seg.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button');
    if (!button) return;
    const next = button.dataset.type as VehicleType;
    // Re-selecting the current type must not rebuild (and so clear) documents.
    if (next === vehicleType) return;
    const previous = vehicleType;
    vehicleType = next;
    // The handler may decline the change, e.g. if the user cancels.
    if (onVehicleTypeChange(next) === false) {
      vehicleType = previous;
      return;
    }
    for (const child of Array.from(seg.children)) {
      child.setAttribute('aria-pressed', String(child === button));
    }
  });

  // ---- current location ---------------------------------------------------

  locBtn.addEventListener('click', () => {
    if (!('geolocation' in navigator)) {
      locStatus.className = 'locstatus err';
      locStatus.textContent = t('step1.locationUnsupported');
      return;
    }

    locBtn.disabled = true;
    locStatus.className = 'locstatus';
    locStatus.textContent = t('step1.locating');

    navigator.geolocation.getCurrentPosition(
      async (position) => {
        const { latitude, longitude } = position.coords;
        try {
          const response = await fetch(
            `${REVERSE_GEOCODE}?format=jsonv2&lat=${latitude}&lon=${longitude}`,
            { headers: { Accept: 'application/json' } }
          );
          if (!response.ok) throw new Error('lookup failed');

          const json = await response.json();
          const address: NominatimAddress = json.address ?? {};
          const town =
            address.town ?? address.city ?? address.village ?? address.suburb ?? address.county ?? '';
          const district = address.county && address.county !== town ? address.county : '';

          accPlace.value =
            [town, district].filter(Boolean).join(', ') ||
            json.display_name ||
            `${latitude.toFixed(4)}, ${longitude.toFixed(4)}`;

          const stateName = [address.state, address.country].filter(Boolean).join(', ');
          if (stateName) accState.value = stateName;
          onChange();

          locStatus.textContent = t('step1.locationSet');
        } catch {
          accPlace.value = `${latitude.toFixed(5)}, ${longitude.toFixed(5)}`;
          onChange();
          locStatus.className = 'locstatus err';
          locStatus.textContent = t('step1.locationCoordsOnly');
        } finally {
          locBtn.disabled = false;
        }
      },
      (error) => {
        locStatus.className = 'locstatus err';
        locStatus.textContent =
          error.code === error.PERMISSION_DENIED
            ? t('step1.locationDenied')
            : t('step1.locationFailed');
        locBtn.disabled = false;
      },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  });

  // ---- labels -------------------------------------------------------------

  function refresh(): void {
    heading.textContent = t('step1.title');
    section.querySelector('.lbl-claimno')!.textContent = t('step1.claimNo');
    section.querySelector('.lbl-handler')!.textContent = t('step1.handler');
    section.querySelector('.lbl-designation')!.textContent = t('step1.designation');
    claimNo.placeholder = t('step1.claimNoPlaceholder');
    handlerName.placeholder = t('step1.handlerPlaceholder');
    handlerDesignation.placeholder = t('step1.designationPlaceholder');
    section.querySelector('.lbl-vtype')!.textContent = t('step1.vehicleType');
    section.querySelector('.lbl-date')!.textContent = t('step1.accidentDate');
    section.querySelector('.lbl-place')!.textContent = t('step1.place');
    section.querySelector('.lbl-state')!.textContent = t('step1.state');
    accPlace.placeholder = t('step1.placePlaceholder');
    accState.placeholder = t('step1.statePlaceholder');
    locBtn.textContent = `📍 ${t('step1.useLocation')}`;

    for (const child of Array.from(seg.children) as HTMLButtonElement[]) {
      const type = child.dataset.type as VehicleType;
      child.querySelector('b')!.textContent = t(`vehicle.${type}`);
      child.querySelector('small')!.textContent = t(`vehicle.${type}.hint`);
    }
  }

  refresh();

  return {
    element: section,
    getVehicleType: () => vehicleType,
    getParticulars: () => ({
      accidentDate: accDate.value,
      place: accPlace.value,
      state: accState.value,
      claimNumber: claimNo.value.trim(),
      handlerName: handlerName.value.trim(),
      handlerDesignation: handlerDesignation.value.trim(),
    }),
    refresh,
    clearClaimNumber: () => {
      claimNo.value = '';
    },
  };
}
