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
 * Find the label on page 1 by itself: render the page, take the largest connected block of
 * dark pixels (the label's frame with everything inside it) and return its box as fractions of
 * the page box (PDF space), plus a picture of just that part for the thumbnail.
 * Instructions, dashed cut lines and scissors are separate small blocks, so they are left out.
 */
export async function analyze(bytes) {
  const pdfjs = await viewer();
  const doc = await pdfjs.getDocument({ data: bytes.slice(0) }).promise;
  const page = await doc.getPage(1);
  const vp = page.getViewport({ scale: 1.5 });
  const W = Math.round(vp.width), H = Math.round(vp.height);
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const cx = cv.getContext('2d', { willReadFrequently: true });
  cx.fillStyle = '#fff'; cx.fillRect(0, 0, W, H);
  await page.render({ canvasContext: cx, viewport: vp }).promise;
  const px = cx.getImageData(0, 0, W, H).data, dark = new Uint8Array(W * H);
  let any = 0, ax1 = W, ay1 = H, ax2 = 0, ay2 = 0;
  for (let i = 0, k = 0; k < W * H; i += 4, k++) {
    if (px[i] * 0.3 + px[i + 1] * 0.59 + px[i + 2] * 0.11 < 170) {
      dark[k] = 1; any++;
      const x = k % W, y = (k - x) / W;
      if (x < ax1) ax1 = x; if (x > ax2) ax2 = x; if (y < ay1) ay1 = y; if (y > ay2) ay2 = y;
    }
  }
  // connected blocks (8 neighbours); keep the one with the biggest box
  const seen = new Uint8Array(W * H), q = new Int32Array(W * H);
  let best = null;
  for (let k0 = 0; k0 < W * H; k0++) {
    if (!dark[k0] || seen[k0]) continue;
    let h = 0, t = 0, x1 = W, y1 = H, x2 = 0, y2 = 0;
    q[t++] = k0; seen[k0] = 1;
    while (h < t) {
      const k = q[h++], x = k % W, y = (k - x) / W;
      if (x < x1) x1 = x; if (x > x2) x2 = x; if (y < y1) y1 = y; if (y > y2) y2 = y;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy; if (yy < 0 || yy >= H) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx; if (xx < 0 || xx >= W) continue;
          const kk = yy * W + xx; if (dark[kk] && !seen[kk]) { seen[kk] = 1; q[t++] = kk; }
        }
      }
    }
    const area = (x2 - x1 + 1) * (y2 - y1 + 1);
    if (!best || area > best.area) best = { x1, y1, x2, y2, area };
  }
  // no clear frame (a label without a border): fall back to everything printed on the page
  let r = best && best.area > W * H * 0.04 ? best : any ? { x1: ax1, y1: ay1, x2: ax2, y2: ay2 } : { x1: 0, y1: 0, x2: W - 1, y2: H - 1 };
  const m = 4; // a hair of white around the frame
  r = { x1: Math.max(0, r.x1 - m), y1: Math.max(0, r.y1 - m), x2: Math.min(W - 1, r.x2 + m), y2: Math.min(H - 1, r.y2 + m) };
  const [vx1, vy1, vx2, vy2] = page.view, vw = vx2 - vx1, vh = vy2 - vy1;
  const a = vp.convertToPdfPoint(r.x1, r.y1), b = vp.convertToPdfPoint(r.x2 + 1, r.y2 + 1);
  const crop = { x: (Math.min(a[0], b[0]) - vx1) / vw, y: (Math.min(a[1], b[1]) - vy1) / vh, w: Math.abs(a[0] - b[0]) / vw, h: Math.abs(a[1] - b[1]) / vh };
  const src = document.createElement('canvas'); src.width = r.x2 - r.x1 + 1; src.height = r.y2 - r.y1 + 1;
  src.getContext('2d').drawImage(cv, r.x1, r.y1, src.width, src.height, 0, 0, src.width, src.height);
  doc.destroy();
  return { crop, src, landscape: src.width > src.height * 1.08 };
}
/** Small picture of the cut label, turned `rot` degrees anticlockwise like it will print. */
export function thumb(src, rot, maxH = 150) {
  const q = ((rot % 360) + 360) % 360, side = q === 90 || q === 270;
  const w0 = side ? src.height : src.width, h0 = side ? src.width : src.height, k = Math.min(1, maxH / h0);
  const c = document.createElement('canvas'); c.width = Math.round(w0 * k); c.height = Math.round(h0 * k);
  const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
  g.translate(c.width / 2, c.height / 2); g.rotate(-q * Math.PI / 180); g.scale(k, k);
  g.drawImage(src, -src.width / 2, -src.height / 2);
  return c.toDataURL('image/png');
}

export const SIZES = { '100x150': { w: 283.46, h: 425.2, label: '100×150 mm' }, '100x100': { w: 283.46, h: 283.46, label: '100×100 mm' }, orig: { w: 0, h: 0, label: 'Tamaño real' } };

/**
 * One PDF, one label per page, ready for a label printer: each label is cut out of its PDF,
 * turned upright, scaled to fit the label size and `text` goes in the white strip on top.
 * items: [{ bytes, crop, rot, text }]
 */
export async function build(items, sizeKey = '100x150') {
  const { PDFDocument, StandardFonts, rgb, degrees } = await lib();
  const out = await PDFDocument.create();
  const font = await out.embedFont(StandardFonts.HelveticaBold);
  const T = 20, M = 6; // text strip on top, margin
  for (const it of items) {
    const src = await PDFDocument.load(it.bytes, { ignoreEncryption: true });
    const sp = src.getPage(0), cb = sp.getCropBox(), c = it.crop || { x: 0, y: 0, w: 1, h: 1 };
    const box = { left: cb.x + c.x * cb.width, bottom: cb.y + c.y * cb.height, right: cb.x + (c.x + c.w) * cb.width, top: cb.y + (c.y + c.h) * cb.height };
    const emb = await out.embedPage(sp, box);
    const cw = box.right - box.left, ch = box.top - box.bottom;
    // the page's own /Rotate turns clockwise, our rot anticlockwise
    const q = ((((it.rot || 0) - (sp.getRotation().angle || 0)) % 360) + 360) % 360, side = q === 90 || q === 270;
    const ow = side ? ch : cw, oh = side ? cw : ch; // size once upright
    const S = SIZES[sizeKey] || SIZES['100x150'];
    const W = S.w || ow + M * 2, H = S.h || oh + T + M;
    const s = Math.min((W - M * 2) / ow, (H - T - M) / oh);
    const page = out.addPage([W, H]);
    const L = (W - ow * s) / 2, B = M + (H - T - M - oh * s) / 2; // where the upright label sits
    const w = cw * s, h = ch * s;
    // pdf-lib turns the drawing anticlockwise around (x, y): place it so it lands on [L, B, ow*s, oh*s]
    const at = { 0: { x: L, y: B }, 90: { x: L + h, y: B }, 180: { x: L + w, y: B + h }, 270: { x: L, y: B + w } }[q];
    page.drawPage(emb, { x: at.x, y: at.y, width: w, height: h, rotate: degrees(q) });
    if (it.text) {
      const t = latin1(it.text), size = Math.min(11, (W - M * 2) / font.widthOfTextAtSize(t, 1));
      page.drawText(t, { x: (W - font.widthOfTextAtSize(t, size)) / 2, y: H - T + (T - size) / 2 + 1, size, font, color: rgb(0, 0, 0) });
    }
  }
  return out.save();
}

export function download(bytes, name) {
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
  const a = document.createElement('a');
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
