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

      // CANCEL resets everything
      if (incomingMessage.trim().toUpperCase() === 'CANCEL') {
        db.updateConversationState(phoneNumber, 'IDLE', {});
        return "No problem — conversation reset. Text me anytime you need help!";
      }

      // Route to appropriate handler based on conversation state
      switch (state) {
        case 'CONTRACTOR_ONBOARDING':
          return await this.handleContractorOnboarding(phoneNumber, incomingMessage, context);
        case 'AWAITING_QUOTE_APPROVAL':
          return await this.handleQuoteApproval(phoneNumber, incomingMessage, context);
        case 'AWAITING_CONTRACTOR_RESPONSE':
          return await this.handleContractorResponse(phoneNumber, incomingMessage, context);
        case 'JOB_SCHEDULED':
          return await this.handleScheduledJobMessages(phoneNumber, incomingMessage, context);
        case 'IDLE':
        case 'CUSTOMER_INTAKE':
        default:
          return await this.handleSmartConversation(phoneNumber, incomingMessage, context);
      }
    } catch (error) {
      console.error('Error processing message:', error.message, error.stack);
      return "I'm sorry, I encountered an error. Please try again or contact support.";
    }
  }

  // ---- Smart AI Conversation (replaces handleIdleState + handleCustomerIntake) ----

  async handleSmartConversation(phoneNumber, message, context) {
    const normalizedMessage = message.toUpperCase().trim();

    // Contractor setup flow
    if (normalizedMessage === 'SETUP' || normalizedMessage.includes('SETUP')) {
      const existingContractor = db.getContractorByPhone(phoneNumber);
      if (existingContractor) {
        return "You're already set up as a contractor! Text DASHBOARD for login link.";
      }
      db.updateConversationState(phoneNumber, 'CONTRACTOR_ONBOARDING', { step: 'business_name' });
      return "Welcome to JobFlow! Let's get your business set up.\n\nWhat's your business name?";
    }

    // Existing contractor commands
    const contractor = db.getContractorByPhone(phoneNumber);
    if (contractor) {
      return await this.handleContractorMessage(phoneNumber, message, contractor);
    }

    // ---- Customer AI conversation ----

    // Ensure customer exists
    let customer = db.getCustomerByPhone(phoneNumber);
    if (!customer) {
      const customerId = db.createCustomer({ phone_number: phoneNumber });
      customer = { id: customerId, phone_number: phoneNumber };
    }

    // Save inbound message
    db.saveChatMessage(phoneNumber, 'customer', message);

    // Load conversation history
    const recentMessages = db.getRecentChatMessages(phoneNumber, 20);

    // Check for previous jobs
    const previousJobs = db.getCustomerJobs(customer.id);

    // Find contractor for system prompt context
    const allContractors = db.getAllContractors();
    const selectedContractor = allContractors.length > 0 ? allContractors[0] : null;

    if (!selectedContractor) {
      return "Sorry, this service isn't set up yet. Please try again later.";
    }

    // Build system prompt
    let systemPrompt = `You are a friendly AI receptionist for ${selectedContractor.business_name}, a ${selectedContractor.trade_type} business.

Your job is to understand the customer's problem thoroughly before generating a quote.

Information you need to gather (naturally, not as a checklist):
- What's the problem? (specific details)
- How long has it been going on?
- Any related symptoms or damage?
- Have they tried anything to fix it?
- How urgent is it?
- Their location/zip code (if not already known)

When you have enough information to understand the scope of work, respond with your normal conversational message AND include this tag at the very end:
<!--READY_TO_QUOTE:{"problem":"concise problem summary","category":"plumbing|electrical|HVAC|general_handyman|appliance_repair|cleaning|landscaping|pest_control|roofing|flooring","urgency":"low|medium|high|emergency","details":"key details for quoting"}-->

Otherwise, just have a natural conversation. Be empathetic, professional, and thorough.
Don't ask all questions at once — 1-2 per message max.
Keep responses concise (2-4 sentences typically).
If they mention a previous job, ask if this is related.`;

    // Add job history context
    if (previousJobs.length > 0) {
      const jobSummaries = previousJobs.slice(0, 5).map(j =>
        `- ${j.service_category || 'service'}: "${j.problem_description}" (${j.status}, ${j.created_at})`
      ).join('\n');
      systemPrompt += `\n\nThis is a returning customer. Their previous jobs:\n${jobSummaries}\nIf relevant, ask if the new issue is related to a previous one.`;
    }

    // Build messages array
    const aiMessages = [{ role: 'system', content: systemPrompt }];
    for (const msg of recentMessages) {
      aiMessages.push({
        role: msg.role === 'customer' ? 'user' : 'assistant',
        content: msg.content
      });
    }

    // Call OpenAI
    let aiResponse;
    try {
      const completion = await this.openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: aiMessages,
        max_tokens: 300,
        temperature: 0.7
      });
      aiResponse = completion.choices[0].message.content.trim();
    } catch (e) {
      console.error('OpenAI error:', e.message);
      return "I'm having trouble right now. Please try again in a moment.";
    }

    // Check for READY_TO_QUOTE tag
    const quoteMatch = aiResponse.match(/<!--READY_TO_QUOTE:(.*?)-->/s);

    if (quoteMatch) {
      // Extract the conversational part (before the tag)
      const conversationalPart = aiResponse.replace(/<!--READY_TO_QUOTE:.*?-->/s, '').trim();

      let quoteData;
      try {
        quoteData = JSON.parse(quoteMatch[1]);
      } catch (e) {
        console.error('Failed to parse READY_TO_QUOTE JSON:', e.message);
        // Save response without the tag and continue conversation
        const cleanResponse = conversationalPart || "Can you tell me a bit more about the issue?";
        db.saveChatMessage(phoneNumber, 'assistant', cleanResponse);
        db.updateConversationState(phoneNumber, 'CUSTOMER_INTAKE', { customer_id: customer.id });
        return cleanResponse;
      }

      // Map urgency
      const urgencyMap = { 'low': 'low', 'medium': 'medium', 'high': 'high', 'emergency': 'emergency' };
      const urgency = urgencyMap[quoteData.urgency] || 'medium';

      // Generate quote
      const quoteContext = {
        urgency_level: urgency,
        service_category: quoteData.category || 'general_handyman'
      };
      const { minCost, maxCost } = await this.generateQuote(quoteContext, selectedContractor);

      // Create job
      const { v4: uuidv4 } = require('uuid');
      const jobUuid = uuidv4();
      const jobId = db.createJob({
        customer_id: customer.id,
        job_uuid: jobUuid,
        problem_description: quoteData.problem || quoteData.details,
        service_category: quoteData.category || 'general_handyman',
        urgency_level: urgency,
        customer_address: selectedContractor.service_area_zip,
        customer_zip: selectedContractor.service_area_zip,
        estimated_cost_min: minCost,
        estimated_cost_max: maxCost
      });

      const newContext = {
        customer_id: customer.id,
        job_id: jobId,
        contractor_id: selectedContractor.id,
        problem_description: quoteData.problem,
        service_category: quoteData.category,
        urgency_level: urgency
      };

      db.updateConversationState(phoneNumber, 'AWAITING_QUOTE_APPROVAL', newContext);

      const quoteMessage = (conversationalPart ? conversationalPart + '\n\n' : '') +
        `Here's what I've put together:\n\n` +
        `💰 Estimated cost: $${minCost}-$${maxCost}\n` +
        `🔧 ${selectedContractor.business_name}\n` +
        `📅 Available: ${this.getAvailabilityText(selectedContractor)}\n\n` +
        `Reply YES to book this job, or NO to cancel.`;

      db.saveChatMessage(phoneNumber, 'assistant', quoteMessage);
      return quoteMessage;
    }

    // No quote tag — just a conversational response
    db.saveChatMessage(phoneNumber, 'assistant', aiResponse);
    db.updateConversationState(phoneNumber, 'CUSTOMER_INTAKE', { customer_id: customer.id });
    return aiResponse;
  }

  // ---- Existing handlers (kept as-is) ----

  async handleContractorMessage(phoneNumber, message, contractor) {
    const upperMessage = message.toUpperCase().trim();
    
    if (upperMessage === 'DASHBOARD') {
      return `Visit your dashboard: ${process.env.BASE_URL || 'http://localhost:3000'}/dashboard?phone=${encodeURIComponent(phoneNumber)}`;
    }

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

  async handleQuoteApproval(phoneNumber, message, context) {
    const response = message.toUpperCase().trim();
    
    if (response === 'YES' || response === 'Y') {
      const job = db.getJobById(context.job_id);
      const contractor = db.getContractorById(context.contractor_id);
      
      if (job && contractor) {
        db.assignJobToContractor(context.job_id, context.contractor_id);
        db.updateJobStatus(context.job_id, 'quoted');
        
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
    return await this.handleContractorResponse(phoneNumber, message, contractor);
  }

  async handleScheduledJobMessages(phoneNumber, message, context) {
    return "Your job is scheduled! I'll send reminders as the date approaches.";
  }

  // ---- AI Helper Methods ----

  async parseServices(servicesText, tradeType) {
    try {
      const response = await this.openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: `Parse this ${tradeType} service description into a JSON array of specific services. Return valid JSON only.` },
          { role: 'user', content: servicesText }
        ],
        max_tokens: 200,
        temperature: 0.1
      });
      return JSON.parse(response.choices[0].message.content.trim());
    } catch (error) {
      console.error('Error parsing services:', error);
      return [servicesText];
    }
  }

  async parseAvailableHours(hoursText) {
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
    
    const minHours = 1;
    const maxHours = 3;
    
    const minCost = Math.round((baseCost + (hourlyRate * minHours)) * urgencyMultiplier);
    const maxCost = Math.round((baseCost + (hourlyRate * maxHours)) * urgencyMultiplier);

    return { minCost, maxCost };
  }

  getAvailabilityText(contractor) {
    return "This week";
  }
}

module.exports = new AIConversationEngine();
