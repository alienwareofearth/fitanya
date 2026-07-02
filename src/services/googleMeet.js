'use strict';

const { google } = require('googleapis');

function getAuthClient() {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
  oauth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
  return oauth2Client;
}

/**
 * Create a Google Calendar event with Meet link
 * @param {object} opts
 * @returns {Promise<{meetLink: string, eventId: string}>}
 */
async function createMeetSession({ summary, description, date, startTime, endTime, attendeeEmails }) {
  try {
    const auth = getAuthClient();
    const calendar = google.calendar({ version: 'v3', auth });

    const startDateTime = `${date}T${startTime}:00+05:30`;
    const endDateTime   = `${date}T${endTime}:00+05:30`;

    const event = {
      summary,
      description,
      start: { dateTime: startDateTime, timeZone: 'Asia/Kolkata' },
      end:   { dateTime: endDateTime,   timeZone: 'Asia/Kolkata' },
      attendees: attendeeEmails.map(email => ({ email })),
      conferenceData: {
        createRequest: {
          requestId: `fitanya-${Date.now()}`,
          conferenceSolutionKey: { type: 'hangoutsMeet' },
        },
      },
      reminders: {
        useDefault: false,
        overrides: [
          { method: 'email',  minutes: 24 * 60 },
          { method: 'popup',  minutes: 30 },
        ],
      },
    };

    const response = await calendar.events.insert({
      calendarId: 'primary',
      resource: event,
      conferenceDataVersion: 1,
      sendUpdates: 'all',
    });

    const meetLink = response.data.conferenceData?.entryPoints?.find(e => e.entryPointType === 'video')?.uri || '';
    return { meetLink, eventId: response.data.id };
  } catch (err) {
    console.error('[google-meet] Failed to create event:', err.message);
    // Return a placeholder if Google API not configured
    return {
      meetLink: `https://meet.google.com/placeholder-${Date.now()}`,
      eventId: `placeholder-${Date.now()}`,
    };
  }
}

async function deleteMeetSession(eventId) {
  try {
    const auth = getAuthClient();
    const calendar = google.calendar({ version: 'v3', auth });
    await calendar.events.delete({ calendarId: 'primary', eventId });
  } catch (err) {
    console.error('[google-meet] Failed to delete event:', err.message);
  }
}

module.exports = { createMeetSession, deleteMeetSession };
