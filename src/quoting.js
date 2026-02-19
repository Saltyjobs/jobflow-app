const db = require('./db');

class QuotingEngine {
  constructor() {
    // Base complexity multipliers for different service categories
    this.categoryComplexity = {
      'plumbing': {
        simple: { hours: 1, complexity: 1.0, description: 'Basic repair' },
        moderate: { hours: 2.5, complexity: 1.3, description: 'Standard installation' },
        complex: { hours: 4, complexity: 1.6, description: 'Major repair/replacement' }
      },
      'electrical': {
        simple: { hours: 1.5, complexity: 1.2, description: 'Outlet/switch work' },
        moderate: { hours: 3, complexity: 1.5, description: 'Circuit installation' },
        complex: { hours: 6, complexity: 2.0, description: 'Panel/major wiring' }
      },
      'hvac': {
        simple: { hours: 1, complexity: 1.1, description: 'Filter/maintenance' },
        moderate: { hours: 3, complexity: 1.4, description: 'Repair/tune-up' },
        complex: { hours: 8, complexity: 1.8, description: 'Installation/replacement' }
      },
      'general_handyman': {
        simple: { hours: 1, complexity: 0.9, description: 'Simple fix' },
        moderate: { hours: 2, complexity: 1.1, description: 'Installation/repair' },
        complex: { hours: 4, complexity: 1.3, description: 'Multi-step project' }
      },
      'appliance_repair': {
        simple: { hours: 1, complexity: 1.0, description: 'Diagnostic/simple fix' },
        moderate: { hours: 2, complexity: 1.2, description: 'Part replacement' },
        complex: { hours: 3, complexity: 1.5, description: 'Major repair' }
      },
      'roofing': {
        simple: { hours: 2, complexity: 1.3, description: 'Small repair' },
        moderate: { hours: 6, complexity: 1.7, description: 'Section repair' },
        complex: { hours: 16, complexity: 2.5, description: 'Full replacement' }
      },
      'flooring': {
        simple: { hours: 2, complexity: 1.1, description: 'Small area' },
        moderate: { hours: 6, complexity: 1.4, description: 'Room installation' },
        complex: { hours: 12, complexity: 1.7, description: 'Whole house' }
      }
    };

    // Urgency multipliers
    this.urgencyMultipliers = {
      'low': 1.0,
      'medium': 1.1,
      'high': 1.25,
      'emergency': 1.0 // Emergency markup is handled separately in contractor settings
    };

    // Time-based multipliers
    this.timeMultipliers = {
      'weekday_hours': 1.0,      // Mon-Fri 8AM-6PM
      'weekday_evening': 1.2,    // Mon-Fri 6PM-10PM
      'weekend_day': 1.15,       // Sat-Sun 8AM-6PM
      'weekend_evening': 1.3,    // Sat-Sun 6PM-10PM
      'late_night': 1.5,         // 10PM-8AM any day
      'holiday': 1.4             // Recognized holidays
    };
  }

