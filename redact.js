// Server-side copy of the page's redact(). The server applies it to every prompt, so a customer's
// emails, phone numbers, card numbers, keys and similar are masked even if a modified client skips it.
// It does not catch names, addresses or free-text details, and it cannot mask text inside screenshots.
export function redact(s) {
  return String(s)
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '[email]')
    .replace(/(https?:\/\/[^\s?#]+)[?#]\S*/g, '$1')
    .replace(/eyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]+/g, '[secret]')
    .replace(/\b(?:sk|pk|rk|ghp|gho|xox[bpa]|AKIA|AIza)[-_A-Za-z0-9]{12,}\b/g, '[secret]')
    .replace(/\b[A-Fa-f0-9]{32,}\b/g, '[secret]')
    .replace(/\b(password|passwd|pwd|pw|passcode|pin|otp|token|secret)(\s*(?:is|:|=)\s*)\S+/gi, '$1$2[secret]')
    .replace(/\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g, '[iban]')
    .replace(/\b(?:\d[ -]?){13,19}\b/g, '[card]')
    .replace(/\b\d{3}-\d{2}-\d{4}\b/g, '[id]')
    .replace(/\b\d{4}\s\d{4}\s\d{4}\b/g, '[id]')
    .replace(/\b[A-Z]{5}\d{4}[A-Z]\b/g, '[id]')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[ip]')
    .replace(/\+?\d[\d ()-]{7,}\d/g, '[phone]');
}
