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
// --- Resend email client ---
const { Resend } = require("resend");
const resend = new Resend(process.env.RESEND_API_KEY);

// --- Helper: send a conflict alert email ---
async function sendConflictEmail(toEmail, conflict) {
  try {
    const resolveLink = "https://vaultcontext-backend.onrender.com"; // placeholder — will point to your web app later

    const { data, error } = await resend.emails.send({
      from: "VaultContext <onboarding@resend.dev>",
      to: toEmail,
      subject: `⚠️ Calendar Conflict: ${conflict.new_event} overlaps ${conflict.conflict_with}`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 500px; margin: 0 auto;">
          <h2 style="color: #d97706;">Calendar Conflict Detected</h2>
          <p>Two of your events overlap:</p>
          <div style="background: #f3f4f6; border-radius: 8px; padding: 16px; margin: 16px 0;">
            <p style="margin: 0 0 8px;"><strong>${conflict.new_event}</strong><br/>
            ${conflict.new_start} → ${conflict.new_end}</p>
            <p style="margin: 0; color: #6b7280;">overlaps with</p>
            <p style="margin: 8px 0 0;"><strong>${conflict.conflict_with}</strong><br/>
            ${conflict.existing_start} → ${conflict.existing_end}</p>
          </div>
          <p style="color: #6b7280;">Overlap: <strong>${conflict.overlap_minutes} minutes</strong></p>
          <a href="${resolveLink}" style="display: inline-block; background: #2563eb; color: white; padding: 10px 20px; border-radius: 6px; text-decoration: none; margin-top: 8px;">Resolve Conflict</a>
        </div>
      `,
    });

    if (error) {
      console.error("Email send error:", error);
    } else {
      console.log("Conflict alert email sent to", toEmail);
    }
  } catch (err) {
    console.error("Email send exception:", err.message);
  }
}
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
// --- The deterministic conflict engine ---
// Pure math. Same input → same output. Timezone-safe (works on UTC ms).
function detectConflict(newEvent, existingEvents) {
  const newStart = new Date(newEvent.startISO).getTime();
  const newEnd = new Date(newEvent.endISO).getTime();

  if (isNaN(newStart) || isNaN(newEnd)) {
    return { conflict_detected: false, error: "Invalid new event timestamps" };
  }

  const WINDOW_MIN = 30; // minimum overlap (minutes) that counts as a conflict

  for (const ev of existingEvents) {
    // Skip the event matching itself.
    if (ev.id && newEvent.id && ev.id === newEvent.id) continue;

    const evStart = new Date(ev.startISO).getTime();
    const evEnd = new Date(ev.endISO).getTime();
    if (isNaN(evStart) || isNaN(evEnd)) continue;

    // Core math: overlap = later start to earlier end.
    const overlapStart = Math.max(newStart, evStart);
    const overlapEnd = Math.min(newEnd, evEnd);
    const overlapMinutes = (overlapEnd - overlapStart) / (1000 * 60);

    if (overlapMinutes >= WINDOW_MIN) {
      return {
        conflict_detected: true,
        conflict_with: ev.title || "Untitled Event",
        overlap_minutes: Math.round(overlapMinutes),
        new_event: newEvent.title,
        new_start: newEvent.startISO,
        new_end: newEvent.endISO,
        existing_start: ev.startISO,
        existing_end: ev.endISO,
      };
    }
  }

  return { conflict_detected: false };
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
    const channelId = "vc-" + Date.now() + "-" + Math.floor(Math.random() * 100000);

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

// --- Phase 4: Receive notification and fetch what changed ---
app.post("/notifications", async (req, res) => {
  const channelId = req.headers["x-goog-channel-id"];
  const resourceState = req.headers["x-goog-resource-state"];

  // Respond 200 immediately so Google knows we received it.
  res.status(200).send("OK");

  // Google sends a "sync" ping right after watch setup — ignore it.
  if (resourceState === "sync") {
    console.log("Sync notification received, ignoring.");
    return;
  }

  console.log("=== CHANGE NOTIFICATION ===");
  console.log("Channel ID:", channelId);

  try {
    // 1. Find which user this channel belongs to.
    const { data: connection, error: lookupError } = await supabase
      .from("calendar_connections")
      .select("*")
      .eq("watch_channel_id", channelId)
      .single();

    if (lookupError || !connection) {
      console.error("No user found for channel:", channelId);
      return;
    }

    const userEmail = connection.user_email;
    console.log("Belongs to user:", userEmail);

    // 2. Build an authed Google client (auto-refreshes the token).
    const oauth2Client = makeOAuthClient();
    oauth2Client.setCredentials({
      access_token: connection.google_access_token,
      refresh_token: connection.google_refresh_token,
    });

    // If the library refreshes the token, save the new one back.
    oauth2Client.on("tokens", async (newTokens) => {
      if (newTokens.access_token) {
        await supabase
          .from("calendar_connections")
          .update({
            google_access_token: newTokens.access_token,
            updated_at: new Date().toISOString(),
          })
          .eq("user_email", userEmail);
        console.log("Access token refreshed and saved.");
      }
    });

    const calendar = google.calendar({ version: "v3", auth: oauth2Client });

    // 3. Use the stored sync token to fetch ONLY what changed.
    const listResult = await calendar.events.list({
      calendarId: "primary",
      syncToken: connection.sync_token,
    });

    const changedEvents = listResult.data.items || [];

    // 4. Save the new sync token for next time.
    if (listResult.data.nextSyncToken) {
      await supabase
        .from("calendar_connections")
        .update({
          sync_token: listResult.data.nextSyncToken,
          updated_at: new Date().toISOString(),
        })
        .eq("user_email", userEmail);
    }

    // 5. For each changed event, check for conflicts.
    for (const changed of changedEvents) {
      // Skip cancelled events.
      if (changed.status === "cancelled") continue;

      // Get the changed event's start/end in ISO form.
      const changedStart = changed.start
        ? changed.start.dateTime || changed.start.date
        : null;
      const changedEnd = changed.end
        ? changed.end.dateTime || changed.end.date
        : null;

      if (!changedStart || !changedEnd) continue;

      console.log("Checking conflicts for:", changed.summary);

      // Search the calendar AROUND this event's time (its own date window).
      const windowStart = new Date(new Date(changedStart).getTime() - 60 * 60 * 1000);
      const windowEnd = new Date(new Date(changedEnd).getTime() + 60 * 60 * 1000);

      const nearby = await calendar.events.list({
        calendarId: "primary",
        timeMin: windowStart.toISOString(),
        timeMax: windowEnd.toISOString(),
        singleEvents: true,
        orderBy: "startTime",
      });

      // Shape the events for the engine.
      const existingEvents = (nearby.data.items || []).map((ev) => ({
        id: ev.id,
        title: ev.summary,
        startISO: ev.start ? ev.start.dateTime || ev.start.date : null,
        endISO: ev.end ? ev.end.dateTime || ev.end.date : null,
      }));

      const newEvent = {
        id: changed.id,
        title: changed.summary,
        startISO: changedStart,
        endISO: changedEnd,
      };

      // Run the deterministic engine.
      const result = detectConflict(newEvent, existingEvents);

      if (result.conflict_detected) {
        console.log("⚠️ CONFLICT DETECTED!");
        console.log(`  ${result.new_event} (${result.new_start})`);
        console.log(`  overlaps ${result.conflict_with} by ${result.overlap_minutes} min`);
        await sendConflictEmail(userEmail, result);
      } else {
        console.log("✓ No conflict for", changed.summary);
      }
    }
  } catch (err) {
    console.error("Error fetching changes:", err.message);
  }
});


// --- Start the server ---
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});