import { auth, db } from './firebase-config.js';
import { collection, query, where, onSnapshot } from "https://www.gstatic.com/firebasejs/12.13.0/firebase-firestore.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.13.0/firebase-auth.js";

let allTests = [];
let selectedTests = [];
let compareChart = null;

const CHART_COLORS = [
  { border: '#10b981', bg: 'rgba(16, 185, 129, 0.1)' }, // Emerald
  { border: '#3b82f6', bg: 'rgba(59, 130, 246, 0.1)' }, // Blue
  { border: '#f59e0b', bg: 'rgba(245, 158, 11, 0.1)' }  // Amber
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
    
    // Sort by newest
    allTests.sort((a, b) => {
      const ta = a.createdAt?.toMillis ? a.createdAt.toMillis() : 0;
      const tb = b.createdAt?.toMillis ? b.createdAt.toMillis() : 0;
      return tb - ta;
    });

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
    container.innerHTML = '<div style="color:#94a3b8;padding:20px;grid-column:1/-1;text-align:center;">No valid Proctor tests found. Run tests first.</div>';
    return;
  }

  container.innerHTML = allTests.map(test => {
    const dateStr = test.createdAt?.toDate ? test.createdAt.toDate().toLocaleDateString() : 'Unknown Date';
    return `
      <div class="site-card" data-id="${escapeHTML(test.id)}">
        <div style="font-weight:700;color:#e2e8f0;margin-bottom:6px">${escapeHTML(test.testName || 'Untitled')}</div>
        <div style="font-size:11px;color:#94a3b8;margin-bottom:4px">📍 ${escapeHTML(test.location || 'Unknown Location')}</div>
        <div style="font-size:11px;color:#94a3b8">📅 ${dateStr}</div>
        <div style="margin-top:10px;display:flex;gap:10px;">
          <span style="font-size:11px;background:rgba(59,130,246,0.15);color:#60a5fa;padding:2px 6px;border-radius:4px;">MDD: ${test.results.mdd.toFixed(2)}</span>
          <span style="font-size:11px;background:rgba(16,185,129,0.15);color:#34d399;padding:2px 6px;border-radius:4px;">OMC: ${test.results.omc.toFixed(1)}%</span>
        </div>
      </div>
    `;
  }).join('');
  container.querySelectorAll('.site-card').forEach(card => {
    card.addEventListener('click', () => window.toggleSiteSelection(card.dataset.id));
  });
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
  } else {
    selectedTests.splice(index, 1);
    card.classList.remove('selected');
  }

  document.getElementById('selection-counter').textContent = `${selectedTests.length} / 3 Selected`;
  document.getElementById('run-compare-btn').disabled = selectedTests.length < 2;
};

// ── Comparative Analysis Logic ───────────────────────────────────────────
document.getElementById('run-compare-btn').addEventListener('click', runComparison);

function runComparison() {
  if (selectedTests.length < 2) return;
  
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
      pointBackgroundColor: '#0f172a',
      pointBorderWidth: 2,
      fill: true
    };
  });
  
  // Add OMC/MDD Peak points
  const peakPoints = tests.map((test, i) => {
    return {
      label: `${test.testName} (Peak)`,
      data: [{ x: test.results.omc, y: test.results.mdd }],
      borderColor: '#fbbf24',
      backgroundColor: '#f59e0b',
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
        legend: { labels: { color: '#cbd5e1', font: { family: 'Inter' } } },
        tooltip: {
          backgroundColor: 'rgba(15, 23, 42, 0.9)',
          titleColor: '#f8fafc',
          bodyColor: '#cbd5e1',
          borderColor: 'rgba(59, 130, 246, 0.3)',
          borderWidth: 1,
          padding: 12
        }
      },
      scales: {
        x: {
          type: 'linear',
          title: { display: true, text: 'Moisture Content (%)', color: '#94a3b8' },
          grid: { color: 'rgba(59, 130, 246, 0.1)' },
          ticks: { color: '#94a3b8' }
        },
        y: {
          title: { display: true, text: 'Dry Density (g/cc)', color: '#94a3b8' },
          grid: { color: 'rgba(59, 130, 246, 0.1)' },
          ticks: { color: '#94a3b8' }
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
