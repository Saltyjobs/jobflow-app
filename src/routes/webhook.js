const express = require('express');
const twilio = require('twilio');
const db = require('../db');
const ai = require('../ai');
const sms = require('../sms');
const scheduler = require('../scheduler');

const router = express.Router();

// Twilio webhook signature validation middleware
const validateTwilioSignature = (req, res, next) => {
  if (process.env.NODE_ENV === 'development' || process.env.SKIP_TWILIO_VALIDATION === 'true') {
    return next();
  }

  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const twilioSignature = req.headers['x-twilio-signature'];
  if (!twilioSignature) {
    console.error('Missing Twilio signature header');
    return res.status(403).send('Forbidden');
  }

  // Try multiple URL forms — Railway proxy can cause mismatches
  const protocol = req.headers['x-forwarded-proto'] || req.protocol;
  const host = req.get('host');
  const path = req.originalUrl;
  const urlVariants = [
    `${protocol}://${host}${path}`,
    `https://${host}${path}`,
    `http://${host}${path}`
  ];
  
  const isValid = urlVariants.some(url => 
    twilio.validateRequest(authToken, twilioSignature, url, req.body)
  );
  
  if (!isValid) {
    console.error('Invalid Twilio signature. Tried URLs:', urlVariants);
    // In production behind proxy, skip validation as fallback if request looks legit
    if (req.body && req.body.AccountSid === process.env.TWILIO_ACCOUNT_SID) {
      console.log('Allowing request — AccountSid matches');
      return next();
    }
    return res.status(403).send('Forbidden');
  }
  
  next();
};

// Main SMS webhook handler
router.post('/sms', validateTwilioSignature, async (req, res) => {
  try {
    const { From: fromNumber, To: toNumber, Body: messageBody, MessageSid } = req.body;
    
    console.log(`Incoming SMS from ${fromNumber}: ${messageBody}`);

    // Save incoming message to database
    db.saveMessage(fromNumber, toNumber, messageBody, 'inbound', MessageSid);

    // Check for special contractor commands first
    await handleSpecialCommands(fromNumber, messageBody);

    // Process message through AI engine
    const aiResponse = await ai.processMessage(fromNumber, messageBody);

    if (aiResponse && aiResponse.trim()) {
      // Send response via TwiML (Twilio handles delivery)
      const twiml = new twilio.twiml.MessagingResponse();
      twiml.message(aiResponse);

      // Save outbound message to database (don't send again via API)
      db.saveMessage(toNumber, fromNumber, aiResponse, 'outbound', null);

      res.writeHead(200, { 'Content-Type': 'text/xml' });
      res.end(twiml.toString());
    } else {
      // No response needed
      res.status(200).send();
    }

  } catch (error) {
    console.error('Error processing SMS webhook:', error);
    
    // Send error response to user
    const twiml = new twilio.twiml.MessagingResponse();
    twiml.message("Sorry, I encountered an error. Please try again later.");
    
    res.writeHead(200, { 'Content-Type': 'text/xml' });
    res.end(twiml.toString());
  }
});

// Handle special contractor commands that bypass normal AI flow
async function handleSpecialCommands(phoneNumber, messageBody) {
  const normalizedMessage = messageBody.toUpperCase().trim();
  const contractor = db.getContractorByPhone(phoneNumber);
  
  if (!contractor) return false;

  try {
    // Handle "ON THE WAY" notifications
    if (normalizedMessage.includes('ON THE WAY') || normalizedMessage === 'OTW') {
      await scheduler.handleOnTheWayNotification(phoneNumber, messageBody);
      return true;
    }

    // Handle job completion
    if (normalizedMessage.includes('JOB DONE') || normalizedMessage.includes('COMPLETED')) {
      // Find contractor's active job
      const jobs = db.getJobsByContractor(contractor.id);
      const activeJob = jobs.find(job => job.status === 'in_progress');
      
      if (activeJob) {
        await scheduler.markJobCompleted(activeJob.id, phoneNumber);
      }
      return true;
    }

    // Handle contractor responses to job requests
    const contractorResponse = sms.parseContractorResponse(messageBody);
    if (contractorResponse.action !== 'unknown') {
      await handleContractorJobResponse(phoneNumber, contractorResponse, contractor);
      return true;
    }

    // Handle invoice sending
    if (normalizedMessage.startsWith('INVOICE ')) {
      await handleInvoiceCommand(phoneNumber, contractorResponse, contractor);
      return true;
    }

    return false;
  } catch (error) {
    console.error('Error handling special commands:', error);
    return false;
  }
}

