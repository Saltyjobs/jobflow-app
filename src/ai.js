const OpenAI = require('openai');
const db = require('./db');

class AIConversationEngine {
  constructor() {
    this.openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });
  }

  async processMessage(phoneNumber, incomingMessage) {
    try {
      const conversation = db.getOrCreateConversation(phoneNumber);
      const state = conversation.state;
      const context = conversation.context || {};

      console.log(`Processing message from ${phoneNumber}, state: ${state}, message: ${incomingMessage}`);

      // Route to appropriate handler based on conversation state
      switch (state) {
        case 'IDLE':
          return await this.handleIdleState(phoneNumber, incomingMessage, context);
        case 'CONTRACTOR_ONBOARDING':
          return await this.handleContractorOnboarding(phoneNumber, incomingMessage, context);
        case 'CUSTOMER_INTAKE':
          return await this.handleCustomerIntake(phoneNumber, incomingMessage, context);
        case 'AWAITING_QUOTE_APPROVAL':
          return await this.handleQuoteApproval(phoneNumber, incomingMessage, context);
        case 'AWAITING_CONTRACTOR_RESPONSE':
          return await this.handleContractorResponse(phoneNumber, incomingMessage, context);
        case 'JOB_SCHEDULED':
          return await this.handleScheduledJobMessages(phoneNumber, incomingMessage, context);
        default:
          return await this.handleIdleState(phoneNumber, incomingMessage, context);
      }
    } catch (error) {
      console.error('Error processing message:', error);
      return "I'm sorry, I encountered an error. Please try again or contact support.";
    }
  }

  async handleIdleState(phoneNumber, message, context) {
    const normalizedMessage = message.toUpperCase().trim();

    // Check if it's contractor setup
    if (normalizedMessage === 'SETUP' || normalizedMessage.includes('SETUP')) {
      // Check if contractor already exists
      const existingContractor = db.getContractorByPhone(phoneNumber);
      if (existingContractor) {
        return "You're already set up as a contractor! Text DASHBOARD for login link.";
      }

      // Start contractor onboarding
      db.updateConversationState(phoneNumber, 'CONTRACTOR_ONBOARDING', { step: 'business_name' });
      return "Welcome to JobFlow! Let's get your business set up.\n\nWhat's your business name?";
    }

    // Check if it's an existing contractor
    const contractor = db.getContractorByPhone(phoneNumber);
    if (contractor) {
      return await this.handleContractorMessage(phoneNumber, message, contractor);
    }

    // Otherwise, treat as customer inquiry
    const customer = db.getCustomerByPhone(phoneNumber) || { phone_number: phoneNumber };
    if (!customer.id) {
      const customerId = db.createCustomer(customer);
      customer.id = customerId;
    }

    // Check if the first message already describes a problem (not just "hi" or "hello")
    const greetings = ['HI', 'HELLO', 'HEY', 'SUP', 'YO', 'HELP', 'START'];
    const isJustGreeting = greetings.includes(message.trim().toUpperCase()) || message.trim().length < 4;
    
    if (isJustGreeting) {
      // Generic greeting - ask what they need
      db.updateConversationState(phoneNumber, 'CUSTOMER_INTAKE', { 
        step: 'problem_description',
        customer_id: customer.id 
      });
      return "Hi! I'm JobFlow, your AI assistant for home service needs. What can I help you with today? Please describe the problem you're having.";
    }
    
    // They already described their problem - skip ahead to urgency
    db.updateConversationState(phoneNumber, 'CUSTOMER_INTAKE', { 
      step: 'urgency',
      customer_id: customer.id,
      problem_description: message.trim()
    });
    
    return `Got it — "${message.trim()}"\n\nHow urgent is this? Reply with:\n1 - Not urgent, can wait a few days\n2 - Soon, within 1-2 days\n3 - Today if possible\n4 - Emergency, ASAP`;
  }

  async handleContractorMessage(phoneNumber, message, contractor) {
    const upperMessage = message.toUpperCase().trim();
    
    if (upperMessage === 'DASHBOARD') {
      // Generate dashboard login - this would be handled by dashboard.js
      return `Visit your dashboard: ${process.env.BASE_URL || 'http://localhost:3000'}/dashboard?phone=${encodeURIComponent(phoneNumber)}`;
    }

    // Check if it's a response to a job notification (A/C/Q/X)
    if (['A', 'C', 'X'].includes(upperMessage) || upperMessage.startsWith('Q ')) {
      return await this.handleContractorJobResponse(phoneNumber, message, contractor);
    }

    return "Commands: DASHBOARD (access your jobs), or respond to job notifications with A (approve), C (call customer), Q [amount] (custom quote), or X (pass).";
  }

  async handleContractorOnboarding(phoneNumber, message, context) {
    const step = context.step;
    
    switch (step) {
      case 'business_name':
        context.business_name = message.trim();
        db.updateConversationState(phoneNumber, 'CONTRACTOR_ONBOARDING', { ...context, step: 'trade_type' });
        return "Great! What type of contractor are you? (e.g., plumber, electrician, handyman, HVAC, etc.)";

      case 'trade_type':
        context.trade_type = message.trim().toLowerCase();
        db.updateConversationState(phoneNumber, 'CONTRACTOR_ONBOARDING', { ...context, step: 'service_area' });
        return "What's your primary service area zip code?";

      case 'service_area':
        const zipMatch = message.match(/\b\d{5}\b/);
        if (!zipMatch) {
          return "Please provide a valid 5-digit zip code for your service area.";
        }
        context.service_area_zip = zipMatch[0];
        db.updateConversationState(phoneNumber, 'CONTRACTOR_ONBOARDING', { ...context, step: 'services' });
        return "What services do you offer? (describe what you do - I'll categorize them)";

      case 'services':
        context.services_offered = await this.parseServices(message, context.trade_type);
        db.updateConversationState(phoneNumber, 'CONTRACTOR_ONBOARDING', { ...context, step: 'service_fee' });
        return "What's your base service call fee? (just the number, like 75 for $75)";

      case 'service_fee':
        const serviceFee = parseFloat(message.replace(/[$,]/g, ''));
        if (isNaN(serviceFee) || serviceFee < 0) {
          return "Please provide a valid service fee as a number (e.g., 75 for $75).";
        }
        context.base_service_fee = serviceFee;
        db.updateConversationState(phoneNumber, 'CONTRACTOR_ONBOARDING', { ...context, step: 'hourly_rate' });
        return "What's your hourly rate? (just the number)";

      case 'hourly_rate':
        const hourlyRate = parseFloat(message.replace(/[$,]/g, ''));
        if (isNaN(hourlyRate) || hourlyRate < 0) {
          return "Please provide a valid hourly rate as a number.";
        }
        context.hourly_rate = hourlyRate;
        db.updateConversationState(phoneNumber, 'CONTRACTOR_ONBOARDING', { ...context, step: 'emergency_markup' });
        return "What's your emergency/after-hours markup? (e.g., 50 for 50% markup, or 0 for no markup)";

      case 'emergency_markup':
        const markup = parseFloat(message.replace(/%/g, '')) / 100;
        if (isNaN(markup) || markup < 0) {
          return "Please provide a valid markup percentage (e.g., 50 for 50% markup).";
        }
        context.emergency_markup = markup;
        db.updateConversationState(phoneNumber, 'CONTRACTOR_ONBOARDING', { ...context, step: 'hours' });
        return "What are your available hours? (e.g., 'Mon-Fri 8-5, Sat 9-2' or 'Available 24/7')";

      case 'hours':
        context.available_hours = await this.parseAvailableHours(message);
        
        // Create contractor record
        try {
          const contractorId = db.createContractor({
            phone_number: phoneNumber,
            business_name: context.business_name,
            trade_type: context.trade_type,
            service_area_zip: context.service_area_zip,
            services_offered: context.services_offered,
            base_service_fee: context.base_service_fee,
            hourly_rate: context.hourly_rate,
            emergency_markup: context.emergency_markup,
            available_hours: context.available_hours
          });

          db.updateConversationState(phoneNumber, 'IDLE', {});
          
          return `🎉 Welcome to JobFlow, ${context.business_name}!\n\nYour profile is set up and you're ready to receive job requests.\n\nText DASHBOARD anytime to view your jobs and requests.`;
        } catch (error) {
          console.error('Error creating contractor:', error);
          return "Sorry, there was an error setting up your profile. Please try again later or contact support.";
        }

      default:
        db.updateConversationState(phoneNumber, 'IDLE', {});
        return "Sorry, something went wrong. Please text SETUP to start over.";
    }
  }

  async handleCustomerIntake(phoneNumber, message, context) {
    const step = context.step;

    switch (step) {
      case 'problem_description':
        context.problem_description = message;
        context.service_category = await this.categorizeService(message);
        
        const diagnosticQuestion = await this.generateDiagnosticQuestion(message, context.service_category);
        context.diagnostic_question = diagnosticQuestion;
        
        db.updateConversationState(phoneNumber, 'CUSTOMER_INTAKE', { ...context, step: 'diagnostic' });
        return `Thanks! I understand you need help with ${context.service_category}.\n\n${diagnosticQuestion}`;

      case 'diagnostic':
        context.diagnostic_answer = message;
        db.updateConversationState(phoneNumber, 'CUSTOMER_INTAKE', { ...context, step: 'urgency' });
        return "How urgent is this? Reply with:\n1 - Not urgent, can wait a few days\n2 - Soon, within 1-2 days\n3 - Today if possible\n4 - Emergency, ASAP";

      case 'urgency':
        const urgencyMap = { '1': 'low', '2': 'medium', '3': 'high', '4': 'emergency' };
        context.urgency_level = urgencyMap[message.trim()] || 'medium';
        
        db.updateConversationState(phoneNumber, 'CUSTOMER_INTAKE', { ...context, step: 'address' });
        return "What's your address or zip code? (I need this to find contractors near you)";

      case 'address':
        const zipMatch = message.match(/\b\d{5}\b/);
        if (!zipMatch) {
          return "I need at least your zip code to find contractors near you. What's your zip code?";
        }
        
        context.customer_address = message;
        context.customer_zip = zipMatch[0];
        
        // Find available contractors
        const contractors = db.findAvailableContractors(context.customer_zip, context.service_category);
        
        if (contractors.length === 0) {
          db.updateConversationState(phoneNumber, 'IDLE', {});
          return "Sorry, I don't have any contractors available in your area right now. Please try again later or expand your search area.";
        }

        // Generate quote and create job
        const selectedContractor = contractors[0]; // For now, select first available
        const { minCost, maxCost } = await this.generateQuote(context, selectedContractor);
        
        // Create job record
        const { v4: uuidv4 } = require('uuid');
        const jobUuid = uuidv4();
        
        const jobId = db.createJob({
          customer_id: context.customer_id,
          job_uuid: jobUuid,
          problem_description: context.problem_description,
          service_category: context.service_category,
          urgency_level: context.urgency_level,
          customer_address: context.customer_address,
          customer_zip: context.customer_zip,
          estimated_cost_min: minCost,
          estimated_cost_max: maxCost
        });

        context.job_id = jobId;
        context.contractor_id = selectedContractor.id;
        
        db.updateConversationState(phoneNumber, 'AWAITING_QUOTE_APPROVAL', context);
        
        const quoteMessage = `Based on what you described, this looks like a ${context.service_category} job.\n\n` +
          `💰 Estimated cost: $${minCost}-$${maxCost}\n` +
          `🔧 ${selectedContractor.business_name}\n` +
          `📅 Available: ${this.getAvailabilityText(selectedContractor)}\n\n` +
          `Reply YES to book this job, or NO to cancel.`;
        
        return quoteMessage;

      default:
        db.updateConversationState(phoneNumber, 'IDLE', {});
        return "Sorry, something went wrong. Please describe your problem again.";
    }
  }

  async handleQuoteApproval(phoneNumber, message, context) {
    const response = message.toUpperCase().trim();
    
    if (response === 'YES' || response === 'Y') {
      // Customer approved the quote
      const job = db.getJobById(context.job_id);
      const contractor = db.getContractorById(context.contractor_id);
      
      if (job && contractor) {
        db.assignJobToContractor(context.job_id, context.contractor_id);
        db.updateJobStatus(context.job_id, 'quoted');
        
        // Notify contractor
        const contractorMessage = `🔔 NEW JOB REQUEST\n\n` +
          `Problem: ${job.problem_description}\n` +
          `Location: ${job.customer_address}\n` +
          `Urgency: ${job.urgency_level}\n` +
          `Est. Cost: $${job.estimated_cost_min}-$${job.estimated_cost_max}\n` +
          `Customer: ${phoneNumber}\n\n` +
          `Reply: A (approve), C (call customer), Q [amount] (custom quote), X (pass)`;
        
        // Log contractor notification for polling
        console.log('CONTRACTOR_NOTIFICATION:' + JSON.stringify({
          contractor_id: context.contractor_id,
          contractor_phone: contractor.phone_number,
          business_name: contractor.business_name,
          job_id: context.job_id,
          problem: job.problem_description,
          location: job.customer_address,
          urgency: job.urgency_level,
          cost_min: job.estimated_cost_min,
          cost_max: job.estimated_cost_max,
          customer_phone: phoneNumber
        }));
        db.updateConversationState(phoneNumber, 'AWAITING_CONTRACTOR_RESPONSE', context);
        
        return `Great! I've sent your request to ${contractor.business_name}. They'll respond soon with confirmation or may call you directly. I'll keep you updated!`;
      } else {
        db.updateConversationState(phoneNumber, 'IDLE', {});
        return "Sorry, there was an error processing your request. Please try again.";
      }
    } else if (response === 'NO' || response === 'N') {
      // Customer declined
      if (context.job_id) {
        db.updateJobStatus(context.job_id, 'cancelled');
      }
      db.updateConversationState(phoneNumber, 'IDLE', {});
      return "No problem! Feel free to text me again if you need help with anything else.";
    } else {
      return "Please reply YES to book this job, or NO to cancel.";
    }
  }

  async handleContractorResponse(phoneNumber, message, contractor) {
    const response = message.toUpperCase().trim();
    
    // This would find the pending job for this contractor
    // For now, simplified - in production you'd track which job this response is for
    if (response === 'A') {
      return "Job approved! Customer will be notified and you'll receive scheduling details.";
    } else if (response === 'C') {
      return "Got it - calling the customer is a great option. Please update the job status after your call.";
    } else if (response.startsWith('Q ')) {
      const amount = parseFloat(response.substring(2));
      return `Custom quote of $${amount} sent to customer. Waiting for their approval.`;
    } else if (response === 'X') {
      return "Job passed. Looking for another contractor for the customer.";
    }
    
    return "Reply: A (approve), C (call customer), Q [amount] (custom quote), X (pass)";
  }

  async handleContractorJobResponse(phoneNumber, message, contractor) {
    // Simplified - in production, you'd find the specific job this relates to
    return await this.handleContractorResponse(phoneNumber, message, contractor);
  }

  async handleScheduledJobMessages(phoneNumber, message, context) {
    // Handle messages during scheduled job phase
    return "Your job is scheduled! I'll send reminders as the date approaches.";
  }

  // AI Helper Methods
  async categorizeService(problemDescription) {
    try {
      const response = await this.openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: 'You are a service categorization expert. Categorize home service requests into one of these categories: plumbing, electrical, HVAC, general_handyman, appliance_repair, cleaning, landscaping, pest_control, roofing, flooring. Respond with just the category name.'
          },
          {
            role: 'user',
            content: problemDescription
          }
        ],
        max_tokens: 20,
        temperature: 0.1
      });

      return response.choices[0].message.content.trim().toLowerCase();
    } catch (error) {
      console.error('Error categorizing service:', error);
      return 'general_handyman'; // fallback
    }
  }

  async generateDiagnosticQuestion(problemDescription, category) {
    try {
      const response = await this.openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: `You are a diagnostic question generator for ${category} services. Ask ONE specific diagnostic question that would help a contractor understand the problem better and provide an accurate quote. Keep it conversational and under 50 words.`
          },
          {
            role: 'user',
            content: problemDescription
          }
        ],
        max_tokens: 100,
        temperature: 0.7
      });

      return response.choices[0].message.content.trim();
    } catch (error) {
      console.error('Error generating diagnostic question:', error);
      return 'Can you tell me more details about the problem?';
    }
  }

  async parseServices(servicesText, tradeType) {
    try {
      const response = await this.openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: `Parse this ${tradeType} service description into a JSON array of specific services. Extract concrete services they offer. Return valid JSON only.`
          },
          {
            role: 'user',
            content: servicesText
          }
        ],
        max_tokens: 200,
        temperature: 0.1
      });

      return JSON.parse(response.choices[0].message.content.trim());
    } catch (error) {
      console.error('Error parsing services:', error);
      return [servicesText]; // fallback
    }
  }

  async parseAvailableHours(hoursText) {
    // Simple parsing for now - in production, use AI to parse complex schedules
    return { general: hoursText };
  }

  async generateQuote(context, contractor) {
    const baseMultipliers = {
      'low': 1.0,
      'medium': 1.2,
      'high': 1.4,
      'emergency': 1.0 + contractor.emergency_markup
    };

    const baseCost = contractor.base_service_fee;
    const hourlyRate = contractor.hourly_rate;
    const urgencyMultiplier = baseMultipliers[context.urgency_level] || 1.2;
    
    // Estimate 1-3 hours for most jobs (simplified)
    const minHours = 1;
    const maxHours = 3;
    
    const minCost = Math.round((baseCost + (hourlyRate * minHours)) * urgencyMultiplier);
    const maxCost = Math.round((baseCost + (hourlyRate * maxHours)) * urgencyMultiplier);

    return { minCost, maxCost };
  }

  getAvailabilityText(contractor) {
    // Simplified availability text
    return "This week";
  }
}

module.exports = new AIConversationEngine();