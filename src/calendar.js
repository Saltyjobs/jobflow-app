const { google } = require('googleapis');
const db = require('./db');

const SCOPES = ['https://www.googleapis.com/auth/calendar'];

function getOAuth2Client() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
}

function getAuthUrl(contractorId) {
  const oauth2Client = getOAuth2Client();
  return oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES,
    state: String(contractorId),
  });
}

async function handleCallback(code, contractorId) {
  const oauth2Client = getOAuth2Client();
  const { tokens } = await oauth2Client.getToken(code);
  oauth2Client.setCredentials(tokens);

  // Get user email
  const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
  let email = '';
  try {
    const userInfo = await oauth2.userinfo.get();
    email = userInfo.data.email || '';
  } catch (e) {
    console.error('Could not fetch user email:', e.message);
  }

  const existing = db.getCalendarTokens(contractorId);
  if (existing) {
    db.updateCalendarTokens(contractorId, {
      google_email: email,
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token || existing.refresh_token,
    });
  } else {
    db.saveCalendarTokens({
      contractor_id: contractorId,
      google_email: email,
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
    });
  }

  return { email, tokens };
}

function getAuthenticatedClient(contractorId) {
  const tokenRow = db.getCalendarTokens(contractorId);
  if (!tokenRow) return null;

  const oauth2Client = getOAuth2Client();
  oauth2Client.setCredentials({
    access_token: tokenRow.access_token,
    refresh_token: tokenRow.refresh_token,
  });

  // Auto-refresh token
  oauth2Client.on('tokens', (tokens) => {
    db.updateCalendarTokens(contractorId, {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token || tokenRow.refresh_token,
      google_email: tokenRow.google_email,
    });
  });

  return oauth2Client;
}

async function getBusySlots(contractorId, startDate, endDate) {
  const auth = getAuthenticatedClient(contractorId);
  if (!auth) return [];

  const calendar = google.calendar({ version: 'v3', auth });
  const res = await calendar.freebusy.query({
    requestBody: {
      timeMin: startDate.toISOString(),
      timeMax: endDate.toISOString(),
      items: [{ id: 'primary' }],
    },
  });

  return res.data.calendars.primary.busy || [];
}

async function getAvailableSlots(contractorId, jobDurationHours = 2, jobZip = null) {
  const contractor = db.getContractorById(contractorId);
  if (!contractor) throw new Error('Contractor not found');

  const availableHours = contractor.available_hours || {};
  const now = new Date();
  const endDate = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

  let busySlots = [];
  try {
    busySlots = await getBusySlots(contractorId, now, endDate);
  } catch (e) {
    console.error('Error fetching busy slots:', e.message);
  }

  const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const slots = [];

  for (let d = 0; d < 7; d++) {
    const day = new Date(now.getTime() + d * 24 * 60 * 60 * 1000);
    const dayName = dayNames[day.getDay()];
    const hours = availableHours[dayName];
    if (!hours) continue;

    const [startH, endH] = hours.split('-').map(Number);
    const slotStart = new Date(day);
    slotStart.setHours(startH, 0, 0, 0);
    const slotEnd = new Date(day);
    slotEnd.setHours(endH, 0, 0, 0);

    // Skip if day is already past
    if (slotEnd <= now) continue;

    // Generate hourly candidate slots
    let cursor = new Date(Math.max(slotStart.getTime(), now.getTime()));
    cursor.setMinutes(0, 0, 0);
    if (cursor < slotStart) cursor = new Date(slotStart);
    // Round up to next hour
    if (cursor.getMinutes() > 0) {
      cursor.setHours(cursor.getHours() + 1, 0, 0, 0);
    }

    while (cursor.getTime() + jobDurationHours * 60 * 60 * 1000 <= slotEnd.getTime()) {
      const candidateEnd = new Date(cursor.getTime() + jobDurationHours * 60 * 60 * 1000);

      // Check against busy slots
      const isBusy = busySlots.some(busy => {
        const busyStart = new Date(busy.start);
        const busyEnd = new Date(busy.end);
        return cursor < busyEnd && candidateEnd > busyStart;
      });

      if (!isBusy) {
        slots.push({
          start: new Date(cursor),
          end: candidateEnd,
          date: cursor.toISOString().split('T')[0],
          time: `${cursor.getHours()}:${String(cursor.getMinutes()).padStart(2, '0')}`,
          display: `${cursor.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })} at ${cursor.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`,
        });
      }

      cursor = new Date(cursor.getTime() + 60 * 60 * 1000); // 1 hour increments
    }
  }

  // Return top 3 slots (prefer morning, spread across days)
  const byDay = {};
  for (const s of slots) {
    if (!byDay[s.date]) byDay[s.date] = [];
    byDay[s.date].push(s);
  }

  const result = [];
  const days = Object.keys(byDay).sort();
  for (const day of days) {
    if (result.length >= 3) break;
    // Pick earliest slot from each day first
    result.push(byDay[day][0]);
  }
  // If less than 3, fill from remaining
  if (result.length < 3) {
    for (const s of slots) {
      if (result.length >= 3) break;
      if (!result.find(r => r.start.getTime() === s.start.getTime())) {
        result.push(s);
      }
    }
  }

  return result.slice(0, 3);
}

async function createCalendarEvent(contractorId, job, customer) {
  const auth = getAuthenticatedClient(contractorId);
  if (!auth) {
    console.log('No calendar auth for contractor', contractorId);
    return null;
  }

  const calendar = google.calendar({ version: 'v3', auth });

  const startDateTime = new Date(`${job.scheduled_date}T${job.scheduled_time || '09:00'}:00`);
  const endDateTime = new Date(startDateTime.getTime() + 2 * 60 * 60 * 1000); // Default 2 hours

  const event = {
    summary: `🔧 ${job.service_category || 'Service'} - ${job.customer_address || 'TBD'}`,
    description: [
      `Job #${job.job_uuid || job.id}`,
      `Customer: ${customer?.name || 'N/A'}`,
      `Phone: ${customer?.phone_number || 'N/A'}`,
      `Address: ${job.customer_address || 'N/A'}`,
      `Problem: ${job.problem_description || 'N/A'}`,
      `Estimate: $${job.estimated_cost_min || '?'}-$${job.estimated_cost_max || '?'}`,
    ].join('\n'),
    start: {
      dateTime: startDateTime.toISOString(),
      timeZone: 'America/New_York',
    },
    end: {
      dateTime: endDateTime.toISOString(),
      timeZone: 'America/New_York',
    },
    location: job.customer_address || '',
    reminders: {
      useDefault: false,
      overrides: [
        { method: 'popup', minutes: 60 },
        { method: 'popup', minutes: 15 },
      ],
    },
  };

  try {
    const result = await calendar.events.insert({
      calendarId: 'primary',
      requestBody: event,
    });
    console.log('Calendar event created:', result.data.htmlLink);
    return result.data;
  } catch (e) {
    console.error('Error creating calendar event:', e.message);
    return null;
  }
}

module.exports = {
  getAuthUrl,
  handleCallback,
  getAuthenticatedClient,
  getAvailableSlots,
  createCalendarEvent,
  getBusySlots,
};
