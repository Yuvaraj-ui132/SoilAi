import { auth, db } from './firebase-config.js';
import { collection, query, where, onSnapshot } from "https://www.gstatic.com/firebasejs/12.13.0/firebase-firestore.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.13.0/firebase-auth.js";
import { canRunComparison, groupTestsBySavedDate, savedDateInfo } from './compare-utils.mjs';

let allTests = [];
let selectedTests = [];
let compareChart = null;

const CHART_COLORS = [
  { border: '#527a5c', bg: 'rgba(82, 122, 92, 0.1)' },
  { border: '#496b52', bg: 'rgba(73, 107, 82, 0.1)' },
  { border: '#9a6a2f', bg: 'rgba(154, 106, 47, 0.1)' }
];

function escapeHTML(value) {
  return String(value).replace(/[&<>"']/g, character => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[character]);
}

// ── Auth Guard & Fetching ──────────────────────────────────────────────
onAuthStateChanged(auth, (user) => {
  if (!user) { window.location.href = '/'; return; }
  
  const nameEl = document.getElementById('user-display-name');
  const avEl = document.getElementById('user-avatar');
  if (nameEl) nameEl.textContent = user.displayName || user.email;
  if (avEl) avEl.textContent = (user.displayName || user.email || 'U')[0].toUpperCase();

  fetchSavedTests(user.uid);
});

function fetchSavedTests(uid) {
  const q = query(collection(db, 'soilTests'), where('uid', '==', uid));
  onSnapshot(q, (snap) => {
    allTests = snap.docs.map(d => ({ id: d.id, ...d.data() }))
      .filter(t => t.results && t.results.omc && t.results.mdd); // Only tests with results
    selectedTests = selectedTests.filter(id => allTests.some(test => test.id === id));
    
    renderSiteSelector();
  }, (err) => {
    console.error("Error fetching tests:", err);
    document.getElementById('site-selector').innerHTML = '<div style="color:#f87171;padding:20px;">Error loading tests.</div>';
  });
}

// ── UI Rendering ────────────────────────────────────────────────────────
function renderSiteSelector() {
  const container = document.getElementById('site-selector');
  if (allTests.length === 0) {
    container.innerHTML = `
      <div class="site-selector-empty">
        <strong>No saved tests available to compare</strong>
        Save a Proctor test with calculated results, then return here to compare sites.
        <a href="/proctor">Create a Proctor test</a>
      </div>
    `;
    syncSelectionUI();
    return;
  }

  container.innerHTML = groupTestsBySavedDate(allTests).map(group => `
    <section class="site-date-group" aria-labelledby="site-date-${escapeHTML(group.key)}">
      <h3 class="site-date-heading" id="site-date-${escapeHTML(group.key)}">${escapeHTML(group.label)}</h3>
      <div class="site-date-cards">${group.tests.map(test => `
      <div class="site-card" data-id="${escapeHTML(test.id)}" role="button" tabindex="0" aria-pressed="false">
        <div class="site-card-name">${escapeHTML(test.testName || 'Untitled')}</div>
        <div class="site-card-meta"><span class="site-card-meta-icon" aria-hidden="true">📍</span><span>${escapeHTML(test.location || 'Unknown Location')}</span></div>
        <div class="site-card-meta"><span class="site-card-meta-icon" aria-hidden="true">📅</span><span>${escapeHTML(savedDateInfo(test.createdAt)?.label || 'Date unavailable')}</span></div>
        <div class="site-card-metrics">
          <span class="site-card-metric">MDD: ${test.results.mdd.toFixed(2)}</span>
          <span class="site-card-metric">OMC: ${test.results.omc.toFixed(1)}%</span>
        </div>
      </div>
      `).join('')}</div>
    </section>
  `).join('');
  container.querySelectorAll('.site-card').forEach(card => {
    const isSelected = selectedTests.includes(card.dataset.id);
    card.classList.toggle('selected', isSelected);
    card.setAttribute('aria-pressed', String(isSelected));
    card.addEventListener('click', () => window.toggleSiteSelection(card.dataset.id));
    card.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        window.toggleSiteSelection(card.dataset.id);
      }
    });
  });
  syncSelectionUI();
}

