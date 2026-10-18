import test from 'node:test';
import assert from 'node:assert/strict';
import { canRunComparison, groupTestsBySavedDate, savedDateInfo } from '../js/compare-utils.mjs';
import {
  buildReportPayload,
  downloadReportPdf,
  isReportEligible,
  resolveReportEndpoint,
  viewReportPdf
} from '../js/report-actions.mjs';

const fireTimestamp = date => ({ toDate: () => date });

test('saved tests are grouped by actual date, newest first, with unavailable dates last', () => {
  const newest = new Date('2026-10-18T14:00:00Z');
  const sameDayOlder = new Date('2026-10-18T10:00:00Z');
  const priorDay = new Date('2026-10-17T12:00:00Z');
  const tests = [
    { id: 'prior', testName: 'Prior', createdAt: fireTimestamp(priorDay) },
    { id: 'older', testName: 'Older', createdAt: fireTimestamp(sameDayOlder) },
    { id: 'missing', testName: 'Missing' },
    { id: 'newest', testName: 'Newest', createdAt: fireTimestamp(newest) }
  ];

  const groups = groupTestsBySavedDate(tests);

  assert.deepEqual(groups.map(group => group.key), [
    savedDateInfo(newest).key,
    savedDateInfo(priorDay).key,
    'unavailable'
  ]);
  assert.deepEqual(groups[0].tests.map(record => record.id), ['newest', 'older']);
  assert.equal(groups[2].label, 'Date unavailable');
});

test('report API uses same-origin Flask for local override and configured production URL otherwise', () => {
  assert.equal(
    resolveReportEndpoint({ hostname: '127.0.0.1', origin: 'http://127.0.0.1:5000', search: '?apiBase=local' }, 'https://soilai.onrender.com'),
    'http://127.0.0.1:5000/api/export-pdf'
  );
  assert.equal(
    resolveReportEndpoint({ hostname: 'localhost', origin: 'http://localhost:5500', search: '?apiBase=local' }, 'https://soilai.onrender.com'),
    'http://localhost:5500/api/export-pdf'
  );
  assert.equal(
    resolveReportEndpoint({ hostname: 'soilai.example', origin: 'https://soilai.example', search: '?apiBase=local' }, 'https://soilai.onrender.com/'),
    'https://soilai.onrender.com/api/export-pdf'
  );
  assert.equal(
    resolveReportEndpoint({ hostname: 'localhost', origin: 'http://localhost:5000', search: '' }, 'https://soilai.onrender.com'),
    'https://soilai.onrender.com/api/export-pdf'
  );
});

test('comparison is enabled only with exactly three selected records', () => {
  assert.equal(canRunComparison(0), false);
  assert.equal(canRunComparison(1), false);
  assert.equal(canRunComparison(2), false);
  assert.equal(canRunComparison(3), true);
  assert.equal(canRunComparison(4), false);
});

test('saved Firestore report payload preserves saved values and omits absent metadata', () => {
  const savedTest = {
    id: 'saved-id',
    testName: 'Saved field test',
    soilType: 'Silty Clay',
    location: 'North site',
    createdAt: fireTimestamp(new Date('2026-10-18T10:00:00Z')),
    results: { omc: 20, mdd: 1.9 },
    trials: [1, 2, 3, 4].map(trial_number => ({
      trial_number,
      W1: 20,
      W2: 140,
      W3: 120,
      wet_density: 2.28,
      moisture_content: 20,
      dry_density: 1.9
    }))
  };

  assert.equal(isReportEligible(savedTest), true);
  const payload = buildReportPayload(savedTest);
  assert.equal(payload.test_id, 'saved-id');
  assert.equal(payload.test_date, '2026-10-18T10:00:00.000Z');
  assert.equal(payload.location, 'North site');
  assert.equal(payload.soil_type, 'Silty Clay');
  assert.deepEqual(payload.evaluation, {});
  assert.equal(payload.trials.length, 4);
  assert.equal(payload.trials[0].trial_number, 1);
  assert.equal(payload.trials[0].container_no, '1');
  assert.equal('fit' in payload, false);
  assert.equal('peak_method' in payload, false);
});

