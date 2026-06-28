const express = require("express");
const { google } = require("googleapis");
const { createClient } = require("@supabase/supabase-js");

const app = express();
const PORT = process.env.PORT || 3000;

// --- Supabase client (uses the secret service key, server-side only) ---
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// --- Helper: build a fresh Google OAuth client from our env vars ---
function makeOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
}

// The calendar permission we request. "events.readonly" lets us read
// events to detect conflicts, without permission to change anything.
const SCOPES = [
  "https://www.googleapis.com/auth/calendar.events.readonly",
  "https://www.googleapis.com/auth/userinfo.email",
];

// --- Health check ---
app.get("/", (req, res) => {
  res.send("VaultContext backend is live.");
});

// --- Step 1: send the user to Google to authorize ---
app.get("/connect", (req, res) => {
  const oauth2Client = makeOAuthClient();
  const url = oauth2Client.generateAuthUrl({
    access_type: "offline",      // so we get a refresh token
    prompt: "consent",           // always show consent (ensures refresh token)
    scope: SCOPES,
  });
  res.redirect(url);
});

// --- Step 2: Google sends the user back here with a code ---
app.get("/oauth/callback", async (req, res) => {
  const code = req.query.code;
  if (!code) {
    return res.status(400).send("Missing authorization code.");
  }

  try {
    const oauth2Client = makeOAuthClient();

    // Exchange the code for access + refresh tokens.
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);

    // Find out which Google account just authorized (their email).
    const oauth2 = google.oauth2({ version: "v2", auth: oauth2Client });
    const userInfo = await oauth2.userinfo.get();
    const userEmail = userInfo.data.email;

    // Save (or update) this user's tokens in Supabase.
    const { error } = await supabase
      .from("calendar_connections")
      .upsert(
        {
          user_email: userEmail,
          google_access_token: tokens.access_token,
          google_refresh_token: tokens.refresh_token,
          token_expiry: tokens.expiry_date
            ? new Date(tokens.expiry_date).toISOString()
            : null,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "user_email" }
      );

    if (error) {
      console.error("Supabase save error:", error);
      return res.status(500).send("Failed to save calendar connection.");
    }

    res.send(
      `Calendar connected successfully for ${userEmail}. You can close this tab.`
    );
  } catch (err) {
    console.error("OAuth callback error:", err);
    res.status(500).send("Something went wrong connecting your calendar.");
  }
});

// --- Start the server ---
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});