'use strict';

// One-time script to get your Google refresh token.
// Run: node get-google-token.js
// Then paste the auth URL in your browser, approve, and paste the code back here.

require('dotenv').config();
const { google } = require('googleapis');
const readline = require('readline');

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI
);

const authUrl = oauth2Client.generateAuthUrl({
  access_type: 'offline',
  prompt: 'consent',
  scope: ['https://www.googleapis.com/auth/calendar'],
});

console.log('\n=== Google OAuth Setup ===\n');
console.log('1. Open this URL in your browser:\n');
console.log(authUrl);
console.log('\n2. Sign in with the Google account that will own the calendar.');
console.log('3. After approving, you\'ll be redirected to your redirect URI.');
console.log('   Copy the "code" query param from the URL.\n');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.question('Paste the code here: ', async (code) => {
  rl.close();
  try {
    const { tokens } = await oauth2Client.getToken(code.trim());
    console.log('\n✅ Success! Add this to your .env:\n');
    console.log(`GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}`);
    console.log('\nKeep this token safe — it gives calendar access to that account.');
  } catch (err) {
    console.error('\n❌ Error exchanging code:', err.message);
    console.error('Make sure the redirect URI in .env matches exactly what you set in Google Cloud Console.');
  }
});
