# Motor Claim Document Checker

Reads Indian motor insurance claim documents, cross-checks them against each
other, and returns one of three answers: **It's valid**, **Not valid**, or
**Needs review**.

## Getting started

```bash
npm install
cp .env.example .env      # then edit .env and put your real key in it
npm run dev
```

Open the URL Vite prints. Use `localhost`, not a LAN IP, if you want the
camera to work — see "Camera requirements" below.

Other commands:

```bash
npm run build      # typecheck, then production build into dist/
npm run preview    # serve the production build locally
```

## Running without an API key

The application works with no key at all, because reading and validating are
separate steps. Only reading a scan needs an external service; **every
cross-check and the verdict run entirely in the browser.**

Attach a document, then use **Enter details by hand** on the card and type the
values printed on it. The document is marked as read at full confidence — a
person transcribing from the paper in front of them is a better source than any
scan — and every cross-check runs exactly as it would after an automated
read. The report, the verdict, printing and camera capture all work unchanged.

The same button appears when a scan fails to read, so a bad photograph never
leaves a card with no way forward.

What you lose without a key: automatic extraction. Nothing else.

## Supported providers

The reader works with either **Anthropic** or **Google Gemini**. The provider
is detected from the key prefix, so normally you only set one variable:

| Key prefix | Provider | Default model |
|---|---|---|
| `sk-ant-...` | Anthropic | `claude-sonnet-4-6` |
| `AIza...` or `AQ....` | Google Gemini | `gemini-2.5-flash` |

Override with `VITE_AI_PROVIDER` (`anthropic` or `gemini`) and `VITE_AI_MODEL`
if you need something else — for instance when pointing `VITE_AI_API_URL` at
your own proxy, whose key format the app cannot recognise.

Everything downstream is provider-agnostic: `src/services/aiProvider.ts` is the
only file that knows about endpoints, authentication and response shapes. The
reader just hands it parts and gets text back.

Both work from the browser in development. Anthropic only accepts a direct
browser call when the request carries the
`anthropic-dangerous-direct-browser-access: true` header, which
`aiProvider.ts` sends. That is acceptable on your own machine; for anything
deployed, use the proxy described under Security.

## Setting your API key

1. Copy `.env.example` to `.env` in the project root.
2. Replace the placeholder:

   ```text
   VITE_AI_API_KEY=sk-ant-your-real-key
   ```

3. Restart `npm run dev`. Vite only reads `.env` at startup.
4. Never commit `.env`. It is already in `.gitignore`.

`VITE_AI_API_URL` is optional and overrides the API endpoint, which is how you
point the app at your own backend proxy.

## Security

The key is read in the browser. That is fine locally, but in a production build
it ends up in the JavaScript bundle where anyone can open dev tools and take it.

Before deploying, put a small backend between the app and the API: have the
frontend call your own endpoint, and have that endpoint attach the real key
server-side. Set `VITE_AI_API_URL` to your proxy and remove the `x-api-key` and
`anthropic-dangerous-direct-browser-access` headers from
`src/services/aiProvider.ts`.

What the app already does:

- No key is hard-coded anywhere; both are environment variables.
- Files are validated in the browser — type, size, magic bytes, PDF
  encryption — so a rejected file never leaves the device.
- Object URLs for previews are revoked when a file is removed or the claim is
  cleared, so image data is not retained.
- Nothing is written to disk or to a server by the app itself. The only stored
  value is the claim's docket number, under `mcdc.docket` in `sessionStorage`,
  so a reload does not renumber a claim. It is cleared with the tab and
  replaced by "Clear claim". No claim content is stored.
- Document contents are never logged. Errors carry message keys, not extracted
  text.

Remaining risk in the default configuration: documents are sent to the AI API
for reading. If that is unacceptable for your data-handling policy, the reader
is the single place to swap for a self-hosted OCR service.


## How the pieces work

### Upload Document

Accepts JPG, JPEG, PNG, WEBP, PDF, DOC and DOCX. Each file shows its name,
type, size, page count for PDFs, and status.

