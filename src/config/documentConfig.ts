import type {
  DocumentDefinition,
  DocumentKey,
  VehicleDocumentConfig,
  VehicleDocumentEntry,
  VehicleType,
} from '../types';

// ---------------------------------------------------------------------------
// The documents themselves, with the fields the AI is asked to extract.
// ---------------------------------------------------------------------------

export const DOCUMENTS: Record<DocumentKey, DocumentDefinition> = {
  POLICY: {
    key: 'POLICY',
    nameKey: 'doc.POLICY',
    hintKey: 'doc.POLICY.hint',
    fields: [
      'policy_no',
      'insured_name',
      'reg_no',
      'vehicle_make',
      'vehicle_model',
      'vehicle_type',
      'engine_no',
      'chassis_no',
      'period_from',
      'period_to',
      'idv',
      'coverage',
      'addons',
      'geographical_area',
      'vehicle_usage',
      'limitations',
    ],
  },
  RC: {
    key: 'RC',
    nameKey: 'doc.RC',
    hintKey: 'doc.RC.hint',
    fields: [
      'reg_no',
      'owner_name',
      'vehicle_make',
      'vehicle_model',
      'vehicle_class',
      'fuel',
      'colour',
      'engine_no',
      'chassis_no',
      'reg_date',
      'address',
    ],
  },
  DL: {
    key: 'DL',
    nameKey: 'doc.DL',
    hintKey: 'doc.DL.hint',
    fields: [
      'dl_no',
      'holder_name',
      'dob',
      'valid_from',
      'valid_upto',
      'vehicle_class',
      'transport_authorization',
      'endorsements',
      'address',
    ],
  },
  PERMIT: {
    key: 'PERMIT',
    nameKey: 'doc.PERMIT',
    hintKey: 'doc.PERMIT.hint',
    fields: [
      'permit_no',
      'reg_no',
      'permit_type',
      'valid_from',
      'valid_upto',
      'vehicle_class',
      'area_route',
      'permit_conditions',
    ],
  },
  PHOTOGRAPHS: {
    key: 'PHOTOGRAPHS',
    nameKey: 'doc.PHOTOGRAPHS',
    hintKey: 'doc.PHOTOGRAPHS.hint',
    multi: true,
    fields: ['visible_condition', 'visible_reg_no'],
  },
  PUC: {
    key: 'PUC',
    nameKey: 'doc.PUC',
    hintKey: 'doc.PUC.hint',
    fields: ['certificate_no', 'reg_no', 'valid_from', 'valid_upto'],
  },
  POLICE_REPORT: {
    key: 'POLICE_REPORT',
    nameKey: 'doc.POLICE_REPORT',
    hintKey: 'doc.POLICE_REPORT.hint',
    multi: true,
    fields: ['fir_no', 'fir_date', 'police_station', 'reg_no', 'incident_date', 'incident_place', 'brief_facts'],
  },
  FITNESS: {
    key: 'FITNESS',
    nameKey: 'doc.FITNESS',
    hintKey: 'doc.FITNESS.hint',
    fields: ['certificate_no', 'reg_no', 'vehicle_class', 'inspection_date', 'valid_upto'],
  },
  FC_VALIDITY: {
    key: 'FC_VALIDITY',
    nameKey: 'doc.FC_VALIDITY',
    hintKey: 'doc.FC_VALIDITY.hint',
    fields: ['certificate_no', 'reg_no', 'valid_from', 'valid_upto'],
  },
  QUARTERLY_TAX: {
    key: 'QUARTERLY_TAX',
    nameKey: 'doc.QUARTERLY_TAX',
    hintKey: 'doc.QUARTERLY_TAX.hint',
    fields: ['receipt_no', 'reg_no', 'tax_amount', 'valid_from', 'valid_upto'],
  },
  NATIONAL_PERMIT_AUTH: {
    key: 'NATIONAL_PERMIT_AUTH',
    nameKey: 'doc.NATIONAL_PERMIT_AUTH',
    hintKey: 'doc.NATIONAL_PERMIT_AUTH.hint',
    multi: true,
    fields: [
      'permit_no',
      'reg_no',
      'permit_type',
      'valid_from',
      'valid_upto',
      'authorization_no',
      'authorization_valid_from',
      'authorization_valid_upto',
      'area_route',
      'permit_conditions',
    ],
  },
  PASSENGER_LIST: {
    key: 'PASSENGER_LIST',
    nameKey: 'doc.PASSENGER_LIST',
    hintKey: 'doc.PASSENGER_LIST.hint',
    multi: true,
    fields: ['reg_no', 'journey_date', 'from_place', 'to_place', 'passenger_count', 'passenger_names'],
  },
  AITC: {
    key: 'AITC',
    nameKey: 'doc.AITC',
    hintKey: 'doc.AITC.hint',
    fields: ['aitc_no', 'reg_no', 'valid_from', 'valid_upto', 'area_route'],
  },
  INVOICE: {
    key: 'INVOICE',
    nameKey: 'doc.INVOICE',
    hintKey: 'doc.INVOICE.hint',
    fields: ['invoice_no', 'description_of_goods', 'value', 'invoice_date'],
  },
  CHALLAN: {
    key: 'CHALLAN',
    nameKey: 'doc.CHALLAN',
    hintKey: 'doc.CHALLAN.hint',
    fields: ['challan_no', 'description_of_goods', 'challan_date', 'reg_no'],
  },
  WEIGHMENT: {
    key: 'WEIGHMENT',
    nameKey: 'doc.WEIGHMENT',
    hintKey: 'doc.WEIGHMENT.hint',
    fields: ['slip_no', 'weight', 'weighment_date', 'reg_no'],
  },
};

