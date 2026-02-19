require('dotenv').config();

const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use('/public', express.static(path.join(__dirname, '../public')));

// Health check
app.get('/', (req, res) => {
  res.json({ service: 'JobFlow API', status: 'running', version: '1.0.0' });
});

async function start() {
  // Initialize database first
  const db = require('./db');
  await db.initDb();
  console.log('Database ready');

  // Now load routes (they require db which is now initialized)
  const webhookRoutes = require('./routes/webhook');
  const dashboardRoutes = require('./routes/dashboard');
  const apiRoutes = require('./routes/api');

  app.use('/webhook', webhookRoutes);
  app.use('/dashboard', dashboardRoutes);
  app.use('/api', apiRoutes);

  // Dev test page
  if (process.env.NODE_ENV === 'development') {
    app.get('/test', (req, res) => {
      res.send(`
        <!DOCTYPE html><html><head><title>JobFlow Test</title>
        <style>
          body{font-family:Arial,sans-serif;max-width:800px;margin:0 auto;padding:20px;background:#f5f5f5}
          .chat{background:#fff;border-radius:12px;padding:20px;margin:20px 0;box-shadow:0 2px 10px rgba(0,0,0,.1)}
          .msg{margin:8px 0;padding:10px 14px;border-radius:18px;max-width:80%;font-size:15px}
          .msg.in{background:#e3f2fd;margin-right:auto}
          .msg.out{background:#e8f5e9;margin-left:auto;text-align:right}
          input,button{padding:12px;border:1px solid #ddd;border-radius:8px;font-size:15px}
          input{width:70%}button{background:#1976d2;color:#fff;border:none;cursor:pointer;margin-left:8px}
          .quick{margin:10px 0}.quick button{background:#f5f5f5;color:#333;margin:4px;font-size:13px}
        </style></head><body>
        <h1>🔧 JobFlow SMS Simulator</h1>
        <div class="quick">
          <button onclick="send('SETUP')">Contractor Setup</button>
          <button onclick="send('My kitchen sink is leaking under the cabinet')">Customer: Leak</button>
          <button onclick="send('I need an electrician, outlets sparking')">Customer: Electrical</button>
          <button onclick="send('A')">Approve Job</button>
        </div>
        <div>
          <input id="phone" value="+1234567890" placeholder="Phone #" style="width:200px">
        </div>
        <div id="chat" class="chat"></div>
        <div>
          <input id="msg" placeholder="Type a message..." onkeydown="if(event.key==='Enter')send()">
          <button onclick="send()">Send</button>
        </div>
        <script>
          const chat=document.getElementById('chat');
          function addMsg(text,dir){const d=document.createElement('div');d.className='msg '+dir;d.textContent=text;chat.appendChild(d);chat.scrollTop=chat.scrollHeight}
          async function send(text){
            const msg=text||document.getElementById('msg').value;if(!msg)return;
            document.getElementById('msg').value='';
            addMsg(msg,'out');
            try{
              const r=await fetch('/webhook/test-sms',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({phoneNumber:document.getElementById('phone').value,message:msg})});
              const d=await r.json();
              addMsg(d.aiResponse||d.error,'in');
            }catch(e){addMsg('Error: '+e.message,'in')}
          }
        </script></body></html>
      `);
    });
  }

  // Error handling
  app.use((err, req, res, next) => {
    console.error('Error:', err);
    res.status(500).json({ error: 'Internal server error' });
  });

  app.listen(PORT, () => {
    console.log(`
🚀 JobFlow running on port ${PORT}

  Twilio:  ${process.env.TWILIO_PHONE_NUMBER || 'Not configured'}
  OpenAI:  ${process.env.OPENAI_API_KEY ? 'Configured' : 'Not configured'}
  Test:    http://localhost:${PORT}/test
  Webhook: http://localhost:${PORT}/webhook/sms

Ready to receive SMS! 📱
    `);
  });
}

start().catch(err => {
  console.error('Failed to start:', err);
  process.exit(1);
});
