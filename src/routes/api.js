const express = require('express');
const db = require('../db');
const quoting = require('../quoting');

const router = express.Router();

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