  generateQuote(jobDetails, contractor, options = {}) {
    try {
      const category = jobDetails.service_category || 'general_handyman';
      const urgencyLevel = jobDetails.urgency_level || 'medium';
      
      // Determine job complexity based on problem description
      const complexity = this.assessJobComplexity(jobDetails.problem_description, category);
      const complexityData = this.categoryComplexity[category]?.[complexity] || 
                             this.categoryComplexity['general_handyman']['moderate'];

      // Base calculations
      const baseFee = contractor.base_service_fee || 75;
      const hourlyRate = contractor.hourly_rate || 100;
      const estimatedHours = complexityData.hours;
      const complexityMultiplier = complexityData.complexity;

      // Apply multipliers
      const urgencyMultiplier = this.urgencyMultipliers[urgencyLevel] || 1.1;
      
      // Emergency markup from contractor settings
      let emergencyMultiplier = 1.0;
      if (urgencyLevel === 'emergency') {
        emergencyMultiplier = 1.0 + (contractor.emergency_markup || 0.5);
      }

      // Time-based multiplier (if scheduling info provided)
      const timeMultiplier = options.scheduledTime ? 
        this.getTimeMultiplier(options.scheduledTime) : 1.0;

      // Calculate base cost
      const laborCost = hourlyRate * estimatedHours;
      const totalBeforeMultipliers = baseFee + laborCost;

      // Apply all multipliers
      const totalWithMultipliers = totalBeforeMultipliers * 
        complexityMultiplier * 
        urgencyMultiplier * 
        emergencyMultiplier * 
        timeMultiplier;

      // Generate range (±15% for uncertainty)
      const minCost = Math.round(totalWithMultipliers * 0.85);
      const maxCost = Math.round(totalWithMultipliers * 1.15);

      // Ensure minimum viable quote
      const absoluteMinimum = baseFee + (hourlyRate * 0.5);
      const finalMinCost = Math.max(minCost, absoluteMinimum);
      const finalMaxCost = Math.max(maxCost, finalMinCost + 50);

      return {
        minCost: finalMinCost,
        maxCost: finalMaxCost,
        averageCost: Math.round((finalMinCost + finalMaxCost) / 2),
        breakdown: {
          baseFee,
          estimatedHours,
          hourlyRate,
          laborCost,
          complexity,
          complexityMultiplier,
          urgencyMultiplier,
          emergencyMultiplier,
          timeMultiplier,
          description: complexityData.description
        }
      };

    } catch (error) {
      console.error('Error generating quote:', error);
      // Fallback quote
      return {
        minCost: 100,
        maxCost: 250,
        averageCost: 175,
        breakdown: {
          error: 'Quote calculation failed, using fallback pricing'
        }
      };
    }
  }

  assessJobComplexity(problemDescription, category) {
    const description = problemDescription.toLowerCase();
    
    // Category-specific complexity keywords
    const complexityKeywords = {
      'plumbing': {
        simple: ['faucet', 'leak', 'drip', 'clog', 'running', 'flush', 'handle'],
        moderate: ['install', 'replace', 'pipe', 'fitting', 'valve', 'fixture'],
        complex: ['main', 'sewer', 'remodel', 'reroute', 'whole house', 'major']
      },
      'electrical': {
        simple: ['outlet', 'switch', 'light', 'fixture', 'bulb', 'fuse'],
        moderate: ['circuit', 'breaker', 'wire', 'install', 'ceiling fan'],
        complex: ['panel', 'rewire', 'upgrade', 'service', 'whole house', '220']
      },
      'hvac': {
        simple: ['filter', 'thermostat', 'maintenance', 'clean', 'check'],
        moderate: ['repair', 'fix', 'part', 'component', 'tune', 'service'],
        complex: ['install', 'replace', 'new system', 'ductwork', 'whole house']
      },
      'general_handyman': {
        simple: ['hang', 'mount', 'fix', 'adjust', 'tighten', 'small'],
        moderate: ['install', 'repair', 'replace', 'build', 'assemble'],
        complex: ['remodel', 'construction', 'major', 'multiple', 'project']
      }
    };

    const categoryKeywords = complexityKeywords[category] || complexityKeywords['general_handyman'];
    
    // Check for complex indicators first
    for (const keyword of categoryKeywords.complex || []) {
      if (description.includes(keyword)) {
        return 'complex';
      }
    }
    
    // Then moderate
    for (const keyword of categoryKeywords.moderate || []) {
      if (description.includes(keyword)) {
        return 'moderate';
      }
    }
    
    // Check for simple indicators
    for (const keyword of categoryKeywords.simple || []) {
      if (description.includes(keyword)) {
        return 'simple';
      }
    }
    
    // Default to moderate if no clear indicators
    return 'moderate';
  }

  getTimeMultiplier(scheduledDateTime) {
    const date = new Date(scheduledDateTime);
    const day = date.getDay(); // 0 = Sunday, 6 = Saturday
    const hour = date.getHours();
    
    // Check if it's a weekend
    const isWeekend = day === 0 || day === 6;
    
    // Determine time period
    if (hour >= 22 || hour < 8) {
      return this.timeMultipliers['late_night'];
    } else if (hour >= 18) {
      return isWeekend ? 
        this.timeMultipliers['weekend_evening'] : 
        this.timeMultipliers['weekday_evening'];
    } else {
      return isWeekend ? 
        this.timeMultipliers['weekend_day'] : 
        this.timeMultipliers['weekday_hours'];
    }
  }

