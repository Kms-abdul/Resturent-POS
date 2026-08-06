# Excel as an interface, not a database

Read this whenever a request involves spreadsheets — as a data source, a requested
"database", a reporting output, or a bulk-edit workflow.

## Why the pushback, and how to deliver it

When someone says "just use Excel as the database", they are almost never making an
architecture claim. They're saying: *this is the tool I work in, my staff know it, and I
don't want a system that takes it away from me.* That requirement is legitimate and you
should satisfy it completely.

What you refuse is xlsx-as-storage, and the reason is consequences, not purity:

- **No transactions.** A crash mid-write leaves a half-written file. There is no rollback.
- **No concurrent writes.** Two people with the file open: last save wins, the other
  person's work vanishes, nothing warns anyone.
- **No referential integrity.** Nothing stops an order row pointing at a customer ID that
  no longer exists.
- **No point-in-time recovery.** "Restore to 3pm yesterday" means finding a copy someone
  happened to make.
- **Silent corruption.** Excel coerces types — leading zeros drop off SKUs, long IDs
  become floats, `1-2` becomes a date. It doesn't warn; it just changes your data.
- **No audit trail.** For anything money-adjacent this is usually a compliance problem,
  not just an engineering one.

Deliver this in one short paragraph, in their terms ("two staff saving at once means one
of them loses a shift's orders with no error message"), then immediately show what they
get instead. Nobody enjoys being told no; everyone likes being told yes to the thing they
actually wanted.

## The architecture

Postgres (or SQLite where genuinely single-writer) is the system of record. Excel is a
first-class interface on both sides:

- **Import:** upload xlsx/csv → validate → preview → commit, with a downloadable error
  report for rejected rows.
- **Export:** any report or list view downloads as a formatted xlsx.
- **Templates:** downloadable, pre-formatted, with validation rules and instructions
  baked in, so users fill them offline and upload clean data.
- **Scheduled reports:** generated on a cron and emailed or dropped in shared storage.

The user keeps their spreadsheet workflow. The data stops being one bad save from gone.

## Import pipeline

Do not stream rows straight into the database. Use a staging pattern — it's the
difference between a partial import you have to unpick by hand and a clean rejection.

1. **Receive** — cap file size, check the magic bytes (xlsx is a zip; a renamed `.exe`
   isn't), store the original in object storage for audit.
2. **Parse** — read all rows into memory or a staging table. Never trust the header row's
   order; map by header name and fail loudly on unknown or missing columns.
3. **Normalize** — trim whitespace, strip currency symbols and thousands separators,
   parse dates with an explicit expected format rather than a guess, coerce numerics
   read as text.
4. **Validate row by row** — schema validation (Zod/Pydantic) plus business rules plus
   referential checks. Collect *every* error with row number and column name; do not
   abort on the first.
5. **Preview** — show the user: N rows valid, M rows rejected, sample of each, and the
   diff for rows that would update existing records. Let them confirm.
6. **Commit in a transaction** — all-or-nothing by default. Offer partial commit ("import
   the 940 valid rows, skip 60") as an explicit choice, never as the silent default.
7. **Report** — an xlsx of rejected rows with an added `error` column, so the user fixes
   it in the tool they know and re-uploads.

For files over ~10k rows, run steps 2–6 as a background job with a progress endpoint. A
90-second HTTP request will die at a proxy timeout and leave the user with no idea what
happened.

## The type-coercion traps

These cause the majority of real-world import bugs:

- **Leading zeros.** SKU `00123` arrives as `123`. Read cells as text where the column is
  an identifier; never let the parser infer.
- **Large numbers.** Barcodes and phone numbers become `1.23457E+12`. Same fix.
- **Dates.** Excel stores dates as serial numbers from 1899-12-30. Ambiguous strings
  (`03/04/2025`) are unresolvable without knowing the locale — require ISO format in
  templates, or ask explicitly and record the choice.
- **Floats.** `0.1 + 0.2` money errors. Store money as integer minor units (cents/paise)
  or `NUMERIC`, never as `float`.
- **Merged cells and multi-row headers.** Reject with a clear message and point at the
  template rather than trying to guess the structure.
- **Trailing blank rows.** Excel files routinely carry thousands of empty formatted rows.
  Skip rows where every mapped column is empty.
- **Formulas.** Read cached values, not formula strings; note that a file never opened in
  Excel may have no cached value at all.

## Export

Generate xlsx (not csv) whenever the user will open it in Excel — csv re-triggers every
coercion trap above. Include a header row with frozen panes, correct number/date/currency
formats applied to the columns, sensible column widths, and a metadata sheet recording
what filters produced the file and when. That last one saves an enormous amount of "which
export is this?" confusion later.

Generate large exports as background jobs with a download link; don't hold an HTTP
connection open while assembling 200k rows.

## Libraries

- **Node:** `exceljs` for read and styled write (streaming support for large files);
  `xlsx`/SheetJS for fast parse-only.
- **Python:** `openpyxl` for xlsx read/write; `pandas.read_excel` for analysis-shaped
  work (but validate explicitly afterward — pandas' type inference is exactly the
  coercion problem above); `xlsxwriter` for formatted output.

## Security

Uploaded spreadsheets are untrusted input. Validate the extension *and* the magic bytes,
cap file size and row count before parsing, and never evaluate formulas from an uploaded
file. Be aware of CSV injection on export: a cell beginning with `=`, `+`, `-`, or `@`
executes as a formula when opened, so prefix such values with a single quote in exports
that may contain user-supplied text. Scan uploads if your threat model warrants it, and
apply the same row-level permissions to imports and exports that you apply to the API —
an export endpoint is a bulk data exfiltration path if it ignores tenancy.
