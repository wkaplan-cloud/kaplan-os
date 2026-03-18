'use strict'
require('dotenv').config()
const express = require('express')
const session = require('express-session')
const multer  = require('multer')
const path    = require('path')
const fs      = require('fs')
const { pool, init } = require('./db')

const app = express()

// ── Uploads directory ─────────────────────────────────────────────────────────

const UPLOADS_DIR = path.join(__dirname, 'uploads')
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true })

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename:    (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase()
    cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`)
  }
})

const ALLOWED_MIMES = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/msword',
  'text/plain', 'text/csv',
  'image/jpeg', 'image/jpg', 'image/png', 'image/webp'
])

const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, ALLOWED_MIMES.has(file.mimetype))
})

// ── Session ───────────────────────────────────────────────────────────────────

app.set('trust proxy', 1)  // required behind Railway's load balancer

app.use(session({
  secret: process.env.SESSION_SECRET || 'kaplan-dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    maxAge: 30 * 24 * 60 * 60 * 1000,
    secure: process.env.NODE_ENV === 'production'
  }
}))

app.use(express.json())

// ── Auth ──────────────────────────────────────────────────────────────────────

const PUBLIC_PATHS = ['/login.html', '/api/login', '/api/logout', '/api/people/names',
                      '/sw.js', '/manifest.json', '/icon.svg']

app.use((req, res, next) => {
  if (PUBLIC_PATHS.includes(req.path)) return next()
  if (req.session?.role) return next()
  if (!req.path.startsWith('/api/')) req.session.returnTo = req.path
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Not authenticated' })
  res.redirect('/login.html')
})

function requireParent (req, res, next) {
  if (req.session?.role === 'parent') return next()
  if (req.path.startsWith('/api/')) return res.status(403).json({ error: 'Parent access required' })
  res.redirect('/login.html')
}

// ── Auth routes ───────────────────────────────────────────────────────────────

app.post('/api/login', async (req, res) => {
  const { name, password } = req.body
  if (!password) return res.status(400).json({ error: 'Password required' })

  const parentPw = process.env.PARENT_PASSWORD
  if (!parentPw) return res.status(503).json({ error: 'Passwords not configured in .env' })

  const returnTo = req.session.returnTo

  // Parent login
  if (password === parentPw) {
    req.session.role = 'parent'
    req.session.personName = 'Parent'
    delete req.session.returnTo
    return res.json({ success: true, role: 'parent', redirect: returnTo || '/parent.html' })
  }

  // Family member login
  if (name) {
    const { rows } = await pool.query('SELECT * FROM people WHERE LOWER(name) = LOWER($1)', [name.trim()])
    const person = rows[0]
    if (person && person.password && person.password === password) {
      req.session.role = 'family'
      req.session.personId = person.id
      req.session.personName = person.name
      delete req.session.returnTo
      return res.json({ success: true, role: 'family', redirect: returnTo || '/' })
    }
  }

  res.status(401).json({ error: 'Wrong password' })
})

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ success: true }))
})

// ── Static files ──────────────────────────────────────────────────────────────

app.get('/',            (req, res) => res.sendFile(path.join(__dirname, 'index.html')))
app.get('/parent.html', (req, res) => res.sendFile(path.join(__dirname, 'parent.html')))
app.get('/login.html',  (req, res) => res.sendFile(path.join(__dirname, 'login.html')))
app.use(express.static(path.join(__dirname)))

// ── OpenAI ────────────────────────────────────────────────────────────────────

let openai = null
if (process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY !== 'sk-your-key-here') {
  const { default: OpenAI } = require('openai')
  openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
}

async function buildKnowledgeContext () {
  const [people, knowledge, events, documents, docFiles] = await Promise.all([
    pool.query('SELECT * FROM people'),
    pool.query('SELECT * FROM knowledge_entries ORDER BY created_at DESC'),
    pool.query('SELECT * FROM events ORDER BY date'),
    pool.query('SELECT * FROM documents'),
    pool.query('SELECT id, name, content FROM document_files WHERE content IS NOT NULL ORDER BY created_at DESC')
  ])

  const sections = []

  if (people.rows.length > 0) {
    const lines = people.rows.map(p => {
      let l = `• ${p.name} (${p.role || 'family member'})`
      if (p.date_of_birth)          l += `, born ${p.date_of_birth}`
      if (p.phone_number)           l += `, phone: ${p.phone_number}`
      if (p.id_number)              l += `, ID: ${p.id_number}`
      if (p.emergency_contact_name) l += `, emergency: ${p.emergency_contact_name} (${p.emergency_contact_number || 'no number'})`
      return l
    })
    sections.push(`FAMILY MEMBERS:\n${lines.join('\n')}`)
  }

  if (knowledge.rows.length > 0) {
    sections.push(`KNOWLEDGE BASE:\n${knowledge.rows.map(k => `Q: ${k.question}\nA: ${k.answer}`).join('\n\n')}`)
  }

  if (events.rows.length > 0) {
    sections.push(`IMPORTANT DATES:\n${events.rows.map(e => `• ${e.type}: ${e.date}${e.description ? ` — ${e.description}` : ''}`).join('\n')}`)
  }

  if (documents.rows.length > 0) {
    sections.push(`DOCUMENTS:\n${documents.rows.map(d => `• ${d.name}: ${d.location || 'unknown'}${d.notes ? ` — ${d.notes}` : ''}`).join('\n')}`)
  }

  if (docFiles.rows.length > 0) {
    const lines = docFiles.rows.map(d => {
      const text = d.content.length > 4000 ? d.content.slice(0, 4000) + '\n[…continues…]' : d.content
      return `=== ${d.name} ===\n${text}`
    })
    sections.push(`UPLOADED DOCUMENTS:\n${lines.join('\n\n')}`)
  }

  return sections.length > 0 ? sections.join('\n\n') : null
}

// ── Text extraction ───────────────────────────────────────────────────────────

async function extractText (filePath, mimeType) {
  try {
    if (mimeType === 'application/pdf') {
      const pdfParse = require('pdf-parse')
      const data = await pdfParse(fs.readFileSync(filePath))
      return data.text.trim()
    }
    if (mimeType.includes('wordprocessingml') || mimeType === 'application/msword') {
      const mammoth = require('mammoth')
      const result  = await mammoth.extractRawText({ path: filePath })
      return result.value.trim()
    }
    if (mimeType === 'text/plain' || mimeType === 'text/csv') {
      return fs.readFileSync(filePath, 'utf8').trim()
    }
    if (mimeType.startsWith('image/')) {
      if (!openai) return '[Image uploaded — add OPENAI_API_KEY to extract text]'
      const base64   = fs.readFileSync(filePath).toString('base64')
      const response = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: [
          { type: 'text', text: 'Extract and transcribe ALL text and important information from this image.' },
          { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64}` } }
        ]}],
        max_tokens: 1000
      })
      return response.choices[0].message.content.trim()
    }
    return null
  } catch (err) {
    console.error('Text extraction error:', err.message)
    return null
  }
}

