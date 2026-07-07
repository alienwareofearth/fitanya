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

// Fallback: Jitsi Meet — no API, no host required, always works
function jitsiFallback() {
  const seg = () => Math.random().toString(36).slice(2, 6);
  const roomId = `fitanya-${seg()}-${seg()}-${seg()}`;
  const config = '#config.lobby.enabled=false&config.prejoinPageEnabled=false&config.startWithAudioMuted=false&config.startWithVideoMuted=false';
  return { meetLink: `https://meet.jit.si/${roomId}${config}`, eventId: `jitsi-${roomId}` };
}

async function createMeetSession({ summary, description, date, startTime, endTime, attendeeEmails }) {
  // Check if Google credentials are configured
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_REFRESH_TOKEN) {
    console.warn('[google-meet] Google credentials not set — using Jitsi fallback');
    return jitsiFallback();
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
      console.warn('[google-meet] Calendar API returned no Meet link — using Jitsi fallback');
      return jitsiFallback();
    }

    return { meetLink, eventId: response.data.id };
  } catch (err) {
    console.error('[google-meet] Calendar API error — using Jitsi fallback:', err.message);
    return jitsiFallback();
  }
}

async function deleteMeetSession(eventId) {
  if (!eventId || eventId.startsWith('jitsi-')) return; // nothing to delete for Jitsi rooms
  try {
    const auth = getAuthClient();
    const calendar = google.calendar({ version: 'v3', auth });
    await calendar.events.delete({ calendarId: 'primary', eventId });
  } catch (err) {
    console.error('[google-meet] Failed to delete event:', err.message);
  }
}

module.exports = { createMeetSession, deleteMeetSession };