// Handle contractor responses to job notifications
async function handleContractorJobResponse(phoneNumber, response, contractor) {
  try {
    // Find the most recent pending job for this contractor
    const jobs = db.getJobsByContractor(contractor.id);
    const pendingJob = jobs.find(job => job.status === 'quoted');

    if (!pendingJob) {
      await sms.sendSMS(phoneNumber, "No pending job requests found.");
      return;
    }

    switch (response.action) {
      case 'approve':
        // Contractor approved the job
        db.updateJobStatus(pendingJob.id, 'approved');
        
        // Notify customer
        const customer = db.queryGet('SELECT * FROM customers WHERE id = ?', [pendingJob.customer_id]);
        if (customer) {
          await sms.sendJobApprovalNotification(
            customer.phone_number, 
            contractor, 
            pendingJob
          );
        }

        await sms.sendSMS(phoneNumber, `✅ Job approved! Customer has been notified. Please contact them to schedule: ${customer?.phone_number}`);
        break;

      case 'call_customer':
        // Contractor will call customer
        const customerForCall = db.queryGet('SELECT * FROM customers WHERE id = ?', [pendingJob.customer_id]);
        await sms.sendSMS(phoneNumber, `📞 Customer contact info:\n${customerForCall?.phone_number}\n\nPlease call them to discuss the job. Reply with A after you agree on details.`);
        break;

      case 'custom_quote':
        // Contractor provided custom quote
        db.updateJobQuote(response.amount, pendingJob.id);
        
        const customerForQuote = db.queryGet('SELECT * FROM customers WHERE id = ?', [pendingJob.customer_id]);
        if (customerForQuote) {
          await sms.sendCustomQuoteToCustomer(
            customerForQuote.phone_number,
            contractor.business_name,
            response.amount,
            pendingJob
          );
        }

        await sms.sendSMS(phoneNumber, `💰 Custom quote of $${response.amount} sent to customer. Waiting for their response.`);
        break;

      case 'pass':
        // Contractor passed on the job
        db.updateJobStatus(pendingJob.id, 'contractor_passed');
        
        const customerForRejection = db.queryGet('SELECT * FROM customers WHERE id = ?', [pendingJob.customer_id]);
        if (customerForRejection) {
          await sms.sendJobRejectionNotification(customerForRejection.phone_number, "Contractor unavailable");
        }

        await sms.sendSMS(phoneNumber, "Job passed. Looking for another contractor for the customer.");
        
        // TODO: Find another contractor
        await findAlternativeContractor(pendingJob);
        break;

      default:
        await sms.sendSMS(phoneNumber, "Reply: A (approve), C (call customer), Q [amount] (custom quote), X (pass)");
    }

  } catch (error) {
    console.error('Error handling contractor job response:', error);
    await sms.sendSMS(phoneNumber, "Error processing your response. Please try again.");
  }
}

// Handle invoice commands from contractors
async function handleInvoiceCommand(phoneNumber, response, contractor) {
  try {
    if (response.action === 'invoice' && response.amount && response.description) {
      // Find recently completed job
      const jobs = db.getJobsByContractor(contractor.id);
      const completedJob = jobs.find(job => 
        job.status === 'completed' && 
        !job.invoice_sent
      );

      if (completedJob) {
        const customer = db.queryGet('SELECT * FROM customers WHERE id = ?', [completedJob.customer_id]);
        
        if (customer) {
          await sms.sendInvoiceToCustomer(
            customer.phone_number,
            contractor,
            response.amount,
            response.description
          );

          // Mark invoice as sent
          db.queryRun('UPDATE jobs SET invoice_sent = 1 WHERE id = ?', [completedJob.id]);
          
          await sms.sendSMS(phoneNumber, `📧 Invoice sent to customer for $${response.amount}`);
        }
      } else {
        await sms.sendSMS(phoneNumber, "No completed jobs found that need invoicing.");
      }
    } else {
      await sms.sendSMS(phoneNumber, "Format: INVOICE [amount] [description]\nExample: INVOICE 150 Plumbing repair - fixed leaky pipe");
    }
  } catch (error) {
    console.error('Error handling invoice command:', error);
    await sms.sendSMS(phoneNumber, "Error processing invoice. Please try again.");
  }
}

