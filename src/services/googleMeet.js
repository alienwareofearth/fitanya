'use strict';

const { google } = require('googleapis');

// Read refresh token from DB first; fall back to env var
async function getRefreshToken() {
  try {
    const { getDb } = require('../config/database');
    const db = getDb();
    const row = await db.execute(`SELECT value FROM app_settings WHERE key = 'google_refresh_token' LIMIT 1`);
    if (row.rows.length && row.rows[0].value) return row.rows[0].value;
  } catch (_) {}
  return process.env.GOOGLE_REFRESH_TOKEN || null;
}

async function getAuthClient() {
  const refreshToken = await getRefreshToken();
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
  oauth2Client.setCredentials({ refresh_token: refreshToken });
  return oauth2Client;
}

async function createMeetSession({ summary, description, date, startTime, endTime, attendeeEmails }) {
  const refreshToken = await getRefreshToken();
  if (!process.env.GOOGLE_CLIENT_ID || !refreshToken) {
    console.warn('[google-meet] Google credentials not set — meet link will be generated later');
    return { meetLink: null, eventId: null };
  }

  try {
    const auth = await getAuthClient();
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
    const auth = await getAuthClient();
    const calendar = google.calendar({ version: 'v3', auth });
    await calendar.events.delete({ calendarId: 'primary', eventId });
  } catch (err) {
    console.error('[google-meet] Failed to delete event:', err.message);
  }
}

module.exports = { createMeetSession, deleteMeetSession };
