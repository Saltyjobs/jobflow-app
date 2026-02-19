const cron = require('node-cron');
const db = require('./db');
const sms = require('./sms');

class JobScheduler {
  constructor() {
    this.jobs = new Map(); // Store active cron jobs
    this.startScheduledTasks();
  }

  startScheduledTasks() {
    // Daily reminder check at 9 AM
    cron.schedule('0 9 * * *', () => {
      this.sendDayBeforeReminders();
    });

    // Follow-up check at 6 PM daily
    cron.schedule('0 18 * * *', () => {
      this.sendJobFollowups();
    });

    // Cleanup old sessions at midnight
    cron.schedule('0 0 * * *', () => {
      this.cleanupExpiredSessions();
    });

    console.log('Scheduler tasks started');
  }

  // Schedule a job between contractor and customer
  scheduleJob(jobId, contractorId, scheduledDate, scheduledTime, notes = null) {
    try {
      // Update job in database
      db.stmts.scheduleJob.run(scheduledDate, scheduledTime, 'scheduled', jobId);
      
      // Get job details for notifications
      const job = db.getJobById(jobId);
      const contractor = db.stmts.getContractorByPhone.get(
        db.stmts.getJobById.get(jobId)?.contractor_id
      );
      const customer = db.stmts.getCustomerById?.get(job?.customer_id);

      if (job && contractor && customer) {
        // Send confirmation to both parties
        this.sendScheduleConfirmation(job, contractor, customer);
        
        // Schedule reminders
        this.scheduleReminders(job, contractor, customer);
        
        return {
          success: true,
          jobId,
          scheduledDate,
          scheduledTime
        };
      }

      return { success: false, error: 'Missing job, contractor, or customer data' };
    } catch (error) {
      console.error('Error scheduling job:', error);
      return { success: false, error: error.message };
    }
  }

  // Send schedule confirmation to both parties
  async sendScheduleConfirmation(job, contractor, customer) {
    const dateStr = new Date(job.scheduled_date).toLocaleDateString();
    const timeStr = job.scheduled_time || 'TBD';

    // Message to customer
    const customerMessage = `📅 Job Scheduled!\n\n` +
      `Date: ${dateStr}\n` +
      `Time: ${timeStr}\n` +
      `Contractor: ${contractor.business_name}\n` +
      `Phone: ${contractor.phone_number}\n\n` +
      `Service: ${job.service_category}\n` +
      `Location: ${job.customer_address}\n\n` +
      `I'll send reminders as the date approaches!`;

    // Message to contractor
    const contractorMessage = `📅 Job Confirmed!\n\n` +
      `Date: ${dateStr}\n` +
      `Time: ${timeStr}\n` +
      `Customer: ${customer.phone_number}\n\n` +
      `Job: ${job.problem_description}\n` +
      `Location: ${job.customer_address}\n` +
      `Quote: $${job.final_quote || job.estimated_cost_min}-${job.estimated_cost_max}`;

    await sms.sendSMS(customer.phone_number, customerMessage);
    await sms.sendSMS(contractor.phone_number, contractorMessage);
  }

  // Schedule automatic reminders
  scheduleReminders(job, contractor, customer) {
    const scheduledDate = new Date(job.scheduled_date);
    const now = new Date();
    
    // Day-before reminder
    const dayBefore = new Date(scheduledDate);
    dayBefore.setDate(dayBefore.getDate() - 1);
    dayBefore.setHours(18, 0, 0, 0); // 6 PM day before

    if (dayBefore > now) {
      const reminderKey = `reminder_${job.id}_day_before`;
      const cronExpression = this.dateToCronExpression(dayBefore);
      
      const cronJob = cron.schedule(cronExpression, async () => {
        await this.sendDayBeforeReminder(job.id);
        this.jobs.delete(reminderKey);
      }, { scheduled: false });
      
      cronJob.start();
      this.jobs.set(reminderKey, cronJob);
    }

    // Day-of reminder (2 hours before)
    const dayOf = new Date(scheduledDate);
    if (job.scheduled_time) {
      const [hour, minute] = job.scheduled_time.split(':').map(Number);
      dayOf.setHours(hour - 2, minute, 0, 0);
    } else {
      dayOf.setHours(8, 0, 0, 0); // Default to 8 AM if no specific time
    }

    if (dayOf > now) {
      const reminderKey = `reminder_${job.id}_day_of`;
      const cronExpression = this.dateToCronExpression(dayOf);
      
      const cronJob = cron.schedule(cronExpression, async () => {
        await this.sendDayOfReminder(job.id);
        this.jobs.delete(reminderKey);
      }, { scheduled: false });
      
      cronJob.start();
      this.jobs.set(reminderKey, cronJob);
    }
  }

