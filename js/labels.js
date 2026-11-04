// Shipping labels: stamp the watch on top of each Vinted PDF label, keep today's labels on
// this device (PDFs are not synced), and merge them into one print batch sorted by watch.
import { loadScript } from './loader.js';

const DB_NAME = 'ooq-labels';
const STORE = 'labels';
const BAND = 30; // points added on the label's top edge for the header (≈1 cm)

let idbP = null;
function open() {
  if (!idbP) {
    idbP = new Promise((res, rej) => {
      const r = indexedDB.open(DB_NAME, 1);
      r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains(STORE)) r.result.createObjectStore(STORE, { keyPath: 'id' }); };
      r.onsuccess = () => res(r.result);
      r.onerror = () => { idbP = null; rej(r.error); };
    });
  }
  return idbP;
}
const done = (rq) => new Promise((res, rej) => { rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error); });

export async function all() {
  const d = await open();
  const rows = await done(d.transaction(STORE).objectStore(STORE).getAll());
  return rows.sort((a, b) => (a.day + String(a.n).padStart(4, '0')).localeCompare(b.day + String(b.n).padStart(4, '0')));
}
export async function ofDay(day) { return (await all()).filter((l) => l.day === day); }
export async function put(label) {
  const d = await open();
  const t = d.transaction(STORE, 'readwrite');
  t.objectStore(STORE).put(label);
  await new Promise((res, rej) => { t.oncomplete = res; t.onerror = () => rej(t.error); });
  return label;
}
export async function remove(id) {
  const d = await open();
  const t = d.transaction(STORE, 'readwrite');
  t.objectStore(STORE).delete(id);
  await new Promise((res, rej) => { t.oncomplete = res; t.onerror = () => rej(t.error); });
}
/** Keep the last `days` days of labels so the device doesn't fill up. */
export async function prune(today, days = 14) {
  const cut = new Date(today + 'T12:00:00');
  cut.setDate(cut.getDate() - days);
  const lim = cut.toISOString().slice(0, 10);
  for (const l of await all()) if (l.day < lim) await remove(l.id);
}

async function lib() {
  if (!window.PDFLib) await loadScript('vendor/pdf-lib.min.js');
  return window.PDFLib;
}

// Standard PDF fonts only cover Latin-1: drop anything else (emojis, etc.).
const latin1 = (s) => String(s).normalize('NFC').replace(/[^\x20-\x7E\xA0-\xFF]/g, '').replace(/\s+/g, ' ').trim();

export const headerText = ({ n, model, account }) => latin1(`#${n} >>> ${String(model).toUpperCase()} <<< (${account})`);

/**
 * Add a white band with a black border on the edge that is "up" when the label is viewed,
 * and write the header in it. The label itself is never covered: the page grows by BAND.
 */
export async function stamp(bytes, text) {
  const { PDFDocument, StandardFonts, rgb, degrees } = await lib();
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const page = doc.getPage(0);
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  const mb = page.getMediaBox();
  const rot = ((page.getRotation().angle % 360) + 360) % 360;
  const H = BAND, pad = 8;
  let band, box; // band: the new strip in page coordinates; box: where text starts and how it turns
  if (rot === 90) {
    page.setMediaBox(mb.x - H, mb.y, mb.width + H, mb.height);
    band = { x: mb.x - H, y: mb.y, w: H, h: mb.height };
  } else if (rot === 180) {
    page.setMediaBox(mb.x, mb.y - H, mb.width, mb.height + H);
    band = { x: mb.x, y: mb.y - H, w: mb.width, h: H };
  } else if (rot === 270) {
    page.setMediaBox(mb.x, mb.y, mb.width + H, mb.height);
    band = { x: mb.x + mb.width, y: mb.y, w: H, h: mb.height };
  } else {
    page.setMediaBox(mb.x, mb.y, mb.width, mb.height + H);
    band = { x: mb.x, y: mb.y + mb.height, w: mb.width, h: H };
  }
  // keep any crop box in step, or viewers would hide the band
  const cb = page.getCropBox();
  const nb = page.getMediaBox();
  if (cb.x !== nb.x || cb.y !== nb.y || cb.width !== nb.width || cb.height !== nb.height) page.setCropBox(nb.x, nb.y, nb.width, nb.height);

  const along = rot === 90 || rot === 270 ? band.h : band.w; // length available for the text
  const size = Math.max(6, Math.min(H * 0.5, (along - pad * 2) / font.widthOfTextAtSize(text, 1)));
  const off = H / 2 - size * 0.35; // baseline distance from the band's outer edge
  page.drawRectangle({ x: band.x + 1, y: band.y + 1, width: band.w - 2, height: band.h - 2, color: rgb(1, 1, 1), borderColor: rgb(0, 0, 0), borderWidth: 1.5 });
  if (rot === 90) box = { x: band.x + H - off, y: band.y + pad, r: 90 };
  else if (rot === 180) box = { x: band.x + band.w - pad, y: band.y + H - off, r: 180 };
  else if (rot === 270) box = { x: band.x + off, y: band.y + band.h - pad, r: 270 };
  else box = { x: band.x + pad, y: band.y + off, r: 0 };
  page.drawText(text, { x: box.x, y: box.y, size, font, color: rgb(0, 0, 0), rotate: degrees(box.r) });
  return doc.save();
}

/** One PDF with every label, in the order given. */
export async function merge(list) {
  const { PDFDocument } = await lib();
  const out = await PDFDocument.create();
  for (const l of list) {
    const src = await PDFDocument.load(l.bytes, { ignoreEncryption: true });
    const pages = await out.copyPages(src, src.getPageIndices());
    pages.forEach((p) => out.addPage(p));
  }
  return out.save();
}

export function download(bytes, name) {
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
  const a = document.createElement('a');
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
