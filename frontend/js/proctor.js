import { auth, db, COLLECTIONS } from './firebase-config.js';
import {
  collection, addDoc, serverTimestamp, doc, getDoc
} from "https://www.gstatic.com/firebasejs/12.13.0/firebase-firestore.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.13.0/firebase-auth.js";
import { downloadReportPdf, viewReportPdf } from './report-actions.mjs';

let currentUser = null;
let trialCount = 0;
let lastResults = null;
let chartInstance = null;

// ── Auth Guard ───────────────────────────────────────────────
onAuthStateChanged(auth, (user) => {
  if (!user) { window.location.href = '/'; return; }
  currentUser = user;
  document.getElementById('user-display-name').textContent = user.displayName || user.email;
  document.getElementById('user-avatar').textContent = (user.displayName || user.email || 'U')[0].toUpperCase();
  document.getElementById('sync-status').textContent = '● Firestore Sync';
  
  // Init 3 trials by default
  for(let i=0; i<3; i++) addTrial();
});

// ── Trial Management ─────────────────────────────────────────
window.addTrial = () => {
  trialCount++;
  const num = trialCount;
  const div = document.createElement('div');
  div.className = 'trial-card fade-in';
  div.id = `trial-${num}`;
  div.style.background = 'rgba(10,18,40,0.7)';
  div.style.border = '1px solid rgba(59,130,246,0.18)';
  div.style.borderRadius = '14px';
  div.style.padding = '22px';
  div.style.transition = 'all 0.2s';
  div.innerHTML = `
    <div class="trial-header" style="display:flex;align-items:center;gap:14px;margin-bottom:18px">
      <div style="display:flex;align-items:center;gap:6px;background:linear-gradient(135deg, rgba(59,130,246,0.2), rgba(37,99,235,0.15));border:1px solid rgba(59,130,246,0.3);border-radius:8px;padding:6px 14px">
        <span style="font-size:10px;font-weight:700;text-transform:uppercase;color:#64748b">Trial</span>
        <span class="trial-number" style="font-size:16px;font-weight:800;color:#60a5fa;font-family:'JetBrains Mono',monospace">${num}</span>
      </div>
      <button class="calc-trial-btn" onclick="calcSingleTrial(${num})">⚡ Calculate Trial</button>
      <span id="trial-status-${num}" class="trial-calc-status" style="display:none"></span>
      <button class="btn btn-ghost btn-sm remove-trial-btn" onclick="removeTrial(${num})" style="margin-left:auto;color:#f87171" title="Remove Trial">✕</button>
    </div>
    <div class="trial-fields">
      <div class="form-group">
        <label style="font-size:11px;font-weight:600;color:#64748b">W1 (Empty, g)</label>
        <input type="number" id="W1-${num}" class="form-input trial-input" placeholder="e.g. 25.0" step="0.01" min="0">
      </div>
      <div class="form-group">
        <label style="font-size:11px;font-weight:600;color:#64748b">W2 (Wet, g)</label>
        <input type="number" id="W2-${num}" class="form-input trial-input" placeholder="e.g. 185.0" step="0.01" min="0">
      </div>
      <div class="form-group">
        <label style="font-size:11px;font-weight:600;color:#64748b">W3 (Dry, g)</label>
        <input type="number" id="W3-${num}" class="form-input trial-input" placeholder="e.g. 160.0" step="0.01" min="0">
      </div>
      <div class="form-group">
        <label style="font-size:11px;font-weight:600;color:#64748b">Wet Density (g/cc)</label>
        <input type="number" id="WD-${num}" class="form-input trial-input" placeholder="e.g. 1.85" step="0.001" min="0">
      </div>
    </div>
    
    <!-- Single Trial Result Panel -->
    <div id="trial-res-panel-${num}" class="trial-result-panel" style="background:rgba(5,10,25,0.5);border:1px solid rgba(59,130,246,0.15);border-radius:8px;padding:14px;margin-top:14px;display:none">
      <div style="display:flex;gap:14px;align-items:center;flex-wrap:wrap">
        <div style="flex:1;background:rgba(15,23,50,0.6);padding:10px 14px;border-radius:6px;text-align:center;border:1px solid rgba(59,130,246,0.1)">
          <div style="font-size:10px;color:#475569;text-transform:uppercase;margin-bottom:4px">Moisture Content</div>
          <div id="res-mc-${num}" style="font-size:16px;font-weight:800;color:#60a5fa;font-family:'JetBrains Mono',monospace">—</div>
        </div>
        <div style="flex:1;background:rgba(15,23,50,0.6);padding:10px 14px;border-radius:6px;text-align:center;border:1px solid rgba(16,185,129,0.1)">
          <div style="font-size:10px;color:#475569;text-transform:uppercase;margin-bottom:4px">Dry Density</div>
          <div id="res-dd-${num}" style="font-size:16px;font-weight:800;color:#34d399;font-family:'JetBrains Mono',monospace">—</div>
        </div>
      </div>
      <div id="res-rec-${num}" style="margin-top:10px;font-size:12px;color:#94a3b8;padding:8px;border-radius:6px;background:rgba(245,158,11,0.05);border:1px solid rgba(245,158,11,0.15);display:none"></div>
    </div>
  `;
  document.getElementById('trials-container').appendChild(div);
  updateRemoveButtons();
};