  // Send day-before reminders for all jobs
  async sendDayBeforeReminders() {
    try {
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      const tomorrowStr = tomorrow.toISOString().split('T')[0];

      const jobs = db.stmts.getJobsByStatus.all('scheduled');
      
      for (const job of jobs) {
        if (job.scheduled_date === tomorrowStr) {
          await this.sendDayBeforeReminder(job.id);
        }
      }
    } catch (error) {
      console.error('Error sending day-before reminders:', error);
    }
  }

  async sendDayBeforeReminder(jobId) {
    try {
      const job = db.getJobById(jobId);
      if (!job || job.status !== 'scheduled') return;

      // Get contractor and customer info
      const contractor = db.getContractorByPhone(
        // This needs a helper query - simplified for now
        '+1234567890' // Placeholder
      );
      
      const customer = db.getCustomerById?.(job.customer_id);

      if (contractor && customer) {
        await sms.sendDayBeforeReminder(contractor.phone_number, true, job, job.scheduled_date);
        await sms.sendDayBeforeReminder(customer.phone_number, false, {
          ...job,
          contractor_business_name: contractor.business_name
        }, job.scheduled_date);
      }
    } catch (error) {
      console.error('Error sending day-before reminder:', error);
    }
  }

  async sendDayOfReminder(jobId) {
    try {
      const job = db.getJobById(jobId);
      if (!job || job.status !== 'scheduled') return;

      // Send "don't forget" reminder to contractor
      const contractor = db.getContractorByPhone('+1234567890'); // Placeholder
      
      if (contractor) {
        const message = `🔔 Job reminder: You have a scheduled appointment today!\n\n` +
          `Time: ${job.scheduled_time || 'TBD'}\n` +
          `Customer: ${job.customer_id}\n` + // Would need customer phone lookup
          `Location: ${job.customer_address}\n\n` +
          `Text "ON THE WAY" when you're heading to the job.`;

        await sms.sendSMS(contractor.phone_number, message);
      }
    } catch (error) {
      console.error('Error sending day-of reminder:', error);
    }
  }

  // Handle "ON THE WAY" notifications from contractors
  async handleOnTheWayNotification(contractorPhone, message, eta = null) {
    try {
      const contractor = db.getContractorByPhone(contractorPhone);
      if (!contractor) return false;

      // Find today's scheduled job for this contractor
      const today = new Date().toISOString().split('T')[0];
      const jobs = db.getJobsByContractor(contractor.id);
      const todaysJob = jobs.find(job => 
        job.scheduled_date === today && 
        job.status === 'scheduled'
      );

      if (todaysJob) {
        // Update job status
        db.updateJobStatus(todaysJob.id, 'in_progress');

        // Notify customer
        await sms.sendOnTheWayNotification(
          todaysJob.customer_phone,
          contractor.business_name,
          eta
        );

        return true;
      }

      return false;
    } catch (error) {
      console.error('Error handling on-the-way notification:', error);
      return false;
    }
  }

  // Send job completion follow-ups
  async sendJobFollowups() {
    try {
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const yesterdayStr = yesterday.toISOString().split('T')[0];

      // Find jobs completed yesterday
      const allJobs = db.stmts.getJobsByStatus.all('completed');
      const yesterdayJobs = allJobs.filter(job => {
        return job.completion_date && 
               job.completion_date.startsWith(yesterdayStr) &&
               !job.customer_rating; // Haven't been rated yet
      });

      for (const job of yesterdayJobs) {
        const contractor = db.getContractorByPhone('+1234567890'); // Placeholder
        const customer = db.getCustomerById?.(job.customer_id);

        if (contractor && customer) {
          await sms.sendJobCompletionFollowup(
            customer.phone_number,
            contractor.business_name,
            job
          );
        }
      }
    } catch (error) {
      console.error('Error sending job follow-ups:', error);
    }
  }

  // Mark job as completed
  async markJobCompleted(jobId, contractorPhone) {
    try {
      const job = db.getJobById(jobId);
      const contractor = db.getContractorByPhone(contractorPhone);
      
      if (!job || !contractor || job.contractor_id !== contractor.id) {
        return { success: false, error: 'Invalid job or contractor' };
      }

      // Update job status
      db.stmts.updateJobStatus.run('completed', jobId);
      
      // Set completion date
      const now = new Date().toISOString();
      db.db.prepare('UPDATE jobs SET completion_date = ? WHERE id = ?')
        .run(now, jobId);

      // Send invoice request to contractor
      await sms.sendInvoiceRequest(contractorPhone, job);

      // Schedule follow-up for tomorrow
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      tomorrow.setHours(18, 0, 0, 0);

      const followupKey = `followup_${jobId}`;
      const cronExpression = this.dateToCronExpression(tomorrow);
      
      const cronJob = cron.schedule(cronExpression, async () => {
        const customer = db.getCustomerById?.(job.customer_id);
        if (customer) {
          await sms.sendJobCompletionFollowup(
            customer.phone_number,
            contractor.business_name,
            job
          );
        }
        this.jobs.delete(followupKey);
      }, { scheduled: false });
      
      cronJob.start();
      this.jobs.set(followupKey, cronJob);

      return { success: true, jobId };
    } catch (error) {
      console.error('Error marking job completed:', error);
      return { success: false, error: error.message };
    }
  }

