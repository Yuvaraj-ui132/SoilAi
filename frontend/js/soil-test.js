import { renderCompactionChart } from './charts.js';

let trialCount = 3;
let lastResults = null;
const configuredApiBase = document.querySelector('meta[name="soilai-api-base-url"]')?.content.trim() || '';

async function apiRequest(path, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch(`${configuredApiBase.replace(/\/+$/, '')}${path}`, {
      ...options,
      signal: controller.signal,
    });
    const contentType = response.headers.get('content-type') || '';
    if (response.ok && contentType.includes('application/pdf')) {
      return await response.blob();
    }

    const responseText = await response.text();
    let payload;
    try {
      payload = JSON.parse(responseText);
    } catch {
      throw new Error(`The API returned an unexpected response (HTTP ${response.status}).`);
    }
    if (!response.ok) {
      const detail = payload.details?.map(item => `${item.field}: ${item.message}`).join('; ');
      throw new Error(detail || payload.error || `The API request failed (HTTP ${response.status}).`);
    }
    return payload;
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error('The API request timed out. Please try again.');
    }
    if (error instanceof TypeError) {
      throw new Error('Could not reach the SoilAI API. Check the API URL and your connection.');
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

const PRESETS = {
  "sandy-silt": {
    testName: "Standard Proctor - Sandy Silt (SM)",
    soilType: "Sandy Silt (SM)",
    moisture: [8, 11, 14, 17, 20],
    density: [1.72, 1.82, 1.88, 1.84, 1.75],
  },
  "clayey-gravel": {
    testName: "Modified Proctor - Clayey Gravel (GC)",
    soilType: "Clayey Gravel (GC)",
    moisture: [5, 8, 11, 14, 17],
    density: [1.82, 1.94, 2.00, 1.96, 1.87],
  },
  "lean-clay": {
    testName: "Cohesive Lean Clay (CL)",
    soilType: "Cohesive Lean Clay (CL)",
    moisture: [12, 16, 20, 24, 28],
    density: [1.48, 1.58, 1.63, 1.60, 1.52],
  },
};

function setUserDisplay() {
  const name = document.getElementById('user-display-name');
  const avatar = document.getElementById('user-avatar');
  if (name) name.textContent = 'Local Demo Mode';
  if (avatar) avatar.textContent = 'D';
}

function createTrialCard(number) {
  const card = document.createElement('div');
  card.className = 'trial-card fade-in';
  card.innerHTML = `
    <div class="trial-header">
      <div class="trial-badge"><span class="trial-label">Trial</span><span class="trial-number">${number}</span></div>
      <div class="trial-live-result" id="live-result-${number}">
        <span class="live-mc">MC: —</span><span class="live-dd">DD: —</span>
      </div>
      <button class="remove-trial-btn" type="button" title="Remove trial">✕</button>
    </div>
    <div class="trial-fields">
      <div class="field-group"><label>W1 — Empty Container (g)</label><input type="number" name="W1" step="0.01" min="0" class="trial-input"></div>
      <div class="field-group"><label>W2 — Container + Wet Soil (g)</label><input type="number" name="W2" step="0.01" min="0" class="trial-input"></div>
      <div class="field-group"><label>W3 — Container + Dry Soil (g)</label><input type="number" name="W3" step="0.01" min="0" class="trial-input"></div>
      <div class="field-group"><label>Wet Density (g/cm³)</label><input type="number" name="wet_density" step="0.001" min="0.8" max="3" class="trial-input"></div>
    </div>`;
  card.querySelector('.remove-trial-btn').addEventListener('click', () => removeTrial(card));
  card.querySelectorAll('input').forEach(input => input.addEventListener('input', () => previewTrial(card)));
  return card;
}

function renumberTrials() {
  document.querySelectorAll('.trial-card').forEach((card, index) => {
    const number = index + 1;
    card.querySelector('.trial-number').textContent = number;
    const result = card.querySelector('.trial-live-result');
    result.id = `live-result-${number}`;
  });
  trialCount = document.querySelectorAll('.trial-card').length;
  updateRemoveButtons();
}

function updateRemoveButtons() {
  const cards = document.querySelectorAll('.trial-card');
  cards.forEach(card => {
    const button = card.querySelector('.remove-trial-btn');
    if (button) button.disabled = cards.length <= 4;
  });
}

function addTrial() {
  const container = document.getElementById('trials-container');
  if (container.children.length >= 10) {
    showToast('A test can contain no more than 10 trials.', 'warning');
    return;
  }
  trialCount += 1;
  container.appendChild(createTrialCard(trialCount));
  updateRemoveButtons();
}

function removeTrial(card) {
  if (document.querySelectorAll('.trial-card').length <= 4) {
    showToast('A minimum of 4 trials is required.', 'warning');
    return;
  }
  card.remove();
  renumberTrials();
}

function previewTrial(card) {
  const read = name => Number.parseFloat(card.querySelector(`[name="${name}"]`).value);
  const W1 = read('W1');
  const W2 = read('W2');
  const W3 = read('W3');
  const wetDensity = read('wet_density');
  const result = card.querySelector('.trial-live-result');
  if (![W1, W2, W3, wetDensity].every(Number.isFinite) || !(W2 > W3 && W3 > W1)) return;
  const moisture = ((W2 - W3) / (W3 - W1)) * 100;
  const dryDensity = wetDensity / (1 + moisture / 100);
  result.querySelector('.live-mc').textContent = `MC: ${moisture.toFixed(2)}%`;
  result.querySelector('.live-dd').textContent = `DD: ${dryDensity.toFixed(4)}`;
}

function loadPreset(presetKey) {
  const preset = PRESETS[presetKey];
  if (!preset) return;
  const container = document.getElementById('trials-container');
  while (container.children.length < preset.moisture.length) addTrial();
  while (container.children.length > preset.moisture.length) {
    container.lastElementChild.remove();
  }
  renumberTrials();

  document.querySelectorAll('.trial-card').forEach((card, index) => {
    const moisture = preset.moisture[index];
    const dryDensity = preset.density[index];
    const values = {
      W1: 25.0,
      W3: 175.0,
      W2: 175.0 + (moisture * 1.5),
      wet_density: dryDensity * (1 + moisture / 100),
    };
    Object.entries(values).forEach(([name, value]) => {
      card.querySelector(`[name="${name}"]`).value = value.toFixed(name === 'wet_density' ? 3 : 2);
    });
    previewTrial(card);
  });

  document.getElementById('test-name').value = preset.testName;
  document.getElementById('soil-type').value = preset.soilType;
  document.getElementById('test-location').value = 'Local recruiter demo';
  runCalculation();
}

async function runCalculation() {
  const button = document.getElementById('calculate-btn');
  const trials = [];
  let valid = true;

  document.querySelectorAll('.trial-card').forEach((card, index) => {
    const trial = {
      container_no: `C-${index + 1}`,
      W1: Number.parseFloat(card.querySelector('[name="W1"]').value),
      W2: Number.parseFloat(card.querySelector('[name="W2"]').value),
      W3: Number.parseFloat(card.querySelector('[name="W3"]').value),
      wet_density: Number.parseFloat(card.querySelector('[name="wet_density"]').value),
    };
    if (!Object.values(trial).slice(1).every(Number.isFinite) ||
        !(trial.W2 > trial.W3 && trial.W3 > trial.W1)) {
      card.style.borderColor = '#ef4444';
      valid = false;
    } else {
      card.style.borderColor = '';
      trials.push(trial);
    }
  });
  if (!valid || trials.length < 4) {
    showToast('Enter valid weights and wet density for at least 4 trials.', 'error');
    return;
  }

  const payload = {
    test_name: document.getElementById('test-name').value.trim() || 'Untitled Test',
    soil_type: document.getElementById('soil-type').value.trim() || 'Unclassified',
    trials,
  };
  button.disabled = true;
  button.textContent = 'Calculating locally…';
  try {
    const result = await apiRequest('/api/calculate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    lastResults = result;
    displayResults(result);
    renderCompactionChart(
      'compaction-chart',
      result.trials,
      { ...result.fit, omc: result.omc, mdd: result.mdd },
      result.zav_curve,
    );
    try {
      const saved = JSON.parse(localStorage.getItem('soilai-local-tests') || '[]');
      if (!Array.isArray(saved)) throw new Error('Local test history is not a valid list.');
      saved.unshift(result);
      localStorage.setItem('soilai-local-tests', JSON.stringify(saved.slice(0, 20)));
      showToast('Calculation complete. Results saved in this browser.', 'success');
    } catch (storageError) {
      console.error('Local test history could not be saved:', storageError);
      showToast(`Calculation complete, but local history could not be saved: ${storageError.message}`, 'warning');
    }
    document.getElementById('results-section').scrollIntoView({ behavior: 'smooth' });
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    button.disabled = false;
    button.textContent = '⚡ Run Calculation';
  }
}

function appendCell(row, value, tag = 'td') {
  const cell = document.createElement(tag);
  cell.textContent = value;
  row.appendChild(cell);
}

function displayResults(data) {
  document.getElementById('results-section').style.display = 'block';
  document.getElementById('result-omc').textContent = `${Number(data.omc).toFixed(2)} %`;
  document.getElementById('result-mdd').textContent = `${Number(data.mdd).toFixed(3)} g/cm³`;
  document.getElementById('result-avg-mc').textContent = `${data.average_moisture_content.toFixed(2)} %`;
  document.getElementById('result-avg-dd').textContent = `${data.average_dry_density.toFixed(3)} g/cm³`;
  document.getElementById('result-trials').textContent = `${data.trials.length} trials`;

  const tbody = document.getElementById('trial-results-tbody');
  tbody.replaceChildren();
  data.trials.forEach((trial, index) => {
    const row = document.createElement('tr');
    [
      index + 1, trial.W1, trial.W2, trial.W3,
      trial.water_content_g.toFixed(2), trial.dry_soil_g.toFixed(2),
      trial.wet_density.toFixed(3), trial.moisture_content.toFixed(2),
      trial.dry_density.toFixed(4),
    ].forEach(value => appendCell(row, value));
    tbody.appendChild(row);
  });

  const evaluation = data.evaluation;
  document.getElementById('evaluation-suitability').textContent = evaluation.subgrade_suitability;
  document.getElementById('evaluation-window').textContent = evaluation.moisture_control_window;
  document.getElementById('evaluation-equipment').textContent = evaluation.recommended_equipment;
  const recs = document.getElementById('recommendations-container');
  recs.textContent = `${data.peak_method === 'quadratic_fit' ? 'Quadratic curve fit' : 'Measured peak fallback'} · R² ${data.fit.r_squared.toFixed(3)}. Screening results are not a substitute for a certified laboratory test.`;
}

async function generatePDF() {
  if (!lastResults) {
    showToast('Run a calculation before exporting a report.', 'warning');
    return;
  }
  try {
    const blob = await apiRequest('/api/export-pdf', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(lastResults),
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'SoilAI_Compaction_Report.pdf';
    anchor.click();
    URL.revokeObjectURL(url);
    showToast('Local PDF report downloaded.', 'success');
  } catch (error) {
    showToast(error.message, 'error');
  }
}

async function runMLScreening() {
  const errorElement = document.getElementById('ml-screening-error');
  const resultPanel = document.getElementById('ml-screening-results');
  const button = document.getElementById('run-ml-screening');
  errorElement.textContent = '';
  errorElement.style.display = 'none';
  button.disabled = true;
  button.textContent = 'Running local model…';
  try {
    const payload = {
      liquid_limit: Number.parseFloat(document.getElementById('ml-liquid-limit').value),
      plastic_limit: Number.parseFloat(document.getElementById('ml-plastic-limit').value),
    };
    const result = await apiRequest('/api/predict', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    document.getElementById('ml-predicted-omc').textContent = `${result.predicted_omc.toFixed(2)}%`;
    document.getElementById('ml-predicted-mdd').textContent = `${result.predicted_mdd.toFixed(3)} g/cm³`;
    document.getElementById('ml-plasticity-index').textContent = `${result.plasticity_index.toFixed(1)}%`;
    document.getElementById('ml-uscs-classification').textContent = result.uscs_classification;
    document.getElementById('ml-moisture-sensitivity').textContent = result.verdict.moisture_sensitivity;
    document.getElementById('ml-roller-recommendation').textContent = result.verdict.roller_recommendation;

    const badge = document.getElementById('ml-verdict-badge');
    badge.textContent = result.verdict.suitability;
    badge.className = 'badge';
    if (result.verdict.suitability.startsWith('Excellent')) {
      badge.style.backgroundColor = 'rgba(16,185,129,0.18)';
      badge.style.color = '#34d399';
    } else if (result.verdict.suitability.startsWith('Fair')) {
      badge.style.backgroundColor = 'rgba(245,158,11,0.18)';
      badge.style.color = '#fbbf24';
    } else if (result.uscs_classification.startsWith('CH')) {
      badge.style.backgroundColor = 'rgba(168,85,247,0.2)';
      badge.style.color = '#c084fc';
    } else {
      badge.style.backgroundColor = 'rgba(239,68,68,0.18)';
      badge.style.color = '#f87171';
    }
    const confidence = result.model_confidence;
    document.getElementById('ml-model-confidence').textContent =
      `${result.model_metrics_note} OMC R² ${confidence.omc_r2.toFixed(3)}, MAE ${confidence.omc_mae.toFixed(2)}%; ` +
      `MDD R² ${confidence.mdd_r2.toFixed(3)}, MAE ${confidence.mdd_mae.toFixed(3)} g/cm³.`;
    resultPanel.style.display = 'block';
  } catch (error) {
    errorElement.textContent = error.message;
    errorElement.style.display = 'block';
    resultPanel.style.display = 'none';
  } finally {
    button.disabled = false;
    button.textContent = 'Run ML Screening';
  }
}

function showToast(message, type = 'info') {
  const toast = document.getElementById('toast');
  if (!toast) return;
  toast.textContent = message;
  toast.className = `toast toast-${type} show`;
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => toast.classList.remove('show'), 4500);
}

window.addTrial = addTrial;
window.removeTrial = button => removeTrial(button.closest('.trial-card'));
window.previewTrial = input => previewTrial(input.closest('.trial-card'));
window.runCalculation = runCalculation;
window.loadSampleData = () => loadPreset('sandy-silt');
window.generatePDF = generatePDF;

document.addEventListener('DOMContentLoaded', () => {
  setUserDisplay();
  if (document.querySelectorAll('.trial-card').length < 4) addTrial();
  updateRemoveButtons();
  document.getElementById('preset-selector').addEventListener('change', event => {
    if (event.target.value) loadPreset(event.target.value);
  });
  document.getElementById('run-ml-screening').addEventListener('click', runMLScreening);
  const mlPresets = {
    expansive: [62, 26],
    silt: [32, 22],
    loam: [22, 15],
  };
  document.querySelectorAll('[data-ml-preset]').forEach(button => {
    button.addEventListener('click', () => {
      const [liquidLimit, plasticLimit] = mlPresets[button.dataset.mlPreset];
      document.getElementById('ml-liquid-limit').value = liquidLimit;
      document.getElementById('ml-plastic-limit').value = plasticLimit;
      runMLScreening();
    });
  });
  document.getElementById('menu-toggle')?.addEventListener('click', () => {
    document.getElementById('sidebar')?.classList.toggle('open');
  });
});