window.removeTrial = (num) => {
  const cards = document.querySelectorAll('.trial-card');
  if (cards.length <= 2) { showToast('Minimum 2 trials required', 'warning'); return; }
  const card = document.getElementById(`trial-${num}`);
  if (card) {
    card.style.opacity = '0';
    setTimeout(() => { card.remove(); updateRemoveButtons(); }, 200);
  }
};

function updateRemoveButtons() {
  const cards = document.querySelectorAll('.trial-card');
  cards.forEach(card => {
    const btn = card.querySelector('.remove-trial-btn');
    if (btn) btn.disabled = cards.length <= 2;
  });
}

// ── Single Trial Calculation ──────────────────────────────────
window.calcSingleTrial = (num) => {
  const W1 = parseFloat(document.getElementById(`W1-${num}`).value);
  const W2 = parseFloat(document.getElementById(`W2-${num}`).value);
  const W3 = parseFloat(document.getElementById(`W3-${num}`).value);
  const WD = parseFloat(document.getElementById(`WD-${num}`).value);
  
  const statusEl = document.getElementById(`trial-status-${num}`);
  statusEl.style.display = 'inline-flex';
  
  if ([W1, W2, W3, WD].some(v => isNaN(v) || v < 0) || W3 <= W1 || W2 < W3) {
    statusEl.className = 'trial-calc-status error';
    statusEl.innerHTML = '❌ Invalid Input';
    return;
  }
  
  // Standard Proctor Formula: Dry Density = Wet Density / (1 + MC/100)
  const moisturePercentage = ((W2 - W3) / (W3 - W1)) * 100;
  const dryDensity = WD / (1 + (moisturePercentage / 100));
  
  const mc = moisturePercentage;
  const dd = dryDensity;
  
  document.getElementById(`res-mc-${num}`).textContent = mc.toFixed(2) + ' %';
  document.getElementById(`res-dd-${num}`).textContent = dd.toFixed(3) + ' g/cc';
  
  const recEl = document.getElementById(`res-rec-${num}`);
  recEl.style.display = 'block';
  if(mc < 10) recEl.innerHTML = '💧 <b>Low Moisture</b> — consider adding water for next trial';
  else if(mc > 25) recEl.innerHTML = '🔥 <b>High Moisture</b> — soil is quite wet';
  else recEl.innerHTML = '✅ <b>Moderate Moisture</b> — optimal range likely nearby';
  
  document.getElementById(`trial-res-panel-${num}`).style.display = 'block';
  statusEl.className = 'trial-calc-status done';
  statusEl.innerHTML = '✅ Calculated';
};

