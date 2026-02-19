require('dotenv').config();

const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');

// Import modules
const db = require('./db');
const webhookRoutes = require('./routes/webhook');
const dashboardRoutes = require('./routes/dashboard');
const apiRoutes = require('./routes/api');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Serve static files
app.use('/public', express.static(path.join(__dirname, '../public')));

// Health check endpoint
app.get('/', (req, res) => {
  res.json({ 
    service: 'JobFlow API',
    status: 'running',
    version: '1.0.0',
    timestamp: new Date().toISOString()
  });
});

// API Routes
app.use('/webhook', webhookRoutes);
app.use('/dashboard', dashboardRoutes);
app.use('/api', apiRoutes);

// SMS Test endpoint for development
if (process.env.NODE_ENV === 'development') {
  app.get('/test', (req, res) => {
    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>JobFlow Test</title>
        <style>
          body { font-family: Arial, sans-serif; max-width: 800px; margin: 0 auto; padding: 20px; }
          .form-group { margin-bottom: 15px; }
          label { display: block; margin-bottom: 5px; font-weight: bold; }
          input, textarea { width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 4px; }
          button { background: #007bff; color: white; padding: 10px 20px; border: none; border-radius: 4px; cursor: pointer; }
          button:hover { background: #0056b3; }
          .response { margin-top: 20px; padding: 15px; background: #f8f9fa; border-radius: 4px; }
          .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 15px; margin-top: 20px; }
          .stat-card { padding: 15px; background: #e9ecef; border-radius: 4px; text-align: center; }
        </style>
      </head>
      <body>
        <h1>JobFlow Development Test</h1>
        
        <h2>Test SMS Conversation</h2>
        <form id="smsForm">
          <div class="form-group">
            <label>Phone Number:</label>
            <input type="tel" id="phoneNumber" value="+1234567890" required>
          </div>
          <div class="form-group">
            <label>Message:</label>
            <textarea id="message" rows="3" placeholder="Enter your test message..." required></textarea>
          </div>
          <button type="submit">Send Test Message</button>
        </form>
        
        <div id="response" class="response" style="display: none;"></div>
        
        <h2>Quick Test Messages</h2>
        <div>
          <button onclick="sendQuickMessage('SETUP')">Contractor Setup</button>
          <button onclick="sendQuickMessage('My sink is leaking')">Customer Problem</button>
          <button onclick="sendQuickMessage('DASHBOARD')">Dashboard Access</button>
        </div>
        
        <h2>System Stats</h2>
        <div id="stats" class="stats"></div>
        
        <script>
          document.getElementById('smsForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            
            const phoneNumber = document.getElementById('phoneNumber').value;
            const message = document.getElementById('message').value;
            
            try {
              const response = await fetch('/webhook/test-sms', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ phoneNumber, message })
              });
              
              const result = await response.json();
              
              document.getElementById('response').style.display = 'block';
              document.getElementById('response').innerHTML = 
                '<h3>Response:</h3>' +
                '<p><strong>Your message:</strong> ' + result.incomingMessage + '</p>' +
                '<p><strong>JobFlow response:</strong> ' + result.aiResponse + '</p>';
              
            } catch (error) {
              document.getElementById('response').innerHTML = '<p style="color: red;">Error: ' + error.message + '</p>';
            }
          });
          
          function sendQuickMessage(message) {
            document.getElementById('message').value = message;
            document.getElementById('smsForm').dispatchEvent(new Event('submit'));
          }
          
          // Load stats
          fetch('/api/stats')
            .then(r => r.json())
            .then(data => {
              const statsDiv = document.getElementById('stats');
              statsDiv.innerHTML = 
                '<div class="stat-card"><h3>' + data.contractors.total + '</h3><p>Total Contractors</p></div>' +
                '<div class="stat-card"><h3>' + data.customers.total + '</h3><p>Total Customers</p></div>' +
                '<div class="stat-card"><h3>' + data.jobs.total + '</h3><p>Total Jobs</p></div>' +
                '<div class="stat-card"><h3>' + data.messages.total + '</h3><p>Total Messages</p></div>';
            })
            .catch(e => console.error('Stats error:', e));
        </script>
      </body>
      </html>
    `);
  });
}

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ 
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  db.close();
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down gracefully');
  db.close();
  process.exit(0);
});

// Start server
app.listen(PORT, () => {
  console.log(`
🚀 JobFlow server running on port ${PORT}

Environment: ${process.env.NODE_ENV || 'development'}
Database: ${process.env.DB_PATH || './db/jobflow.db'}
Twilio: ${process.env.TWILIO_PHONE_NUMBER ? 'Configured' : 'Not configured'}
OpenAI: ${process.env.OPENAI_API_KEY ? 'Configured' : 'Not configured'}

Endpoints:
  GET  /                  - Health check
  POST /webhook/sms       - Twilio SMS webhook
  GET  /dashboard         - Contractor dashboard
  GET  /api/stats         - System statistics
  ${process.env.NODE_ENV === 'development' ? 'GET  /test             - Development test page' : ''}

Ready to receive SMS messages! 📱
  `);
});

module.exports = app;