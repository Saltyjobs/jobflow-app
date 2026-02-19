const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

class JobFlowDB {
  constructor(dbPath = process.env.DB_PATH || './db/jobflow.db') {
    // Ensure database directory exists
    const dbDir = path.dirname(dbPath);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }

    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    
    this.initializeDatabase();
    this.prepareStatements();
  }

  initializeDatabase() {
    const schemaPath = path.join(__dirname, '../db/schema.sql');
    const schema = fs.readFileSync(schemaPath, 'utf8');
    this.db.exec(schema);
    console.log('Database initialized successfully');
  }

  prepareStatements() {
    // Contractor statements
    this.stmts = {
      // Contractors
      createContractor: this.db.prepare(`
        INSERT INTO contractors (phone_number, business_name, trade_type, service_area_zip, 
          service_radius, services_offered, base_service_fee, hourly_rate, emergency_markup, available_hours)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),
      getContractorByPhone: this.db.prepare('SELECT * FROM contractors WHERE phone_number = ?'),
      updateContractor: this.db.prepare(`
        UPDATE contractors SET business_name = ?, trade_type = ?, service_area_zip = ?, 
          service_radius = ?, services_offered = ?, base_service_fee = ?, hourly_rate = ?, 
          emergency_markup = ?, available_hours = ? WHERE id = ?
      `),
      getContractorsInArea: this.db.prepare(`
        SELECT * FROM contractors WHERE service_area_zip = ? AND is_active = 1
      `),
      getAllContractors: this.db.prepare('SELECT * FROM contractors WHERE is_active = 1'),

      // Customers
      createCustomer: this.db.prepare('INSERT INTO customers (phone_number, name, address, zip_code) VALUES (?, ?, ?, ?)'),
      getCustomerByPhone: this.db.prepare('SELECT * FROM customers WHERE phone_number = ?'),
      updateCustomer: this.db.prepare('UPDATE customers SET name = ?, address = ?, zip_code = ? WHERE id = ?'),

      // Jobs
      createJob: this.db.prepare(`
        INSERT INTO jobs (customer_id, job_uuid, problem_description, service_category, 
          urgency_level, customer_address, customer_zip, estimated_cost_min, estimated_cost_max)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),
      getJobById: this.db.prepare('SELECT * FROM jobs WHERE id = ?'),
      getJobByUuid: this.db.prepare('SELECT * FROM jobs WHERE job_uuid = ?'),
      updateJobStatus: this.db.prepare('UPDATE jobs SET status = ? WHERE id = ?'),
      assignJobToContractor: this.db.prepare('UPDATE jobs SET contractor_id = ? WHERE id = ?'),
      updateJobQuote: this.db.prepare('UPDATE jobs SET final_quote = ? WHERE id = ?'),
      scheduleJob: this.db.prepare('UPDATE jobs SET scheduled_date = ?, scheduled_time = ?, status = ? WHERE id = ?'),
      getJobsByContractor: this.db.prepare(`
        SELECT j.*, c.name as customer_name, c.phone_number as customer_phone 
        FROM jobs j 
        LEFT JOIN customers c ON j.customer_id = c.id 
        WHERE j.contractor_id = ? 
        ORDER BY j.created_at DESC
      `),
      getJobsByStatus: this.db.prepare('SELECT * FROM jobs WHERE status = ?'),

      // Conversations
      createConversation: this.db.prepare('INSERT INTO conversations (phone_number, state, context) VALUES (?, ?, ?)'),
      getConversationByPhone: this.db.prepare('SELECT * FROM conversations WHERE phone_number = ?'),
      updateConversationState: this.db.prepare('UPDATE conversations SET state = ?, context = ? WHERE phone_number = ?'),
      linkConversationToJob: this.db.prepare('UPDATE conversations SET job_id = ? WHERE phone_number = ?'),
      linkConversationToContractor: this.db.prepare('UPDATE conversations SET contractor_id = ? WHERE phone_number = ?'),
      linkConversationToCustomer: this.db.prepare('UPDATE conversations SET customer_id = ? WHERE phone_number = ?'),

      // Messages
      createMessage: this.db.prepare(`
        INSERT INTO messages (from_number, to_number, body, direction, twilio_message_sid, conversation_id)
        VALUES (?, ?, ?, ?, ?, ?)
      `),
      getMessagesByPhone: this.db.prepare('SELECT * FROM messages WHERE from_number = ? OR to_number = ? ORDER BY created_at DESC'),

      // Dashboard Sessions
      createDashboardSession: this.db.prepare(`
        INSERT INTO dashboard_sessions (contractor_id, session_token, verification_code, expires_at)
        VALUES (?, ?, ?, ?)
      `),
      getDashboardSession: this.db.prepare('SELECT * FROM dashboard_sessions WHERE session_token = ?'),
      verifyDashboardSession: this.db.prepare('UPDATE dashboard_sessions SET is_verified = 1 WHERE session_token = ?'),
      deleteDashboardSession: this.db.prepare('DELETE FROM dashboard_sessions WHERE session_token = ?'),
    };
  }

  // Contractor methods
  createContractor(contractorData) {
    try {
      const result = this.stmts.createContractor.run(
        contractorData.phone_number,
        contractorData.business_name,
        contractorData.trade_type,
        contractorData.service_area_zip,
        contractorData.service_radius || 25,
        JSON.stringify(contractorData.services_offered || []),
        contractorData.base_service_fee,
        contractorData.hourly_rate,
        contractorData.emergency_markup || 0.5,
        JSON.stringify(contractorData.available_hours || {})
      );
      return result.lastInsertRowid;
    } catch (error) {
      console.error('Error creating contractor:', error);
      throw error;
    }
  }

  getContractorByPhone(phone) {
    const contractor = this.stmts.getContractorByPhone.get(phone);
    if (contractor) {
      contractor.services_offered = JSON.parse(contractor.services_offered || '[]');
      contractor.available_hours = JSON.parse(contractor.available_hours || '{}');
    }
    return contractor;
  }

  findAvailableContractors(zipCode, serviceCategory) {
    // For now, simple matching by zip code
    // In production, you'd want geographic distance calculation
    return this.stmts.getContractorsInArea.all(zipCode).map(contractor => {
      contractor.services_offered = JSON.parse(contractor.services_offered || '[]');
      contractor.available_hours = JSON.parse(contractor.available_hours || '{}');
      return contractor;
    });
  }

  // Customer methods
  createCustomer(customerData) {
    try {
      const result = this.stmts.createCustomer.run(
        customerData.phone_number,
        customerData.name || null,
        customerData.address || null,
        customerData.zip_code || null
      );
      return result.lastInsertRowid;
    } catch (error) {
      console.error('Error creating customer:', error);
      throw error;
    }
  }

  getCustomerByPhone(phone) {
    return this.stmts.getCustomerByPhone.get(phone);
  }

  // Job methods
  createJob(jobData) {
    try {
      const result = this.stmts.createJob.run(
        jobData.customer_id,
        jobData.job_uuid,
        jobData.problem_description,
        jobData.service_category,
        jobData.urgency_level,
        jobData.customer_address,
        jobData.customer_zip,
        jobData.estimated_cost_min,
        jobData.estimated_cost_max
      );
      return result.lastInsertRowid;
    } catch (error) {
      console.error('Error creating job:', error);
      throw error;
    }
  }

  getJobById(id) {
    return this.stmts.getJobById.get(id);
  }

  getJobByUuid(uuid) {
    return this.stmts.getJobByUuid.get(uuid);
  }

  assignJobToContractor(jobId, contractorId) {
    this.stmts.assignJobToContractor.run(contractorId, jobId);
  }

  updateJobStatus(jobId, status) {
    this.stmts.updateJobStatus.run(status, jobId);
  }

  getJobsByContractor(contractorId) {
    return this.stmts.getJobsByContractor.all(contractorId);
  }

  // Conversation methods
  getOrCreateConversation(phoneNumber) {
    let conversation = this.stmts.getConversationByPhone.get(phoneNumber);
    if (!conversation) {
      this.stmts.createConversation.run(phoneNumber, 'IDLE', '{}');
      conversation = this.stmts.getConversationByPhone.get(phoneNumber);
    }
    if (conversation.context) {
      conversation.context = JSON.parse(conversation.context);
    }
    return conversation;
  }

  updateConversationState(phoneNumber, state, context = {}) {
    this.stmts.updateConversationState.run(state, JSON.stringify(context), phoneNumber);
  }

  // Message methods
  saveMessage(fromNumber, toNumber, body, direction, twilioMessageSid = null) {
    const conversation = this.getOrCreateConversation(direction === 'inbound' ? fromNumber : toNumber);
    return this.stmts.createMessage.run(
      fromNumber,
      toNumber,
      body,
      direction,
      twilioMessageSid,
      conversation.id
    );
  }

  // Dashboard session methods
  createDashboardSession(contractorId, sessionToken, verificationCode, expiresAt) {
    return this.stmts.createDashboardSession.run(contractorId, sessionToken, verificationCode, expiresAt);
  }

  getDashboardSession(sessionToken) {
    return this.stmts.getDashboardSession.get(sessionToken);
  }

  verifyDashboardSession(sessionToken) {
    return this.stmts.verifyDashboardSession.run(sessionToken);
  }

  close() {
    this.db.close();
  }
}

module.exports = new JobFlowDB();