test('current Proctor result aliases map to the shared payload without inventing a saved date', () => {
  const proctorResult = {
    testName: 'Current test',
    soilType: 'Sandy soil',
    id: 'current-id',
    timestamp: new Date('2026-10-18T10:00:00Z'),
    omc: 20,
    mdd: 1.9,
    trials: [1, 2, 3, 4].map(trialIndex => ({
      trialIndex,
      W1: 20,
      W2: 140,
      W3: 120,
      WD: 2.28,
      mc: 20,
      dd: 1.9
    }))
  };
  const payload = buildReportPayload(proctorResult);

  assert.equal(isReportEligible(proctorResult), true);
  assert.equal(payload.test_name, 'Current test');
  assert.equal(payload.trials[0].wet_density, 2.28);
  assert.equal(payload.trials[0].moisture_content, 20);
  assert.equal('test_date' in payload, false);
});

test('report payload supplies legacy-required fields without inventing missing soil metadata', () => {
  const savedTest = {
    results: { omc: 20, mdd: 1.9 },
    trials: [1, 2, 3, 4].map(trial_number => ({
      trial_number,
      W1: 20,
      W2: 140,
      W3: 120,
      wet_density: 2.28,
      moisture_content: 20,
      dry_density: 1.9
    }))
  };
  const payload = buildReportPayload(savedTest);
  assert.equal(payload.test_name, 'Not recorded');
  assert.equal(payload.soil_type, 'Not recorded');
  assert.deepEqual(payload.evaluation, {});
  assert.deepEqual(payload.trials.map(trial => trial.container_no), ['1', '2', '3', '4']);
});

test('incomplete saved trial observations are not report eligible', () => {
  assert.equal(isReportEligible({ results: { omc: 20, mdd: 1.9 }, trials: [] }), false);
});

test('the report supports the Proctor module minimum of two valid trials', () => {
  const testRecord = {
    results: { omc: 20, mdd: 1.9 },
    trials: [1, 2].map(trial_number => ({
      trial_number,
      W1: 20,
      W2: trial_number === 1 ? 130 : 140,
      W3: 120,
      wet_density: trial_number === 1 ? 1.815 : 2.28,
      moisture_content: trial_number === 1 ? 10 : 20,
      dry_density: trial_number === 1 ? 1.65 : 1.9
    }))
  };
  assert.equal(isReportEligible(testRecord), true);
});

test('saved records with invalid mass order are not report eligible', () => {
  const testRecord = {
    results: { omc: 20, mdd: 1.9 },
    trials: [1, 2, 3, 4].map(trial_number => ({
      trial_number,
      W1: 20,
      W2: 120,
      W3: 120,
      wet_density: 1.8,
      moisture_content: 0,
      dry_density: 1.8
    }))
  };
  assert.equal(isReportEligible(testRecord), false);
});

