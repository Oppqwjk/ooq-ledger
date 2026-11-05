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
 * Find the label(s) in a PDF by themselves. Works for any carrier:
 *  - pages that are already label-sized (GLS, SEUR, InPost 10×15…) are used whole, every page;
 *  - A4 pages: the label's frame (a closed rectangle with everything inside) is cut out, so
 *    instructions, dashed cut lines and scissors are left out (Vinted Go, Mondial Relay…);
 *  - A4 without a frame: the densest printed block (barcodes + address) is cut out.
 * Returns [{ page, crop, src, landscape }]: crop is fractions of the page box (PDF space).
 */
export async function analyze(bytes) {
  const pdfjs = await viewer();
  const doc = await pdfjs.getDocument({ data: bytes.slice(0) }).promise;
  const out = [], hash = await sha(bytes);
  try {
    for (let pn = 1; pn <= doc.numPages; pn++) {
      const page = await doc.getPage(pn);
      const base = page.getViewport({ scale: 1 }), small = Math.max(base.width, base.height) <= 520;
      if (!small && pn > 1 && out.length) { // extra A4 pages are usually instructions: only keep ones with a framed label
        const r2 = await findLabel(page, false); if (r2 && r2.framed) out.push({ page: pn - 1, key: (await textKey(page)) || `h:${hash}:${pn}`, ...r2 });
        continue;
      }
      const r = small ? await wholePage(page) : await findLabel(page, true);
      if (r) out.push({ page: pn - 1, key: (await textKey(page)) || `h:${hash}:${pn}`, ...r });
    }
  } finally { doc.destroy(); }
  return out;
}
// what identifies a label: its tracking numbers (long codes printed as text), so the same label
// downloaded twice is caught even if the files differ; image-only labels fall back to the file itself
async function textKey(page) {
  try {
    const tc = await page.getTextContent();
    const toks = (tc.items.map((i) => i.str).join(' ').toUpperCase().match(/[A-Z0-9]{10,}/g) || []).filter((t) => /\d{6}/.test(t));
    return [...new Set(toks)].sort().join('|');
  } catch { return ''; }
}
async function sha(bytes) {
  try { const d = await crypto.subtle.digest('SHA-256', bytes); return [...new Uint8Array(d)].slice(0, 12).map((b) => b.toString(16).padStart(2, '0')).join(''); }
  catch { return String(bytes.length); }
}
async function draw(page) {
  const vp = page.getViewport({ scale: 1.5 });
  const W = Math.round(vp.width), H = Math.round(vp.height);
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const cx = cv.getContext('2d', { willReadFrequently: true });
  cx.fillStyle = '#fff'; cx.fillRect(0, 0, W, H);
  await page.render({ canvasContext: cx, viewport: vp }).promise;
  return { vp, W, H, cv, cx };
}
function result(page, d, r) {
  const { vp, W, H, cv } = d, m = 4; // a hair of white around the label
  r = { x1: Math.max(0, r.x1 - m), y1: Math.max(0, r.y1 - m), x2: Math.min(W - 1, r.x2 + m), y2: Math.min(H - 1, r.y2 + m) };
  const [vx1, vy1, vx2, vy2] = page.view, vw = vx2 - vx1, vh = vy2 - vy1;
  const a = vp.convertToPdfPoint(r.x1, r.y1), b = vp.convertToPdfPoint(r.x2 + 1, r.y2 + 1);
  const crop = { x: (Math.min(a[0], b[0]) - vx1) / vw, y: (Math.min(a[1], b[1]) - vy1) / vh, w: Math.abs(a[0] - b[0]) / vw, h: Math.abs(a[1] - b[1]) / vh };
  const src = document.createElement('canvas'); src.width = r.x2 - r.x1 + 1; src.height = r.y2 - r.y1 + 1;
  src.getContext('2d').drawImage(cv, r.x1, r.y1, src.width, src.height, 0, 0, src.width, src.height);
  return { crop, src, landscape: src.width > src.height * 1.08 };
}
async function wholePage(page) {
  const d = await draw(page);
  return { ...result(page, d, { x1: 4, y1: 4, x2: d.W - 5, y2: d.H - 5 }), framed: true };
}
function darkMask(d) {
  const { W, H, cx } = d, px = cx.getImageData(0, 0, W, H).data, dark = new Uint8Array(W * H);
  for (let i = 0, k = 0; k < W * H; i += 4, k++) if (px[i] * 0.3 + px[i + 1] * 0.59 + px[i + 2] * 0.11 < 170) dark[k] = 1;
  return dark;
}
// connected blocks of `mask` (8 neighbours) → [{x1,y1,x2,y2,ink,id}], plus the block id of every pixel
function blocks(mask, W, H, ink) {
  const id = new Int32Array(W * H), q = new Int32Array(W * H), list = [];
  for (let k0 = 0; k0 < W * H; k0++) {
    if (!mask[k0] || id[k0]) continue;
    const b = { id: list.length + 1, x1: W, y1: H, x2: 0, y2: 0, ink: 0 };
    let h = 0, t = 0; q[t++] = k0; id[k0] = b.id;
    while (h < t) {
      const k = q[h++], x = k % W, y = (k - x) / W;
      if (x < b.x1) b.x1 = x; if (x > b.x2) b.x2 = x; if (y < b.y1) b.y1 = y; if (y > b.y2) b.y2 = y;
      if (ink[k]) b.ink++;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy; if (yy < 0 || yy >= H) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx; if (xx < 0 || xx >= W) continue;
          const kk = yy * W + xx; if (mask[kk] && !id[kk]) { id[kk] = b.id; q[t++] = kk; }
        }
      }
    }
    list.push(b);
  }
  return { list, id };
}
// grow every dark pixel into a (2r+1)² square, so the pieces of one label join into one block
function dilate(m, W, H, r) {
  const a = new Uint8Array(W * H), b = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) { let c = 0; const o = y * W; for (let x = 0; x < W + r; x++) { if (x < W && m[o + x]) c++; if (x - 2 * r - 1 >= 0 && m[o + x - 2 * r - 1]) c--; const xx = x - r; if (xx >= 0 && xx < W) a[o + xx] = c > 0 ? 1 : 0; } }
  for (let x = 0; x < W; x++) { let c = 0; for (let y = 0; y < H + r; y++) { if (y < H && a[y * W + x]) c++; if (y - 2 * r - 1 >= 0 && a[(y - 2 * r - 1) * W + x]) c--; const yy = y - r; if (yy >= 0 && yy < H) b[yy * W + x] = c > 0 ? 1 : 0; } }
  return b;
}
async function findLabel(page, fallback) {
  const d = await draw(page), { W, H } = d, dark = darkMask(d);
  const { list, id } = blocks(dark, W, H, dark);
  // 1) a framed label: the biggest block whose four edges are (almost) solid lines
  const edge = (b) => {
    let t = 0, bo = 0, l = 0, ri = 0; const w = b.x2 - b.x1 + 1, h = b.y2 - b.y1 + 1, band = 2;
    const hit = (x, y0, y1) => { for (let y = y0; y <= y1; y++) if (id[y * W + x] === b.id) return 1; return 0; };
    const hitR = (y, x0, x1) => { for (let x = x0; x <= x1; x++) if (id[y * W + x] === b.id) return 1; return 0; };
    for (let x = b.x1; x <= b.x2; x++) { t += hit(x, b.y1, Math.min(b.y2, b.y1 + band)); bo += hit(x, Math.max(b.y1, b.y2 - band), b.y2); }
    for (let y = b.y1; y <= b.y2; y++) { l += hitR(y, b.x1, Math.min(b.x2, b.x1 + band)); ri += hitR(y, Math.max(b.x1, b.x2 - band), b.x2); }
    return Math.min(t / w, bo / w, l / h, ri / h);
  };
  const frames = list.filter((b) => (b.x2 - b.x1 + 1) * (b.y2 - b.y1 + 1) > W * H * 0.04).sort((a, b) => (b.x2 - b.x1) * (b.y2 - b.y1) - (a.x2 - a.x1) * (a.y2 - a.y1));
  const fr = frames.find((b) => edge(b) >= 0.85);
  if (fr) return { ...result(page, d, fr), framed: true };
  if (!fallback) return null;
  // 2) no frame: join nearby ink into blocks and keep the one with the most ink (barcodes + address)
  const g = blocks(dilate(dark, W, H, 18), W, H, dark).list.sort((a, b) => b.ink - a.ink)[0];
  if (!g) return { ...result(page, d, { x1: 0, y1: 0, x2: W - 1, y2: H - 1 }), framed: false };
  // tighten the box to the real ink inside it
  return { ...result(page, d, g), framed: false };
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
  const font = await out.embedFont(StandardFonts.Helvetica);
  const T = 10, M = 4; // thin text strip on top, margin
  for (const it of items) {
    const src = await PDFDocument.load(it.bytes, { ignoreEncryption: true });
    const sp = src.getPage(it.page || 0), cb = sp.getCropBox(), c = it.crop || { x: 0, y: 0, w: 1, h: 1 };
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
      const t = latin1(it.text), size = Math.min(6, (W - M * 2) / font.widthOfTextAtSize(t, 1));
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
