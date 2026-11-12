import { readFile, writeFile } from 'node:fs/promises'

const htmlPath = 'dist/index.html'
const workerPath = 'dist-worker/database-worker.js'

let [html, workerSource] = await Promise.all([
  readFile(htmlPath, 'utf8'),
  readFile(workerPath, 'utf8'),
])

// Prevent worker text from accidentally closing the injected script element.
workerSource = workerSource.replaceAll('</script', '<\\/script')

const serializedWorker = JSON.stringify(workerSource)
  .replace(/</g, '\\u003c')

const injection =
  `<script>window.__DATABASE_WORKER_SOURCE__ = ${serializedWorker};</script>`

html = html.replace('</head>', () => `${injection}</head>`)


await writeFile(htmlPath, html)