// ── Complete Analysis ───────────────────────────────────────
window.runFullAnalysis = async () => {
  const btn = document.getElementById('run-btn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Analyzing...';
  
  const testName = document.getElementById('test-name').value || 'Untitled Test';
  const testLoc = document.getElementById('test-location').value || 'Unknown';
  const soilType = document.getElementById('soil-type').value || 'Unknown';
  
  const cards = document.querySelectorAll('.trial-card');
  let trials = [];
  let valid = true;
  
  cards.forEach((card, i) => {
    const num = card.id.split('-')[1];
    const W1 = parseFloat(document.getElementById(`W1-${num}`).value);
    const W2 = parseFloat(document.getElementById(`W2-${num}`).value);
    const W3 = parseFloat(document.getElementById(`W3-${num}`).value);
    const WD = parseFloat(document.getElementById(`WD-${num}`).value);
    
    if ([W1, W2, W3, WD].some(v => isNaN(v) || v < 0) || W3 <= W1 || W2 < W3) {
      card.style.borderColor = '#ef4444';
      valid = false;
      return;
    }
    card.style.borderColor = 'rgba(59,130,246,0.18)';
    
    // Engineering Calculation: DD = WD / (1 + MC/100)
    const mc = ((W2 - W3) / (W3 - W1)) * 100;
    const dd = WD / (1 + (mc / 100));
    
    // Engineering Validation (Typical soil DD: 1.4 - 2.2 g/cc)
    if (mc > 50 || mc < 1) {
      showToast(`Trial ${i+1}: MC ${mc.toFixed(1)}% is unrealistic.`, 'warning');
    }
    if (dd > 2.5 || dd < 1.0) {
      showToast(`Trial ${i+1}: Dry Density ${dd.toFixed(3)} is outside typical engineering range (1.4-2.2).`, 'warning');
    }

    trials.push({ id: num, trialIndex: i+1, W1, W2, W3, WD, mc, dd });
  });
  
  if(!valid || trials.length < 2) {
    showToast('Please fill all fields correctly (min 2 valid trials needed)', 'error');
    btn.disabled = false;
    btn.innerHTML = '⚡ Run Complete Compaction Analysis';
    return;
  }
  
  // ── Quadratic Regression for Proper Bell Curve ────────────────
  function getQuadraticFit(pts) {
    const n = pts.length;
    if (n < 3) return null;

    let sumX = 0, sumX2 = 0, sumX3 = 0, sumX4 = 0;
    let sumY = 0, sumXY = 0, sumX2Y = 0;

    for (const p of pts) {
      const x = p.mc;
      const y = p.dd;
      const x2 = x * x;
      sumX += x;
      sumX2 += x2;
      sumX3 += x2 * x;
      sumX4 += x2 * x2;
      sumY += y;
      sumXY += x * y;
      sumX2Y += x2 * y;
    }

    const det3x3 = (m) => 
      m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
      m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
      m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);

    const matrixM = [
      [sumX4, sumX3, sumX2],
      [sumX3, sumX2, sumX],
      [sumX2, sumX, n]
    ];
    const det = det3x3(matrixM);
    if (Math.abs(det) < 1e-10) return null;

    const matrixA = [
      [sumX2Y, sumX3, sumX2],
      [sumXY, sumX2, sumX],
      [sumY, sumX, n]
    ];
    const matrixB = [
      [sumX4, sumX2Y, sumX2],
      [sumX3, sumXY, sumX],
      [sumX2, sumY, n]
    ];
    const matrixC = [
      [sumX4, sumX3, sumX2Y],
      [sumX3, sumX2, sumXY],
      [sumX2, sumX, sumY]
    ];

    const a = det3x3(matrixA) / det;
    const b = det3x3(matrixB) / det;
    const c = det3x3(matrixC) / det;

    console.log("--- Compaction Regression Debug ---");
    console.log("Trials:", pts.map(p => `(${p.mc.toFixed(2)}%, ${p.dd.toFixed(3)} g/cc)`));
    console.log("Coefficients:", { a, b, c });
    const peakX = -b/(2*a);
    const peakY = a*peakX*peakX + b*peakX + c;
    console.log("Calculated Peak:", { omc: peakX.toFixed(2), mdd: peakY.toFixed(4) });

    return { a, b, c };
  }

  // Sort trials by Moisture Content for proper curve plotting
  trials.sort((a,b) => a.mc - b.mc);
  
  // Calculate Regression-based OMC & MDD
  let omc, mdd;
  const fit = getQuadraticFit(trials);
  
  if (fit && fit.a < 0) {
    // Parabola opens downwards (correct for compaction)
    omc = -fit.b / (2 * fit.a);
    mdd = (fit.a * omc * omc) + (fit.b * omc) + fit.c;
    
    // Ensure OMC is within reasonable bounds of the data
    const minMc = trials[0].mc;
    const maxMc = trials[trials.length - 1].mc;
    if (omc < minMc - 2 || omc > maxMc + 2) {
      // Fallback if peak is too far out
      const maxTrial = trials.reduce((prev, current) => (prev.dd > current.dd) ? prev : current);
      mdd = maxTrial.dd; omc = maxTrial.mc;
    }
  } else {
    // Fallback: Pick the max measured point if regression fails or curve is inverted
    const maxTrial = trials.reduce((prev, current) => (prev.dd > current.dd) ? prev : current);
    mdd = maxTrial.dd; omc = maxTrial.mc;
  }

  let sumMc = 0;
  let sumDd = 0;
  trials.forEach(t => {
    sumMc += t.mc;
    sumDd += t.dd;
  });
  const avgMc = sumMc / trials.length;
  const avgDd = sumDd / trials.length;
  
  lastResults = {
    testName, location: testLoc, soilType,
    trials, omc, mdd, avgMc, avgDd, fit,
    timestamp: new Date()
  };
  
  // Update UI Cards
  document.getElementById('results-section').style.display = 'block';
  document.getElementById('card-trials').textContent = trials.length;
  document.getElementById('card-avg-mc').textContent = avgMc.toFixed(2) + '%';
  document.getElementById('card-avg-dd').textContent = avgDd.toFixed(3);
  document.getElementById('card-omc').textContent = omc.toFixed(2) + '%';
  document.getElementById('card-mdd').textContent = mdd.toFixed(3);
  
  document.getElementById('graph-omc').textContent = omc.toFixed(2) + '%';
  document.getElementById('graph-mdd').textContent = mdd.toFixed(3) + ' g/cc';

  // --- Engineering Interpretation Populating ---
  // (Old avg cards removed in UI update)
  // document.getElementById('avg-mc-val').textContent = avgMc.toFixed(2) + '%';
  // document.getElementById('avg-dd-val').textContent = avgDd.toFixed(3) + ' g/cc';

  // Dynamic Engineering Summary
  const summaryEl = document.getElementById('eng-summary');
  if (mdd > 1.8) {
    summaryEl.innerHTML = "The soil shows <span class='text-success'>good compaction characteristics</span> suitable for engineering applications like road subgrades and embankments.";
  } else if (mdd > 1.5) {
    summaryEl.innerHTML = "The soil shows <span class='text-warning'>moderate compaction potential</span>. Careful moisture control is required for optimal stability.";
  } else {
    summaryEl.innerHTML = "The soil shows <span class='text-danger'>poor compaction characteristics</span>. Soil stabilization or replacement might be necessary.";
  }

  // Visual Indicator (Status Dot)
  const statusInd = document.getElementById('status-indicator');
  const statusText = document.getElementById('status-text');
  const statusDot = document.getElementById('status-dot');
  
  if (avgDd >= mdd * 0.95) {
    statusInd.className = 'status-dot-indicator dot-good';
    statusText.textContent = 'Good Compaction';
  } else if (avgDd >= mdd * 0.85) {
    statusInd.className = 'status-dot-indicator dot-moderate';
    statusText.textContent = 'Moderate Compaction';
  } else {
    statusInd.className = 'status-dot-indicator dot-poor';
    statusText.textContent = 'Poor Compaction';
  }

  // Comparison Text (Old comparison card removed in UI update)
  // const compText = document.getElementById('comparison-text');
  // const mcDiff = avgMc - omc;
  // if (Math.abs(mcDiff) < 1.5) {
  //   compText.innerHTML = "Moisture is <span class='text-success'>near optimal</span> (within ±1.5% of OMC). Excellent field control.";
  // } else {
  //   compText.innerHTML = `Field moisture is <span class='text-warning'>${mcDiff > 0 ? 'above' : 'below'}</span> OMC by ${Math.abs(mcDiff).toFixed(1)}%. Adjustments recommended.`;
  // }

  // Dynamic Conclusion Box
  const concText = document.getElementById('conclusion-text');
  const concBox = document.getElementById('conclusion-box');
  
  if (avgDd >= mdd * 0.98) {
    concText.textContent = "Optimal compaction achieved. Current field density is very close to maximum lab density.";
    concBox.style.borderLeftColor = 'var(--green)';
  } else if (avgMc < omc) {
    concText.textContent = "Add water. Field moisture is below the Optimum Moisture Content (OMC), preventing full compaction.";
    concBox.style.borderLeftColor = 'var(--blue-400)';
  } else {
    concText.textContent = "Reduce moisture. Field moisture exceeds OMC, causing the soil to become unstable or spongy.";
    concBox.style.borderLeftColor = 'var(--amber)';
  }
  
  // Render Chart
  renderChart(trials, omc, mdd);
  
  // ── Render Raw-Weights Table ──────────────────────────────────────────────
  const tbody = document.getElementById('results-tbody');
  tbody.innerHTML = trials.map(t => {
    const isPeak = Math.abs(t.mc - omc) < 0.01;
    return `
    <tr style="${isPeak ? 'background:rgba(59,130,246,0.1)' : ''}">
      <td>${t.trialIndex}</td>
      <td>${t.W1.toFixed(1)}</td>
      <td>${t.W2.toFixed(1)}</td>
      <td>${t.W3.toFixed(1)}</td>
      <td>${t.WD.toFixed(3)}</td>
      <td style="font-weight:700;color:#60a5fa">${t.mc.toFixed(2)}</td>
      <td style="font-weight:700;color:#34d399">${t.dd.toFixed(3)}</td>
      <td>${isPeak ? '<span class="badge badge-info">Peak</span>' : '—'}</td>
    </tr>`;
  }).join('');

  // ── Populate Horizontal Observation Lab Sheet ─────────────────────────────
  // Standard Proctor mould: D=18 cm, H=15 cm → V = π/4 × 18² × 15 ≈ 3817 cm³
  const MOULD_VOL  = (Math.PI / 4) * 18 * 18 * 15; // ≈ 3817 cm³
  const MOULD_MASS = 4000;                           // g (typical standard mould mass)

  const obsHead  = document.getElementById('obs-lab-thead');
  const obsTbody = document.getElementById('obs-lab-tbody');

  // ── FIXED predefined moisture column headers (IS 2720 Part 7 standard levels) ─
  const FIXED_MC_COLS = [15, 18, 21, 24, 27]; // % — constant, never change

  // ── Determine if a column is the OMC peak column ─────────────────────────
  // Find which fixed column index is closest to the calculated OMC
  const peakColIdx = FIXED_MC_COLS.reduce((best, val, idx) =>
    Math.abs(val - omc) < Math.abs(FIXED_MC_COLS[best] - omc) ? idx : best, 0);

  // ── Pre-compute derived values for each trial (indexed, not by MC) ────────
  // Trial 1 → column 15%, Trial 2 → 18%, Trial 3 → 21%, etc.
  const colData = FIXED_MC_COLS.map((nominalMC, idx) => {
    const t = trials[idx] || null; // null if trial doesn't exist
    if (!t) return { empty: true, nominalMC };
    const massCompacted     = t.WD * MOULD_VOL;
    const massMouldPlusSoil = MOULD_MASS + massCompacted;
    const waterAdded        = massCompacted * (t.mc / 100);
    const isPeak            = idx === peakColIdx && t !== null;
    return { empty: false, nominalMC, t, massCompacted, massMouldPlusSoil, waterAdded, isPeak };
  });

  // ── CSS helpers ───────────────────────────────────────────────────────────
  const TH_LABEL = `style="
    background:rgba(5,12,32,0.9);padding:12px 16px;
    font-size:11px;font-weight:700;color:#64748b;text-align:left;
    border-right:2px solid rgba(59,130,246,0.25);
    border-bottom:2px solid rgba(59,130,246,0.3);
    white-space:nowrap;min-width:230px;letter-spacing:0.04em"`;

  const thCol = (isPeak) => `style="
    background:${isPeak ? 'rgba(251,191,36,0.14)' : 'rgba(5,12,32,0.75)'};
    padding:10px 14px;font-size:12px;font-weight:800;text-align:center;
    border-right:1px solid rgba(59,130,246,0.14);
    border-bottom:2px solid rgba(59,130,246,0.35);
    color:${isPeak ? '#fbbf24' : '#60a5fa'};
    letter-spacing:0.05em;min-width:120px"`;

  const tdLabel = `style="
    background:rgba(5,12,32,0.55);padding:10px 16px;
    font-size:11px;font-weight:700;color:#64748b;text-align:left;
    border-right:2px solid rgba(59,130,246,0.2);
    border-bottom:1px solid rgba(59,130,246,0.08);
    white-space:nowrap"`;

  const tdVal = (color, isPeak, empty) => `style="
    background:${isPeak ? 'rgba(251,191,36,0.07)' : empty ? 'rgba(0,0,0,0.2)' : 'transparent'};
    padding:10px 14px;font-size:13px;font-weight:${empty ? '400' : '700'};
    text-align:center;font-family:'JetBrains Mono',monospace;
    color:${empty ? '#1e293b' : color};
    border-right:1px solid rgba(59,130,246,0.1);
    border-bottom:1px solid rgba(59,130,246,0.08)"`;

  // ── THEAD: "Observation Parameter" + five fixed MC% column headers ────────
  let headRow = `<tr>
    <th ${TH_LABEL}>Observation Parameter</th>`;
  colData.forEach((col, idx) => {
    headRow += `<th ${thCol(idx === peakColIdx)}>
      Trial&nbsp;${idx + 1}<br>
      <span style="font-size:15px;font-weight:900">${col.nominalMC}%</span>
      <br><span style="font-size:9px;color:${idx === peakColIdx ? '#fbbf24' : '#475569'};
        letter-spacing:0.06em;font-weight:600">
        ${idx === peakColIdx ? '★&nbsp;OMC' : 'Moisture'}
      </span>
    </th>`;
  });
  headRow += '</tr>';
  obsHead.innerHTML = headRow;

  // ── TBODY: one row per observation parameter ──────────────────────────────
  const paramRows = [
    {
      label : 'Mass of Water Added (g)',
      color : '#94a3b8',
      val   : c => c.waterAdded.toFixed(1)
    },
    {
      label : 'Mass of Mould + Compacted Soil (g)',
      color : '#cbd5e1',
      val   : c => c.massMouldPlusSoil.toFixed(1)
    },
    {
      label : 'Mass of Compacted Soil (g)',
      color : '#cbd5e1',
      val   : c => c.massCompacted.toFixed(1)
    },
    {
      label : 'Wet / Bulk Density (g/cc)',
      color : '#a78bfa',
      val   : c => c.t.WD.toFixed(3)
    },
    {
      // Shows ACTUAL calculated MC (not the nominal heading value)
      label : 'Moisture Content — Calculated (%)',
      color : '#60a5fa',
      val   : c => c.t.mc.toFixed(2)
    },
    {
      label : 'Dry Density (g/cc)',
      color : c => c.isPeak ? '#fbbf24' : '#34d399',
      val   : c => c.t.dd.toFixed(3)
    }
  ];

  obsTbody.innerHTML = paramRows.map((row, ri) => {
    const rowBg = ri % 2 === 0 ? 'rgba(255,255,255,0.015)' : 'rgba(0,0,0,0.18)';
    let tr = `<tr style="background:${rowBg}"><td ${tdLabel}>${row.label}</td>`;
    colData.forEach(col => {
      if (col.empty) {
        tr += `<td ${tdVal('#1e293b', false, true)}>—</td>`;
      } else {
        const color = typeof row.color === 'function' ? row.color(col) : row.color;
        tr += `<td ${tdVal(color, col.isPeak, false)}>${row.val(col)}</td>`;
      }
    });
    tr += '</tr>';
    return tr;
  }).join('');

  // ── Show & Populate Conclusion Section ───────────────────────────────────
  const conclusionSection = document.getElementById('proctor-conclusion-section');
  const conclusionText    = document.getElementById('proctor-conclusion-text');
  const concMdd           = document.getElementById('conc-mdd');
  const concOmc           = document.getElementById('conc-omc');
  if (conclusionSection && conclusionText) {
    conclusionSection.style.display = 'block';
    conclusionText.innerHTML =
      `From the compaction curve plot, the <strong style="color:#34d399">Maximum Dry Density (MDD)</strong> ` +
      `of the soil is <strong style="color:#34d399;font-family:'JetBrains Mono',monospace">${mdd.toFixed(3)} g/cc</strong> ` +
      `and the <strong style="color:#60a5fa">Optimum Moisture Content (OMC)</strong> ` +
      `is <strong style="color:#60a5fa;font-family:'JetBrains Mono',monospace">${omc.toFixed(2)} %</strong>.`;
    if (concMdd) concMdd.textContent = mdd.toFixed(3) + ' g/cc';
    if (concOmc) concOmc.textContent = omc.toFixed(2) + ' %';
  }
  
  // Recommendations (Keeping existing logic as requested but it complements the new ones)
  const recCont = document.getElementById('recommendations-container');
  recCont.innerHTML = '';
  trials.forEach(t => {
    let rec = ''; let icon = ''; let col = '';
    if (t.mc < omc * 0.9) { rec = 'Add water'; icon='💧'; col='rec-warning'; }
    else if (t.mc > omc * 1.1) { rec = 'Reduce moisture'; icon='🔥'; col='rec-error'; }
    else if (t.dd >= mdd * 0.98) { rec = 'Optimal compaction achieved'; icon='✅'; col='rec-success'; }
    else { rec = 'Near optimal, adjust compaction energy'; icon='⚠️'; col='rec-info'; }
    
    recCont.innerHTML += `
      <div class="rec-card ${col}" style="padding:14px;border-radius:8px;display:flex;align-items:center;gap:10px">
        <span style="font-size:20px">${icon}</span>
        <div>
          <div style="font-size:11px;font-weight:700;color:#64748b">Trial ${t.trialIndex} (MC: ${t.mc.toFixed(1)}%)</div>
          <div style="font-size:13px;color:#e2e8f0">${rec}</div>
        </div>
      </div>
    `;
  });

  // ── 1. Trial Comparison Analytics ────────────────────────────────────────
  // Find best, lowest, and most stable trials
  let bestTrial = trials[0];
  let lowestTrial = trials[0];
  let mostStableTrial = trials[0];

  trials.forEach(t => {
    if (t.dd > bestTrial.dd) bestTrial = t;
    if (t.dd < lowestTrial.dd) lowestTrial = t;
    // Most stable is the one with highest wet density relative to dry density (lowest void ratio implication roughly)
    // Actually, engineering-wise, most stable is closest to OMC without exceeding it.
    const currentDiff = Math.abs(t.mc - omc);
    const stableDiff = Math.abs(mostStableTrial.mc - omc);
    if (currentDiff < stableDiff) mostStableTrial = t;
  });

  const bestEl = document.getElementById('comp-best-trial');
  if (bestEl) bestEl.innerHTML = `Trial ${bestTrial.trialIndex} achieved highest compaction.<br><span style="color:#10b981;font-size:11px">DD: ${bestTrial.dd.toFixed(3)} g/cc at ${bestTrial.mc.toFixed(1)}% MC</span>`;

  const lowestEl = document.getElementById('comp-lowest-density');
  if (lowestEl) lowestEl.innerHTML = `Trial ${lowestTrial.trialIndex} shows lower dry density.<br><span style="color:#f43f5e;font-size:11px">DD: ${lowestTrial.dd.toFixed(3)} g/cc at ${lowestTrial.mc.toFixed(1)}% MC</span>`;

  const stableEl = document.getElementById('comp-most-stable');
  if (stableEl) {
    if (mostStableTrial.mc > omc) {
      stableEl.innerHTML = `Trial ${mostStableTrial.trialIndex} contains excess moisture but is nearest to optimum.<br><span style="color:#3b82f6;font-size:11px">Off peak by ${Math.abs(mostStableTrial.mc - omc).toFixed(1)}%</span>`;
    } else {
      stableEl.innerHTML = `Trial ${mostStableTrial.trialIndex} exhibits the most stable pre-peak compaction.<br><span style="color:#3b82f6;font-size:11px">Off peak by ${Math.abs(mostStableTrial.mc - omc).toFixed(1)}%</span>`;
    }
  }

  // ── 2. Soil Suitability & Type Prediction ────────────────────────────────
  const typeEl = document.getElementById('comp-soil-type');
  const suitEl = document.getElementById('comp-suitability');

  let predictedType = "Unknown Soil Blend";
  let suitability = "Pending analysis";

  if (mdd > 1.9) {
    predictedType = "Sandy / Gravelly Soil (Well-graded)";
    suitability = "Excellent load-bearing capacity. Highly suitable for sub-base and heavy road construction.";
  } else if (mdd > 1.7 && mdd <= 1.9) {
    if (omc < 15) {
      predictedType = "Silty Sand / Sandy Clay";
      suitability = "Good compaction characteristics. Suitable for foundation filling and general embankments.";
    } else {
      predictedType = "Silty Soil";
      suitability = "Moderate compaction quality. Requires careful moisture control during field rolling.";
    }
  } else {
    predictedType = "Clayey Soil (High Plasticity)";
    suitability = "Poor compaction quality. Likely requires chemical stabilization (lime/cement) before use in roads.";
  }

  if (typeEl) typeEl.textContent = predictedType;
  if (suitEl) suitEl.textContent = suitability;

  // Save to Firestore
  try {
    const payload = {
      uid: currentUser.uid, testName, location: testLoc, soilType,
      trials: trials.map(t => ({ W1: t.W1, W2: t.W2, W3: t.W3, wet_density: t.WD, moisture_content: t.mc, dry_density: t.dd, trial_number: t.trialIndex })),
      results: { omc, mdd, average_moisture_content: avgMc, average_dry_density: avgDd, status: 'calculated', trial_count: trials.length },
      createdAt: serverTimestamp()
    };
    const savedTest = await addDoc(collection(db, 'soilTests'), payload);
    lastResults.testId = savedTest.id;
    try {
      const savedSnapshot = await getDoc(doc(db, 'soilTests', savedTest.id));
      if (savedSnapshot.exists()) lastResults.createdAt = savedSnapshot.data().createdAt;
    } catch (timestampError) {
      console.error('Could not retrieve the saved test timestamp for its report:', timestampError);
    }
    showToast('Analysis complete & saved to cloud!', 'success');
  } catch(e) {
    showToast('Saved locally, Firestore sync failed', 'warning');
    console.error(e);
  }
  lastResults.reportReady = true;
  document.getElementById('view-report-btn').disabled = false;
  document.getElementById('download-report-btn').disabled = false;
  
  btn.disabled = false;
  btn.innerHTML = '⚡ Run Complete Compaction Analysis';
  document.getElementById('results-section').scrollIntoView({behavior: 'smooth'});
};

