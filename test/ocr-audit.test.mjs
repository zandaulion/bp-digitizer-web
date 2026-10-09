import test from 'node:test';
import assert from 'node:assert/strict';
import { auditStage, readingValues, readingsDiffer, summarizeAudits } from '../web/ocr-audit.js';

// All values in this file are synthetic and are not sourced from a real reading.

test('normalizes worker and stored reading shapes', () => {
  assert.deepEqual(readingValues({ sys: 118, dia: 76, pulse: 64 }),
    { sys: 118, dia: 76, pulse: 64 });
  assert.deepEqual(readingValues({ systolic: 118, diastolic: 76, pulse: null }),
    { sys: 118, dia: 76, pulse: null });
  assert.equal(readingValues({ sys: 118 }), null);
});

test('detects any correction and treats a refusal as adjusted when saved', () => {
  assert.equal(readingsDiffer({ sys: 118, dia: 76, pulse: 64 },
    { sys: 118, dia: 76, pulse: 64 }), false);
  assert.equal(readingsDiffer({ sys: 118, dia: 76, pulse: 64 },
    { sys: 119, dia: 76, pulse: 64 }), true);
  assert.equal(readingsDiffer(null, { sys: 118, dia: 76, pulse: 64 }), true);
});

test('summarizes saved and unsaved evaluation outcomes', () => {
  const summary = summarizeAudits([
    { decision: 'saved', adjusted: false, rawReading: { sys: 118, dia: 76, pulse: 64 },
      finalReading: { sys: 118, dia: 76, pulse: 64 }, rawResult: {} },
    { decision: 'saved', adjusted: true, rawReading: { sys: 121, dia: 82, pulse: 70 },
      finalReading: { sys: 121, dia: 80, pulse: 70 },
      rawResult: { cropFallback: { method: 'display-rectification-consensus' } } },
    { decision: 'discarded', adjusted: null, rawReading: null },
    { decision: 'error', adjusted: null },
  ]);
  assert.deepEqual(summary, {
    total: 4, unchanged: 1, adjusted: 1, notSaved: 2, compared: 2, exact: 1,
    fields: {
      sys: { correct: 2, total: 2 }, dia: { correct: 1, total: 2 },
      pulse: { correct: 2, total: 2 },
    },
    stages: { full: 1, rectified: 1, unreadable: 1, error: 1 },
  });
});

test('classifies OCR fallback stages without inspecting picture contents', () => {
  assert.equal(auditStage({ rawReading: { sys: 118, dia: 76, pulse: 64 } }), 'full');
  assert.equal(auditStage({ rawResult: { cropFallback: {
    method: 'two-agreeing-row-crops-light-normalized',
  } }, rawReading: { sys: 118, dia: 76, pulse: 64 } }), 'adaptive');
  assert.equal(auditStage({ rawReading: null }), 'unreadable');
});
