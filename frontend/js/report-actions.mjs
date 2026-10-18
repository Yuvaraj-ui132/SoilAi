function toIsoDate(value) {
  let date = value;
  if (typeof value?.toDate === 'function') date = value.toDate();
  else if (typeof value?.toMillis === 'function') date = new Date(value.toMillis());
  else if (typeof value === 'string' || typeof value === 'number') date = new Date(value);
  return date instanceof Date && Number.isFinite(date.getTime())
    ? date.toISOString()
    : undefined;
}

function omitUndefined(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

export function buildReportPayload(test) {
  const results = test.results || test;
  const trials = Array.isArray(test.trials) ? test.trials : [];
  const payload = {
    test_name: test.test_name || test.testName || 'Not recorded',
    test_id: test.test_id || test.testId || test.id,
    test_date: toIsoDate(test.test_date || test.createdAt),
    location: test.location,
    soil_type: test.soil_type || test.soilType || 'Not recorded',
    omc: results.omc,
    mdd: results.mdd,
    evaluation: results.evaluation || {},
    trials: trials.map((trial, index) => omitUndefined({
      container_no: trial.container_no || String(trial.trial_number ?? trial.trialIndex ?? index + 1),
      trial_number: trial.trial_number ?? trial.trialIndex,
      W1: trial.W1,
      W2: trial.W2,
      W3: trial.W3,
      wet_density: trial.wet_density ?? trial.WD,
      moisture_content: trial.moisture_content ?? trial.mc,
      dry_density: trial.dry_density ?? trial.dd
    }))
  };
  if (results.fit
    && ['a', 'b', 'c', 'r_squared'].every(key => Number.isFinite(Number(results.fit[key])))) {
    payload.fit = results.fit;
  }
  if (['quadratic_fit', 'measured_peak_fallback'].includes(results.peak_method)) {
    payload.peak_method = results.peak_method;
  }
  if (results.evaluation) payload.evaluation = results.evaluation;
  return omitUndefined(payload);
}

export function isReportEligible(test) {
  const trials = test?.trials;
  const results = test?.results || test;
  const hasFiniteValue = value =>
    value !== undefined
    && value !== null
    && value !== ''
    && Number.isFinite(Number(value));
  return Array.isArray(trials)
    && trials.length >= 2
    && trials.length <= 10
    && hasFiniteValue(results?.omc)
    && hasFiniteValue(results?.mdd)
    && trials.every(trial => {
      const values = [
        trial.W1,
        trial.W2,
        trial.W3,
        trial.wet_density ?? trial.WD,
        trial.moisture_content ?? trial.mc,
        trial.dry_density ?? trial.dd
      ];
      if (!values.every(hasFiniteValue)) return false;
      const [w1, w2, w3, wetDensity] = values.map(Number);
      return w2 > w3
        && w3 > w1
        && wetDensity >= 0.8
        && wetDensity <= 3.0;
    });
}

export function resolveReportEndpoint(location = window.location, apiBaseMeta = document.querySelector('meta[name="soilai-api-base-url"]')?.content) {
  const localOverride = new URLSearchParams(location.search).get('apiBase') === 'local'
    && ['localhost', '127.0.0.1'].includes(location.hostname);
  const apiBase = localOverride
    ? location.origin
    : (apiBaseMeta || '').trim().replace(/\/+$/, '');
  return `${apiBase.replace(/\/+$/, '')}/api/export-pdf`;
}

async function requestReport(test, inline) {
  if (!isReportEligible(test)) {
    throw new Error('This saved test does not contain the complete trial data required for a PDF report.');
  }
  const baseEndpoint = resolveReportEndpoint();
  const endpoint = inline ? `${baseEndpoint}?disposition=inline` : baseEndpoint;
  let response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildReportPayload(test))
    });
  } catch (error) {
    if (error instanceof TypeError) {
      console.error('PDF API network request failed:', { endpoint, error });
      throw new Error(
        `Could not reach the PDF API at ${new URL(endpoint, window.location.href).origin}. `
        + 'Check that the Flask server is running and that this page uses the correct API base URL.'
      );
    }
    throw error;
  }
  if (!response.ok) {
    let message = `PDF generation failed (HTTP ${response.status}).`;
    try {
      const responseText = await response.text();
      try {
        const errorBody = JSON.parse(responseText);
        const details = errorBody.details?.map(item => `${item.field}: ${item.message}`).join('; ');
        message = details || errorBody.error || errorBody.message || message;
      } catch {
        if (responseText.trim()) message = `${message} ${responseText.trim().slice(0, 240)}`;
      }
    } catch (readError) {
      console.error('Could not read PDF generation error response:', readError);
    }
    throw new Error(message);
  }
  const blob = await response.blob();
  if (blob.type !== 'application/pdf') {
    throw new Error('The report service returned an invalid PDF response.');
  }
  return blob;
}

export async function viewReportPdf(test) {
  const reportWindow = window.open('', '_blank');
  if (!reportWindow) throw new Error('Allow pop-ups to view the generated PDF.');
  try {
    const blob = await requestReport(test, true);
    reportWindow.location.href = URL.createObjectURL(blob);
  } catch (error) {
    reportWindow.close();
    throw error;
  }
}

export async function downloadReportPdf(test) {
  const blob = await requestReport(test, false);
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = objectUrl;
  link.download = 'SoilAI_Compaction_Report.pdf';
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
}
