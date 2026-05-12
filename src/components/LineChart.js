import {
  Chart,
  LineElement,
  PointElement,
  LineController,
  CategoryScale,
  LinearScale,
  Tooltip,
  Filler,
} from 'chart.js'

Chart.register(LineElement, PointElement, LineController, CategoryScale, LinearScale, Tooltip, Filler)

/**
 * @param {string} canvasId
 * @param {Array|object} data
 *   Array of evaluation rows (legacy, plots e.score on 0–5 axis)
 *   OR { labels: string[], values: number[], yMin?, yMax?, tooltipLabel? }
 */
export function LineChart(canvasId, data) {
  let chartInstance = null
  let chartLabels, chartValues, yMin, yMax, tooltipLabel

  if (Array.isArray(data)) {
    const sorted = [...data].sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
    chartLabels  = sorted.map(e =>
      new Date(e.created_at).toLocaleDateString('de-DE', { month: 'short', year: '2-digit' }))
    chartValues  = sorted.map(e => Number(e.score))
    yMin = 0; yMax = 5; tooltipLabel = 'Score'
  } else {
    chartLabels  = data?.labels       ?? []
    chartValues  = data?.values       ?? []
    yMin         = data?.yMin         ?? 0
    yMax         = data?.yMax         ?? 100
    tooltipLabel = data?.tooltipLabel ?? 'PI Monat'
  }

  function render() {
    const canvas = document.getElementById(canvasId)
    if (!canvas) return

    chartInstance?.destroy()

    if (!chartValues.length) {
      canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height)
      return
    }

    chartInstance = new Chart(canvas, {
      type: 'line',
      data: {
        labels: chartLabels,
        datasets: [{
          label: tooltipLabel,
          data: chartValues,
          borderColor: '#B5573A',
          backgroundColor: 'rgba(181,87,58,0.08)',
          borderWidth: 2,
          pointBackgroundColor: '#B5573A',
          pointRadius: 4,
          pointHoverRadius: 6,
          tension: 0.35,
          fill: true,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: '#3D2B35',
            titleColor: '#F5EDE4',
            bodyColor: '#F5EDE4',
            padding: 10,
            callbacks: {
              label: ctx => ` ${tooltipLabel}: ${ctx.parsed.y.toFixed(1)}${yMax === 100 ? '' : ' / 5.0'}`,
            },
          },
        },
        scales: {
          x: {
            grid: { display: false },
            ticks: { color: '#A08090', font: { family: 'DM Sans', size: 11 } },
          },
          y: {
            min: yMin,
            max: yMax,
            grid: { color: 'rgba(61,43,53,0.06)' },
            ticks: {
              stepSize: yMax === 100 ? 20 : 1,
              color: '#A08090',
              font: { family: 'DM Sans', size: 11 },
            },
          },
        },
      },
    })
  }

  function update(newData) {
    data = newData
    if (Array.isArray(newData)) {
      const sorted = [...newData].sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
      chartLabels = sorted.map(e =>
        new Date(e.created_at).toLocaleDateString('de-DE', { month: 'short', year: '2-digit' }))
      chartValues = sorted.map(e => Number(e.score))
    } else {
      chartLabels  = newData?.labels  ?? []
      chartValues  = newData?.values  ?? []
    }
    render()
  }

  function destroy() { chartInstance?.destroy() }

  return { render, update, destroy }
}
