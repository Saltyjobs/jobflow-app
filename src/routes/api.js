const express = require('express');
const db = require('../db');
const quoting = require('../quoting');
const calendar = require('../calendar');

const router = express.Router();

// ---- Google Calendar OAuth routes ----
router.get('/calendar/auth/:contractorId', (req, res) => {
  try {
    const { contractorId } = req.params;
    const contractor = db.getContractorById(parseInt(contractorId));
    if (!contractor) return res.status(404).json({ error: 'Contractor not found' });

    if (!process.env.GOOGLE_CLIENT_ID) {
      return res.status(500).json({ error: 'Google Calendar not configured' });
    }

    const url = calendar.getAuthUrl(contractorId);
    res.redirect(url);
  } catch (error) {
    console.error('Calendar auth error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/calendar/callback', async (req, res) => {
  try {
    const { code, state } = req.query;
    if (!code || !state) return res.status(400).send('Missing code or state');

    const contractorId = parseInt(state);
    const result = await calendar.handleCallback(code, contractorId);
    const contractor = db.getContractorById(contractorId);

    res.send(`
      <!DOCTYPE html><html><body style="font-family:Arial;text-align:center;padding:60px">
        <h1>✅ Calendar Connected!</h1>
        <p>${contractor?.business_name || 'Contractor'} is now linked to <strong>${result.email}</strong></p>
        <p>Jobs you approve will automatically appear on your Google Calendar.</p>
      </body></html>
    `);
  } catch (error) {
    console.error('Calendar callback error:', error);
    res.status(500).send(`
      <!DOCTYPE html><html><body style="font-family:Arial;text-align:center;padding:60px">
        <h1>❌ Connection Failed</h1>
        <p>${error.message}</p>
      </body></html>
    `);
  }
});

router.get('/calendar/status/:contractorId', (req, res) => {
  try {
    const tokens = db.getCalendarTokens(parseInt(req.params.contractorId));
    res.json({
      connected: !!tokens,
      email: tokens?.google_email || null,
      connectedAt: tokens?.created_at || null,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ---- Smart Scheduling ----
router.get('/jobs/:jobId/suggest-times', async (req, res) => {
  try {
    const job = db.getJobById(parseInt(req.params.jobId));
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (!job.contractor_id) return res.status(400).json({ error: 'No contractor assigned' });

    const slots = await calendar.getAvailableSlots(job.contractor_id, 2, job.customer_zip);
    res.json({ slots, jobId: job.id });
  } catch (error) {
    console.error('Suggest times error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get system statistics (for admin/monitoring)
router.get('/stats', (req, res) => {
  try {
    const stats = {
      contractors: {
        total: db.db.prepare('SELECT COUNT(*) as count FROM contractors').get().count,
        active: db.db.prepare('SELECT COUNT(*) as count FROM contractors WHERE is_active = 1').get().count,
        byTrade: db.db.prepare(`
          SELECT trade_type, COUNT(*) as count 
          FROM contractors WHERE is_active = 1 
          GROUP BY trade_type 
          ORDER BY count DESC
        `).all()
      },
      customers: {
        total: db.db.prepare('SELECT COUNT(*) as count FROM customers').get().count
      },
      jobs: {
        total: db.db.prepare('SELECT COUNT(*) as count FROM jobs').get().count,
        byStatus: db.db.prepare(`
          SELECT status, COUNT(*) as count 
          FROM jobs 
          GROUP BY status 
          ORDER BY count DESC
        `).all(),
        thisMonth: db.db.prepare(`
          SELECT COUNT(*) as count 
          FROM jobs 
          WHERE created_at >= date('now', 'start of month')
        `).get().count
      },
      messages: {
        total: db.db.prepare('SELECT COUNT(*) as count FROM messages').get().count,
        today: db.db.prepare(`
          SELECT COUNT(*) as count 
          FROM messages 
          WHERE DATE(created_at) = DATE('now')
        `).get().count
      }
    };

    res.json(stats);
  } catch (error) {
    console.error('Error getting stats:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Contractor responds to a job (A=approve, X=pass, Q $amt=custom quote)
router.post('/jobs/:jobId/respond', async (req, res) => {
  try {
    const { jobId } = req.params;
    const { action, amount, scheduled_date, scheduled_time } = req.body;
    const sms = require('../sms');
    
    const job = db.getJobById(jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    
    const customer = db.queryGet('SELECT * FROM customers WHERE id = ?', [job.customer_id]);
    const contractor = db.getContractorById(job.contractor_id);
    
    if (action === 'A' || action === 'approve') {
      db.updateJobStatus(jobId, 'approved');
      
      // If schedule provided, set it
      if (scheduled_date) {
        db.queryRun('UPDATE jobs SET scheduled_date = ?, scheduled_time = ?, status = ? WHERE id = ?', 
          [scheduled_date, scheduled_time || 'TBD', 'scheduled', jobId]);
      }
      
      const scheduleInfo = scheduled_date ? `\n📅 Date: ${scheduled_date}\n⏰ Time: ${scheduled_time || 'TBD'}` : '\nThey will contact you shortly to schedule.';
      
      // Notify customer via WhatsApp/SMS
      const customerMsg = `✅ Great news! ${contractor.business_name} has accepted your job!\n${scheduleInfo}\n\nContractor: ${contractor.business_name}\nEstimate: $${job.estimated_cost_min}-$${job.estimated_cost_max}\n\nThey'll reach out to confirm details. Reply CANCEL anytime to cancel.`;
      
      try {
        await sms.sendSMS(customer.phone_number, customerMsg);
      } catch (e) { console.error('Failed to notify customer:', e.message); }
      
      // Auto-create Google Calendar event if connected and scheduled
      let calendarEvent = null;
      if (scheduled_date) {
        try {
          const updatedJob = db.getJobById(jobId);
          calendarEvent = await calendar.createCalendarEvent(job.contractor_id, updatedJob, customer);
        } catch (e) { console.error('Failed to create calendar event:', e.message); }
      }
      
      res.json({ success: true, message: 'Job approved, customer notified', customerMsg, calendarEvent: calendarEvent?.htmlLink || null });
    } else if (action === 'X' || action === 'pass') {
      db.updateJobStatus(jobId, 'cancelled');
      res.json({ success: true, message: 'Job passed' });
    } else if (action === 'Q' || action === 'quote') {
      db.queryRun('UPDATE jobs SET final_quote = ? WHERE id = ?', [amount, jobId]);
      
      const customerMsg = `💰 ${contractor.business_name} sent you a custom quote: $${amount}\n\nReply YES to accept or NO to decline.`;
      try {
        await sms.sendSMS(customer.phone_number, customerMsg);
      } catch (e) { console.error('Failed to notify customer:', e.message); }
      
      res.json({ success: true, message: 'Custom quote sent', customerMsg });
    } else {
      res.status(400).json({ error: 'Invalid action. Use: approve, pass, or quote' });
    }
  } catch (error) {
    console.error('Error responding to job:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get recent jobs (for contractor notifications)
router.get('/jobs/recent', (req, res) => {
  try {
    const jobs = db.queryAll("SELECT j.*, c.business_name as contractor_name FROM jobs j LEFT JOIN contractors c ON j.contractor_id = c.id ORDER BY j.created_at DESC LIMIT 10");
    res.json({ jobs });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Add contractor
router.post('/contractors', (req, res) => {
  try {
    const result = db.createContractor(req.body);
    res.json({ success: true, message: 'Contractor added', id: result });
  } catch (error) {
    console.error('Error adding contractor:', error);
    res.status(500).json({ error: error.message });
  }
});

// Search contractors
router.get('/contractors/search', (req, res) => {
  try {
    const { zip, trade, radius } = req.query;
    
    let query = 'SELECT * FROM contractors WHERE is_active = 1';
    const params = [];
    
    if (zip) {
      query += ' AND service_area_zip = ?';
      params.push(zip);
    }
    
    if (trade) {
      query += ' AND trade_type LIKE ?';
      params.push(`%${trade}%`);
    }
    
    query += ' ORDER BY created_at DESC LIMIT 50';
    
    const contractors = db.db.prepare(query).all(...params);
    
    // Parse JSON fields
    const formattedContractors = contractors.map(contractor => ({
      ...contractor,
      services_offered: JSON.parse(contractor.services_offered || '[]'),
      available_hours: JSON.parse(contractor.available_hours || '{}')
    }));

    res.json({ contractors: formattedContractors });
  } catch (error) {
    console.error('Error searching contractors:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get job history for analytics
router.get('/jobs/analytics', (req, res) => {
  try {
    const { startDate, endDate, contractorId } = req.query;
    
    let baseQuery = `
      SELECT j.*, c.name as customer_name, cont.business_name as contractor_name
      FROM jobs j
      LEFT JOIN customers c ON j.customer_id = c.id
      LEFT JOIN contractors cont ON j.contractor_id = cont.id
      WHERE 1=1
    `;
    
    const params = [];
    
    if (startDate) {
      baseQuery += ' AND j.created_at >= ?';
      params.push(startDate);
    }
    
    if (endDate) {
      baseQuery += ' AND j.created_at <= ?';
      params.push(endDate + ' 23:59:59');
    }
    
    if (contractorId) {
      baseQuery += ' AND j.contractor_id = ?';
      params.push(contractorId);
    }
    
    baseQuery += ' ORDER BY j.created_at DESC LIMIT 1000';
    
    const jobs = db.db.prepare(baseQuery).all(...params);
    
    // Calculate analytics
    const analytics = {
      totalJobs: jobs.length,
      completedJobs: jobs.filter(j => j.status === 'completed').length,
      averageJobValue: calculateAverageJobValue(jobs),
      completionRate: jobs.length > 0 ? (jobs.filter(j => j.status === 'completed').length / jobs.length * 100).toFixed(1) : 0,
      averageRating: calculateOverallAverageRating(jobs),
      jobsByCategory: groupJobsByCategory(jobs),
      jobsByUrgency: groupJobsByUrgency(jobs),
      monthlyTrends: calculateMonthlyTrends(jobs)
    };

    res.json({
      jobs: jobs.slice(0, 100), // Return first 100 jobs for details
      analytics
    });
  } catch (error) {
    console.error('Error getting job analytics:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Generate quote estimate for external use
router.post('/quote/estimate', (req, res) => {
  try {
    const { 
      serviceCategory, 
      problemDescription, 
      urgencyLevel, 
      zipCode,
      contractorId 
    } = req.body;

    if (!serviceCategory || !problemDescription || !zipCode) {
      return res.status(400).json({ 
        error: 'Service category, problem description, and zip code are required' 
      });
    }

    const jobDetails = {
      service_category: serviceCategory,
      problem_description: problemDescription,
      urgency_level: urgencyLevel || 'medium',
      customer_zip: zipCode
    };

    let contractor;
    
    if (contractorId) {
      contractor = db.db.prepare('SELECT * FROM contractors WHERE id = ? AND is_active = 1').get(contractorId);
    } else {
      // Find best available contractor
      const availableContractors = db.findAvailableContractors(zipCode, serviceCategory);
      if (availableContractors.length > 0) {
        const bestMatch = quoting.findBestContractor(jobDetails, availableContractors);
        contractor = bestMatch?.contractor;
      }
    }

    if (!contractor) {
      return res.status(404).json({ 
        error: 'No contractors available in the specified area' 
      });
    }

    const quote = quoting.generateQuote(jobDetails, contractor);
    
    res.json({
      quote: {
        minCost: quote.minCost,
        maxCost: quote.maxCost,
        averageCost: quote.averageCost,
        description: quote.breakdown.description
      },
      contractor: {
        businessName: contractor.business_name,
        tradeType: contractor.trade_type,
        serviceArea: contractor.service_area_zip
      }
    });

  } catch (error) {
    console.error('Error generating quote estimate:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get conversation history for a phone number
router.get('/conversations/:phoneNumber', (req, res) => {
  try {
    const { phoneNumber } = req.params;
    const { limit = 50, offset = 0 } = req.query;

    const messages = db.db.prepare(`
      SELECT * FROM messages 
      WHERE from_number = ? OR to_number = ? 
      ORDER BY created_at DESC 
      LIMIT ? OFFSET ?
    `).all(phoneNumber, phoneNumber, parseInt(limit), parseInt(offset));

    const conversation = db.getOrCreateConversation(phoneNumber);

    res.json({
      conversation: {
        phoneNumber,
        currentState: conversation.state,
        context: conversation.context
      },
      messages: messages.reverse() // Show chronological order
    });

  } catch (error) {
    console.error('Error getting conversation history:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update contractor availability
router.post('/contractors/:contractorId/availability', (req, res) => {
  try {
    const { contractorId } = req.params;
    const { availableHours, isActive } = req.body;

    // Verify contractor exists
    const contractor = db.db.prepare('SELECT * FROM contractors WHERE id = ?').get(contractorId);
    if (!contractor) {
      return res.status(404).json({ error: 'Contractor not found' });
    }

    // Update availability
    const updateStmt = db.db.prepare('UPDATE contractors SET available_hours = ?, is_active = ? WHERE id = ?');
    updateStmt.run(
      JSON.stringify(availableHours || {}),
      isActive !== undefined ? isActive : contractor.is_active,
      contractorId
    );

    res.json({ success: true, message: 'Availability updated' });

  } catch (error) {
    console.error('Error updating availability:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get service categories and their pricing
router.get('/services', (req, res) => {
  try {
    // Get categories from active contractors
    const categories = db.db.prepare(`
      SELECT DISTINCT trade_type, COUNT(*) as contractor_count,
             AVG(base_service_fee) as avg_service_fee,
             AVG(hourly_rate) as avg_hourly_rate
      FROM contractors 
      WHERE is_active = 1 
      GROUP BY trade_type
      ORDER BY contractor_count DESC
    `).all();

    // Get service offerings
    const serviceOfferings = db.db.prepare(`
      SELECT services_offered 
      FROM contractors 
      WHERE is_active = 1 AND services_offered IS NOT NULL
    `).all();

    // Parse and aggregate services
    const allServices = [];
    serviceOfferings.forEach(row => {
      try {
        const services = JSON.parse(row.services_offered);
        allServices.push(...services);
      } catch (e) {
        // Skip invalid JSON
      }
    });

    // Count service frequencies
    const serviceCounts = {};
    allServices.forEach(service => {
      const normalizedService = service.toLowerCase().trim();
      serviceCounts[normalizedService] = (serviceCounts[normalizedService] || 0) + 1;
    });

    const popularServices = Object.entries(serviceCounts)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 20)
      .map(([service, count]) => ({ service, count }));

    res.json({
      categories,
      popularServices,
      totalContractors: categories.reduce((sum, cat) => sum + cat.contractor_count, 0)
    });

  } catch (error) {
    console.error('Error getting services:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Bulk message sending (for admin notifications)
router.post('/messages/broadcast', (req, res) => {
  try {
    const { targetType, message, filter } = req.body;

    if (!targetType || !message) {
      return res.status(400).json({ error: 'Target type and message are required' });
    }

    let targets = [];

    if (targetType === 'contractors') {
      let query = 'SELECT phone_number FROM contractors WHERE is_active = 1';
      const params = [];

      if (filter?.tradeType) {
        query += ' AND trade_type = ?';
        params.push(filter.tradeType);
      }

      if (filter?.zipCode) {
        query += ' AND service_area_zip = ?';
        params.push(filter.zipCode);
      }

      targets = db.db.prepare(query).all(...params).map(row => ({
        phoneNumber: row.phone_number,
        message
      }));

    } else if (targetType === 'customers') {
      const customerQuery = 'SELECT DISTINCT phone_number FROM customers LIMIT 1000'; // Limit for safety
      targets = db.db.prepare(customerQuery).all().map(row => ({
        phoneNumber: row.phone_number,
        message
      }));
    }

    if (targets.length === 0) {
      return res.status(400).json({ error: 'No targets found' });
    }

    // In production, you'd want to queue this rather than send immediately
    if (targets.length > 100) {
      return res.status(400).json({ 
        error: 'Too many targets. This endpoint supports up to 100 recipients at once.' 
      });
    }

    // Send messages
    const sms = require('../sms');
    sms.sendBulkSMS(targets).then(results => {
      const successful = results.filter(r => r.success).length;
      const failed = results.filter(r => !r.success).length;
      
      console.log(`Broadcast complete: ${successful} sent, ${failed} failed`);
    });

    res.json({ 
      success: true, 
      message: `Broadcast queued for ${targets.length} recipients`,
      targetCount: targets.length
    });

  } catch (error) {
    console.error('Error broadcasting messages:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Utility functions
function calculateAverageJobValue(jobs) {
  const jobsWithValues = jobs.filter(job => job.final_quote || job.estimated_cost_min);
  if (jobsWithValues.length === 0) return 0;
  
  const total = jobsWithValues.reduce((sum, job) => {
    return sum + (job.final_quote || job.estimated_cost_min || 0);
  }, 0);
  
  return (total / jobsWithValues.length).toFixed(2);
}

function calculateOverallAverageRating(jobs) {
  const ratedJobs = jobs.filter(job => job.customer_rating);
  if (ratedJobs.length === 0) return null;
  
  const total = ratedJobs.reduce((sum, job) => sum + job.customer_rating, 0);
  return (total / ratedJobs.length).toFixed(1);
}

function groupJobsByCategory(jobs) {
  const categories = {};
  jobs.forEach(job => {
    const category = job.service_category || 'unknown';
    categories[category] = (categories[category] || 0) + 1;
  });
  return categories;
}

function groupJobsByUrgency(jobs) {
  const urgency = {};
  jobs.forEach(job => {
    const level = job.urgency_level || 'unknown';
    urgency[level] = (urgency[level] || 0) + 1;
  });
  return urgency;
}

function calculateMonthlyTrends(jobs) {
  const months = {};
  jobs.forEach(job => {
    const date = new Date(job.created_at);
    const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
    months[monthKey] = (months[monthKey] || 0) + 1;
  });
  
  return Object.entries(months)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, count]) => ({ month, count }));
}

module.exports = router;