// ── Chat ──────────────────────────────────────────────────────────────────────

app.post('/api/chat', async (req, res) => {
  try {
    const { message } = req.body
    if (!message?.trim()) return res.status(400).json({ error: 'Message is required' })
    if (!openai) return res.status(503).json({ error: 'AI not configured', message: 'Add OPENAI_API_KEY to .env' })

    const context      = await buildKnowledgeContext()
    const systemPrompt = context
      ? `You are Kaplan OS, a warm and reliable family knowledge assistant.

Answer questions using ONLY the family knowledge below. Do not invent or guess any facts.
If the answer is clearly present, respond naturally, warmly, and briefly (1–3 sentences).
If not, respond with exactly: UNKNOWN

--- FAMILY KNOWLEDGE ---
${context}
--- END ---`
      : `You are Kaplan OS. The knowledge base is empty. For every question respond with exactly: UNKNOWN`

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: message.trim() }],
      max_tokens: 200, temperature: 0.2
    })
    const reply   = completion.choices[0].message.content.trim()
    const unknown = reply === 'UNKNOWN' || reply.startsWith('UNKNOWN')
    res.json({ answer: unknown ? null : reply, unknown })
  } catch (err) {
    console.error('Chat error:', err.constructor?.name, err.message)
    if (err.status) console.error('OpenAI status:', err.status)
    if (err.cause) console.error('Caused by:', err.cause?.message || err.cause)
    res.status(500).json({ error: 'Something went wrong', message: err.message })
  }
})

// ── Pending questions ─────────────────────────────────────────────────────────

app.get('/api/pending', async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM pending_questions WHERE status = 'pending' ORDER BY created_at DESC")
  res.json(rows)
})

app.get('/api/pending/count', async (req, res) => {
  const { rows } = await pool.query("SELECT COUNT(*) as count FROM pending_questions WHERE status = 'pending'")
  res.json({ count: parseInt(rows[0].count, 10) })
})

app.post('/api/pending', async (req, res) => {
  const { question, asked_by } = req.body
  if (!question?.trim()) return res.status(400).json({ error: 'Question is required' })
  const { rows } = await pool.query(
    'INSERT INTO pending_questions (question, asked_by) VALUES ($1, $2) RETURNING id',
    [question.trim(), asked_by?.trim() || 'family']
  )
  res.json({ id: rows[0].id, question: question.trim(), status: 'pending' })
})

app.post('/api/pending/:id/answer', requireParent, async (req, res) => {
  const id     = parseInt(req.params.id, 10)
  const { answer } = req.body
  if (!answer?.trim()) return res.status(400).json({ error: 'Answer is required' })

  const { rows } = await pool.query('SELECT * FROM pending_questions WHERE id = $1', [id])
  if (!rows[0]) return res.status(404).json({ error: 'Question not found' })

  await pool.query(
    'INSERT INTO knowledge_entries (question, answer, category, created_by) VALUES ($1, $2, $3, $4)',
    [rows[0].question, answer.trim(), 'general', 'parent']
  )
  await pool.query("UPDATE pending_questions SET status = 'answered' WHERE id = $1", [id])
  res.json({ success: true })
})