Validation runs in the browser before anything is sent:

| Check | Behaviour |
|---|---|
| Type | MIME type first, file extension as fallback when the browser reports nothing |
| Size | 15 MB per file |
| Empty | Zero-byte files rejected |
| Corrupt | Magic bytes must match: `%PDF`, `PK\x03\x04` for DOCX, JPEG/PNG/WEBP signatures |
| Password-protected PDF | `/Encrypt` in the trailer is detected and rejected |
| Legacy `.doc` | Rejected with an explanation — see Limitations |

A rejected file stays visible with its reason rather than disappearing.

### Camera icon

Every card shows a camera icon (no "Take Photo" text; `aria-label="Take Photo"`
for screen readers) to the left of Upload Document: 32 px on desktop, 36 px on
tablets, 44 px on phones, blue `#1A73E8`, `#0B57D0` on hover or focus, grey
while the document is being read, green once an image has been captured. Where
the camera API is unavailable (for example a phone on a plain-HTTP address) the
icon opens the device's own camera or file picker instead.

Card hierarchy, strongest first: the selected vehicle category heading
(26 px, 24 px on phones), then each card's document icon and name (bold,
19 px / 17 px on phones, never truncated), the Required or Optional badge
(Optional is neutral grey, never error-red), the description, the camera and
upload controls, the preview, and the status. Document icons are inline line
icons in `src/components/icons.ts`.

Each card also has a preview area — the attached image in full, at its own
aspect ratio, nothing cropped by the card — and a Status line (Not Uploaded /
✅ Uploaded). Required and optional documents sit in separate sections, with
required names marked `*`.

Requests camera permission, opens a
modal (← Back, document name), and offers Capture → Preview → Retake / Use.
A flash indicator reports whether the device exposes automatic flash; where it
does, Capture takes a full-resolution photo with it. The rear camera is
preferred; a Switch Camera button appears when more than one is present. The
stream is released while you review a shot, and again when the modal closes.

Permission denied, no camera, and insecure-context are each reported
distinctly, always with the advice to upload a file instead.

Scanning uses OpenCV.js (`@techstark/opencv-js`, loaded on first use as a
separate asset, so it costs nothing until the camera is opened). The page
outline is detected live as a guide. The preview keeps the **full photo by
default** — nothing is cropped away — and reports whether the capture looks
clear, blurry or dark. Choosing "Cropped document" perspective-corrects the
page from its four corners, which can be dragged by hand if detection misses.
Finishes: original, enhanced, grayscale, black and white. Uploaded JPG, PNG and WEBP
files go through the same scanner.


### DOCX, PDF and image handling

- **DOCX** is unzipped in the browser with `mammoth` and its text sent as text.
  This is faster and more exact than rendering the page and reading it back.
  `mammoth` is loaded on demand, so it costs nothing unless a Word file is
  attached.
- **PDF** is sent as a document, so multi-page and scanned PDFs both work.
- **Images** are sent as images, after preprocessing if they came from the camera.


## Documents by vehicle type

| Vehicle type | Required | Optional |
|---|---|---|
| Private car | Driving licence, Permit, RC, Policy | Photographs, PUC, Police report / FIR, Fitness certificate |
| Taxi | Driving licence, Permit, RC, Policy | Photographs, PUC, Police report / FIR, Fitness certificate |
| Commercial — goods | RC, Driving licence, Policy copy, Permit, Fitness certificate, Quarterly tax, National permit with authorization | PUC, Photographs, Invoice / load particulars, Load / lorry challan, Weighment bill, Police report / FIR |
| Commercial — passenger | AITC, Driving licence, RC, Policy copy, FC validity, Permit, Passenger list, Quarterly tax, National permit with authorization | Fitness certificate, PUC, Photographs, Police report / FIR |

`src/config/documentConfig.ts` is the single source for this table.

Rules that hold throughout, enforced in code and covered by tests:

1. There is no "Accident / Damage Photographs" document for any vehicle type.
2. An optional document that was not supplied never fails a claim and is never
   reported as missing. The report shows it as "Not provided — Optional".
