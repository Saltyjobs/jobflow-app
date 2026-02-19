#!/usr/bin/env node

require('dotenv').config();
const db = require('../src/db');

console.log('Setting up JobFlow database...');

try {
  // Database is automatically initialized when db module is imported
  console.log('✅ Database schema created successfully');
  
  // Test basic operations
  const testInsert = db.db.prepare('INSERT INTO contractors (phone_number, business_name, trade_type, service_area_zip, base_service_fee, hourly_rate) VALUES (?, ?, ?, ?, ?, ?)');
  const testContractorId = testInsert.run('+1555TEST00', 'Test Business', 'test', '12345', 100, 75).lastInsertRowid;
  
  // Clean up test data
  db.db.prepare('DELETE FROM contractors WHERE id = ?').run(testContractorId);
  
  console.log('✅ Database operations test successful');
  console.log('✅ Database setup complete!');
  
  console.log('\nNext steps:');
  console.log('1. Copy .env.example to .env and fill in your credentials');
  console.log('2. Run: npm run seed (to add demo data)');
  console.log('3. Run: npm start (to start the server)');
  
} catch (error) {
  console.error('❌ Database setup failed:', error.message);
  process.exit(1);
} finally {
  db.close();
}