// ── Chart.js ─────────────────────────────────────────────────
function renderChart(trials, omc, mdd) {
  const ctx = document.getElementById('compaction-chart').getContext('2d');
  if (chartInstance) chartInstance.destroy();
  
  // 1. Prepare raw data points (Scatter)
  const scatterData = trials.map(t => ({ x: t.mc, y: t.dd }));
  
  // 2. Prepare fitted curve points
  const curveData = [];
  const fit = lastResults.fit;
  if (fit) {
    const minX = Math.max(0, trials[0].mc - 2);
    const maxX = trials[trials.length - 1].mc + 2;
    const step = (maxX - minX) / 40;
    for (let x = minX; x <= maxX; x += step) {
      const y = (fit.a * x * x) + (fit.b * x) + fit.c;
      if (y > 0) curveData.push({ x, y });
    }
  } else {
    // Fallback to simple line
    trials.forEach(t => curveData.push({ x: t.mc, y: t.dd }));
  }

  // 3. Prepare Zero Air Voids (ZAV) curve (Assuming Gs = 2.65)
  const zavData = [];
  const Gs = 2.65;
  const minX_zav = Math.max(0, trials[0].mc - 2);
  const maxX_zav = trials[trials.length - 1].mc + 4;
  for (let x = minX_zav; x <= maxX_zav; x += 0.5) {
    const zav = (Gs * 1.0) / (1 + (x * Gs / 100));
    zavData.push({ x, y: zav });
  }

  const gradient = ctx.createLinearGradient(0,0,0,400);
  gradient.addColorStop(0, 'rgba(73,107,82,0.2)');
  gradient.addColorStop(1, 'rgba(73,107,82,0.0)');
  
  chartInstance = new Chart(ctx, {
    type: 'scatter',
    data: {
      datasets: [
        {
          label: 'Zero Air Voids (ZAV) Curve',
          data: zavData,
          type: 'line',
          borderColor: 'rgba(239, 68, 68, 0.5)',
          borderDash: [10, 5],
          borderWidth: 1,
          pointRadius: 0,
          fill: false,
          order: 3
        },
        {
          label: 'Fitted Compaction Curve',
          data: curveData,
          type: 'line',
          borderColor: '#496b52',
          backgroundColor: gradient,
          borderWidth: 3,
          tension: 0.4,
          fill: true,
          pointRadius: 0, // Hide points on the curve
          order: 2
        },
        {
          label: 'Trial Data Points',
          data: scatterData,
          backgroundColor: '#496b52',
          pointRadius: 6,
          pointHoverRadius: 10,
          order: 1
        },
        {
          label: 'OMC/MDD Peak',
          data: [{ x: omc, y: mdd }],
          backgroundColor: '#b67d35',
          pointRadius: 10,
          pointStyle: 'star',
          order: 0
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: 'rgba(38,55,45,0.96)',
          callbacks: {
            label: (item) => `${item.dataset.label}: (${item.parsed.x.toFixed(2)}%, ${item.parsed.y.toFixed(3)} g/cc)`
          }
        }
      },
      scales: {
        x: { 
          type: 'linear',
          title: { display: true, text: 'Moisture Content (%)', color: '#526358' },
          grid: { color: 'rgba(73,107,82,0.12)' },
          ticks: { color: '#526358' },
          suggestedMin: Math.max(0, trials[0].mc - 2),
          suggestedMax: trials[trials.length - 1].mc + 2
        },
        y: {
          title: { display: true, text: 'Dry Density (g/cc)', color: '#526358' },
          grid: { color: 'rgba(73,107,82,0.12)' },
          ticks: { color: '#526358', callback: v => v.toFixed(3) },
          // Dynamic range: pad 0.08 below/above actual data so curve is never clipped
          min: Math.max(0, parseFloat((Math.min(...trials.map(t => t.dd)) - 0.12).toFixed(2))),
          max: parseFloat((Math.max(...trials.map(t => t.dd)) + 0.12).toFixed(2))
        }
      }
    }
  });

  // Add Crosshair for OMC/MDD
  const originalDraw = chartInstance.draw;
  chartInstance.draw = function() {
    originalDraw.apply(this, arguments);
    const chart = this;
    const ctx = chart.ctx;
    const xAxis = chart.scales.x;
    const yAxis = chart.scales.y;
    
    const xPos = xAxis.getPixelForValue(omc);
    const yPos = yAxis.getPixelForValue(mdd);
    
    ctx.save();
    ctx.setLineDash([5, 5]);
    ctx.strokeStyle = '#b67d35';
    ctx.lineWidth = 1;
    
    // Vertical Line
    ctx.beginPath();
    ctx.moveTo(xPos, yAxis.bottom);
    ctx.lineTo(xPos, yPos);
    ctx.stroke();
    
    // Horizontal Line
    ctx.beginPath();
    ctx.moveTo(xAxis.left, yPos);
    ctx.lineTo(xPos, yPos);
    ctx.stroke();
    
    // Labels
    ctx.fillStyle = '#b67d35';
    ctx.font = '10px Inter';
    ctx.fillText(`OMC: ${omc.toFixed(2)}%`, xPos + 5, yAxis.bottom - 5);
    ctx.fillText(`MDD: ${mdd.toFixed(3)}`, xAxis.left + 5, yPos - 5);
    
    ctx.restore();
  };
}

