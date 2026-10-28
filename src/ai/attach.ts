// Attachments for the AI: images (pasted, dropped, picked or captured from a
// remote screen), PDFs, and text files. Images are scaled down to what models
// read well (long edge 1600 px), which also keeps requests small. Text files
// become part of the message text, so masking applies to them; images and
// PDFs cannot be masked.

export interface Attached {
  kind: "image" | "pdf" | "text";
  name: string;
  /** image/pdf: media type and base64 bytes. */
  mime?: string;
  data?: string;
  /** image: a small data URL to show. */
  preview?: string;
  /** text: the file's text. */
  text?: string;
  /** Bytes as sent (for the size note). */
  size: number;
}

const MAX_EDGE = 1600;
const PDF_LIMIT = 20 * 1024 * 1024;
const TEXT_LIMIT = 300 * 1024;
const TEXT_EXT = /\.(log|txt|text|out|conf|cfg|config|ini|json|xml|ya?ml|csv|tsv|md|sh|bash|ksh|ps1|bat|cmd|py|js|ts|sql|properties|env|toml|rules|service|crt|pem|cer|htm|html|diff|patch)$/i;

function base64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** An image from a canvas, scaled down, as PNG (sharp text) or JPEG when that is much smaller. */
export function fromCanvas(source: CanvasImageSource & { width: number; height: number }, name: string): Attached {
  const scale = Math.min(1, MAX_EDGE / Math.max(source.width, source.height));
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(source.width * scale));
  c.height = Math.max(1, Math.round(source.height * scale));
  c.getContext("2d")!.drawImage(source, 0, 0, c.width, c.height);
  let url = c.toDataURL("image/png");
  // Photos and gradients compress badly as PNG.
  if (url.length > 1_500_000) url = c.toDataURL("image/jpeg", 0.85);
  const mime = url.slice(5, url.indexOf(";"));
  const data = url.slice(url.indexOf(",") + 1);
  const t = document.createElement("canvas");
  const ts = Math.min(1, 160 / Math.max(c.width, c.height));
  t.width = Math.max(1, Math.round(c.width * ts));
  t.height = Math.max(1, Math.round(c.height * ts));
  t.getContext("2d")!.drawImage(c, 0, 0, t.width, t.height);
  return { kind: "image", name, mime, data, preview: t.toDataURL("image/png"), size: Math.round((data.length * 3) / 4) };
}

/** A file the user picked, dropped or pasted. Throws a message when it cannot be sent. */
export async function fromFile(file: File): Promise<Attached> {
  const name = file.name || "clipboard";
  if (/^image\/(png|jpeg|webp|gif|bmp)$/.test(file.type)) {
    const bitmap = await createImageBitmap(file);
    try {
      return { ...fromCanvas(bitmap, name), name };
    } finally {
      bitmap.close();
    }
  }
  if (file.type === "application/pdf" || /\.pdf$/i.test(name)) {
    if (file.size > PDF_LIMIT) throw new Error(`PDF가 너무 큽니다 (최대 20MB): ${name}`);
    const data = base64(new Uint8Array(await file.arrayBuffer()));
    return { kind: "pdf", name, mime: "application/pdf", data, size: file.size };
  }
  if (file.type.startsWith("text/") || TEXT_EXT.test(name) || !file.type) {
    if (file.size > TEXT_LIMIT * 4) throw new Error(`텍스트 파일이 너무 큽니다 (최대 ${((TEXT_LIMIT * 4) / (1024 * 1024)).toFixed(1)}MB): ${name}`);
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes.subarray(0, 4096).includes(0)) throw new Error(`텍스트가 아닌 파일은 보낼 수 없습니다: ${name}`);
    let text = new TextDecoder("utf-8").decode(bytes);
    // Korean Windows files are often CP949.
    if (text.includes("�")) {
      try {
        text = new TextDecoder("euc-kr").decode(bytes);
      } catch {
        // Keep the UTF-8 reading.
      }
    }
    if (text.length > TEXT_LIMIT) text = `${text.slice(0, TEXT_LIMIT / 3)}\n…(${text.length - TEXT_LIMIT}자 생략)…\n${text.slice(-(TEXT_LIMIT * 2) / 3)}`;
    return { kind: "text", name, text, size: file.size };
  }
  throw new Error(`이 형식의 파일은 보낼 수 없습니다 (이미지·PDF·텍스트만): ${name}`);
}

export function sizeLabel(n: number): string {
  return n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)}MB` : `${Math.max(1, Math.round(n / 1024))}KB`;
}
