const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

let db;
const DB_PATH = process.env.DB_PATH || './db/jobflow.db';

function saveDb() {
  const data = db.export();
  const buffer = Buffer.from(data);
  const dbDir = path.dirname(DB_PATH);
  if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
  fs.writeFileSync(DB_PATH, buffer);
}

async function initDb() {
  const SQL = await initSqlJs();
  const dbDir = path.dirname(DB_PATH);
  if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

  if (fs.existsSync(DB_PATH)) {
    const fileBuffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(fileBuffer);
  } else {
    db = new SQL.Database();
  }

  // Create tables
  db.run(`
    CREATE TABLE IF NOT EXISTS contractors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone_number TEXT UNIQUE NOT NULL,
      business_name TEXT,
      trade_type TEXT,
      service_area_zip TEXT,
      service_radius INTEGER DEFAULT 25,
      services_offered TEXT DEFAULT '[]',
      base_service_fee REAL DEFAULT 0,
      hourly_rate REAL DEFAULT 0,
      emergency_markup REAL DEFAULT 0.5,
      available_hours TEXT DEFAULT '{}',
      is_active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS customers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone_number TEXT UNIQUE NOT NULL,
      name TEXT,
      address TEXT,
      zip_code TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_uuid TEXT UNIQUE NOT NULL,
      customer_id INTEGER,
      contractor_id INTEGER,
      problem_description TEXT,
      service_category TEXT,
      urgency_level TEXT DEFAULT 'standard',
      customer_address TEXT,
      customer_zip TEXT,
      estimated_cost_min REAL,
      estimated_cost_max REAL,
      final_quote REAL,
      status TEXT DEFAULT 'pending',
      scheduled_date TEXT,
      scheduled_time TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (customer_id) REFERENCES customers(id),
      FOREIGN KEY (contractor_id) REFERENCES contractors(id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone_number TEXT UNIQUE NOT NULL,
      state TEXT DEFAULT 'IDLE',
      context TEXT DEFAULT '{}',
      job_id INTEGER,
      contractor_id INTEGER,
      customer_id INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_number TEXT,
      to_number TEXT,
      body TEXT,
      direction TEXT,
      twilio_message_sid TEXT,
      conversation_id INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS chat_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone_number TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS contractor_calendar (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contractor_id INTEGER NOT NULL,
      google_email TEXT,
      access_token TEXT,
      refresh_token TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (contractor_id) REFERENCES contractors(id)
    )
  `);

  saveDb();
  console.log('Database initialized successfully');
  return db;
}