// ── PDF Export ───────────────────────────────────────────────
async function runReportAction(action) {
  if (!lastResults) {
    showToast('Run a compaction analysis before exporting a report.', 'warning');
    return;
  }
  if (!lastResults.reportReady) {
    showToast('Wait for the test save to finish before generating its report.', 'warning');
    return;
  }
  try {
    await action(lastResults);
    showToast('PDF report ready.', 'success');
  } catch (error) {
    console.error('PDF report action failed:', error);
    showToast(error.message || 'Could not generate the PDF report.', 'warning');
  }
}

window.viewReport = () => runReportAction(viewReportPdf);
window.generatePDF = () => runReportAction(downloadReportPdf);

window.exportChartPNG = () => {
  const canvas = document.getElementById('compaction-chart');
  if(!canvas) return;
  const a = document.createElement('a');
  a.href = canvas.toDataURL('image/png');
  a.download = `Compaction_Curve_${Date.now()}.png`;
  a.click();
};

window.loadSampleData = () => {
  const d = [
    {"W1": 25.0, "W2": 162.5, "W3": 150.0, "WD": 1.87},
    {"W1": 25.0, "W2": 165.0, "W3": 150.0, "WD": 2.07},
    {"W1": 25.0, "W2": 167.5, "W3": 150.0, "WD": 2.19},
    {"W1": 25.0, "W2": 170.0, "W3": 150.0, "WD": 2.18},
    {"W1": 25.0, "W2": 172.5, "W3": 150.0, "WD": 2.065}
  ];
  // Ensure we have 5 trials for the sample
  while(document.querySelectorAll('.trial-card').length < 5) addTrial();
  
  const trials = document.querySelectorAll('.trial-card');
  for(let i=0; i<Math.min(trials.length, d.length); i++) {
    const num = trials[i].id.split('-')[1];
    document.getElementById(`W1-${num}`).value = d[i].W1;
    document.getElementById(`W2-${num}`).value = d[i].W2;
    document.getElementById(`W3-${num}`).value = d[i].W3;
    document.getElementById(`WD-${num}`).value = d[i].WD;
  }
  document.getElementById('test-name').value = 'Sample Site Test';
  showToast('Sample data loaded. Run analysis!', 'success');
};

function showToast(msg, type='info') {
  const t = document.getElementById('toast');
  t.textContent = msg; t.className = `toast toast-${type} show`;
  setTimeout(()=>t.classList.remove('show'), 3000);
}
