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

async function createMeetSession({ summary, description, date, startTime, endTime, attendeeEmails }) {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_REFRESH_TOKEN) {
    console.warn('[google-meet] Google credentials not set — meet link will be generated later');
    return { meetLink: null, eventId: null };
  }

  try {
    const auth = getAuthClient();
    const calendar = google.calendar({ version: 'v3', auth });

    const event = {
      summary,
      description,
      start: { dateTime: `${date}T${startTime}:00+05:30`, timeZone: 'Asia/Kolkata' },
      end:   { dateTime: `${date}T${endTime}:00+05:30`,   timeZone: 'Asia/Kolkata' },
      attendees: attendeeEmails.map(email => ({ email })),
      conferenceData: {
        createRequest: {
          requestId: `fitanya-${Date.now()}-${Math.random().toString(36).slice(2,8)}`,
          conferenceSolutionKey: { type: 'hangoutsMeet' },
        },
      },
      reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 30 }] },
    };

    const response = await calendar.events.insert({
      calendarId: 'primary',
      resource: event,
      conferenceDataVersion: 1,
      sendUpdates: 'none',
    });

    const meetLink = response.data.conferenceData?.entryPoints?.find(e => e.entryPointType === 'video')?.uri;
    if (!meetLink) {
      console.warn('[google-meet] Calendar API returned no Meet link');
      return { meetLink: null, eventId: response.data.id };
    }

    return { meetLink, eventId: response.data.id };
  } catch (err) {
    console.error('[google-meet] Calendar API error:', err.message);
    return { meetLink: null, eventId: null };
  }
}

async function deleteMeetSession(eventId) {
  if (!eventId) return;
  try {
    const auth = getAuthClient();
    const calendar = google.calendar({ version: 'v3', auth });
    await calendar.events.delete({ calendarId: 'primary', eventId });
  } catch (err) {
    console.error('[google-meet] Failed to delete event:', err.message);
  }
}

module.exports = { createMeetSession, deleteMeetSession };