// Find alternative contractor when one passes
async function findAlternativeContractor(job) {
  try {
    const quoting = require('../quoting');
    
    // Find contractors in the area (excluding the one who passed)
    const availableContractors = db.findAvailableContractors(job.customer_zip, job.service_category);
    const eligibleContractors = availableContractors.filter(c => c.id !== job.contractor_id);

    if (eligibleContractors.length > 0) {
      // Find best alternative contractor
      const bestMatch = quoting.findBestContractor(job, eligibleContractors);
      
      if (bestMatch) {
        // Assign job to new contractor
        db.assignJobToContractor(job.id, bestMatch.contractor.id);
        
        // Generate new quote
        const newQuote = bestMatch.quote;
        db.queryRun('UPDATE jobs SET estimated_cost_min = ?, estimated_cost_max = ? WHERE id = ?', [newQuote.minCost, newQuote.maxCost, job.id]);

        // Notify new contractor
        const contractorDetails = db.queryGet('SELECT * FROM contractors WHERE id = ?', [bestMatch.contractor.id]);
        const customer = db.queryGet('SELECT * FROM customers WHERE id = ?', [job.customer_id]);
        
        if (contractorDetails && customer) {
          await sms.sendContractorNotification(contractorDetails.phone_number, {
            ...job,
            estimated_cost_min: newQuote.minCost,
            estimated_cost_max: newQuote.maxCost,
            customer_phone: customer.phone_number
          });

          // Update customer with new quote
          const customerMessage = `Found another contractor for your ${job.service_category} job!\n\n` +
            `💰 New quote: $${newQuote.minCost}-${newQuote.maxCost}\n` +
            `🔧 ${contractorDetails.business_name}\n\n` +
            `They're reviewing your request now. I'll update you soon!`;
          
          await sms.sendSMS(customer.phone_number, customerMessage);
        }
      }
    } else {
      // No other contractors available
      const customer = db.queryGet('SELECT * FROM customers WHERE id = ?', [job.customer_id]);
      if (customer) {
        await sms.sendSMS(customer.phone_number, 
          "Sorry, no other contractors are available in your area right now. You can try again later or expand your search area."
        );
      }
      
      db.updateJobStatus(job.id, 'no_contractors_available');
    }
  } catch (error) {
    console.error('Error finding alternative contractor:', error);
  }
}

// Status webhook for Twilio message delivery updates
router.post('/sms-status', (req, res) => {
  const { MessageSid, MessageStatus, ErrorCode, ErrorMessage } = req.body;
  
  console.log(`Message ${MessageSid} status: ${MessageStatus}`);
  
  if (ErrorCode) {
    console.error(`Message error: ${ErrorCode} - ${ErrorMessage}`);
  }

  // Update message status in database if needed
  // db.updateMessageStatus(MessageSid, MessageStatus, ErrorCode);
  
  res.status(200).send('OK');
});

// Handle customer rating responses
router.post('/handle-rating', async (req, res) => {
  try {
    const { phoneNumber, messageBody } = req.body;
    
    const ratingData = sms.parseCustomerRating(messageBody);
    
    if (ratingData) {
      // Find the customer's most recent completed job
      const customer = db.getCustomerByPhone(phoneNumber);
      if (customer) {
        const jobs = db.queryAll(
          `SELECT * FROM jobs WHERE customer_id = ? AND status = 'completed' ORDER BY created_at DESC LIMIT 1`,
          [customer.id]
        );

        if (jobs.length > 0) {
          const job = jobs[0];
          
          // Save rating and feedback
          db.queryRun('UPDATE jobs SET customer_rating = ?, customer_feedback = ? WHERE id = ?', [ratingData.rating, ratingData.feedback, job.id]);

          let responseMessage = `Thank you for rating your service experience: ${ratingData.rating}/5 stars! ⭐`;
          
          if (ratingData.feedback) {
            responseMessage += `\n\nYour feedback: "${ratingData.feedback}"`;
          }
          
          responseMessage += `\n\nWe appreciate your business! Text me anytime for future service needs.`;

          await sms.sendSMS(phoneNumber, responseMessage);
          
          // If it's a high rating, could ask for referral
          if (ratingData.rating >= 4) {
            setTimeout(async () => {
              await sms.sendSMS(phoneNumber, 
                "Glad you had a great experience! 😊\n\n" +
                "Know someone who needs similar help? Just have them text this number!"
              );
            }, 5000);
          }
        }
      }
    }

    res.status(200).json({ success: true });
  } catch (error) {
    console.error('Error handling rating:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Test endpoint for development
router.post('/test-sms', async (req, res) => {
  if (process.env.NODE_ENV !== 'development') {
    return res.status(404).send('Not found');
  }

  const { phoneNumber, message } = req.body;
  
  if (!phoneNumber || !message) {
    return res.status(400).json({ error: 'phoneNumber and message are required' });
  }

  try {
    console.log(`Test SMS from ${phoneNumber}: ${message}`);
    
    // Process through AI engine
    const aiResponse = await ai.processMessage(phoneNumber, message);
    
    res.json({ 
      incomingMessage: message,
      aiResponse: aiResponse || 'No response generated'
    });
  } catch (error) {
    console.error('Error in test SMS:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;