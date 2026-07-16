const express = require("express");
const { google } = require("googleapis");
const { createClient } = require("@supabase/supabase-js");
const cors = require("cors");
const app = express();
app.use(cors());
const PORT = process.env.PORT || 3000;

// --- Supabase client (uses the secret service key, server-side only) ---
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);
// --- Resend email client ---
const { Resend } = require("resend");
const resend = new Resend(process.env.RESEND_API_KEY);

// --- Helper: format an ISO timestamp into a readable string ---
// Renders in the user's own calendar timezone. Falls back to Asia/Bangkok
// when unknown (older rows), preserving previous behavior.
function formatTime(iso, timeZone) {
  try {
    const d = new Date(iso);
    return d.toLocaleString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
      timeZone: timeZone || "Asia/Bangkok",
    });
  } catch {
    return iso; // fall back to raw if anything goes wrong
  }
}

// --- Helper: send a conflict alert email ---
async function sendConflictEmail(toEmail, conflict, conflictId, timeZone) {
  try {
    const resolveLink = conflictId
  ? `https://vaultcontext.online/resolve?conflictRef=${conflictId}`
  : "https://vaultcontext.online";

    // Send users straight to Google Calendar with a conflict-free time
    // pre-filled. Falls back to the in-app page if the suggestion fails.
    const suggestUrl = buildSuggestUrl(conflict, toEmail);
    const buttonUrl = suggestUrl || resolveLink;

    const { data, error } = await resend.emails.send({
      from: "VaultContext <alerts@vaultcontext.online>",
      to: toEmail,
      subject: conflict.conflict_type === "overlap"
  ? `⚠️ Calendar Conflict: ${conflict.new_event} overlaps ${conflict.conflict_with}`
  : `⏱️ Tight Schedule: ${conflict.new_event} has under 60 min before ${conflict.conflict_with}`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 500px; margin: 0 auto;">
          <h2 style="color: #d97706;">Calendar Conflict Detected</h2>
          <p>${conflict.conflict_type === "overlap" ? "Two of your events overlap:" : "Two of your events are too close together:"}</p>
          <div style="background: #f3f4f6; border-radius: 8px; padding: 16px; margin: 16px 0;">
            <p style="margin: 0 0 8px;"><strong>${conflict.new_event}</strong><br/>
            ${formatTime(conflict.new_start, timeZone)} → ${formatTime(conflict.new_end, timeZone)}</p>
            <p style="margin: 0; color: #6b7280;">${conflict.conflict_type === "overlap" ? "overlaps with" : "is too close to"}</p>
            <p style="margin: 8px 0 0;"><strong>${conflict.conflict_with}</strong><br/>
            ${formatTime(conflict.existing_start, timeZone)} → ${formatTime(conflict.existing_end, timeZone)}</p>
          </div>
          <p style="color: #6b7280;">${conflict.conflict_type === "overlap"
  ? `Overlap: <strong>${conflict.overlap_minutes} minutes</strong>`
  : `Gap: <strong>${conflict.gap_minutes} min</strong> — under 60 min breathing room`
}</p>
          <a href="${buttonUrl}" style="display: inline-block; background: #2563eb; color: white; padding: 10px 20px; border-radius: 6px; text-decoration: none; margin-top: 8px;">Tap to Reschedule</a>
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
// --- Helper: send a resolution-confirmation email (batched, green) ---
// Fires once after auto-resolve clears one or more conflicts, so success
// is audible instead of silent. Self-contained: never throws.
async function sendResolutionEmail(toEmail, resolvedRows) {
  try {
    const count = resolvedRows.length;
    const list = resolvedRows
      .map((r) => `<li style="margin: 4px 0;"><strong>${r.task_name}</strong> vs <strong>${r.conflict_with}</strong></li>`)
      .join("");

    const { error } = await resend.emails.send({
      from: "VaultContext <alerts@vaultcontext.online>",
      to: toEmail,
      subject: `✅ Resolved: ${count} conflict${count === 1 ? "" : "s"}`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 500px; margin: 0 auto;">
          <h2 style="color: #059669;">Conflict Resolved</h2>
          <p>Your recent calendar change${count === 1 ? "" : "s"} cleared the following conflict${count === 1 ? "" : "s"}:</p>
          <div style="background: #f0fdf4; border-radius: 8px; padding: 16px; margin: 16px 0;">
            <ul style="margin: 0; padding-left: 20px; color: #065f46;">
              ${list}
            </ul>
          </div>
          <p style="color: #6b7280;">No further action needed — your calendar is clear.</p>
        </div>
      `,
    });

    if (error) {
      console.error("Resolution email send error:", error);
    } else {
      console.log("Resolution email sent to", toEmail);
    }
  } catch (err) {
    console.error("Resolution email exception:", err.message);
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

    // Auto-register the watch so notifications start immediately
    try {
      await registerWatch(userEmail);
      console.log("✅ OAuth + watch complete for", userEmail);
    } catch (watchErr) {
      console.error("Watch registration failed:", watchErr.message);
      // Don't block the redirect — tokens are saved, watch can be retried
    }

    // Redirect back to the app
    res.redirect("https://vaultcontext.online/mobileSettings");
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

 
  const BUFFER_MIN = 60;  // minimum breathing room between events (minutes)

  for (const ev of existingEvents) {
    if (ev.id && newEvent.id && ev.id === newEvent.id) continue;

    const evStart = new Date(ev.startISO).getTime();
    const evEnd = new Date(ev.endISO).getTime();
    if (isNaN(evStart) || isNaN(evEnd)) continue;

    const overlapStart = Math.max(newStart, evStart);
    const overlapEnd = Math.min(newEnd, evEnd);
    const overlapMinutes = (overlapEnd - overlapStart) / (1000 * 60);

    if (overlapMinutes > 0) {
      // Real overlap: events genuinely intersect
      return {
        conflict_detected: true,
        conflict_type: "overlap",
        conflict_with: ev.title || "Untitled Event",
        overlap_minutes: Math.round(overlapMinutes),
        gap_minutes: 0,
        new_event: newEvent.title,
        new_location: newEvent.location || null,
        new_start: newEvent.startISO,
        new_end: newEvent.endISO,
        existing_start: ev.startISO,
        existing_end: ev.endISO,
      };
    } else if (overlapMinutes > -BUFFER_MIN) {
      // Too close — gap exists but under 60 min breathing room
      const gapMinutes = overlapMinutes < 0 ? Math.round(-overlapMinutes) : 0;
      return {
        conflict_detected: true,
        conflict_type: "buffer",
        conflict_with: ev.title || "Untitled Event",
        overlap_minutes: 0,
        gap_minutes: gapMinutes,
        new_event: newEvent.title,
        new_location: newEvent.location || null,
        new_start: newEvent.startISO,
        new_end: newEvent.endISO,
        existing_start: ev.startISO,
        existing_end: ev.endISO,
      };
    }
  }

  return { conflict_detected: false };
}
// --- Helper: build a Google Calendar "create event" URL suggesting a
// non-conflicting time for the changed event. Official, documented
// Google URL scheme — requires no API write access.
function buildSuggestUrl(result, ownerEmail) {
  try {
    const BUFFER_MS = 60 * 60 * 1000; // 60 min breathing room

    // Keep the same duration as the original changed event
    const durationMs =
      new Date(result.new_end).getTime() - new Date(result.new_start).getTime();
    if (isNaN(durationMs) || durationMs <= 0) return null;

    // Suggest: start after the existing event ends + buffer
    const suggestStart = new Date(
      new Date(result.existing_end).getTime() + BUFFER_MS
    );
    const suggestEnd = new Date(suggestStart.getTime() + durationMs);

    // Google Calendar URL format: YYYYMMDDTHHMMSSZ (UTC)
    const fmt = (d) =>
      d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

    const params = new URLSearchParams({
      action: "TEMPLATE",
      text: result.new_event || "Rescheduled event",
      dates: `${fmt(suggestStart)}/${fmt(suggestEnd)}`,
      details: `Suggested by VaultContext for ${ownerEmail} to resolve a conflict with "${result.conflict_with}". Save this on that account's calendar, then delete or move the original "${result.new_event}" event.`,
   });

    // Carry the original event's location if it had one. Conditional:
    // URLSearchParams would serialize undefined as the string "undefined".
    if (result.new_location) {
      params.set("location", result.new_location);
    }

    return `https://calendar.google.com/calendar/render?${params.toString()}`;
  } catch {
    return null; // never let suggestion failure break detection or alerts
  }
}
// --- Helper: register a Google Calendar push notification watch ---
async function registerWatch(userEmail) {
  const { oauth2Client, connection } = await getAuthedClientForUser(userEmail);
const calendar = google.calendar({ version: "v3", auth: oauth2Client });

// Stop any existing watch channel first so we don't leave zombies behind
if (connection.watch_channel_id && connection.watch_resource_id) {
  try {
    await calendar.channels.stop({
      requestBody: {
        id: connection.watch_channel_id,
        resourceId: connection.watch_resource_id,
      },
    });
    console.log("Stopped old channel:", connection.watch_channel_id);
  } catch (stopErr) {
    // Old channel may already be expired — that's fine, keep going
    console.log("Old channel stop skipped:", stopErr.message);
  }
}

  const initialList = await calendar.events.list({
    calendarId: "primary",
    timeMin: new Date().toISOString(),
    singleEvents: true,
  });
  const syncToken = initialList.data.nextSyncToken;

  // Capture the user's calendar timezone (IANA name, e.g. "Asia/Manila")
  // so alert emails render times in THEIR timezone, not the server's.
  // Read from the events.list response we already made — the calendar's
  // timeZone ships with events.readonly, so no extra scope or API call.
  const userTimezone = initialList.data.timeZone || null;
  console.log("Timezone for", userEmail, "→", userTimezone);

  const channelId = "vc-" + Date.now() + "-" + Math.floor(Math.random() * 100000);

  const watchResponse = await calendar.events.watch({
    calendarId: "primary",
    requestBody: {
      id: channelId,
      type: "web_hook",
      address: "https://vaultcontext-backend.onrender.com/notifications",
    },
  });

  const { error } = await supabase
    .from("calendar_connections")
    .update({
      watch_channel_id: channelId,
      watch_resource_id: watchResponse.data.resourceId,
      watch_expiration: watchResponse.data.expiration
        ? new Date(Number(watchResponse.data.expiration)).toISOString()
        : null,
      sync_token: syncToken,
      timezone: userTimezone,
      updated_at: new Date().toISOString(),
    })
    .eq("user_email", userEmail);

  if (error) throw new Error("Failed to save watch details: " + error.message);

  console.log("✅ Watch registered for", userEmail, "channel:", channelId);
  return channelId;
}
// --- Phase 3a: Register a watch on the user's calendar ---
app.get("/watch", async (req, res) => {
  const userEmail = req.query.email;
  if (!userEmail) {
    return res.status(400).send("Missing ?email= parameter.");
  }

  try {
    await registerWatch(userEmail);
    res.send("Watch registered successfully for " + userEmail);
  } catch (err) {
    console.error("Watch registration error:", err);
    res.status(500).send("Failed to register watch: " + err.message);
  }
});

// --- Account deletion request (emailed to admin for manual fulfillment) ---
// Receives a user's email and notifies the admin to delete their data.
// Request-based, not automated: no auth means we never delete on submit.
app.post("/request-deletion", express.json(), async (req, res) => {
  const email = req.body && req.body.email;

  if (!email || typeof email !== "string" || !email.includes("@")) {
    return res.status(400).json({ error: "A valid email is required." });
  }

  try {
    const { error } = await resend.emails.send({
      from: "VaultContext <alerts@vaultcontext.online>",
      to: "support@vaultcontext.online",
      subject: `🗑️ Deletion request: ${email}`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 500px; margin: 0 auto;">
          <h2 style="color: #d97706;">Account Deletion Request</h2>
          <p>A user has requested deletion of their VaultContext data.</p>
          <p><strong>Email:</strong> ${email}</p>
          <p><strong>Requested at:</strong> ${new Date().toISOString()}</p>
          <p style="color: #6b7280;">Delete this user's rows from <strong>conflicts</strong> and <strong>calendar_connections</strong> in Supabase.</p>
        </div>
      `,
    });

    if (error) {
      console.error("Deletion request email error:", error);
      return res.status(500).json({ error: "Failed to submit request." });
    }

    console.log("🗑️ Deletion request received for", email);
    res.json({ message: "Your deletion request has been received. We will remove your data shortly." });
  } catch (err) {
    console.error("Deletion request exception:", err.message);
    res.status(500).json({ error: "Failed to submit request." });
  }
});


// --- Renew watch channels nearing expiry (called by external cron) ---
// Google watch channels expire (~1 week). Without renewal, notifications
// silently stop. This finds connections expiring within 48h and re-registers.
app.get("/renew-watches", async (req, res) => {
  if (req.query.secret !== process.env.CRON_SECRET) {
    return res.status(403).send("Forbidden");
  }

  const cutoff = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();

  try {
    const { data: rows, error } = await supabase
      .from("calendar_connections")
      .select("user_email, watch_expiration")
      .or(`watch_expiration.lt.${cutoff},watch_expiration.is.null`);

    if (error) {
      console.error("Renew lookup failed:", error.message);
      return res.status(500).send("Lookup failed");
    }

    if (!rows || rows.length === 0) {
      console.log("Renew: no channels need renewal.");
      return res.send("Nothing to renew.");
    }

    console.log(`Renew: ${rows.length} channel(s) need renewal.`);

    const results = [];
    for (const row of rows) {
      try {
        await registerWatch(row.user_email);
        console.log("🔄 Watch renewed for", row.user_email);
        results.push(`${row.user_email}: OK`);
      } catch (err) {
        console.error("Renew failed for", row.user_email, "-", err.message);
        results.push(`${row.user_email}: FAILED (${err.message})`);
      }
    }

    res.send(`Renewal complete: ${results.length} processed`);
  } catch (err) {
    console.error("Renew endpoint exception:", err.message);
    res.status(500).send("Renewal failed");
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
    let listResult;
    try {
      listResult = await calendar.events.list({
        calendarId: "primary",
        syncToken: connection.sync_token,
      });
    } catch (syncErr) {
      // Sync token expired/invalid (Google returns 410). Recover:
      // re-baseline and wait for the next real change.
      console.log("Sync token invalid — re-baselining for", userEmail);
      const fresh = await calendar.events.list({
        calendarId: "primary",
        timeMin: new Date().toISOString(),
        singleEvents: true,
      });
      if (fresh.data.nextSyncToken) {
        await supabase
          .from("calendar_connections")
          .update({
            sync_token: fresh.data.nextSyncToken,
            updated_at: new Date().toISOString(),
          })
          .eq("user_email", userEmail);
        console.log("✅ Sync token re-baselined for", userEmail);
      }
      return; // skip this notification; next change flows normally
    }

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

    const allResolved = [];

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
        location: ev.location || null,
        startISO: ev.start ? ev.start.dateTime || ev.start.date : null,
        endISO: ev.end ? ev.end.dateTime || ev.end.date : null,
      }));

      const newEvent = {
        id: changed.id,
        title: changed.summary,
        location: changed.location || null,
        startISO: changedStart,
        endISO: changedEnd,
      };

      // Run the deterministic engine.
      const result = detectConflict(newEvent, existingEvents);

      if (result.conflict_detected) {
  console.log("⚠️ CONFLICT DETECTED!");
  console.log(`  ${result.new_event} (${result.new_start})`);
  console.log(result.conflict_type === "overlap"
    ? `  overlaps ${result.conflict_with} by ${result.overlap_minutes} min`
    : `  is ${result.gap_minutes} min before ${result.conflict_with}`);

  // Dedupe guard: skip if this exact pair already has an unresolved
  // conflict, in either orientation (A-vs-B or B-vs-A).
  const { data: existingRows, error: dupCheckError } = await supabase
    .from("conflicts")
    .select("id, task_name, conflict_with")
    .eq("user_email", userEmail)
    .eq("is_resolved", false);

  const isDuplicate = !dupCheckError && (existingRows || []).some(r =>
    (r.task_name === result.new_event && r.conflict_with === result.conflict_with) ||
    (r.task_name === result.conflict_with && r.conflict_with === result.new_event)
  );

  if (isDuplicate) {
    console.log("Duplicate pair — skipping insert & email:", result.new_event, "vs", result.conflict_with);
    continue; // move on to the next changed event
  }

  // Look up this user's auth UUID so we can save to conflicts table
  const { data: authData, error: authLookupError } = await supabase.auth.admin.listUsers();
  if (authLookupError) {
    console.error("Auth user lookup failed:", authLookupError.message);
    await sendConflictEmail(userEmail, result, null, connection.timezone);
  } else {
    const authUser = authData?.users?.find(u => u.email === userEmail);
    if (!authUser) {
      console.error("No auth user found for email:", userEmail);
      await sendConflictEmail(userEmail, result, null, connection.timezone);
    } else {
      // Save conflict to DB and capture the generated id
      const { data: inserted, error: insertError } = await supabase
        .from("conflicts")
        .insert({
          user_id: authUser.id,
          user_email: userEmail,
          task_name: result.new_event,
          clash_event: result.conflict_type === "overlap"
  ? `Overlaps "${result.conflict_with}" by ${result.overlap_minutes} min`
  : `Only ${result.gap_minutes} min gap before "${result.conflict_with}" — under 60 min buffer`,
         deadline: result.new_start,
          is_resolved: false,
          suggest_url: buildSuggestUrl(result, userEmail),
          conflict_with: result.conflict_with,
        })
        .select("id")
        .single();

      if (insertError) {
        console.error("Failed to save conflict to DB:", insertError.message);
        await sendConflictEmail(userEmail, result, null, connection.timezone);
      } else {
        console.log("✅ Conflict saved to DB, id:", inserted.id);
        await sendConflictEmail(userEmail, result, inserted.id, connection.timezone);
      }
    }
  }
} else {
  console.log("✓ No conflict for", changed.summary);

  // Auto-resolve: this event is now conflict-free, so clear any
  // unresolved conflicts that involve it (in either role).
  try {
    const evName = changed.summary;
    if (evName) {
      const { data: openRows, error: openErr } = await supabase
        .from("conflicts")
        .select("id, task_name, conflict_with")
        .eq("user_email", userEmail)
        .eq("is_resolved", false);

      if (!openErr && openRows) {
        const toResolve = openRows.filter(r =>
          r.task_name === evName || r.conflict_with === evName
        );
        const resolvedNow = [];
        for (const row of toResolve) {
          const { error: updErr } = await supabase
            .from("conflicts")
            .update({ is_resolved: true })
            .eq("id", row.id);
          if (!updErr) {
            resolvedNow.push(row);
            console.log("🟢 Auto-resolved conflict id", row.id,
              `(${row.task_name} vs ${row.conflict_with})`);
          }
        }
        allResolved.push(...resolvedNow);
      }
    }
  } catch (autoErr) {
    console.log("Auto-resolve skipped:", autoErr.message);
  }
}
    }

    if (allResolved.length > 0) {
      await sendResolutionEmail(userEmail, allResolved);
    }
  } catch (err) {
    console.error("Error fetching changes:", err.message);
  }
});


// --- Start the server ---
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});