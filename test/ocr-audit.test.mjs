import test from 'node:test';
import assert from 'node:assert/strict';
import { readingValues, readingsDiffer, summarizeAudits } from '../web/ocr-audit.js';

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
  assert.deepEqual(summarizeAudits([
    { decision: 'saved', adjusted: false },
    { decision: 'saved', adjusted: true },
    { decision: 'discarded', adjusted: null },
    { decision: 'error', adjusted: null },
  ]), { total: 4, unchanged: 1, adjusted: 1, notSaved: 2 });
});