  // Find best contractor for a job based on multiple factors
  findBestContractor(jobDetails, availableContractors) {
    if (!availableContractors || availableContractors.length === 0) {
      return null;
    }

    const scoredContractors = availableContractors.map(contractor => {
      const quote = this.generateQuote(jobDetails, contractor);
      
      let score = 0;
      
      // Price competitiveness (lower is better, 40% weight)
      const avgPrice = quote.averageCost;
      const priceScore = Math.max(0, 1000 - avgPrice) / 1000;
      score += priceScore * 40;
      
      // Service match (30% weight)
      const serviceMatch = this.calculateServiceMatch(jobDetails.service_category, contractor.services_offered);
      score += serviceMatch * 30;
      
      // Availability (20% weight) - simplified for now
      const availabilityScore = contractor.is_active ? 1 : 0;
      score += availabilityScore * 20;
      
      // Emergency capability (10% weight)
      const emergencyScore = jobDetails.urgency_level === 'emergency' && 
                             contractor.emergency_markup !== null ? 1 : 0.5;
      score += emergencyScore * 10;

      return {
        contractor,
        quote,
        score,
        factors: {
          priceScore,
          serviceMatch,
          availabilityScore,
          emergencyScore
        }
      };
    });

    // Sort by score (highest first)
    scoredContractors.sort((a, b) => b.score - a.score);
    
    return scoredContractors[0]; // Return best match
  }

  calculateServiceMatch(requestedCategory, contractorServices) {
    if (!contractorServices || contractorServices.length === 0) {
      return 0.5; // Default moderate match
    }

    const category = requestedCategory.toLowerCase();
    const services = contractorServices.map(s => s.toLowerCase());
    
    // Exact category match
    if (services.some(service => service.includes(category))) {
      return 1.0;
    }
    
    // Partial matches based on category
    const categoryMatches = {
      'plumbing': ['pipe', 'drain', 'water', 'plumb'],
      'electrical': ['electric', 'wire', 'power', 'light'],
      'hvac': ['heat', 'cool', 'air', 'hvac', 'furnace'],
      'general_handyman': ['repair', 'fix', 'install', 'maintenance']
    };

    const matchKeywords = categoryMatches[category] || [];
    
    for (const keyword of matchKeywords) {
      if (services.some(service => service.includes(keyword))) {
        return 0.8; // Good partial match
      }
    }
    
    return 0.3; // Poor match but contractor might still be able to help
  }

  // Generate quote comparison for multiple contractors
  compareQuotes(jobDetails, contractors) {
    return contractors.map(contractor => {
      const quote = this.generateQuote(jobDetails, contractor);
      return {
        contractor: {
          id: contractor.id,
          business_name: contractor.business_name,
          trade_type: contractor.trade_type,
          phone_number: contractor.phone_number
        },
        quote
      };
    }).sort((a, b) => a.quote.averageCost - b.quote.averageCost);
  }

  // Adjust quote based on additional information
  adjustQuote(originalQuote, adjustmentFactors) {
    const { complexity, materials, timeline, accessibility } = adjustmentFactors;
    
    let multiplier = 1.0;
    
    if (complexity) multiplier *= complexity;
    if (materials) multiplier *= materials;
    if (timeline) multiplier *= timeline;
    if (accessibility) multiplier *= accessibility;
    
    return {
      minCost: Math.round(originalQuote.minCost * multiplier),
      maxCost: Math.round(originalQuote.maxCost * multiplier),
      averageCost: Math.round(originalQuote.averageCost * multiplier),
      adjustmentMultiplier: multiplier,
      originalQuote
    };
  }

  // Format quote for display
  formatQuoteForCustomer(quote, contractorName) {
    const { minCost, maxCost, breakdown } = quote;
    
    let message = `💰 Estimated cost: $${minCost}`;
    
    if (maxCost > minCost) {
      message += ` - $${maxCost}`;
    }
    
    message += `\n🔧 ${contractorName}`;
    
    if (breakdown?.description) {
      message += `\n📋 ${breakdown.description}`;
    }
    
    if (breakdown?.estimatedHours) {
      const hours = breakdown.estimatedHours;
      message += `\n⏰ Est. time: ${hours < 1 ? '< 1 hour' : `${hours} hour${hours !== 1 ? 's' : ''}`}`;
    }
    
    return message;
  }
}

module.exports = new QuotingEngine();