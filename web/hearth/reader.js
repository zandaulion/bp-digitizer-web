// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 zandaulion
// Integration example: one persistent worker, one in-flight photo, no storage.
export async function createHearthReader(workerUrl, {
  initTimeoutMs = 90000,
  readTimeoutMs = 30000,
  maxEdge = 1920,
} = {}) {
  if (![initTimeoutMs, readTimeoutMs, maxEdge].every(v => Number.isFinite(v) && v > 0)) {
    throw new Error('Timeouts and maxEdge must be positive finite numbers');
  }
  const worker = new Worker(workerUrl, {type: 'module'});
  let closed = false, busy = false, nextId = 0, pending = null;
  let resolveReady, rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const initTimer = setTimeout(() => stop(new Error('Reader initialization timed out')), initTimeoutMs);

  function stop(error = new Error('Reader disposed')) {
    if (closed) return;
    closed = true;
    clearTimeout(initTimer);
    worker.terminate();
    rejectReady(error);
    if (pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      pending = null;
    }
  }

  worker.onerror = event => stop(new Error(event.message || 'Reader worker failed'));
  worker.onmessageerror = () => stop(new Error('Invalid worker message'));
  worker.onmessage = ({data}) => {
    if (closed) return;
    if (data.type === 'ready') { clearTimeout(initTimer); resolveReady(); return; }
    if (data.type === 'error' && data.id === undefined) { stop(new Error(data.message)); return; }
    if (!pending || data.id !== pending.id) return;
    if (data.type !== 'result' && data.type !== 'error') return;
    const request = pending;
    pending = null;
    clearTimeout(request.timer);
    if (data.type === 'error') request.reject(new Error(data.message));
    else request.resolve(data);
  };

  await ready;
  return {
    async read(source) {
      if (closed) throw new Error('Reader is closed; create a new instance');
      if (busy) throw new Error('A photo is already being processed');
      busy = true;
      let bitmap;
      try {
        bitmap = await createImageBitmap(source, {imageOrientation: 'from-image'});
        const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
        if (scale < 1) {
          const resized = await createImageBitmap(bitmap, {
            resizeWidth: Math.max(1, Math.round(bitmap.width * scale)),
            resizeHeight: Math.max(1, Math.round(bitmap.height * scale)),
            resizeQuality: 'high',
          });
          bitmap.close();
          bitmap = resized;
        }
        if (closed) throw new Error('Reader disposed while preparing image');
        const imageSize = {width: bitmap.width, height: bitmap.height};
        const id = ++nextId;
        const response = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => stop(new Error('OCR timed out; create a new reader')), readTimeoutMs);
          pending = {id, resolve, reject, timer};
          try {
            worker.postMessage({type: 'read', id, bitmap}, [bitmap]);
            bitmap = null; // Ownership transferred; the worker closes it.
          } catch (error) {
            clearTimeout(timer);
            pending = null;
            reject(error);
          }
        });
        return {result: response.result, elapsedMs: response.elapsedMs, imageSize};
      } finally {
        bitmap?.close();
        busy = false;
      }
    },
    dispose() { stop(); },
  };
}
