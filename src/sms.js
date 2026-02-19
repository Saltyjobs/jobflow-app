const twilio = require('twilio');
const db = require('./db');

class SMSService {
  constructor() {
    this.client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    this.fromNumber = process.env.TWILIO_PHONE_NUMBER;
    
    if (!this.fromNumber || !process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) {
      console.warn('Twilio not configured - SMS functionality will not work');
    }
  }

  async sendSMS(toNumber, message) {
    try {
      if (!this.client || !this.fromNumber) {
        console.log(`SMS not configured. Would send to ${toNumber}: ${message}`);
        return { success: false, error: 'Twilio not configured' };
      }

      // Use WhatsApp sandbox if configured, otherwise regular SMS
      const useWhatsApp = process.env.TWILIO_WHATSAPP_FROM;
      let from, to;
      
      if (toNumber.startsWith('whatsapp:')) {
        // Already a WhatsApp number — use as-is
        to = toNumber;
        from = `whatsapp:${useWhatsApp || this.fromNumber}`;
      } else if (useWhatsApp) {
        to = `whatsapp:${toNumber}`;
        from = `whatsapp:${useWhatsApp}`;
      } else {
        to = toNumber;
        from = this.fromNumber;
      }
      
      const result = await this.client.messages.create({
        body: message,
        from: from,
        to: to
      });

      // Save outbound message to database
      db.saveMessage(this.fromNumber, toNumber, message, 'outbound', result.sid);
      
      console.log(`SMS sent to ${toNumber}: ${result.sid}`);
      return { success: true, messageSid: result.sid };

    } catch (error) {
      console.error('Error sending SMS:', error);
      return { success: false, error: error.message };
    }
  }

  async sendContractorNotification(contractorPhone, jobDetails) {
    const message = `🔔 NEW JOB REQUEST\n\n` +
      `Problem: ${jobDetails.problem_description}\n` +
      `Location: ${jobDetails.customer_address}\n` +
      `Urgency: ${jobDetails.urgency_level}\n` +
      `Est. Cost: $${jobDetails.estimated_cost_min}-$${jobDetails.estimated_cost_max}\n` +
      `Customer: ${jobDetails.customer_phone}\n\n` +
      `Reply: A (approve), C (call customer), Q [amount] (custom quote), X (pass)`;

    return await this.sendSMS(contractorPhone, message);
  }

  async sendCustomerConfirmation(customerPhone, contractorName, jobDetails) {
    const message = `✅ Job Request Confirmed!\n\n` +
      `${contractorName} will contact you soon about your ${jobDetails.service_category} issue.\n\n` +
      `If you don't hear from them within 2 hours, please let me know by replying to this message.`;

    return await this.sendSMS(customerPhone, message);
  }

  async sendJobApprovalNotification(customerPhone, contractorDetails, jobDetails) {
    const message = `🎉 Great news! ${contractorDetails.business_name} has accepted your job.\n\n` +
      `They'll contact you soon to schedule the work.\n\n` +
      `📞 ${contractorDetails.phone_number}\n` +
      `💼 ${contractorDetails.business_name}`;

    return await this.sendSMS(customerPhone, message);
  }

  async sendJobRejectionNotification(customerPhone, reason = null) {
    let message = `Sorry, the contractor isn't available for your job right now.`;
    
    if (reason) {
      message += ` Reason: ${reason}`;
    }
    
    message += `\n\nI'm looking for another contractor for you. I'll update you soon!`;

    return await this.sendSMS(customerPhone, message);
  }

  async sendCustomQuoteToCustomer(customerPhone, contractorName, customQuote, jobDetails) {
    const message = `💰 Updated Quote from ${contractorName}\n\n` +
      `For your ${jobDetails.service_category} issue:\n` +
      `New quote: $${customQuote}\n\n` +
      `Reply YES to accept this quote, or NO to decline.`;

    return await this.sendSMS(customerPhone, message);
  }

  async sendDayBeforeReminder(phoneNumber, isContractor, jobDetails, scheduledDate) {
    const tomorrow = new Date(scheduledDate);
    const timeStr = jobDetails.scheduled_time || 'TBD';
    
    let message;
    if (isContractor) {
      message = `🔧 Reminder: You have a job tomorrow (${tomorrow.toLocaleDateString()})\n\n` +
        `Time: ${timeStr}\n` +
        `Customer: ${jobDetails.customer_phone}\n` +
        `Job: ${jobDetails.problem_description}\n` +
        `Location: ${jobDetails.customer_address}`;
    } else {
      message = `📅 Reminder: Your service appointment is tomorrow (${tomorrow.toLocaleDateString()})\n\n` +
        `Time: ${timeStr}\n` +
        `Contractor: ${jobDetails.contractor_business_name}\n` +
        `Service: ${jobDetails.service_category}`;
    }

    return await this.sendSMS(phoneNumber, message);
  }

