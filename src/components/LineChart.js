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

export function LineChart(canvasId, evaluations) {
  let chartInstance = null

  function buildData(evals) {
    const sorted = [...evals].sort(
      (a, b) => new Date(a.created_at) - new Date(b.created_at)
    )
    return {
      labels: sorted.map(e =>
        new Date(e.created_at).toLocaleDateString('de-DE', { month: 'short', year: '2-digit' })
      ),
      scores: sorted.map(e => Number(e.score)),
    }
  }

  function render() {
    const canvas = document.getElementById(canvasId)
    if (!canvas) return

    if (chartInstance) {
      chartInstance.destroy()
    }

    if (!evaluations?.length) {
      const ctx = canvas.getContext('2d')
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      return
    }

    const { labels, scores } = buildData(evaluations)

    chartInstance = new Chart(canvas, {
      type: 'line',
      data: {
        labels,
        datasets: [
          {
            label: 'Score',
            data: scores,
            borderColor: '#B5573A',
            backgroundColor: 'rgba(181,87,58,0.08)',
            borderWidth: 2,
            pointBackgroundColor: '#B5573A',
            pointRadius: 4,
            pointHoverRadius: 6,
            tension: 0.35,
            fill: true,
          },
        ],
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
              label: ctx => ` Score: ${ctx.parsed.y.toFixed(1)} / 5.0`,
            },
          },
        },
        scales: {
          x: {
            grid: { display: false },
            ticks: {
              color: '#A08090',
              font: { family: 'DM Sans', size: 11 },
            },
          },
          y: {
            min: 0,
            max: 5,
            grid: { color: 'rgba(61,43,53,0.06)' },
            ticks: {
              stepSize: 1,
              color: '#A08090',
              font: { family: 'DM Sans', size: 11 },
            },
          },
        },
      },
    })
  }

  function update(newEvaluations) {
    evaluations = newEvaluations
    render()
  }

  function destroy() {
    chartInstance?.destroy()
  }

  return { render, update, destroy }
}