function syncSelectionUI() {
  const selectedCount = selectedTests.length;
  const compareButton = document.getElementById('run-compare-btn');
  const selectionHint = document.getElementById('selection-hint');
  document.getElementById('selection-counter').textContent = `${selectedCount} of 3 selected`;
  compareButton.disabled = !canRunComparison(selectedCount);
  selectionHint.hidden = canRunComparison(selectedCount);
  if (!selectionHint.hidden) selectionHint.textContent = 'Select exactly 3 sites to compare.';
}

window.toggleSiteSelection = (id) => {
  const index = selectedTests.indexOf(id);
  const card = Array.from(document.querySelectorAll('.site-card'))
    .find(siteCard => siteCard.dataset.id === id);
  if (!card) return;
  
  if (index === -1) {
    if (selectedTests.length >= 3) {
      showToast('Maximum 3 sites can be compared at once.', 'warning');
      return;
    }
    selectedTests.push(id);
    card.classList.add('selected');
    card.setAttribute('aria-pressed', 'true');
  } else {
    selectedTests.splice(index, 1);
    card.classList.remove('selected');
    card.setAttribute('aria-pressed', 'false');
  }

  syncSelectionUI();
};

// ── Comparative Analysis Logic ───────────────────────────────────────────
document.getElementById('run-compare-btn').addEventListener('click', runComparison);

function runComparison() {
  if (!canRunComparison(selectedTests.length)) {
    showToast('Select exactly 3 sites to run the comparison.', 'warning');
    syncSelectionUI();
    return;
  }
  
  // Get full objects
  const testsToCompare = selectedTests.map(id => allTests.find(t => t.id === id));
  
  // Rank by MDD (descending)
  const ranked = [...testsToCompare].sort((a, b) => b.results.mdd - a.results.mdd);
  
  document.getElementById('comparison-results').style.display = 'block';
  
  renderRankingTable(ranked);
  renderComparisonChart(testsToCompare);
  generateRecommendation(ranked);
  
  document.getElementById('comparison-results').scrollIntoView({ behavior: 'smooth' });
}

function renderRankingTable(ranked) {
  const tbody = document.getElementById('ranking-tbody');
  
  tbody.innerHTML = ranked.map((test, index) => {
    const mdd = test.results.mdd;
    const omc = test.results.omc;
    
    // Simple Rule-based Suitability
    let type = "Clayey Soil";
    let suit = "Poor / Sub-grade only";
    if (mdd > 1.9) { type = "Sandy/Gravelly"; suit = "Excellent / Road Base"; }
    else if (mdd > 1.7) { type = "Silty Sand"; suit = "Moderate / Embankment"; }
    
    return `
      <tr>
        <td><span class="rank-badge rank-${index+1}">Rank ${index+1}</span></td>
        <td style="font-weight:600;color:#e2e8f0">${escapeHTML(test.testName || 'Untitled')}</td>
        <td style="font-family:'JetBrains Mono';color:#34d399;font-weight:700">${mdd.toFixed(3)}</td>
        <td style="font-family:'JetBrains Mono';color:#60a5fa;font-weight:700">${omc.toFixed(2)}</td>
        <td>${type}</td>
        <td>${suit}</td>
      </tr>
    `;
  }).join('');
}

function generateRecommendation(ranked) {
  const best = ranked[0];
  const worst = ranked[ranked.length - 1];
  
  const recEl = document.getElementById('auto-recommendation');
  
  let paragraph = `<p style="margin-bottom:10px;">Based on the comparative Standard Proctor Test analysis, <strong>${escapeHTML(best.testName || 'the highest ranked site')}</strong> achieved the highest Maximum Dry Density (${best.results.mdd.toFixed(3)} g/cc) with an Optimum Moisture Content of ${best.results.omc.toFixed(1)}%.</p>`;
  
  paragraph += `<p style="margin-bottom:10px;">This indicates superior load-bearing capacity and compaction characteristics, making it the most suitable material among the selected options for structural fill or road construction applications.</p>`;
  
  if (ranked.length > 1) {
    paragraph += `<p>Conversely, <strong>${escapeHTML(worst.testName || 'the lowest ranked site')}</strong> showed the lowest density (${worst.results.mdd.toFixed(3)} g/cc), suggesting higher plasticity or poorer gradation, and may require chemical stabilization prior to use.</p>`;
  }
  
  recEl.innerHTML = paragraph;
}