// ── Knowledge ─────────────────────────────────────────────────────────────────

app.get('/api/knowledge', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM knowledge_entries ORDER BY created_at DESC')
  res.json(rows)
})

app.post('/api/knowledge', requireParent, async (req, res) => {
  const { question, answer, category } = req.body
  if (!question?.trim() || !answer?.trim()) return res.status(400).json({ error: 'Question and answer required' })
  const { rows } = await pool.query(
    'INSERT INTO knowledge_entries (question, answer, category, created_by) VALUES ($1, $2, $3, $4) RETURNING id',
    [question.trim(), answer.trim(), category || 'general', 'parent']
  )
  res.json({ id: rows[0].id })
})

app.delete('/api/knowledge/:id', requireParent, async (req, res) => {
  await pool.query('DELETE FROM knowledge_entries WHERE id = $1', [parseInt(req.params.id, 10)])
  res.json({ success: true })
})

// ── People ────────────────────────────────────────────────────────────────────

// Public — used by login page to populate name dropdown
app.get('/api/people/names', async (req, res) => {
  const { rows } = await pool.query('SELECT id, name FROM people ORDER BY name')
  res.json(rows)
})

app.get('/api/people', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM people ORDER BY name')
  res.json(rows)
})

app.post('/api/people', requireParent, async (req, res) => {
  const { name, role, date_of_birth, phone_number,
          emergency_contact_name, emergency_contact_number, id_number, password } = req.body
  if (!name?.trim()) return res.status(400).json({ error: 'Name is required' })
  const { rows } = await pool.query(`
    INSERT INTO people (name, role, date_of_birth, phone_number,
      emergency_contact_name, emergency_contact_number, id_number, password)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [name.trim(), role?.trim() || null, date_of_birth?.trim() || null,
     phone_number?.trim() || null, emergency_contact_name?.trim() || null,
     emergency_contact_number?.trim() || null, id_number?.trim() || null,
     password?.trim() || null]
  )
  res.json({ id: rows[0].id })
})

app.put('/api/people/:id/password', requireParent, async (req, res) => {
  const id = parseInt(req.params.id, 10)
  const { password } = req.body
  if (!password?.trim()) return res.status(400).json({ error: 'Password required' })
  await pool.query('UPDATE people SET password = $1 WHERE id = $2', [password.trim(), id])
  res.json({ success: true })
})

app.delete('/api/people/:id', requireParent, async (req, res) => {
  await pool.query('DELETE FROM people WHERE id = $1', [parseInt(req.params.id, 10)])
  res.json({ success: true })
})

// ── Document files ────────────────────────────────────────────────────────────

app.get('/api/documents', requireParent, async (req, res) => {
  const { rows } = await pool.query(
    'SELECT id, name, original_filename, mime_type, size, created_at, SUBSTRING(content, 1, 200) as preview FROM document_files ORDER BY created_at DESC'
  )
  res.json(rows)
})

app.post('/api/documents/upload', requireParent, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file or unsupported file type' })
  const { originalname, mimetype, size, path: filePath } = req.file
  const name = req.body.name?.trim() || originalname
  try {
    const content = await extractText(filePath, mimetype)
    const { rows } = await pool.query(
      'INSERT INTO document_files (name, original_filename, file_path, mime_type, content, size) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
      [name, originalname, filePath, mimetype, content, size]
    )
    res.json({ id: rows[0].id, name, extracted: !!content, preview: content?.slice(0, 200) || null })
  } catch (err) {
    try { fs.unlinkSync(filePath) } catch {}
    res.status(500).json({ error: 'Failed to process file' })
  }
})

app.delete('/api/documents/:id', requireParent, async (req, res) => {
  const id  = parseInt(req.params.id, 10)
  const { rows } = await pool.query('SELECT file_path FROM document_files WHERE id = $1', [id])
  if (rows[0]?.file_path) try { fs.unlinkSync(rows[0].file_path) } catch {}
  await pool.query('DELETE FROM document_files WHERE id = $1', [id])
  res.json({ success: true })
})

// ── Start ─────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000
if (!process.env.DATABASE_URL) {
  console.error('ERROR: DATABASE_URL environment variable is not set.')
  process.exit(1)
}

init().then(() => {
  app.listen(PORT, () => {
    console.log(`\n🏠 Kaplan OS running at http://localhost:${PORT}`)
    console.log(`   Chat:         http://localhost:${PORT}/`)
    console.log(`   Parent Inbox: http://localhost:${PORT}/parent.html\n`)
  })
}).catch(err => {
  console.error('Failed to initialise database:', err.message, err.stack)
  process.exit(1)
})