3. Upload completeness uses required documents only. While any is missing the
   status reads "Required Documents Missing" and lists exactly which, and
   **Proceed to Validation** stays disabled; once all are uploaded it reads
   "All Required Documents Uploaded · Documents Ready for Validation",
   whether or not optional documents were added.
4. Each vehicle category keeps its own uploads (`uploadedDocuments[category]`).
   Switching category shows that category's own documents; nothing is copied or
   carried between categories, and switching back restores what was uploaded
   there. New claim / Reset clears every category.
5. Private car asks for a Permit because the specification lists one. Private
   cars do not normally carry a permit; drop `doc('PERMIT')` from the Private
   car line in `documentConfig.ts` to ask only for licence, RC and policy.

## Cross-document checks

| Check | Fails when | Needs review when |
|---|---|---|
| Policy registration number vs RC | The two numbers differ | One is missing |
| Permit, national permit, fitness, FC, tax, passenger list, AITC registration numbers vs RC | The numbers differ | — |
| Insured name vs RC owner | The names are different people | Only a partial match |
| Vehicle make and model — policy vs RC | Different vehicle | One wording contains the other, e.g. `SWIFT VXI` vs `SWIFT` |
| RC vehicle class vs licence class | Never | The classes don't clearly align |
| Permit, fitness, FC, tax, national permit, authorization, AITC in force | Expired before, or started after, the accident | A date is missing or is not a real date |
| Policy period vs date of accident | The accident falls outside the period | A date can't be read |
| Licence valid on date of accident | The licence expired before the accident | The expiry can't be read |

Dates are accepted as `DD/MM/YYYY`, `DD-MM-YY`, `YYYY-MM-DD` or `17 Sep 2026`.
A date that does not exist (`31/02/2025`, `31/13/2026`) or free text
(`Life time`) is treated as unreadable and sent to review — never passed.

Registration, chassis and engine numbers are compared with punctuation and
spacing stripped and regional digits (Devanagari, Bengali, Gurmukhi, Gujarati,
Oriya, Tamil, Telugu, Kannada, Malayalam, Arabic-Indic) turned into 0–9, so
`AP-07 AB 1234`, `AP07AB1234` and `AP ०७ AB १२३४` match. Regional *letters*
are not transliterated.

Company words (`INDIA`, `LTD`, `PVT`, `MOTORS`…) are ignored when comparing
makes, so `MARUTI SUZUKI INDIA LTD` and `Maruti Suzuki` pass.

Name matching tolerates case, punctuation, initials, missing middle names and
reordering: "POCHITHREDDY VENKATA KRISHNA REDDY" and "P V KRISHNA REDDY" are
the same person. A genuinely different name is not waved through, and a
half-match returns "needs review" rather than guessing.

## How the verdict is reached

- **Not valid** — a required document is missing, or any check failed outright.
- **Needs review** — nothing failed, but something is uncertain: a required
  document was unreadable, read below 40% confidence, came back with warnings,
  or a check could not be settled.
- **It's valid** — every required document read cleanly and every check passed.

## The claim report

After **Validate claim**, step 04 shows a report laid out for the claim file.
**Print / save as PDF** prints only the report, on A4 portrait:

- **Header** — report title, claim number (typed in step 01; flagged in red if
  left blank), docket number and the time the report was produced.
- **Claim and vehicle particulars** — policy number, insured, registration,
  make and model, vehicle type, policy period, IDV, driver and licence number,
  date and place of accident. Taken from the documents as read or entered;
  only documents shown for the selected vehicle type are used.
- **Documents examined** and **Cross-document checks** — the two tables.
- **Findings and verdict** — a tally, the verdict stamp, and every failing or
  uncertain point listed in one place so nobody has to scan the tables.
- **Handler's remarks** — typed on screen, printed as plain text. Kept if you
  validate again.
- **Verification** — "Prepared by" filled from step 01, "Reviewed and approved
  by" left blank, each with name, designation, signature and date lines.
