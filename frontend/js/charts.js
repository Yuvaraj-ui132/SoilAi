/**
 * SoilAI Cloud Lab — Chart.js Module
 * Moisture Content vs Dry Density compaction curves
 */

const compactionChartInstances = new Map();

/**
 * Render the Moisture Content vs Dry Density compaction chart.
 * @param {Array}  trials  - Experimental moisture-content/dry-density measurements
 * @param {object} fitData - Polynomial coefficients and optional peak {a, b, c, omc, mdd}
 * @param {Array}  zavData - Zero-air-void line points
 * @param {boolean} mini   - Compact mode for dashboard widget
 */
function renderCompactionChart(canvasId, trials, fitData, zavData = [], mini = false) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;

  const existingChart = compactionChartInstances.get(canvasId);
  if (existingChart) existingChart.destroy();

  const ctx = canvas.getContext('2d');
  const measurements = trials.map(trial => ({
    moisture_content: trial.moisture_content ?? trial.mc,
    dry_density: trial.dry_density ?? trial.dd
  }));
  const scatterData = measurements.map(trial => ({
    x: trial.moisture_content,
    y: trial.dry_density
  }));
  const curveData = [];
  if (fitData && [fitData.a, fitData.b, fitData.c].every(Number.isFinite) && measurements.length) {
    const minX = Math.max(0, Math.min(...measurements.map(trial => trial.moisture_content)) - 2);
    const maxX = Math.max(...measurements.map(trial => trial.moisture_content)) + 2;
    const step = Math.max((maxX - minX) / 100, 0.05);
    for (let x = minX; x <= maxX; x += step) {
      const y = (fitData.a * x * x) + (fitData.b * x) + fitData.c;
      if (y > 0) curveData.push({ x, y });
    }
  }
  const zavPoints = zavData.map(point => ({ x: point.moisture, y: point.dry_density }));
  if (typeof Chart === 'undefined') {
    return drawLocalCompactionChart(canvas, scatterData, curveData, zavPoints, fitData, mini);
  }

  const gradient = ctx.createLinearGradient(0, 0, 0, canvas.height);
  gradient.addColorStop(0,   'rgba(59, 130, 246, 0.35)');
  gradient.addColorStop(0.5, 'rgba(59, 130, 246, 0.12)');
  gradient.addColorStop(1,   'rgba(59, 130, 246, 0.00)');

  const chart = new Chart(ctx, {
    type: 'scatter',
    data: {
      datasets: [
        {
          label: 'Zero Air Void (ZAV)',
          data: zavPoints,
          borderColor: 'rgba(248, 113, 113, 0.85)',
          borderDash: [7, 5],
          borderWidth: 1.5,
          pointRadius: 0,
          fill: false,
          order: 3,
        },
        {
          label: 'Compaction Curve',
          data: curveData,
          type: 'line',
          borderColor: '#3b82f6',
          borderWidth: 2.5,
          backgroundColor: gradient,
          fill: true,
          tension: 0.4,
          pointRadius: 0,
          order: 2
        },
        {
          label: 'Trial Points',
          data: scatterData,
          backgroundColor: 'rgba(59,130,246,0.9)',
          borderColor: '#3b82f6',
          pointRadius: mini ? 3 : 6,
          order: 1
        },
        ...(Number.isFinite(fitData?.omc) && Number.isFinite(fitData?.mdd) ? [{
          label: 'OMC/MDD Peak',
          data: [{ x: fitData.omc, y: fitData.mdd }],
          backgroundColor: '#fbbf24',
          borderColor: '#f59e0b',
          pointRadius: mini ? 5 : 10,
          pointStyle: 'star',
          order: 0,
        }] : [])
      ]
    },
    options: {
      responsive : true,
      maintainAspectRatio: true,
      animation: {
        duration: 1000,
        easing  : 'easeInOutQuart'
      },
      plugins: {
        legend: {
          display: !mini,
          labels : { color: '#94a3b8', font: { size: 12, family: 'Inter' } }
        },
        tooltip: {
          backgroundColor : 'rgba(15, 23, 42, 0.95)',
          borderColor     : 'rgba(59,130,246,0.4)',
          borderWidth     : 1,
          titleColor      : '#e2e8f0',
          bodyColor       : '#94a3b8',
          padding         : 12,
          callbacks: {
            label : (item)  => ` ${item.dataset.label}: (${item.parsed.x.toFixed(2)}%, ${item.parsed.y.toFixed(4)})`,
            afterBody: (item) => {
              if (item[0].dataset.label === 'OMC/MDD Peak') return [`\n★ Peak Detected`];
              return [];
            }
          }
        },
      },
      scales: {
        x: {
          type: 'linear',
          title: {
            display: !mini,
            text   : 'Moisture Content (%)',
            color  : '#64748b',
            font   : { size: 12, family: 'Inter' }
          },
          grid : { color: 'rgba(255,255,255,0.04)' },
          ticks: { color: '#64748b', font: { size: mini ? 9 : 11 } }
        },
        y: {
          title: {
            display: !mini,
            text   : 'Dry Density (g/cm³)',
            color  : '#64748b',
            font   : { size: 12, family: 'Inter' }
          },
          grid : { color: 'rgba(255,255,255,0.04)' },
          min  : 1.0,
          max  : 2.5,
          ticks: {
            color    : '#64748b',
            font     : { size: mini ? 9 : 11 },
            callback : (v) => v.toFixed(3)
          }
        }
      }
    }
  });

  compactionChartInstances.set(canvasId, chart);
  return chart;
}

