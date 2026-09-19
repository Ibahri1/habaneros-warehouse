/**
 * Normalize spacing characters unsupported by pdf-lib's WinAnsi standard
 * fonts without changing names or accented Latin characters.
 */
export function pdfText(value) {
  return String(value ?? "").replace(/[\u202F\u00A0]/g, " ");
}
