'use strict'
require('dotenv').config()
const express = require('express')
const session = require('express-session')
const multer  = require('multer')
const path    = require('path')
const fs      = require('fs')
const db      = require('./db')

// ── Upload directory (same volume as DB on Railway) ───────────────────────────

const DB_FILE    = process.env.DB_PATH ? path.resolve(process.env.DB_PATH) : path.join(__dirname, 'kaplan.db')
const DATA_DIR   = path.dirname(DB_FILE)
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads')
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
  limits: { fileSize: 20 * 1024 * 1024 },   // 20 MB
  fileFilter: (req, file, cb) => cb(null, ALLOWED_MIMES.has(file.mimetype))
})

const app = express()

// ── Session ───────────────────────────────────────────────────────────────────

app.use(session({
  secret: process.env.SESSION_SECRET || 'kaplan-dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    maxAge: 30 * 24 * 60 * 60 * 1000   // 30 days — stay logged in
  }
}))

app.use(express.json())

// ── Auth middleware ───────────────────────────────────────────────────────────

// Paths that don't need a login
const PUBLIC_PATHS = ['/login.html', '/api/login', '/api/logout',
                      '/sw.js', '/manifest.json', '/icon.svg']

app.use((req, res, next) => {
  if (PUBLIC_PATHS.includes(req.path)) return next()
  if (req.session?.role) return next()

  // Save where they were trying to go so we can redirect after login
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

app.post('/api/login', (req, res) => {
  const { password } = req.body
  if (!password) return res.status(400).json({ error: 'Password required' })

  const parentPw = process.env.PARENT_PASSWORD
  const familyPw = process.env.FAMILY_PASSWORD

  if (!parentPw || !familyPw) {
    return res.status(503).json({ error: 'Passwords not configured in .env' })
  }

  const returnTo = req.session.returnTo

  if (password === parentPw) {
    req.session.role = 'parent'
    delete req.session.returnTo
    return res.json({ success: true, role: 'parent', redirect: returnTo || '/parent.html' })
  }

  if (password === familyPw) {
    req.session.role = 'family'
    delete req.session.returnTo
    return res.json({ success: true, role: 'family', redirect: returnTo || '/' })
  }

  res.status(401).json({ error: 'Wrong password' })
})

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ success: true }))
})

// ── Static files (protected by auth middleware above) ─────────────────────────

app.use(express.static(path.join(__dirname)))

// ── OpenAI ────────────────────────────────────────────────────────────────────

let openai = null
if (process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY !== 'sk-your-key-here') {
  const { default: OpenAI } = require('openai')
  openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
}

// ── Text extraction ───────────────────────────────────────────────────────────