test('ReportNav view and download use the shared PDF endpoint and payload', async () => {
  const testRecord = {
    testName: 'Shared endpoint test',
    createdAt: fireTimestamp(new Date('2026-10-18T10:00:00Z')),
    results: { omc: 20, mdd: 1.9 },
    trials: [1, 2, 3, 4].map(trial_number => ({
      trial_number,
      W1: 20,
      W2: 140,
      W3: 120,
      wet_density: 2.28,
      moisture_content: 20,
      dry_density: 1.9
    }))
  };
  const originalGlobals = {
    window: globalThis.window,
    document: globalThis.document,
    fetch: globalThis.fetch,
    createObjectURL: URL.createObjectURL,
    revokeObjectURL: URL.revokeObjectURL
  };
  const requests = [];
  let openedWindow;
  let downloaded = false;
  globalThis.window = {
    location: { search: '?apiBase=local', hostname: 'localhost', origin: 'http://localhost:5000', href: 'http://localhost:5000/reports?apiBase=local' },
    open: () => (openedWindow = { location: {}, close() {} }),
    setTimeout() {}
  };
  globalThis.document = {
    querySelector: () => null,
    createElement: () => ({ click: () => { downloaded = true; } })
  };
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    return { ok: true, blob: async () => new Blob(['%PDF'], { type: 'application/pdf' }) };
  };
  URL.createObjectURL = () => 'blob:shared-report';
  URL.revokeObjectURL = () => {};

  try {
    await viewReportPdf(testRecord);
    await downloadReportPdf(testRecord);
    assert.equal(openedWindow.location.href, 'blob:shared-report');
    assert.equal(downloaded, true);
    assert.equal(requests[0].url, 'http://localhost:5000/api/export-pdf?disposition=inline');
    assert.equal(requests[1].url, 'http://localhost:5000/api/export-pdf');
    assert.equal(
      new URL(requests[0].url).origin,
      new URL(requests[1].url).origin,
      'View and Download must use the same API origin'
    );
    assert.deepEqual(
      requests.map(request => JSON.parse(request.options.body)),
      [buildReportPayload(testRecord), buildReportPayload(testRecord)]
    );
  } finally {
    globalThis.window = originalGlobals.window;
    globalThis.document = originalGlobals.document;
    globalThis.fetch = originalGlobals.fetch;
    URL.createObjectURL = originalGlobals.createObjectURL;
    URL.revokeObjectURL = originalGlobals.revokeObjectURL;
  }
});

test('PDF network failures name the configured endpoint and local server troubleshooting', async () => {
  const original = {
    window: globalThis.window,
    document: globalThis.document,
    fetch: globalThis.fetch
  };
  globalThis.window = {
    location: { search: '?apiBase=local', hostname: '127.0.0.1', origin: 'http://127.0.0.1:5000', href: 'http://127.0.0.1:5000/proctor?apiBase=local' }
  };
  globalThis.document = { querySelector: () => null };
  globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
  try {
    await assert.rejects(
      downloadReportPdf({
        omc: 20,
        mdd: 1.9,
        trials: [1, 2].map(trial_number => ({
          trial_number, W1: 20, W2: 140, W3: 120,
          wet_density: 2.28, moisture_content: 20, dry_density: 1.9
        }))
      }),
      /Could not reach the PDF API at http:\/\/127\.0\.0\.1:5000/
    );
  } finally {
    globalThis.window = original.window;
    globalThis.document = original.document;
    globalThis.fetch = original.fetch;
  }
});

test('PDF API validation response displays server-provided detail', async () => {
  const original = {
    window: globalThis.window,
    document: globalThis.document,
    fetch: globalThis.fetch
  };
  globalThis.window = {
    location: { search: '?apiBase=local', hostname: 'localhost', origin: 'http://localhost:5000', href: 'http://localhost:5000/reports?apiBase=local' }
  };
  globalThis.document = { querySelector: () => null };
  globalThis.fetch = async () => ({
    ok: false,
    status: 422,
    text: async () => JSON.stringify({ error: 'Validation failed', details: [{ field: 'trials.0.W1', message: 'Input should be greater than 0' }] })
  });
  try {
    await assert.rejects(
      downloadReportPdf({
        omc: 20,
        mdd: 1.9,
        trials: [1, 2].map(trial_number => ({
          trial_number, W1: 20, W2: 140, W3: 120,
          wet_density: 2.28, moisture_content: 20, dry_density: 1.9
        }))
      }),
      /trials\.0\.W1: Input should be greater than 0/
    );
  } finally {
    globalThis.window = original.window;
    globalThis.document = original.document;
    globalThis.fetch = original.fetch;
  }
});
