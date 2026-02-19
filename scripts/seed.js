#!/usr/bin/env node

require('dotenv').config();
const { v4: uuidv4 } = require('uuid');
const db = require('../src/db');

console.log('Seeding JobFlow database with demo data...');

try {
  // Demo contractors
  const contractors = [
    {
      phone_number: '+15551234567',
      business_name: 'ABC Plumbing Services',
      trade_type: 'plumber',
      service_area_zip: '90210',
      service_radius: 30,
      services_offered: ['pipe repair', 'drain cleaning', 'water heater installation', 'emergency plumbing'],
      base_service_fee: 75,
      hourly_rate: 125,
      emergency_markup: 0.5,
      available_hours: {
        monday: '8-17',
        tuesday: '8-17',
        wednesday: '8-17',
        thursday: '8-17',
        friday: '8-17',
        saturday: '9-14'
      }
    },
    {
      phone_number: '+15559876543',
      business_name: 'ElectriCorp',
      trade_type: 'electrician',
      service_area_zip: '90210',
      service_radius: 25,
      services_offered: ['outlet installation', 'ceiling fan installation', 'electrical panel upgrade', 'circuit repair'],
      base_service_fee: 85,
      hourly_rate: 150,
      emergency_markup: 0.75,
      available_hours: {
        monday: '7-19',
        tuesday: '7-19',
        wednesday: '7-19',
        thursday: '7-19',
        friday: '7-19',
        saturday: '8-16',
        sunday: '10-15'
      }
    },
    {
      phone_number: '+15555555555',
      business_name: 'Handy Dave',
      trade_type: 'handyman',
      service_area_zip: '90210',
      service_radius: 40,
      services_offered: ['furniture assembly', 'picture hanging', 'minor repairs', 'door installation', 'drywall patching'],
      base_service_fee: 60,
      hourly_rate: 85,
      emergency_markup: 0.25,
      available_hours: {
        monday: '9-17',
        tuesday: '9-17',
        wednesday: '9-17',
        thursday: '9-17',
        friday: '9-17'
      }
    }
  ];

  // Demo customers
  const customers = [
    {
      phone_number: '+15558881234',
      name: 'Sarah Johnson',
      address: '123 Main St, Beverly Hills, CA',
      zip_code: '90210'
    },
    {
      phone_number: '+15558885678',
      name: 'Mike Rodriguez',
      address: '456 Oak Ave, Beverly Hills, CA',
      zip_code: '90210'
    },
    {
      phone_number: '+15558889999',
      name: 'Emma Chen',
      address: '789 Pine Blvd, Beverly Hills, CA',
      zip_code: '90210'
    }
  ];

  // Insert contractors
  console.log('Creating demo contractors...');
  const contractorIds = [];
  for (const contractor of contractors) {
    try {
      const contractorId = db.createContractor(contractor);
      contractorIds.push(contractorId);
      console.log(`✅ Created contractor: ${contractor.business_name} (ID: ${contractorId})`);
    } catch (error) {
      if (error.message.includes('UNIQUE constraint failed')) {
        console.log(`⚠️  Contractor ${contractor.business_name} already exists, skipping...`);
        const existing = db.getContractorByPhone(contractor.phone_number);
        contractorIds.push(existing.id);
      } else {
        throw error;
      }
    }
  }

  // Insert customers
  console.log('\nCreating demo customers...');
  const customerIds = [];
  for (const customer of customers) {
    try {
      const customerId = db.createCustomer(customer);
      customerIds.push(customerId);
      console.log(`✅ Created customer: ${customer.name} (ID: ${customerId})`);
    } catch (error) {
      if (error.message.includes('UNIQUE constraint failed')) {
        console.log(`⚠️  Customer ${customer.name} already exists, skipping...`);
        const existing = db.getCustomerByPhone(customer.phone_number);
        customerIds.push(existing.id);
      } else {
        throw error;
      }
    }
  }

  // Demo jobs
  console.log('\nCreating demo jobs...');
  const jobs = [
    {
      customer_id: customerIds[0],
      contractor_id: contractorIds[0], // ABC Plumbing
      job_uuid: uuidv4(),
      problem_description: 'Kitchen sink is leaking under the cabinet',
      service_category: 'plumbing',
      urgency_level: 'medium',
      customer_address: '123 Main St, Beverly Hills, CA',
      customer_zip: '90210',
      estimated_cost_min: 120,
      estimated_cost_max: 200,
      final_quote: 165,
      status: 'completed'
    },
    {
      customer_id: customerIds[1],
      contractor_id: contractorIds[1], // ElectriCorp
      job_uuid: uuidv4(),
      problem_description: 'Need ceiling fan installed in bedroom',
      service_category: 'electrical',
      urgency_level: 'low',
      customer_address: '456 Oak Ave, Beverly Hills, CA',
      customer_zip: '90210',
      estimated_cost_min: 200,
      estimated_cost_max: 300,
      status: 'scheduled'
    },
    {
      customer_id: customerIds[2],
      contractor_id: null, // Unassigned
      job_uuid: uuidv4(),
      problem_description: 'Bathroom outlet not working, no power',
      service_category: 'electrical',
      urgency_level: 'high',
      customer_address: '789 Pine Blvd, Beverly Hills, CA',
      customer_zip: '90210',
      estimated_cost_min: 150,
      estimated_cost_max: 250,
      status: 'quoted'
    },
    {
      customer_id: customerIds[0],
      contractor_id: contractorIds[2], // Handy Dave
      job_uuid: uuidv4(),
      problem_description: 'Need help assembling IKEA furniture',
      service_category: 'general_handyman',
      urgency_level: 'low',
      customer_address: '123 Main St, Beverly Hills, CA',
      customer_zip: '90210',
      estimated_cost_min: 100,
      estimated_cost_max: 150,
      status: 'pending'
    }
  ];

  for (const job of jobs) {
    try {
      const jobId = db.createJob(job);
      console.log(`✅ Created job: "${job.problem_description}" (ID: ${jobId})`);
      
      // Add some completion data for completed jobs
      if (job.status === 'completed') {
        db.db.prepare('UPDATE jobs SET completion_date = ?, customer_rating = ? WHERE id = ?')
          .run(new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(), 5, jobId);
      }
    } catch (error) {
      console.error(`❌ Failed to create job: ${error.message}`);
    }
  }

  // Demo conversations (to show conversation state tracking)
  console.log('\nCreating demo conversations...');
  for (let i = 0; i < customers.length; i++) {
    const conversation = db.getOrCreateConversation(customers[i].phone_number);
    console.log(`✅ Created conversation for: ${customers[i].name}`);
  }

  // Demo messages (sample conversation history)
  console.log('\nCreating demo message history...');
  const demoMessages = [
    {
      from: customers[0].phone_number,
      to: process.env.TWILIO_PHONE_NUMBER || '+15550000000',
      body: 'Kitchen sink is leaking under the cabinet',
      direction: 'inbound'
    },
    {
      from: process.env.TWILIO_PHONE_NUMBER || '+15550000000',
      to: customers[0].phone_number,
      body: 'Thanks! I understand you need help with plumbing. How bad is the leak? Is it a steady drip or more of a stream?',
      direction: 'outbound'
    }
  ];

  for (const msg of demoMessages) {
    try {
      db.saveMessage(msg.from, msg.to, msg.body, msg.direction);
    } catch (error) {
      console.log(`⚠️  Message already exists, skipping...`);
    }
  }

  console.log('\n🎉 Database seeded successfully!');
  console.log('\nDemo Data Summary:');
  console.log(`- ${contractors.length} contractors`);
  console.log(`- ${customers.length} customers`);
  console.log(`- ${jobs.length} jobs`);
  console.log(`- ${demoMessages.length} messages`);
  
  console.log('\nDemo Contractor Logins:');
  contractors.forEach(contractor => {
    console.log(`- ${contractor.business_name}: ${contractor.phone_number}`);
  });

  console.log('\nTest the system:');
  console.log('1. Start the server: npm start');
  console.log('2. Visit dashboard: http://localhost:3000/dashboard');
  console.log('3. Login with one of the demo contractor phone numbers above');
  console.log('4. Or test SMS: POST to /webhook/test-sms with demo customer numbers');

} catch (error) {
  console.error('❌ Seeding failed:', error.message);
  console.error(error.stack);
  process.exit(1);
} finally {
  db.close();
}