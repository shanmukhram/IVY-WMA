import qrcode from "qrcode-terminal";

/** Render text as a terminal QR (half-block characters). Returns null if it cannot be encoded. */
export function renderQr(text: string): string | null {
  let out: string | null = null;
  try { qrcode.generate(text, { small: true }, (s: string) => { out = s; }); }
  catch { return null; }
  return out;
}
