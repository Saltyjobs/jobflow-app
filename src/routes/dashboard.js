const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const sms = require('../sms');
const path = require('path');

const router = express.Router();

// Dashboard home - serves the HTML interface
router.get('/', (req, res) => {
  const { phone, session } = req.query;
  
  if (!phone && !session) {
    return res.status(400).send('Phone number or session required');
  }

  // Serve the dashboard HTML
  res.sendFile(path.join(__dirname, '../../public/dashboard.html'));
});

// Initiate login via SMS verification
router.post('/login', async (req, res) => {
  try {
    const { phoneNumber } = req.body;
    
    if (!phoneNumber) {
      return res.status(400).json({ error: 'Phone number is required' });
    }

    const formattedPhone = sms.formatPhoneNumber(phoneNumber);
    
    // Check if contractor exists
    const contractor = db.getContractorByPhone(formattedPhone);
    if (!contractor) {
      return res.status(404).json({ error: 'Contractor not found. Text SETUP to get started.' });
    }

    // Generate session token and verification code
    const sessionToken = uuidv4();
    const verificationCode = Math.floor(100000 + Math.random() * 900000).toString(); // 6-digit code
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes

    // Save session
    db.createDashboardSession(contractor.id, sessionToken, verificationCode, expiresAt.toISOString());

    // Send verification code via SMS
    await sms.sendVerificationCode(formattedPhone, verificationCode);

    res.json({ 
      success: true, 
      sessionToken,
      message: 'Verification code sent to your phone'
    });

  } catch (error) {
    console.error('Error initiating login:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Verify SMS code and complete login
router.post('/verify', async (req, res) => {
  try {
    const { sessionToken, verificationCode } = req.body;
    
    if (!sessionToken || !verificationCode) {
      return res.status(400).json({ error: 'Session token and verification code are required' });
    }

    const session = db.getDashboardSession(sessionToken);
    
    if (!session) {
      return res.status(404).json({ error: 'Invalid session' });
    }

    if (new Date() > new Date(session.expires_at)) {
      return res.status(400).json({ error: 'Session expired' });
    }

    if (session.verification_code !== verificationCode) {
      return res.status(400).json({ error: 'Invalid verification code' });
    }

    // Mark session as verified
    db.verifyDashboardSession(sessionToken);

    // Get contractor info
    const contractor = db.db.prepare('SELECT * FROM contractors WHERE id = ?').get(session.contractor_id);

    res.json({ 
      success: true,
      contractor: {
        id: contractor.id,
        businessName: contractor.business_name,
        tradeType: contractor.trade_type,
        phoneNumber: contractor.phone_number
      }
    });

  } catch (error) {
    console.error('Error verifying login:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Middleware to verify session
const verifySession = (req, res, next) => {
  const sessionToken = req.headers.authorization?.replace('Bearer ', '');
  
  if (!sessionToken) {
    return res.status(401).json({ error: 'No session token provided' });
  }

  const session = db.getDashboardSession(sessionToken);
  
  if (!session || !session.is_verified || new Date() > new Date(session.expires_at)) {
    return res.status(401).json({ error: 'Invalid or expired session' });
  }

  req.contractorId = session.contractor_id;
  req.sessionToken = sessionToken;
  next();
};

// Get contractor dashboard data
router.get('/data', verifySession, async (req, res) => {
  try {
    const contractorId = req.contractorId;
    
    // Get contractor info
    const contractor = db.db.prepare('SELECT * FROM contractors WHERE id = ?').get(contractorId);
    
    // Get jobs with different statuses
    const allJobs = db.getJobsByContractor(contractorId);
    
    const jobs = {
      pending: allJobs.filter(job => job.status === 'quoted'),
      scheduled: allJobs.filter(job => job.status === 'scheduled'),
      inProgress: allJobs.filter(job => job.status === 'in_progress'),
      completed: allJobs.filter(job => job.status === 'completed'),
      total: allJobs.length
    };

    // Calculate statistics
    const stats = {
      totalJobs: jobs.total,
      pendingRequests: jobs.pending.length,
      scheduledJobs: jobs.scheduled.length,
      completedThisMonth: jobs.completed.filter(job => {
        const completionDate = new Date(job.completion_date || 0);
        const thisMonth = new Date();
        return completionDate.getMonth() === thisMonth.getMonth() && 
               completionDate.getFullYear() === thisMonth.getFullYear();
      }).length,
      averageRating: calculateAverageRating(jobs.completed)
    };

    res.json({
      contractor: {
        id: contractor.id,
        businessName: contractor.business_name,
        tradeType: contractor.trade_type,
        serviceArea: contractor.service_area_zip,
        phoneNumber: contractor.phone_number,
        isActive: contractor.is_active
      },
      jobs,
      stats
    });

  } catch (error) {
    console.error('Error getting dashboard data:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get specific job details
router.get('/jobs/:jobId', verifySession, (req, res) => {
  try {
    const { jobId } = req.params;
    const contractorId = req.contractorId;
    
    const job = db.db.prepare(`
      SELECT j.*, c.name as customer_name, c.phone_number as customer_phone, c.address as customer_full_address
      FROM jobs j
      LEFT JOIN customers c ON j.customer_id = c.id
      WHERE j.id = ? AND j.contractor_id = ?
    `).get(jobId, contractorId);

    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    res.json({ job });

  } catch (error) {
    console.error('Error getting job details:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update job status
router.post('/jobs/:jobId/status', verifySession, async (req, res) => {
  try {
    const { jobId } = req.params;
    const { status, notes } = req.body;
    const contractorId = req.contractorId;

    // Verify job belongs to this contractor
    const job = db.db.prepare('SELECT * FROM jobs WHERE id = ? AND contractor_id = ?').get(jobId, contractorId);
    
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    const validStatuses = ['quoted', 'approved', 'scheduled', 'in_progress', 'completed', 'cancelled'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }

    // Update job status
    db.updateJobStatus(jobId, status);

    // Add notes if provided
    if (notes) {
      db.db.prepare('UPDATE jobs SET notes = ? WHERE id = ?').run(notes, jobId);
    }

    // Handle status-specific actions
    await handleJobStatusChange(jobId, status, contractorId);

    res.json({ success: true, message: `Job status updated to ${status}` });

  } catch (error) {
    console.error('Error updating job status:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Schedule a job
router.post('/jobs/:jobId/schedule', verifySession, async (req, res) => {
  try {
    const { jobId } = req.params;
    const { date, time, notes } = req.body;
    const contractorId = req.contractorId;

    if (!date) {
      return res.status(400).json({ error: 'Date is required' });
    }

    // Verify job belongs to this contractor
    const job = db.db.prepare('SELECT * FROM jobs WHERE id = ? AND contractor_id = ?').get(jobId, contractorId);
    
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    const scheduler = require('../scheduler');
    const result = scheduler.scheduleJob(jobId, contractorId, date, time, notes);

    if (result.success) {
      res.json({ success: true, message: 'Job scheduled successfully' });
    } else {
      res.status(400).json({ error: result.error });
    }

  } catch (error) {
    console.error('Error scheduling job:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update contractor profile
router.post('/profile', verifySession, async (req, res) => {
  try {
    const contractorId = req.contractorId;
    const { 
      businessName, 
      tradeType, 
      serviceAreaZip, 
      serviceRadius,
      servicesOffered,
      baseServiceFee, 
      hourlyRate, 
      emergencyMarkup,
      availableHours 
    } = req.body;

    // Update contractor record
    const updateStmt = db.db.prepare(`
      UPDATE contractors 
      SET business_name = ?, trade_type = ?, service_area_zip = ?, service_radius = ?,
          services_offered = ?, base_service_fee = ?, hourly_rate = ?, 
          emergency_markup = ?, available_hours = ?
      WHERE id = ?
    `);

    updateStmt.run(
      businessName,
      tradeType,
      serviceAreaZip,
      serviceRadius || 25,
      JSON.stringify(servicesOffered || []),
      baseServiceFee,
      hourlyRate,
      emergencyMarkup || 0.5,
      JSON.stringify(availableHours || {}),
      contractorId
    );

    res.json({ success: true, message: 'Profile updated successfully' });

  } catch (error) {
    console.error('Error updating profile:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get contractor availability
router.get('/availability', verifySession, (req, res) => {
  try {
    const contractorId = req.contractorId;
    const { startDate, endDate } = req.query;
    
    if (!startDate || !endDate) {
      return res.status(400).json({ error: 'Start date and end date are required' });
    }

    const scheduler = require('../scheduler');
    const availability = scheduler.getContractorAvailability(contractorId, startDate, endDate);

    res.json({ availability });

  } catch (error) {
    console.error('Error getting availability:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Send custom message to customer
router.post('/jobs/:jobId/message', verifySession, async (req, res) => {
  try {
    const { jobId } = req.params;
    const { message } = req.body;
    const contractorId = req.contractorId;

    if (!message || !message.trim()) {
      return res.status(400).json({ error: 'Message is required' });
    }

    // Verify job and get customer info
    const job = db.db.prepare(`
      SELECT j.*, c.phone_number as customer_phone
      FROM jobs j
      LEFT JOIN customers c ON j.customer_id = c.id
      WHERE j.id = ? AND j.contractor_id = ?
    `).get(jobId, contractorId);

    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    // Get contractor info for message context
    const contractor = db.db.prepare('SELECT business_name FROM contractors WHERE id = ?').get(contractorId);
    
    const fullMessage = `Message from ${contractor.business_name}:\n\n${message}`;
    
    const result = await sms.sendSMS(job.customer_phone, fullMessage);

    if (result.success) {
      res.json({ success: true, message: 'Message sent to customer' });
    } else {
      res.status(400).json({ error: result.error });
    }

  } catch (error) {
    console.error('Error sending message:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Logout - invalidate session
router.post('/logout', verifySession, (req, res) => {
  try {
    db.deleteDashboardSession(req.sessionToken);
    res.json({ success: true, message: 'Logged out successfully' });
  } catch (error) {
    console.error('Error logging out:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Handle job status change side effects
async function handleJobStatusChange(jobId, status, contractorId) {
  const job = db.getJobById(jobId);
  const contractor = db.db.prepare('SELECT * FROM contractors WHERE id = ?').get(contractorId);
  const customer = db.db.prepare('SELECT * FROM customers WHERE id = ?').get(job.customer_id);

  if (!job || !contractor || !customer) return;

  switch (status) {
    case 'approved':
      await sms.sendJobApprovalNotification(customer.phone_number, contractor, job);
      break;
      
    case 'in_progress':
      await sms.sendOnTheWayNotification(customer.phone_number, contractor.business_name);
      break;
      
    case 'completed':
      const scheduler = require('../scheduler');
      await scheduler.markJobCompleted(jobId, contractor.phone_number);
      break;
      
    case 'cancelled':
      await sms.sendSMS(customer.phone_number, 
        `Your ${job.service_category} job has been cancelled by ${contractor.business_name}. ` +
        `Please text me if you'd like to find another contractor.`
      );
      break;
  }
}

// Calculate average rating from completed jobs
function calculateAverageRating(completedJobs) {
  const ratedJobs = completedJobs.filter(job => job.customer_rating !== null);
  if (ratedJobs.length === 0) return null;
  
  const totalRating = ratedJobs.reduce((sum, job) => sum + job.customer_rating, 0);
  return (totalRating / ratedJobs.length).toFixed(1);
}

module.exports = router;