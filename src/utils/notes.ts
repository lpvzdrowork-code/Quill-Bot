// ─── Staff Note Limits ────────────────────────────────────────────────────────
// Shared by /note and /modlogs so the two can't drift apart.
//
// NOTE_CONTENT_MAX is sized so a full page still fits Discord's embed limits:
// one note renders as a field (content + author + date/ID lines) and a field
// value caps at 1024 characters, so 800 leaves headroom for the metadata lines.

export const NOTE_CONTENT_MAX    = 800;
export const MAX_NOTES_PER_USER  = 50;
export const NOTES_PER_PAGE      = 5;
