// Load bundled library scripts on demand.

const loading = new Map();

export function loadScript(src) {
  if (!loading.has(src)) {
    loading.set(src, new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = src;
      s.async = false; // keep order when several are requested together
      s.onload = () => res();
      s.onerror = () => {
        loading.delete(src);
        s.remove();
        rej(new Error('Could not load ' + src));
      };
      document.head.appendChild(s);
    }));
  }
  return loading.get(src);
}

export function loadScripts(list) {
  return Promise.all(list.map(loadScript));
}