async function extractText (filePath, mimeType) {
  try {
    if (mimeType === 'application/pdf') {
      const pdfParse = require('pdf-parse')
      const data = await pdfParse(fs.readFileSync(filePath))
      return data.text.trim()
    }

    if (mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
        mimeType === 'application/msword') {
      const mammoth = require('mammoth')
      const result  = await mammoth.extractRawText({ path: filePath })
      return result.value.trim()
    }

    if (mimeType === 'text/plain' || mimeType === 'text/csv') {
      return fs.readFileSync(filePath, 'utf8').trim()
    }

    if (mimeType.startsWith('image/')) {
      if (!openai) return '[Image uploaded — add OPENAI_API_KEY to extract text from images]'
      const base64  = fs.readFileSync(filePath).toString('base64')
      const response = await openai.chat.completions.create({
        model:    'gpt-4o-mini',
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: 'Extract and transcribe ALL text and important information from this image. Include every number, date, name, and detail you can see.' },
            { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64}` } }
          ]
        }],
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

function buildKnowledgeContext () {
  const people    = db.prepare('SELECT * FROM people').all()
  const knowledge = db.prepare('SELECT * FROM knowledge_entries ORDER BY created_at DESC').all()
  const events    = db.prepare('SELECT * FROM events ORDER BY date').all()
  const documents = db.prepare('SELECT * FROM documents').all()
  const sections  = []

  if (people.length > 0) {
    const lines = people.map(p => {
      let l = `• ${p.name} (${p.role || 'family member'})`
      if (p.date_of_birth)          l += `, born ${p.date_of_birth}`
      if (p.phone_number)           l += `, phone: ${p.phone_number}`
      if (p.id_number)              l += `, ID: ${p.id_number}`
      if (p.emergency_contact_name) l += `, emergency: ${p.emergency_contact_name} (${p.emergency_contact_number || 'no number'})`
      return l
    })
    sections.push(`FAMILY MEMBERS:\n${lines.join('\n')}`)
  }

  if (knowledge.length > 0) {
    sections.push(`KNOWLEDGE BASE:\n${knowledge.map(k => `Q: ${k.question}\nA: ${k.answer}`).join('\n\n')}`)
  }

  if (events.length > 0) {
    sections.push(`IMPORTANT DATES:\n${events.map(e => `• ${e.type}: ${e.date}${e.description ? ` — ${e.description}` : ''}`).join('\n')}`)
  }

  if (documents.length > 0) {
    sections.push(`DOCUMENTS:\n${documents.map(d => `• ${d.name}: ${d.location || 'location unknown'}${d.notes ? ` — ${d.notes}` : ''}`).join('\n')}`)
  }

  const docFiles = db.prepare(
    'SELECT id, name, content FROM document_files WHERE content IS NOT NULL ORDER BY created_at DESC'
  ).all()
  if (docFiles.length > 0) {
    const lines = docFiles.map(d => {
      const text = d.content.length > 4000
        ? d.content.slice(0, 4000) + '\n[…document continues…]'
        : d.content
      return `=== ${d.name} ===\n${text}`
    })
    sections.push(`UPLOADED DOCUMENTS:\n${lines.join('\n\n')}`)
  }

  return sections.length > 0 ? sections.join('\n\n') : null
}

// ── Chat ──────────────────────────────────────────────────────────────────────

app.post('/api/chat', async (req, res) => {
  const { message } = req.body
  if (!message?.trim()) return res.status(400).json({ error: 'Message is required' })

  if (!openai) {
    return res.status(503).json({
      error: 'AI not configured',
      message: 'Add your OPENAI_API_KEY to the .env file.'
    })
  }

  const context      = buildKnowledgeContext()
  const systemPrompt = context
    ? `You are Kaplan OS, a warm and reliable family knowledge assistant.

Answer questions using ONLY the family knowledge below. Do not invent or guess any facts.
If the answer is clearly present, respond naturally, warmly, and briefly (1–3 sentences).
If not, respond with exactly: UNKNOWN

--- FAMILY KNOWLEDGE ---
${context}
--- END ---`
    : `You are Kaplan OS. The family knowledge base is empty. For every question respond with exactly: UNKNOWN`

  try {
    const completion = await openai.chat.completions.create({
      model:       'gpt-4o-mini',
      messages:    [{ role: 'system', content: systemPrompt }, { role: 'user', content: message.trim() }],
      max_tokens:  200,
      temperature: 0.2
    })
    const reply   = completion.choices[0].message.content.trim()
    const unknown = reply === 'UNKNOWN' || reply.startsWith('UNKNOWN')
    res.json({ answer: unknown ? null : reply, unknown })
  } catch (err) {
    console.error('OpenAI error:', err.message)
    res.status(500).json({ error: 'AI request failed', message: err.message })
  }
})

// ── Pending questions ─────────────────────────────────────────────────────────

app.get('/api/pending', (req, res) => {
  res.json(db.prepare("SELECT * FROM pending_questions WHERE status = 'pending' ORDER BY created_at DESC").all())
})

app.get('/api/pending/count', (req, res) => {
  res.json(db.prepare("SELECT COUNT(*) as count FROM pending_questions WHERE status = 'pending'").get())
})

app.post('/api/pending', (req, res) => {
  const { question, asked_by } = req.body
  if (!question?.trim()) return res.status(400).json({ error: 'Question is required' })
  const r = db.prepare('INSERT INTO pending_questions (question, asked_by) VALUES (?, ?)').run(question.trim(), asked_by?.trim() || 'family')
  res.json({ id: Number(r.lastInsertRowid), question: question.trim(), status: 'pending' })
})

app.post('/api/pending/:id/answer', requireParent, (req, res) => {
  const id     = parseInt(req.params.id, 10)
  const { answer } = req.body
  if (!answer?.trim()) return res.status(400).json({ error: 'Answer is required' })

  const row = db.prepare('SELECT * FROM pending_questions WHERE id = ?').get(id)
  if (!row) return res.status(404).json({ error: 'Question not found' })

  db.prepare('INSERT INTO knowledge_entries (question, answer, category, created_by) VALUES (?, ?, ?, ?)').run(row.question, answer.trim(), 'general', 'parent')
  db.prepare("UPDATE pending_questions SET status = 'answered' WHERE id = ?").run(id)
  res.json({ success: true })
})

// ── Knowledge ─────────────────────────────────────────────────────────────────

app.get('/api/knowledge', (req, res) => {
  res.json(db.prepare('SELECT * FROM knowledge_entries ORDER BY created_at DESC').all())
})

app.post('/api/knowledge', requireParent, (req, res) => {
  const { question, answer, category } = req.body
  if (!question?.trim() || !answer?.trim()) return res.status(400).json({ error: 'Question and answer required' })
  const r = db.prepare('INSERT INTO knowledge_entries (question, answer, category, created_by) VALUES (?, ?, ?, ?)').run(question.trim(), answer.trim(), category || 'general', 'parent')
  res.json({ id: Number(r.lastInsertRowid) })
})

app.delete('/api/knowledge/:id', requireParent, (req, res) => {
  db.prepare('DELETE FROM knowledge_entries WHERE id = ?').run(parseInt(req.params.id, 10))
  res.json({ success: true })
})

// ── People ────────────────────────────────────────────────────────────────────

app.get('/api/people', (req, res) => {
  res.json(db.prepare('SELECT * FROM people ORDER BY name').all())
})

app.post('/api/people', requireParent, (req, res) => {
  const { name, role, date_of_birth, phone_number,
          emergency_contact_name, emergency_contact_number, id_number } = req.body
  if (!name?.trim()) return res.status(400).json({ error: 'Name is required' })
  const r = db.prepare(`
    INSERT INTO people (name, role, date_of_birth, phone_number,
      emergency_contact_name, emergency_contact_number, id_number)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(name.trim(), role?.trim() || null, date_of_birth?.trim() || null,
         phone_number?.trim() || null, emergency_contact_name?.trim() || null,
         emergency_contact_number?.trim() || null, id_number?.trim() || null)
  res.json({ id: Number(r.lastInsertRowid) })
})

app.delete('/api/people/:id', requireParent, (req, res) => {
  db.prepare('DELETE FROM people WHERE id = ?').run(parseInt(req.params.id, 10))
  res.json({ success: true })
})

// ── Document files ────────────────────────────────────────────────────────────

app.get('/api/documents', requireParent, (req, res) => {
  const rows = db.prepare(
    'SELECT id, name, original_filename, mime_type, size, created_at, SUBSTR(content,1,200) as preview FROM document_files ORDER BY created_at DESC'
  ).all()
  res.json(rows)
})

app.post('/api/documents/upload', requireParent, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file or unsupported file type' })

  const { originalname, filename, mimetype, size, path: filePath } = req.file
  const name = req.body.name?.trim() || originalname

  try {
    const content = await extractText(filePath, mimetype)

    const result = db.prepare(`
      INSERT INTO document_files (name, original_filename, file_path, mime_type, content, size)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(name, originalname, filePath, mimetype, content, size)

    res.json({
      id:       Number(result.lastInsertRowid),
      name,
      extracted: !!content,
      preview:  content ? content.slice(0, 200) : null
    })
  } catch (err) {
    console.error('Upload error:', err.message)
    // Clean up the file on error
    try { fs.unlinkSync(filePath) } catch {}
    res.status(500).json({ error: 'Failed to process file' })
  }
})

app.delete('/api/documents/:id', requireParent, (req, res) => {
  const id  = parseInt(req.params.id, 10)
  const row = db.prepare('SELECT file_path FROM document_files WHERE id = ?').get(id)
  if (row?.file_path) {
    try { fs.unlinkSync(row.file_path) } catch {}
  }
  db.prepare('DELETE FROM document_files WHERE id = ?').run(id)
  res.json({ success: true })
})

// ── Daily SQLite backup ───────────────────────────────────────────────────────

function runBackup () {
  const dbFile = process.env.DB_PATH
    ? path.resolve(process.env.DB_PATH)
    : path.join(__dirname, 'kaplan.db')

  if (!fs.existsSync(dbFile)) return   // nothing to back up yet

  const backupDir = path.join(path.dirname(dbFile), 'backups')
  if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true })

  const today = new Date().toISOString().split('T')[0]
  const dest  = path.join(backupDir, `kaplan-${today}.db`)
  fs.copyFileSync(dbFile, dest)
  console.log(`📦 Backup saved: ${dest}`)

  // Keep only the 7 most recent backups
  const all = fs.readdirSync(backupDir)
    .filter(f => f.startsWith('kaplan-') && f.endsWith('.db'))
    .sort()
  if (all.length > 7) {
    all.slice(0, all.length - 7).forEach(f => fs.unlinkSync(path.join(backupDir, f)))
  }
}

runBackup()                                       // run once on startup
setInterval(runBackup, 24 * 60 * 60 * 1000)      // then every 24 hours

// ── Start ─────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000
app.listen(PORT, () => {
  console.log(`\n🏠 Kaplan OS running at http://localhost:${PORT}`)
  console.log(`   Chat:         http://localhost:${PORT}/`)
  console.log(`   Parent Inbox: http://localhost:${PORT}/parent.html\n`)
})