  async sendOnTheWayNotification(customerPhone, contractorName, eta = null) {
    let message = `🚛 ${contractorName} is on their way to your location!`;
    
    if (eta) {
      message += ` ETA: ${eta}`;
    }
    
    message += `\n\nThey'll text or call when they arrive.`;

    return await this.sendSMS(customerPhone, message);
  }

  async sendJobCompletionFollowup(customerPhone, contractorName, jobDetails) {
    const message = `✅ How did your service with ${contractorName} go?\n\n` +
      `Please rate your experience (1-5) and any feedback:\n\n` +
      `5 = Excellent\n4 = Good\n3 = Okay\n2 = Poor\n1 = Very Poor\n\n` +
      `Just reply with your rating and any comments.`;

    return await this.sendSMS(customerPhone, message);
  }

  async sendInvoiceRequest(contractorPhone, jobDetails) {
    const message = `💼 Job completed for ${jobDetails.customer_phone}\n\n` +
      `Send invoice? Reply with:\n` +
      `INVOICE [amount] [description]\n\n` +
      `Example: INVOICE 150 Plumbing repair - fixed leaky pipe`;

    return await this.sendSMS(contractorPhone, message);
  }

  async sendInvoiceToCustomer(customerPhone, contractorDetails, amount, description) {
    const message = `🧾 INVOICE from ${contractorDetails.business_name}\n\n` +
      `Service: ${description}\n` +
      `Amount: $${amount}\n\n` +
      `Please pay the contractor directly:\n` +
      `📞 ${contractorDetails.phone_number}\n\n` +
      `Payment methods will vary by contractor.`;

    return await this.sendSMS(customerPhone, message);
  }

  async sendDashboardLogin(contractorPhone, loginUrl) {
    const message = `🔐 JobFlow Dashboard Access\n\n` +
      `Click here to view your jobs: ${loginUrl}\n\n` +
      `Link expires in 15 minutes for security.`;

    return await this.sendSMS(contractorPhone, message);
  }

  async sendVerificationCode(phoneNumber, code) {
    const message = `🔐 Your JobFlow verification code: ${code}\n\n` +
      `Enter this code to access your dashboard.\n` +
      `Code expires in 5 minutes.`;

    return await this.sendSMS(phoneNumber, message);
  }

  // Utility methods
  formatPhoneNumber(phoneNumber) {
    // Remove any non-digit characters
    const cleaned = phoneNumber.replace(/\D/g, '');
    
    // Add +1 if it's a 10-digit US number
    if (cleaned.length === 10) {
      return '+1' + cleaned;
    } else if (cleaned.length === 11 && cleaned.startsWith('1')) {
      return '+' + cleaned;
    }
    
    return phoneNumber; // Return as-is if already formatted or unknown format
  }

  isValidPhoneNumber(phoneNumber) {
    const cleaned = phoneNumber.replace(/\D/g, '');
    return cleaned.length === 10 || (cleaned.length === 11 && cleaned.startsWith('1'));
  }

  // Batch sending for reminders/notifications
  async sendBulkSMS(recipients) {
    const results = [];
    
    for (const recipient of recipients) {
      const result = await this.sendSMS(recipient.phoneNumber, recipient.message);
      results.push({
        phoneNumber: recipient.phoneNumber,
        success: result.success,
        error: result.error,
        messageSid: result.messageSid
      });
      
      // Small delay to avoid rate limits
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    return results;
  }

  // Message parsing helpers
  parseContractorResponse(message) {
    const upperMessage = message.toUpperCase().trim();
    
    if (upperMessage === 'A') {
      return { action: 'approve' };
    } else if (upperMessage === 'C') {
      return { action: 'call_customer' };
    } else if (upperMessage === 'X') {
      return { action: 'pass' };
    } else if (upperMessage.startsWith('Q ')) {
      const amount = parseFloat(upperMessage.substring(2).replace(/[$,]/g, ''));
      if (!isNaN(amount) && amount > 0) {
        return { action: 'custom_quote', amount };
      }
    } else if (upperMessage.startsWith('INVOICE ')) {
      const parts = upperMessage.substring(8).split(' ');
      const amount = parseFloat(parts[0].replace(/[$,]/g, ''));
      const description = parts.slice(1).join(' ');
      
      if (!isNaN(amount) && amount > 0 && description) {
        return { action: 'invoice', amount, description };
      }
    }
    
    return { action: 'unknown', originalMessage: message };
  }

  parseCustomerRating(message) {
    const rating = parseInt(message.trim().charAt(0));
    if (rating >= 1 && rating <= 5) {
      const feedback = message.trim().substring(1).trim();
      return { rating, feedback: feedback || null };
    }
    return null;
  }
}

module.exports = new SMSService();