import type { Message } from './i18n/types';
import type { ScanMode, ScanOutput } from './services/documentScanner';
import type { FileKind } from './services/fileValidation';
import type { Quad } from './services/scanGeometry';

// ---------------------------------------------------------------------------
// Vehicle types
//
// Display names come from the string table under `vehicle.*`, so this module
// carries no labels of its own.
// ---------------------------------------------------------------------------

export type VehicleType = 'PRIVATE_CAR' | 'TAXI' | 'COMMERCIAL_GOODS' | 'COMMERCIAL_PASSENGER';

export const VEHICLE_TYPES: VehicleType[] = [
  'PRIVATE_CAR',
  'TAXI',
  'COMMERCIAL_GOODS',
  'COMMERCIAL_PASSENGER',
];

// ---------------------------------------------------------------------------
// Document keys
//
// There is intentionally NO "Accident / Damage Photographs" key here. It must
// never be introduced, for any vehicle type.
// ---------------------------------------------------------------------------

// Keys are stable, language-independent document IDs. Validation always works
// on these keys; display wording comes from the string table.
export type DocumentKey =
  | 'POLICY'
  | 'RC'
  | 'DL'
  | 'PERMIT'
  | 'PHOTOGRAPHS'
  | 'PUC'
  | 'POLICE_REPORT'
  | 'FITNESS'
  | 'FC_VALIDITY'
  | 'QUARTERLY_TAX'
  | 'NATIONAL_PERMIT_AUTH'
  | 'PASSENGER_LIST'
  | 'AITC'
  | 'INVOICE'
  | 'CHALLAN'
  | 'WEIGHMENT';

export interface DocumentDefinition {
  key: DocumentKey;
  /** String-table key for the document name, e.g. 'doc.POLICY'. */
  nameKey: string;
  /** String-table key for the one-line hint. */
  hintKey: string;
  /** Whether several files may be attached to this one document. */
  multi?: boolean;
  /** Field keys the reader is asked to extract, in display order. */
  fields: string[];
}

/**
 * One document as it appears for a particular vehicle type. The same document
 * can be worded differently per vehicle type (e.g. "Policy" for a private car,
 * "Policy Copy" for a commercial vehicle), so the label lives here rather than
 * on the document definition.
 */
export interface VehicleDocumentEntry {
  key: DocumentKey;
  /** String-table key for the display name, e.g. 'doc.POLICY.copy'. */
  labelKey: string;
}

export interface VehicleDocumentConfig {
  vehicleType: VehicleType;
  /** Required documents, in display order. */
  required: VehicleDocumentEntry[];
  /** Optional supporting documents, in display order. */
  optional: VehicleDocumentEntry[];
}

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

export type AttachmentStatus = 'CHECKING' | 'READY' | 'EXTRACTING' | 'ERROR';

/** How the file arrived, which the UI shows and the reader uses. */
export type AttachmentSource = 'upload' | 'camera';

export interface ScanRecord {
  original: File;
  /** Corners in the original image's processing coordinates. */
  quad: Quad;
  mode: ScanMode;
  /** Whether the full photo or the cropped, perspective-corrected document was saved. */
  output: ScanOutput;
  /** Whether the edges were found automatically (informational only). */
  detected: boolean;
}

export interface AttachedFile {
  file: File;
  /** Object URL for images; null for PDF and DOCX. */
  url: string | null;
  name: string;
  size: number;
  kind: FileKind;
  source: AttachmentSource;
  status: AttachmentStatus;
  /** Localizable failure reason from validation or extraction. */
  error?: Message;
  /** Page count for PDFs, where known. */
  pages?: number;
  /** Text pulled out of a DOCX in the browser, sent instead of an image. */
  extractedText?: string;
  /**
   * Present when the image came through the document scanner. `file` is then
   * the processed document; the untouched original and the corners are kept
   * so the scan can be re-adjusted or compared without re-capturing.
   *
   * Scan state is independent of validation: a scan can succeed (or its edges
   * go undetected) regardless of whether the document later passes checks.
   */
  scan?: ScanRecord;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export type ReadStatus = 'IDLE' | 'READING' | 'READ' | 'ERROR';

export interface ExtractedDocument {
  documentType: string;
  /** 0 to 1. */
  confidence: number;
  /** Values exactly as printed on the document. */
  fields: Record<string, string>;
  warnings: string[];
  /** Verbatim text as printed, kept separate from the extracted fields. */
  originalText: string;
}

export interface DocumentState {
  key: DocumentKey;
  files: AttachedFile[];
  status: ReadStatus;
  /** Localizable read failure. */
  error: Message | null;
  /**
   * Extracted values, editable by the user. Validation reads this, never the
   * raw reader response, so a corrected value is the one that counts.
   */
  data: Record<string, string>;
  confidence: number | null;
  warnings: string[];
  documentType: string;
  originalText: string;
}

export type DocumentStateMap = Record<DocumentKey, DocumentState>;

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** 'ok' passes, 'chk' needs review, 'no' fails. Values double as CSS classes. */
export type ValidationStatus = 'ok' | 'chk' | 'no';

export const PASS: ValidationStatus = 'ok';
export const REVIEW: ValidationStatus = 'chk';
export const FAIL: ValidationStatus = 'no';

export type DocumentSummaryStatus = ValidationStatus | 'NONE';

export interface DocumentSummary {
  key: DocumentKey;
  required: boolean;
  status: DocumentSummaryStatus;
  /** Localizable remark; null when there is nothing to say. */
  message: Message | null;
  /** Reader warnings, verbatim, appended after the localized remark. */
  rawWarnings?: string[];
}

export interface CrossCheck {
  /** String-table key for the check name, e.g. 'check.names'. */
  labelKey: string;
  /** What the document said, as printed. */
  a: string;
  /** What it was compared against, as printed. */
  b: string;
  status: ValidationStatus;
  message: Message;
}

export interface ClaimParticulars {
  /** ISO yyyy-mm-dd, straight from the date input. */
  accidentDate: string;
  place: string;
  state: string;
  /** Insurer's claim number, as typed. */
  claimNumber: string;
  /** Claims handler preparing the report. */
  handlerName: string;
  handlerDesignation: string;
}

/**
 * Everything the printable report needs beyond the validation result itself.
 * Kept separate so the validator stays free of presentation concerns.
 */
export interface ReportContext {
  docketNumber: string;
  generatedAt: Date;
  particulars: ClaimParticulars;
  /** Document states, used to fill the claim and vehicle particulars block. */
  documents: DocumentStateMap;
  /** Free-text remarks, kept by the caller so re-validating does not lose them. */
  remarks: string;
  onRemarksChange: (value: string) => void;
}

export interface ClaimValidationResult {
  /** Vehicle type the claim was validated against. */
  vehicleType: VehicleType;
  verdict: ValidationStatus;
  documentSummaries: DocumentSummary[];
  crossChecks: CrossCheck[];
  /** String-table name keys of required documents with nothing attached. */
  missingRequired: string[];
  accidentDate: Date | null;
  place: string;
  failCount: number;
  reviewCount: number;
}