function drawLocalCompactionChart(canvas, trials, curve, zav, fitData, mini) {
  const ctx = canvas.getContext('2d');
  const width = canvas.width;
  const height = canvas.height;
  const points = [...trials, ...curve, ...zav].filter(point =>
    Number.isFinite(point.x) && Number.isFinite(point.y)
  );
  if (points.length === 0) return null;

  const padding = { left: 52, right: 20, top: 20, bottom: mini ? 34 : 48 };
  const minX = Math.min(...points.map(point => point.x));
  const maxX = Math.max(...points.map(point => point.x));
  const minY = Math.min(...points.map(point => point.y));
  const maxY = Math.max(...points.map(point => point.y));
  const xSpan = Math.max(maxX - minX, 1);
  const ySpan = Math.max(maxY - minY, 0.1);
  const x = value => padding.left + ((value - minX) / xSpan) * (width - padding.left - padding.right);
  const y = value => height - padding.bottom - ((value - minY) / ySpan) * (height - padding.top - padding.bottom);

  ctx.clearRect(0, 0, width, height);
  ctx.font = '11px sans-serif';
  ctx.strokeStyle = 'rgba(148, 163, 184, 0.55)';
  ctx.fillStyle = '#94a3b8';
  ctx.beginPath();
  ctx.moveTo(padding.left, padding.top);
  ctx.lineTo(padding.left, height - padding.bottom);
  ctx.lineTo(width - padding.right, height - padding.bottom);
  ctx.stroke();
  ctx.fillText('Moisture Content (%)', padding.left, height - 10);
  ctx.save();
  ctx.translate(14, height / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText('Dry Density (g/cm³)', 0, 0);
  ctx.restore();

  const drawLine = (linePoints, color, dashed, lineWidth) => {
    if (!linePoints.length) return;
    ctx.beginPath();
    linePoints.forEach((point, index) => {
      if (index === 0) ctx.moveTo(x(point.x), y(point.y));
      else ctx.lineTo(x(point.x), y(point.y));
    });
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;
    ctx.setLineDash(dashed ? [7, 5] : []);
    ctx.stroke();
    ctx.setLineDash([]);
  };
  drawLine(zav, 'rgba(248, 113, 113, 0.9)', true, 1.5);
  drawLine(curve, '#3b82f6', false, 2.5);

  trials.forEach(point => {
    ctx.beginPath();
    ctx.arc(x(point.x), y(point.y), 4, 0, Math.PI * 2);
    ctx.fillStyle = '#60a5fa';
    ctx.fill();
  });
  if (Number.isFinite(fitData?.omc) && Number.isFinite(fitData?.mdd)) {
    ctx.beginPath();
    ctx.arc(x(fitData.omc), y(fitData.mdd), 6, 0, Math.PI * 2);
    ctx.fillStyle = '#fbbf24';
    ctx.fill();
  }
  if (!mini) {
    ctx.fillStyle = '#94a3b8';
    ctx.fillText('Trials   — Fitted curve   - - ZAV', padding.left, padding.top + 12);
  }
  return null;
}

/**
 * Render a simple bar chart for moisture distribution overview.
 */
function renderMoistureDistribution(canvasId, tests) {
  const canvas = document.getElementById(canvasId);
  if (!canvas || tests.length === 0) return;

  const labels = tests.slice(0, 8).map((_, i) => `Test ${i + 1}`);
  const mcData = tests.slice(0, 8).map(t => t.results?.average_moisture_content || 0);
  const ddData = tests.slice(0, 8).map(t => t.results?.average_dry_density || 0);

  new Chart(canvas.getContext('2d'), {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          label           : 'Avg Moisture (%)',
          data            : mcData,
          backgroundColor : 'rgba(59,130,246,0.6)',
          borderColor     : '#3b82f6',
          borderWidth     : 1,
          borderRadius    : 4,
          yAxisID         : 'y'
        },
        {
          label           : 'Avg Dry Density',
          data            : ddData,
          backgroundColor : 'rgba(16,185,129,0.6)',
          borderColor     : '#10b981',
          borderWidth     : 1,
          borderRadius    : 4,
          yAxisID         : 'y1'
        }
      ]
    },
    options: {
      responsive: true,
      plugins: {
        legend: { labels: { color: '#94a3b8', font: { family: 'Inter' } } },
        tooltip: {
          backgroundColor: 'rgba(15,23,42,0.95)',
          titleColor     : '#e2e8f0',
          bodyColor      : '#94a3b8'
        }
      },
      scales: {
        x   : { grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { color: '#64748b' } },
        y   : { grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { color: '#64748b', callback: v => v.toFixed(1) + '%' }, position: 'left' },
        y1  : { grid: { display: false },                  ticks: { color: '#10b981', callback: v => v.toFixed(3) },       position: 'right' }
      }
    }
  });
}

export { renderCompactionChart, renderMoistureDistribution };
