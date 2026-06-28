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

// --- Helper: get a user's stored tokens and build an authed client ---
async function getAuthedClientForUser(userEmail) {
  const { data, error } = await supabase
    .from("calendar_connections")
    .select("*")
    .eq("user_email", userEmail)
    .single();

  if (error || !data) {
    throw new Error("No stored connection for " + userEmail);
  }

  const oauth2Client = makeOAuthClient();
  oauth2Client.setCredentials({
    access_token: data.google_access_token,
    refresh_token: data.google_refresh_token,
  });

  return { oauth2Client, connection: data };
}

// --- Phase 3a: Register a watch on the user's calendar ---
app.get("/watch", async (req, res) => {
  const userEmail = req.query.email;
  if (!userEmail) {
    return res.status(400).send("Missing ?email= parameter.");
  }

  try {
    const { oauth2Client } = await getAuthedClientForUser(userEmail);
    const calendar = google.calendar({ version: "v3", auth: oauth2Client });

    // First, do an initial sync to capture a starting syncToken.
    const initialList = await calendar.events.list({
      calendarId: "primary",
      timeMin: new Date().toISOString(),
      singleEvents: true,
    });
    const syncToken = initialList.data.nextSyncToken;

    // A unique channel ID for this watch.
    const channelId = "vc-" + userEmail + "-" + Date.now();

    // Tell Google to send change notifications to our /notifications route.
    const watchResponse = await calendar.events.watch({
      calendarId: "primary",
      requestBody: {
        id: channelId,
        type: "web_hook",
        address: "https://vaultcontext-backend.onrender.com/notifications",
      },
    });

    // Save the watch details so we can match notifications back to this user.
    const { error } = await supabase
      .from("calendar_connections")
      .update({
        watch_channel_id: channelId,
        watch_resource_id: watchResponse.data.resourceId,
        watch_expiration: watchResponse.data.expiration
          ? new Date(Number(watchResponse.data.expiration)).toISOString()
          : null,
        sync_token: syncToken,
        updated_at: new Date().toISOString(),
      })
      .eq("user_email", userEmail);

    if (error) {
      console.error("Failed to save watch details:", error);
      return res.status(500).send("Watch registered but failed to save.");
    }

    res.send("Watch registered successfully for " + userEmail);
  } catch (err) {
    console.error("Watch registration error:", err);
    res.status(500).send("Failed to register watch: " + err.message);
  }
});

// --- Phase 3b: Receive notifications from Google ---
app.post("/notifications", (req, res) => {
  // Google sends details in the request headers.
  const channelId = req.headers["x-goog-channel-id"];
  const resourceState = req.headers["x-goog-resource-state"];

  console.log("=== NOTIFICATION RECEIVED ===");
  console.log("Channel ID:", channelId);
  console.log("Resource State:", resourceState);

  // Always respond 200 quickly so Google knows we got it.
  res.status(200).send("OK");
});


// --- Start the server ---
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});