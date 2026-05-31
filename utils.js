// ─────────────────────────────────────────
// SHARED HELPERS
// Phone formatting + timezone-aware date handling
// ─────────────────────────────────────────

// Normalize a raw phone number into WhatsApp format: "whatsapp:+91XXXXXXXXXX"
// Strips spaces/dashes/parens, defaults to +91 (India) when no country code.
// Returns null if the result isn't a plausible E.164 number.
function formatWhatsAppNumber(raw, defaultCountryCode = "+91") {
  if (!raw || typeof raw !== "string") return null;

  let phone = raw.trim().replace(/^whatsapp:/i, "");
  phone = phone.replace(/[\s\-()]/g, "");

  if (!phone.startsWith("+")) {
    // strip a leading 0 then prepend the default country code
    phone = defaultCountryCode + phone.replace(/^0+/, "");
  }

  // E.164: leading + then 8–15 digits
  if (!/^\+\d{8,15}$/.test(phone)) return null;

  return `whatsapp:${phone}`;
}

// Today's date as YYYY-MM-DD in the given IANA timezone.
function todayInTimezone(timezone = "Asia/Kolkata") {
  try {
    // en-CA renders as YYYY-MM-DD
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
  } catch {
    // invalid timezone — fall back to UTC date
    return new Date().toISOString().split("T")[0];
  }
}

// Convert a value (Date or string) to a YYYY-MM-DD string, or null.
function toYMD(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().split("T")[0];
}

module.exports = { formatWhatsAppNumber, todayInTimezone, toYMD };