// ── Chart.js ─────────────────────────────────────────────────────────────
function renderComparisonChart(tests) {
  const ctx = document.getElementById('compare-chart').getContext('2d');
  
  if (compareChart) compareChart.destroy();
  
  const datasets = tests.map((test, i) => {
    const color = CHART_COLORS[i % CHART_COLORS.length];
    
    // Generate smooth curve points from regression
    const fit = test.results.regression_fit; // Requires regression coefficients saved in DB
    let dataPoints = [];
    
    // If backend didn't save regression_fit, we reconstruct from trials
    if (!fit && test.trials) {
       // We'll just plot the raw trials as lines
       dataPoints = test.trials.map(t => ({ x: t.moisture_content || t.mc, y: t.dry_density || t.dd }))
         .sort((a,b) => a.x - b.x);
    } else if (fit) {
      // Generate smooth curve
      const minX = test.results.omc - 5;
      const maxX = test.results.omc + 5;
      for (let x = minX; x <= maxX; x += 0.5) {
        const y = fit.a * x * x + fit.b * x + fit.c;
        if (y > 0) dataPoints.push({ x, y });
      }
    }
    
    return {
      label: test.testName || `Site ${i+1}`,
      data: dataPoints,
      borderColor: color.border,
      backgroundColor: color.bg,
      borderWidth: 3,
      tension: 0.4,
      pointRadius: 4,
      pointBackgroundColor: '#fff',
      pointBorderWidth: 2,
      fill: true
    };
  });
  
  // Add OMC/MDD Peak points
  const peakPoints = tests.map((test, i) => {
    return {
      label: `${test.testName} (Peak)`,
      data: [{ x: test.results.omc, y: test.results.mdd }],
      borderColor: '#9a6a2f',
      backgroundColor: '#b67d35',
      borderWidth: 2,
      pointRadius: 8,
      pointStyle: 'star',
      showLine: false
    };
  });

  compareChart = new Chart(ctx, {
    type: 'line',
    data: { datasets: [...datasets, ...peakPoints] },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { labels: { color: '#526358', font: { family: 'Inter' } } },
        tooltip: {
          backgroundColor: 'rgba(38, 55, 45, 0.96)',
          titleColor: '#ffffff',
          bodyColor: '#e3ebe3',
          borderColor: 'rgba(73, 107, 82, 0.45)',
          borderWidth: 1,
          padding: 12
        }
      },
      scales: {
        x: {
          type: 'linear',
          title: { display: true, text: 'Moisture Content (%)', color: '#526358' },
          grid: { color: 'rgba(73, 107, 82, 0.12)' },
          ticks: { color: '#526358' }
        },
        y: {
          title: { display: true, text: 'Dry Density (g/cc)', color: '#526358' },
          grid: { color: 'rgba(73, 107, 82, 0.12)' },
          ticks: { color: '#526358' }
        }
      }
    }
  });
}

// ── Sidebar UI ───────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  const menuBtn = document.getElementById('menu-toggle');
  const sidebar = document.getElementById('sidebar');
  if (menuBtn && sidebar) {
    menuBtn.addEventListener('click', () => sidebar.classList.toggle('open'));
  }
  
  document.getElementById('logout-btn')?.addEventListener('click', async () => {
    const { handleLogout } = await import('./auth.js');
    handleLogout();
  });
});

function showToast(msg, type='info') {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = `toast toast-${type} show`;
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove('show'), 3500);
}