// ---------------------------------------------------------------------------
// Which documents each vehicle type calls for.
//
// There is intentionally no "Accident / Damage Photographs" entry for any
// vehicle type.
// ---------------------------------------------------------------------------

/** Shorthand for a document entry in a vehicle configuration. */
function doc(key: DocumentKey, labelKey: string = `doc.${key}`): VehicleDocumentEntry {
  return { key, labelKey };
}

/**
 * The single source of truth for which documents each vehicle type shows.
 * Order here is display order. Label keys preserve each vehicle type's exact
 * wording; the underlying keys stay the same across vehicle types.
 */
export const VEHICLE_CONFIG: Record<VehicleType, VehicleDocumentConfig> = {
  PRIVATE_CAR: {
    vehicleType: 'PRIVATE_CAR',
    // Permit is required here because the specification lists it for Private
    // Car (§3). Note that private cars do not normally carry a permit: with
    // this list, a private-car claim cannot proceed until one is attached.
    // Drop doc('PERMIT') from this line to ask only for licence, RC and policy.
    required: [doc('DL'), doc('PERMIT'), doc('RC'), doc('POLICY')],
    // No fitness certificate for a private car.
    optional: [doc('PHOTOGRAPHS'), doc('PUC'), doc('POLICE_REPORT')],
  },
  TAXI: {
    vehicleType: 'TAXI',
    required: [doc('DL'), doc('PERMIT'), doc('RC'), doc('POLICY')],
    optional: [doc('PHOTOGRAPHS'), doc('PUC'), doc('POLICE_REPORT'), doc('FITNESS')],
  },
  COMMERCIAL_GOODS: {
    vehicleType: 'COMMERCIAL_GOODS',
    required: [
      doc('RC'),
      doc('DL'),
      doc('POLICY', 'doc.POLICY.copy'),
      doc('PERMIT'),
      doc('FITNESS'),
      doc('QUARTERLY_TAX'),
      doc('NATIONAL_PERMIT_AUTH'),
    ],
    optional: [
      doc('PUC'),
      doc('PHOTOGRAPHS', 'doc.PHOTOGRAPHS.short'),
      doc('INVOICE'),
      doc('CHALLAN'),
      doc('WEIGHMENT'),
      doc('POLICE_REPORT'),
    ],
  },
  COMMERCIAL_PASSENGER: {
    vehicleType: 'COMMERCIAL_PASSENGER',
    required: [
      doc('AITC'),
      doc('DL'),
      doc('RC'),
      doc('POLICY', 'doc.POLICY.copy'),
      doc('FC_VALIDITY'),
      doc('PERMIT'),
      doc('PASSENGER_LIST'),
      doc('QUARTERLY_TAX'),
      doc('NATIONAL_PERMIT_AUTH'),
    ],
    optional: [
      doc('FITNESS'),
      doc('PUC'),
      doc('PHOTOGRAPHS', 'doc.PHOTOGRAPHS.short'),
      doc('POLICE_REPORT'),
    ],
  },
};

export function getConfig(vehicleType: VehicleType): VehicleDocumentConfig {
  return VEHICLE_CONFIG[vehicleType];
}

export function requiredKeys(vehicleType: VehicleType): DocumentKey[] {
  return getConfig(vehicleType).required.map((entry) => entry.key);
}

export function optionalKeys(vehicleType: VehicleType): DocumentKey[] {
  return getConfig(vehicleType).optional.map((entry) => entry.key);
}

export function activeKeys(vehicleType: VehicleType): DocumentKey[] {
  return [...requiredKeys(vehicleType), ...optionalKeys(vehicleType)];
}

export function isRequired(vehicleType: VehicleType, key: DocumentKey): boolean {
  return requiredKeys(vehicleType).includes(key);
}

/** True when the document is shown (required or optional) for this vehicle type. */
export function isActive(vehicleType: VehicleType, key: DocumentKey): boolean {
  return activeKeys(vehicleType).includes(key);
}

/**
 * String-table key for a document's name as worded for this vehicle type.
 * Falls back to the document's default name if it is not shown for the type.
 */
export function documentLabelKey(vehicleType: VehicleType, key: DocumentKey): string {
  const cfg = getConfig(vehicleType);
  const entry = [...cfg.required, ...cfg.optional].find((e) => e.key === key);
  return entry?.labelKey ?? DOCUMENTS[key].nameKey;
}