// Helper: run a query and return all rows
function all(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

// Helper: get one row
function get(sql, params = []) {
  const rows = all(sql, params);
  return rows[0] || null;
}

// Helper: run insert/update and return lastInsertRowid
function run(sql, params = []) {
  db.run(sql, params);
  const result = get('SELECT last_insert_rowid() as id');
  saveDb();
  return result ? result.id : null;
}

// ---- Contractor methods ----
function createContractor(data) {
  return run(
    `INSERT INTO contractors (phone_number, business_name, trade_type, service_area_zip, 
      service_radius, services_offered, base_service_fee, hourly_rate, emergency_markup, available_hours)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [data.phone_number, data.business_name, data.trade_type, data.service_area_zip,
     data.service_radius || 25, JSON.stringify(data.services_offered || []),
     data.base_service_fee, data.hourly_rate, data.emergency_markup || 0.5,
     JSON.stringify(data.available_hours || {})]
  );
}

function getContractorById(id) {
  const c = get('SELECT * FROM contractors WHERE id = ?', [id]);
  if (c) {
    c.services_offered = JSON.parse(c.services_offered || '[]');
    c.available_hours = JSON.parse(c.available_hours || '{}');
  }
  return c;
}

function getContractorByPhone(phone) {
  const c = get('SELECT * FROM contractors WHERE phone_number = ?', [phone]);
  if (c) {
    c.services_offered = JSON.parse(c.services_offered || '[]');
    c.available_hours = JSON.parse(c.available_hours || '{}');
  }
  return c;
}

function findAvailableContractors(zipCode) {
  return all('SELECT * FROM contractors WHERE service_area_zip = ? AND is_active = 1', [zipCode])
    .map(c => {
      c.services_offered = JSON.parse(c.services_offered || '[]');
      c.available_hours = JSON.parse(c.available_hours || '{}');
      return c;
    });
}

function getAllContractors() {
  return all('SELECT * FROM contractors WHERE is_active = 1')
    .map(c => {
      c.services_offered = JSON.parse(c.services_offered || '[]');
      c.available_hours = JSON.parse(c.available_hours || '{}');
      return c;
    });
}

// ---- Customer methods ----
function createCustomer(data) {
  return run(
    'INSERT INTO customers (phone_number, name, address, zip_code) VALUES (?, ?, ?, ?)',
    [data.phone_number, data.name || null, data.address || null, data.zip_code || null]
  );
}

function getCustomerByPhone(phone) {
  return get('SELECT * FROM customers WHERE phone_number = ?', [phone]);
}

// ---- Job methods ----
function createJob(data) {
  return run(
    `INSERT INTO jobs (customer_id, job_uuid, problem_description, service_category, 
      urgency_level, customer_address, customer_zip, estimated_cost_min, estimated_cost_max)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [data.customer_id, data.job_uuid, data.problem_description, data.service_category,
     data.urgency_level, data.customer_address, data.customer_zip,
     data.estimated_cost_min, data.estimated_cost_max]
  );
}

function getJobById(id) { return get('SELECT * FROM jobs WHERE id = ?', [id]); }
function getJobByUuid(uuid) { return get('SELECT * FROM jobs WHERE job_uuid = ?', [uuid]); }

function updateJobStatus(jobId, status) {
  run('UPDATE jobs SET status = ? WHERE id = ?', [status, jobId]);
}

function assignJobToContractor(jobId, contractorId) {
  run('UPDATE jobs SET contractor_id = ? WHERE id = ?', [contractorId, jobId]);
}

function updateJobQuote(jobId, quote) {
  run('UPDATE jobs SET final_quote = ? WHERE id = ?', [quote, jobId]);
}

function scheduleJob(jobId, date, time, status = 'scheduled') {
  run('UPDATE jobs SET scheduled_date = ?, scheduled_time = ?, status = ? WHERE id = ?', [date, time, status, jobId]);
}

function getJobsByContractor(contractorId) {
  return all(
    `SELECT j.*, c.name as customer_name, c.phone_number as customer_phone 
     FROM jobs j LEFT JOIN customers c ON j.customer_id = c.id 
     WHERE j.contractor_id = ? ORDER BY j.created_at DESC`, [contractorId]
  );
}

// ---- Conversation methods ----
function getOrCreateConversation(phoneNumber) {
  let conv = get('SELECT * FROM conversations WHERE phone_number = ?', [phoneNumber]);
  if (!conv) {
    run('INSERT INTO conversations (phone_number, state, context) VALUES (?, ?, ?)', [phoneNumber, 'IDLE', '{}']);
    conv = get('SELECT * FROM conversations WHERE phone_number = ?', [phoneNumber]);
  }
  if (conv && conv.context) conv.context = JSON.parse(conv.context);
  return conv;
}

function updateConversationState(phoneNumber, state, context = {}) {
  run('UPDATE conversations SET state = ?, context = ?, updated_at = CURRENT_TIMESTAMP WHERE phone_number = ?',
    [state, JSON.stringify(context), phoneNumber]);
}

// ---- Message methods ----
function saveMessage(fromNumber, toNumber, body, direction, twilioMessageSid = null) {
  const conv = getOrCreateConversation(direction === 'inbound' ? fromNumber : toNumber);
  return run(
    `INSERT INTO messages (from_number, to_number, body, direction, twilio_message_sid, conversation_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [fromNumber, toNumber, body, direction, twilioMessageSid, conv.id]
  );
}

function getMessagesByPhone(phone) {
  return all('SELECT * FROM messages WHERE from_number = ? OR to_number = ? ORDER BY created_at DESC', [phone, phone]);
}

// ---- Chat message methods (for AI conversation history) ----
function saveChatMessage(phone, role, content) {
  return run(
    'INSERT INTO chat_messages (phone_number, role, content) VALUES (?, ?, ?)',
    [phone, role, content]
  );
}

function getRecentChatMessages(phone, limit = 20) {
  return all(
    'SELECT role, content, created_at FROM chat_messages WHERE phone_number = ? ORDER BY created_at DESC LIMIT ?',
    [phone, limit]
  ).reverse();
}

function getCustomerJobs(customerId) {
  return all(
    'SELECT * FROM jobs WHERE customer_id = ? ORDER BY created_at DESC',
    [customerId]
  );
}

// ---- Calendar token methods ----
function saveCalendarTokens(data) {
  return run(
    'INSERT INTO contractor_calendar (contractor_id, google_email, access_token, refresh_token) VALUES (?, ?, ?, ?)',
    [data.contractor_id, data.google_email, data.access_token, data.refresh_token]
  );
}

function getCalendarTokens(contractorId) {
  return get('SELECT * FROM contractor_calendar WHERE contractor_id = ?', [contractorId]);
}

function updateCalendarTokens(contractorId, data) {
  run(
    'UPDATE contractor_calendar SET google_email = ?, access_token = ?, refresh_token = ?, updated_at = CURRENT_TIMESTAMP WHERE contractor_id = ?',
    [data.google_email, data.access_token, data.refresh_token, contractorId]
  );
}

// Raw query helpers for routes that need them
function queryGet(sql, params = []) { return get(sql, params); }
function queryAll(sql, params = []) { return all(sql, params); }
function queryRun(sql, params = []) { return run(sql, params); }

// Compatibility shim — mimics better-sqlite3 db.prepare().get/run/all interface
const dbProxy = {
  prepare(sql) {
    return {
      get(...params) { return get(sql, params); },
      run(...params) { run(sql, params); return { changes: 1 }; },
      all(...params) { return all(sql, params); },
    };
  }
};

// Prepared statement shims
const stmts = {
  getContractorByPhone: { get(phone) { return getContractorByPhone(phone); } },
  getJobById: { get(id) { return getJobById(id); } },
  getJobsByStatus: { all(status) { return all('SELECT * FROM jobs WHERE status = ?', [status]); } },
  updateJobStatus: { run(status, id) { run('UPDATE jobs SET status = ? WHERE id = ?', [status, id]); } },
  updateJobQuote: { run(quote, id) { run('UPDATE jobs SET final_quote = ? WHERE id = ?', [quote, id]); } },
  scheduleJob: { run(date, time, status, id) { scheduleJob(id, date, time, status); } },
};

module.exports = {
  initDb,
  createContractor, getContractorById, getContractorByPhone, findAvailableContractors, getAllContractors,
  createCustomer, getCustomerByPhone,
  createJob, getJobById, getJobByUuid, updateJobStatus, assignJobToContractor, updateJobQuote, scheduleJob, getJobsByContractor,
  saveCalendarTokens, getCalendarTokens, updateCalendarTokens,
  getOrCreateConversation, updateConversationState,
  saveMessage, getMessagesByPhone,
  saveChatMessage, getRecentChatMessages, getCustomerJobs,
  queryGet, queryAll, queryRun,
  db: dbProxy,
  stmts,
  close() { if (db) { saveDb(); } },
};