- **Disclaimer** — the report records completeness and consistency of the
  papers, not liability or quantum.

The saved PDF is named after the claim number (or the docket if none).

**Stale reports are blocked.** Editing any value, attachment or particular
after validating dims the report, shows a notice, and stops printing until you
validate again, so a signed report always matches the values in the boxes.

## Accessibility and UX

- Progress is shown per file and per document; a Cancel button aborts a read in
  flight via `AbortController`.
- Files can be removed individually; documents accepting multiple files say so.
- Layout adapts at 900px and 640px; tables scroll horizontally on small screens.

## Project structure

```text
motor-claim-document-checker/
├── index.html
├── package.json  tsconfig.json  vite.config.ts
├── .env.example  .gitignore
└── src/
    ├── main.ts                       # wiring, read loop, locale changes
    ├── style.css
    ├── types.ts                      # shared types; PASS/REVIEW/FAIL
    ├── vite-env.d.ts                 # env vars and the mammoth declaration
    ├── i18n/
    │   ├── index.ts                  # t(), tm(), formatting
    │   ├── types.ts                  # Message
    │   └── locales/en.ts             # the string table
    ├── config/
    │   └── documentConfig.ts         # documents and per-type checklists
    ├── services/
    │   ├── aiDocumentReader.ts       # extraction prompt and parsing
    │   ├── claimValidator.ts         # comparison, checks, verdict
    │   ├── fileValidation.ts         # type, size, magic bytes, encryption
    │   ├── documentScanner.ts        # OpenCV detection, perspective, finishes
    │   ├── scanGeometry.ts           # corner maths and live guidance, no DOM
    │   ├── opencvLoader.ts           # loads OpenCV.js on demand
    │   ├── docxExtractor.ts          # DOCX text via mammoth
    │   └── aiProvider.ts             # Anthropic / Gemini transport
    └── components/
        ├── claimParticulars.ts
        ├── documentSlot.ts
        ├── documentUploader.ts
        ├── documentScanner.ts        # scanner modal and attached-scan viewer
        └── validationReport.ts
```

`en.ts` is the single string table. User-facing wording lives there rather than
scattered through the components, which is what lets the validator return
message keys instead of finished sentences.

Attachments are held per document key for all nine documents, not only the
visible ones, so switching vehicle type and back does not lose work.

## Camera requirements

`getUserMedia` is only available in a secure context. The camera works on
`https://` and on `http://localhost`, but not on a plain-HTTP LAN address such
as `http://192.168.1.5:5173`. To test on a phone, use an HTTPS tunnel or serve
the dev server over TLS. The app detects this case and says so.

## Limitations

- **Legacy `.doc`** (the pre-2007 binary format) cannot be parsed in the
  browser. Save as `.docx` or PDF, or photograph the page.
- **Edge detection can miss** on low-contrast backgrounds (white paper on a
  white table). The scanner then asks for the corners to be placed by hand.
- **PDF page counting is approximate**, taken from `/Type /Page` occurrences.
- **Encryption detection reads the PDF trailer**, which covers ordinary files
  but not every possible structure.
- **OCR accuracy has not been measured against real documents.** See Testing.

## Testing

There is no test runner in the repository yet. What has been checked: a clean
`tsc --noEmit` under `strict`, a successful production build, and a scripted
browser run through hand entry, validation, the stale-report guard and
printing to PDF. Adding Vitest with the validator cases (impossible dates,
make/model wording, regional digits, private car without permit) is the
obvious next step.

What is **not** covered: real OCR accuracy against genuine documents, poor-quality
photographs, rotated pages, scanned PDFs and real Word files. That needs sample
documents and a manual pass on real devices. Treat it as an open item before
production use.

## Backend and database

None. The application is entirely client-side: no server, no database, no
migrations. The only persisted value is the docket number in
`sessionStorage`.

The one backend change worth making is the API proxy described under Security,
which requires a single endpoint that forwards a request body to the AI API
with the key attached server-side.
