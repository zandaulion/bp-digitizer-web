/* Local OCR evaluation records. Pictures and results stay in IndexedDB until
   the user explicitly downloads or deletes them; this module never uploads. */
'use strict';

export const MAX_AUDITS = 100;
export const MAX_IMAGE_EDGE = 1920;
export const JPEG_QUALITY = 0.86;

const finite = (value) => value == null || value === ''
  ? null : Number.isFinite(Number(value)) ? Number(value) : null;

export function readingValues(reading) {
  if (!reading) return null;
  const sys = finite(reading.sys ?? reading.systolic);
  const dia = finite(reading.dia ?? reading.diastolic);
  if (sys == null || dia == null) return null;
  return { sys, dia, pulse: finite(reading.pulse) };
}

export function readingsDiffer(raw, final) {
  const a = readingValues(raw), b = readingValues(final);
  if (!a || !b) return true;
  return a.sys !== b.sys || a.dia !== b.dia || a.pulse !== b.pulse;
}

export function auditStage(row) {
  if (row?.decision === 'error' || row?.ocrStatus === 'error') return 'error';
  const method = row?.rawResult?.cropFallback?.method;
  if (method === 'display-rectification-consensus') return 'rectified';
  if (method === 'two-agreeing-row-crops-light-normalized') return 'adaptive';
  if (method === 'two-agreeing-center-crops') return 'portrait';
  return readingValues(row?.rawReading || row?.rawResult?.reading) ? 'full' : 'unreadable';
}

export function summarizeAudits(rows) {
  const saved = rows.filter((row) => row.decision === 'saved');
  const compared = saved.map((row) => ({
    raw: readingValues(row.rawReading || row.rawResult?.reading),
    final: readingValues(row.finalReading),
  })).filter((pair) => pair.raw && pair.final);
  const fields = Object.fromEntries(['sys', 'dia', 'pulse'].map((field) => {
    const eligible = compared.filter((pair) => pair.raw[field] != null && pair.final[field] != null);
    return [field, {
      correct: eligible.filter((pair) => pair.raw[field] === pair.final[field]).length,
      total: eligible.length,
    }];
  }));
  const stages = {};
  for (const row of rows) {
    const stage = auditStage(row);
    stages[stage] = (stages[stage] || 0) + 1;
  }
  return {
    total: rows.length,
    unchanged: saved.filter((row) => row.adjusted === false).length,
    adjusted: saved.filter((row) => row.adjusted === true).length,
    notSaved: rows.length - saved.length,
    compared: compared.length,
    exact: compared.filter((pair) => !readingsDiffer(pair.raw, pair.final)).length,
    fields,
    stages,
  };
}

/* Store the same practical input scale used by the reader, rather than a
   multi-megabyte camera original. Canvas also strips EXIF metadata. */
export async function prepareAuditImage(file) {
  let bitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    canvas.getContext('2d').drawImage(bitmap, 0, 0, width, height);
    const image = await new Promise((resolve, reject) => canvas.toBlob(
      (blob) => blob ? resolve(blob) : reject(new Error('image-encode-failed')),
      'image/jpeg', JPEG_QUALITY));
    return { image, width, height };
  } finally {
    bitmap?.close();
  }
}

function blobDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

export async function serializableAudits(rows) {
  const result = [];
  for (const row of rows) {
    const { image, ...metadata } = row;
    result.push({
      ...metadata,
      image: image ? {
        type: image.type,
        size: image.size,
        dataUrl: await blobDataUrl(image),
      } : null,
    });
  }
  return result;
}