  // Get contractor availability for a given date range
  getContractorAvailability(contractorId, startDate, endDate) {
    try {
      // Get contractor's general availability
      const contractor = db.db.prepare('SELECT * FROM contractors WHERE id = ?').get(contractorId);
      if (!contractor) return null;

      const availableHours = JSON.parse(contractor.available_hours || '{}');
      
      // Get existing bookings
      const bookings = db.db.prepare(`
        SELECT scheduled_date, scheduled_time 
        FROM jobs 
        WHERE contractor_id = ? 
        AND scheduled_date BETWEEN ? AND ? 
        AND status IN ('scheduled', 'in_progress')
      `).all(contractorId, startDate, endDate);

      return {
        generalAvailability: availableHours,
        existingBookings: bookings,
        availableSlots: this.calculateAvailableSlots(availableHours, bookings, startDate, endDate)
      };
    } catch (error) {
      console.error('Error getting contractor availability:', error);
      return null;
    }
  }

  // Calculate available time slots
  calculateAvailableSlots(generalAvailability, existingBookings, startDate, endDate) {
    // Simplified implementation - in production would be more sophisticated
    const slots = [];
    const start = new Date(startDate);
    const end = new Date(endDate);
    
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      const dayName = d.toLocaleDateString('en-US', { weekday: 'long' }).toLowerCase();
      const dateStr = d.toISOString().split('T')[0];
      
      // Check if contractor works this day
      if (generalAvailability[dayName]) {
        // Check if already booked
        const isBooked = existingBookings.some(booking => booking.scheduled_date === dateStr);
        
        if (!isBooked) {
          slots.push({
            date: dateStr,
            availableHours: generalAvailability[dayName],
            suggestedTimes: ['9:00 AM', '1:00 PM', '3:00 PM']
          });
        }
      }
    }
    
    return slots;
  }

  // Reschedule a job
  async rescheduleJob(jobId, newDate, newTime, reason = null) {
    try {
      const job = db.getJobById(jobId);
      if (!job) {
        return { success: false, error: 'Job not found' };
      }

      // Update schedule
      db.stmts.scheduleJob.run(newDate, newTime, 'scheduled', jobId);

      // Get contractor and customer for notifications
      const contractor = db.getContractorByPhone('+1234567890'); // Placeholder
      const customer = db.getCustomerById?.(job.customer_id);

      if (contractor && customer) {
        // Notify both parties
        const dateStr = new Date(newDate).toLocaleDateString();
        let message = `📅 Job Rescheduled\n\nNew Date: ${dateStr}\nNew Time: ${newTime}`;
        
        if (reason) {
          message += `\nReason: ${reason}`;
        }

        await sms.sendSMS(customer.phone_number, message);
        await sms.sendSMS(contractor.phone_number, message);

        // Cancel old reminders and schedule new ones
        this.cancelJobReminders(jobId);
        this.scheduleReminders(job, contractor, customer);
      }

      return { success: true, jobId, newDate, newTime };
    } catch (error) {
      console.error('Error rescheduling job:', error);
      return { success: false, error: error.message };
    }
  }

  // Cancel job reminders
  cancelJobReminders(jobId) {
    const reminderKeys = [`reminder_${jobId}_day_before`, `reminder_${jobId}_day_of`];
    
    for (const key of reminderKeys) {
      if (this.jobs.has(key)) {
        this.jobs.get(key).destroy();
        this.jobs.delete(key);
      }
    }
  }

  // Cleanup expired sessions and old data
  async cleanupExpiredSessions() {
    try {
      const now = new Date().toISOString();
      
      // Clean up expired dashboard sessions
      db.db.prepare('DELETE FROM dashboard_sessions WHERE expires_at < ?').run(now);
      
      // Clean up old conversation contexts (older than 7 days with IDLE state)
      const weekAgo = new Date();
      weekAgo.setDate(weekAgo.getDate() - 7);
      
      db.db.prepare(`
        UPDATE conversations 
        SET context = '{}' 
        WHERE state = 'IDLE' 
        AND updated_at < ?
      `).run(weekAgo.toISOString());

      console.log('Cleanup completed');
    } catch (error) {
      console.error('Error during cleanup:', error);
    }
  }

  // Utility function to convert Date to cron expression
  dateToCronExpression(date) {
    const minute = date.getMinutes();
    const hour = date.getHours();
    const dayOfMonth = date.getDate();
    const month = date.getMonth() + 1;
    
    return `${minute} ${hour} ${dayOfMonth} ${month} *`;
  }

  // Stop all scheduled tasks
  stop() {
    for (const [key, job] of this.jobs.entries()) {
      job.destroy();
    }
    this.jobs.clear();
    console.log('Scheduler stopped');
  }
}

module.exports = new JobScheduler();