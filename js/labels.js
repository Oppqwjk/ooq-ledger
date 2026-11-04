// Shipping labels: cut each Vinted PDF down to the label itself, write the watch colour on it
// in small letters, keep today's labels on this device (PDFs are not synced) and merge them
// into one print batch sorted by colour.
import { loadScript } from './loader.js';

const DB_NAME = 'ooq-labels';
const STORE = 'labels';
const BAND = 14; // points added on the label's top edge for the small line of text (≈5 mm)

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
async function viewer() {
  if (!window.pdfjsLib) await loadScript('vendor/pdf.min.js');
  window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';
  return window.pdfjsLib;
}

// Standard PDF fonts only cover Latin-1: drop anything else (emojis, etc.).
const latin1 = (s) => String(s).normalize('NFC').replace(/[^\x20-\x7E\xA0-\xFF]/g, '').replace(/\s+/g, ' ').trim();
export const headerText = ({ n, tag }) => latin1(`#${n} · ${tag}`);

/**
 * Draw page 1 into a canvas `width` px wide. Returns helpers to turn a rectangle drawn on the
 * canvas into a crop (fractions of the page box, the same numbers stamp() uses) and back.
 */
export async function preview(bytes, canvas, width) {
  const pdfjs = await viewer();
  const doc = await pdfjs.getDocument({ data: bytes.slice(0) }).promise;
  const page = await doc.getPage(1);
  const base = page.getViewport({ scale: 1 });
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const vp = page.getViewport({ scale: (width / base.width) * dpr });
  canvas.width = Math.round(vp.width); canvas.height = Math.round(vp.height);
  canvas.style.width = Math.round(vp.width / dpr) + 'px'; canvas.style.height = Math.round(vp.height / dpr) + 'px';
  await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
  const [vx1, vy1, vx2, vy2] = page.view; const vw = vx2 - vx1, vh = vy2 - vy1;
  const key = `${Math.round(vw)}x${Math.round(vh)}r${page.rotate || 0}`;
  // canvas CSS px rect {l,t,w,h} -> page-box fractions {x,y,w,h} (PDF space, unrotated)
  const toCrop = (r) => {
    const a = vp.convertToPdfPoint(r.l * dpr, r.t * dpr), b = vp.convertToPdfPoint((r.l + r.w) * dpr, (r.t + r.h) * dpr);
    const x = (Math.min(a[0], b[0]) - vx1) / vw, y = (Math.min(a[1], b[1]) - vy1) / vh;
    const w = Math.abs(a[0] - b[0]) / vw, h = Math.abs(a[1] - b[1]) / vh;
    const c = (v) => Math.max(0, Math.min(1, v));
    return { x: c(x), y: c(y), w: Math.min(w, 1 - c(x)), h: Math.min(h, 1 - c(y)) };
  };
  const toRect = (cr) => {
    const p1 = vp.convertToViewportPoint(vx1 + cr.x * vw, vy1 + cr.y * vh), p2 = vp.convertToViewportPoint(vx1 + (cr.x + cr.w) * vw, vy1 + (cr.y + cr.h) * vh);
    return { l: Math.min(p1[0], p2[0]) / dpr, t: Math.min(p1[1], p2[1]) / dpr, w: Math.abs(p1[0] - p2[0]) / dpr, h: Math.abs(p1[1] - p2[1]) / dpr };
  };
  const css = { w: vp.width / dpr, h: vp.height / dpr };
  doc.destroy();
  return { key, toCrop, toRect, css };
}

/**
 * Cut page 1 to `crop` (fractions of its page box) and add a thin white strip on the edge that
 * is "up" when the label is viewed, with `text` in small letters. The label is never covered.
 */
export async function stamp(bytes, text, crop) {
  const { PDFDocument, StandardFonts, rgb, degrees } = await lib();
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const page = doc.getPage(0);
  // only the first page is the label; drop instruction pages
  while (doc.getPageCount() > 1) doc.removePage(1);
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  if (crop && crop.w > 0.02 && crop.h > 0.02) {
    const cb = page.getCropBox();
    const r = { x: cb.x + crop.x * cb.width, y: cb.y + crop.y * cb.height, w: crop.w * cb.width, h: crop.h * cb.height };
    page.setMediaBox(r.x, r.y, r.w, r.h); page.setCropBox(r.x, r.y, r.w, r.h);
    page.setTrimBox(r.x, r.y, r.w, r.h); page.setBleedBox(r.x, r.y, r.w, r.h); page.setArtBox(r.x, r.y, r.w, r.h);
  }
  if (!text) return doc.save();
  const mb = page.getMediaBox();
  const rot = ((page.getRotation().angle % 360) + 360) % 360;
  const H = BAND, pad = 6;
  let band;
  if (rot === 90) { page.setMediaBox(mb.x - H, mb.y, mb.width + H, mb.height); band = { x: mb.x - H, y: mb.y, w: H, h: mb.height }; }
  else if (rot === 180) { page.setMediaBox(mb.x, mb.y - H, mb.width, mb.height + H); band = { x: mb.x, y: mb.y - H, w: mb.width, h: H }; }
  else if (rot === 270) { page.setMediaBox(mb.x, mb.y, mb.width + H, mb.height); band = { x: mb.x + mb.width, y: mb.y, w: H, h: mb.height }; }
  else { page.setMediaBox(mb.x, mb.y, mb.width, mb.height + H); band = { x: mb.x, y: mb.y + mb.height, w: mb.width, h: H }; }
  const nb = page.getMediaBox();
  page.setCropBox(nb.x, nb.y, nb.width, nb.height); page.setTrimBox(nb.x, nb.y, nb.width, nb.height); page.setBleedBox(nb.x, nb.y, nb.width, nb.height); page.setArtBox(nb.x, nb.y, nb.width, nb.height);
  const along = rot === 90 || rot === 270 ? band.h : band.w;
  const size = Math.max(5, Math.min(8.5, (along - pad * 2) / font.widthOfTextAtSize(text, 1)));
  const off = H / 2 - size * 0.35;
  page.drawRectangle({ x: band.x, y: band.y, width: band.w, height: band.h, color: rgb(1, 1, 1) });
  let box;
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
