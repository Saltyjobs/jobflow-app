-- JobFlow Database Schema

-- Contractors table
CREATE TABLE IF NOT EXISTS contractors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone_number TEXT UNIQUE NOT NULL,
  business_name TEXT NOT NULL,
  trade_type TEXT NOT NULL, -- plumber, electrician, handyman, etc.
  service_area_zip TEXT NOT NULL,
  service_radius INTEGER NOT NULL DEFAULT 25, -- miles
  services_offered TEXT, -- JSON array of services
  base_service_fee DECIMAL(10,2) NOT NULL,
  hourly_rate DECIMAL(10,2) NOT NULL,
  emergency_markup DECIMAL(5,2) DEFAULT 0.5, -- 50% markup for emergencies
  available_hours TEXT, -- JSON: {"monday": "8-17", "tuesday": "8-17", ...}
  is_active BOOLEAN DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Customers table
CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone_number TEXT UNIQUE NOT NULL,
  name TEXT,
  address TEXT,
  zip_code TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Jobs table
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL,
  contractor_id INTEGER,
  job_uuid TEXT UNIQUE NOT NULL, -- for external references
  problem_description TEXT NOT NULL,
  service_category TEXT, -- plumbing, electrical, general, etc.
  urgency_level TEXT CHECK(urgency_level IN ('low', 'medium', 'high', 'emergency')),
  customer_address TEXT,
  customer_zip TEXT,
  estimated_cost_min DECIMAL(10,2),
  estimated_cost_max DECIMAL(10,2),
  final_quote DECIMAL(10,2),
  status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'quoted', 'approved', 'scheduled', 'in_progress', 'completed', 'cancelled')),
  scheduled_date DATE,
  scheduled_time TIME,
  completion_date DATETIME,
  customer_rating INTEGER CHECK(customer_rating BETWEEN 1 AND 5),
  customer_feedback TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (customer_id) REFERENCES customers (id),
  FOREIGN KEY (contractor_id) REFERENCES contractors (id)
);

-- Conversations table - tracks SMS conversation state
CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone_number TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'IDLE' CHECK(state IN (
    'IDLE', 
    'CONTRACTOR_ONBOARDING', 
    'CUSTOMER_INTAKE', 
    'AWAITING_QUOTE_APPROVAL', 
    'AWAITING_CONTRACTOR_RESPONSE', 
    'JOB_SCHEDULED'
  )),
  context TEXT, -- JSON blob for conversation context
  job_id INTEGER, -- linked job if applicable
  contractor_id INTEGER, -- linked contractor if applicable
  customer_id INTEGER, -- linked customer if applicable
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (job_id) REFERENCES jobs (id),
  FOREIGN KEY (contractor_id) REFERENCES contractors (id),
  FOREIGN KEY (customer_id) REFERENCES customers (id)
);

-- Messages table - stores all SMS messages for audit/history
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_number TEXT NOT NULL,
  to_number TEXT NOT NULL,
  body TEXT NOT NULL,
  direction TEXT NOT NULL CHECK(direction IN ('inbound', 'outbound')),
  twilio_message_sid TEXT,
  conversation_id INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (conversation_id) REFERENCES conversations (id)
);

-- Quotes table - tracks quote history
CREATE TABLE IF NOT EXISTS quotes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL,
  contractor_id INTEGER NOT NULL,
  amount DECIMAL(10,2) NOT NULL,
  notes TEXT,
  status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'accepted', 'rejected', 'expired')),
  expires_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (job_id) REFERENCES jobs (id),
  FOREIGN KEY (contractor_id) REFERENCES contractors (id)
);

-- Dashboard sessions for contractor login
CREATE TABLE IF NOT EXISTS dashboard_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contractor_id INTEGER NOT NULL,
  session_token TEXT UNIQUE NOT NULL,
  verification_code TEXT,
  is_verified BOOLEAN DEFAULT 0,
  expires_at DATETIME NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (contractor_id) REFERENCES contractors (id)
);

-- Indexes for better performance
CREATE INDEX IF NOT EXISTS idx_contractors_phone ON contractors(phone_number);
CREATE INDEX IF NOT EXISTS idx_contractors_zip_active ON contractors(service_area_zip, is_active);
CREATE INDEX IF NOT EXISTS idx_customers_phone ON customers(phone_number);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_contractor ON jobs(contractor_id);
CREATE INDEX IF NOT EXISTS idx_jobs_customer ON jobs(customer_id);
CREATE INDEX IF NOT EXISTS idx_conversations_phone ON conversations(phone_number);
CREATE INDEX IF NOT EXISTS idx_conversations_state ON conversations(state);
CREATE INDEX IF NOT EXISTS idx_messages_numbers ON messages(from_number, to_number);
CREATE INDEX IF NOT EXISTS idx_dashboard_sessions_token ON dashboard_sessions(session_token);

-- Triggers to update updated_at timestamps
CREATE TRIGGER IF NOT EXISTS update_contractors_timestamp 
  AFTER UPDATE ON contractors
  BEGIN
    UPDATE contractors SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
  END;

CREATE TRIGGER IF NOT EXISTS update_customers_timestamp 
  AFTER UPDATE ON customers
  BEGIN
    UPDATE customers SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
  END;

CREATE TRIGGER IF NOT EXISTS update_jobs_timestamp 
  AFTER UPDATE ON jobs
  BEGIN
    UPDATE jobs SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
  END;

CREATE TRIGGER IF NOT EXISTS update_conversations_timestamp 
  AFTER UPDATE ON conversations
  BEGIN
    UPDATE conversations SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
  END;