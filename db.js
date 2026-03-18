'use strict'
const { Pool } = require('pg')

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
})

async function init () {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS people (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      role TEXT,
      date_of_birth TEXT,
      age INTEGER,
      id_number TEXT,
      phone_number TEXT,
      emergency_contact_name TEXT,
      emergency_contact_number TEXT,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS knowledge_entries (
      id SERIAL PRIMARY KEY,
      question TEXT NOT NULL,
      answer TEXT NOT NULL,
      category TEXT DEFAULT 'general',
      created_by TEXT DEFAULT 'parent',
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS pending_questions (
      id SERIAL PRIMARY KEY,
      question TEXT NOT NULL,
      asked_by TEXT DEFAULT 'family',
      status TEXT DEFAULT 'pending',
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS events (
      id SERIAL PRIMARY KEY,
      type TEXT NOT NULL,
      date TEXT NOT NULL,
      linked_person_id INTEGER REFERENCES people(id),
      description TEXT,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS documents (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      owner_person_id INTEGER REFERENCES people(id),
      location TEXT,
      notes TEXT,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS document_files (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      original_filename TEXT NOT NULL,
      file_path TEXT,
      mime_type TEXT,
      content TEXT,
      size INTEGER,
      uploaded_by TEXT DEFAULT 'parent',
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    );
  `)
  // Migrations for existing databases
  await pool.query(`ALTER TABLE people ADD COLUMN IF NOT EXISTS password TEXT;`)
}

module.exports = { pool, init }
