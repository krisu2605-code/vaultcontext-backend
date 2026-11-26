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
// --- ElevenLabs voice client ---
const { ElevenLabsClient } = require("@elevenlabs/elevenlabs-js");
const elevenlabs = new ElevenLabsClient({ apiKey: process.env.ELEVENLABS_API_KEY });
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
// --- Helper: format a time for SPOKEN alerts --- (voice reads "9 a.m" better than "9:00 AM"). Keeps minutes for :30, :45, etc. ---
function speakTime(iso, timeZone) {
  try {
    const d = new Date(iso);
    let t = d.toLocaleString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
      timeZone: timeZone || "Asia/Bangkok",
    });
    // "9:00 AM" -> "9 AM", 9:30 AM" stays "9:30 AM"
    t = t.replace(":00", "");
    // "AM"/"PM" -> "a.m"/"p.m" so the voice pronounces it cleanly
    t =t.replace("AM", "a.m").replace("PM", "p.m");
    return t;
  } catch {
    return iso;
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

// Generate voice alert (defensive: never let TTS break the email)
let audioAttachment = null;
try {
  let spokenText;

  if (conflict.conflict_type === "overlap") {
    // Read the earlier event first, so the voice narrates chronologically
    const newStartsFirst =
      new Date(conflict.new_start) <= new Date(conflict.existing_start);

    const firstName  = newStartsFirst ? conflict.new_event    : conflict.conflict_with;
    const firstStart = newStartsFirst ? conflict.new_start    : conflict.existing_start;
    const firstEnd   = newStartsFirst ? conflict.new_end      : conflict.existing_end;
    const secondName  = newStartsFirst ? conflict.conflict_with : conflict.new_event;
    const secondStart = newStartsFirst ? conflict.existing_start : conflict.new_start;
    const secondEnd   = newStartsFirst ? conflict.existing_end   : conflict.new_end;

    spokenText =
      `Calendar conflict. ${firstName} runs from ${speakTime(firstStart, timeZone)} ` +
      `to ${speakTime(firstEnd, timeZone)}, and ${secondName} runs from ` +
      `${speakTime(secondStart, timeZone)} to ${speakTime(secondEnd, timeZone)}. ` +
      `They overlap by ${conflict.overlap_minutes} minutes.`;
  } else {
    spokenText =
      `Tight schedule. ${conflict.new_event} at ${speakTime(conflict.new_start, timeZone)} ` +
      `has only ${conflict.gap_minutes} minutes before ${conflict.conflict_with} ` +
      `at ${speakTime(conflict.existing_start, timeZone)}.`;
  }

  const audio = await elevenlabs.textToSpeech.convert("JBFqnCBsd6RMkjVDRZzb", {
    text: spokenText,
    modelId: "eleven_multilingual_v2",
  });
  const chunks = [];
  for await (const chunk of audio) chunks.push(chunk);
  audioAttachment = { filename: "conflict-alert.mp3", content: Buffer.concat(chunks) };
} catch (ttsErr) {
  console.error("TTS generation failed (email will still send):", ttsErr);
}

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
      attachments: audioAttachment ? [audioAttachment] : [],
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

// --- Public landing page (homepage) ---
app.get("/", (req, res) => {
  res.type("html").send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>VaultContext — Calendar conflict detection</title>
<style>
  body{margin:0;font-family:Arial,Helvetica,sans-serif;color:#1f2430;background:#f7f7fb;line-height:1.6}
  .wrap{max-width:760px;margin:0 auto;padding:48px 24px}
  .logo{width:56px;height:56px;border-radius:14px;background:#5B4AE8;display:inline-block}
  h1{font-size:34px;margin:20px 0 8px}
  .lead{font-size:19px;color:#4b5160}
  .card{background:#fff;border-radius:12px;padding:24px;margin:24px 0;box-shadow:0 1px 4px rgba(0,0,0,.06)}
  ul{padding-left:20px}li{margin:8px 0}
  .btn{display:inline-block;background:#5B4AE8;color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;margin-top:8px}
  .note{color:#5f6675;font-size:15px}
  a{color:#5B4AE8}
  footer{margin-top:32px;font-size:14px;color:#8a909c}
</style></head>
<body><div class="wrap">
  <span class="logo"></span>
  <h1>VaultContext</h1>
  <p class="lead">Catch double-bookings and tight gaps in your Google Calendar before they cost you.</p>

  <div class="card">
    <p>VaultContext watches your Google Calendar and alerts you by email when two events overlap, or when back-to-back bookings leave too little time between them. It's built for people who manage busy, shared calendars — clinics, studios, tutoring centers, and coordinators — where a double-booking means a client waits or walks.</p>
    <ul>
      <li>Automatic detection of overlapping events and tight buffer gaps</li>
      <li>Email alerts the moment a conflict appears</li>
      <li>One-tap reschedule that opens the event in Google Calendar</li>
      <li><strong>Read-only by design</strong> — VaultContext only reads calendar events to detect conflicts. It never creates, edits, or deletes anything on your calendar.</li>
    </ul>
    <a class="btn" href="https://vaultcontext.online">Open the app</a>
  </div>

  <p class="note">VaultContext uses read-only access to your Google Calendar events (calendar.events.readonly) solely to detect scheduling conflicts and notify you.</p>

  <footer>
    <a href="/privacy">Privacy Policy</a> ·
    <a href="/terms">Terms of Service</a> ·
    Contact: support@vaultcontext.online
  </footer>
</div></body></html>`);
});
// --- Google Search Console domain verification ---
app.get("/googlef37a6fa844dbf8cc.html", (req, res) => {
  res.type("text/html");
  res.send("google-site-verification: googlef37a6fa844dbf8cc.html");
});

// --- Public Privacy Policy (static, crawlable HTML) ---
app.get("/privacy", (req, res) => {
  res.type("html").send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Privacy Policy — VaultContext</title>
<style>
  body{margin:0;font-family:Arial,Helvetica,sans-serif;color:#1f2430;background:#f7f7fb;line-height:1.7}
  .wrap{max-width:760px;margin:0 auto;padding:48px 24px}
  h1{font-size:30px;margin:0 0 4px}
  h2{font-size:22px;margin:32px 0 8px}
  h3{font-size:18px;margin:22px 0 6px}
  .updated{color:#5f6675;font-size:15px;margin-bottom:8px}
  ul{padding-left:22px}li{margin:6px 0}
  a{color:#5B4AE8}
  hr{border:none;border-top:1px solid #e3e5ee;margin:28px 0}
  footer{margin-top:40px;font-size:14px;color:#8a909c}
</style></head>
<body><div class="wrap">
  <h1>Privacy Policy for VaultContext</h1>
  <p class="updated"><strong>Last updated: July 14, 2026</strong></p>
  <p>This Privacy Policy describes how VaultContext collects, uses, and discloses your information when you use the Service, and tells you about your privacy rights and how the law protects you.</p>
  <p>We use your Personal Data to provide and improve the Service. By using the Service, you agree to the collection and use of information in accordance with this Privacy Policy.</p>

  <hr>
  <h2>Interpretation and Definitions</h2>
  <h3>Interpretation</h3>
  <p>The words whose initial letters are capitalized have meanings defined under the following conditions. The following definitions shall have the same meaning regardless of whether they appear in singular or in plural.</p>
  <h3>Definitions</h3>
  <p>For the purposes of this Privacy Policy:</p>
  <ul>
    <li><strong>Account</strong> means a unique account created for you to access the Service or parts of the Service.</li>
    <li><strong>Application</strong> refers to VaultContext, the software program provided by the Company.</li>
    <li><strong>Company</strong> (referred to as "the Company", "We", "Us", "Our", or "VaultContext" in this Privacy Policy) refers to VaultContext, a personal software project operated by an individual developer.</li>
    <li><strong>Cookies</strong> are small files that are placed on your computer, mobile device, or any other device by a website, containing details of your browsing activity on that website.</li>
    <li><strong>Country</strong> refers to: Vietnam.</li>
    <li><strong>Device</strong> means any device that can access the Service, such as a computer, a cell phone, or a digital tablet.</li>
    <li><strong>Google User Data</strong> means the data VaultContext accesses from your Google Account through the Google Calendar API, as described in the "Google User Data" section below.</li>
    <li><strong>Personal Data</strong> (or <strong>"Personal Information"</strong>) is any information that relates to an identified or identifiable individual. We use "Personal Data" and "Personal Information" interchangeably unless a law uses a specific term.</li>
    <li><strong>Service</strong> refers to the Application or the Website, or both.</li>
    <li><strong>Service Provider</strong> means any natural or legal person who processes data on behalf of the Company. It refers to the third-party companies or individuals we use to facilitate the Service, provide the Service on our behalf, or perform services related to the Service.</li>
    <li><strong>Usage Data</strong> refers to data collected automatically, either generated by the use of the Service or from the Service infrastructure itself.</li>
    <li><strong>Website</strong> refers to VaultContext, accessible from https://vaultcontext.online.</li>
    <li><strong>You</strong> means the individual accessing or using the Service.</li>
  </ul>

  <hr>
  <h2>Collecting and Using Your Personal Data</h2>
  <h3>Types of Data Collected</h3>
  <h3>Personal Data</h3>
  <p>While using the Service, we may ask you to provide certain personally identifiable information that can be used to contact or identify you. This may include, but is not limited to:</p>
  <ul><li>Email address</li><li>First name and last name</li></ul>
  <p>For details on how we handle your Google Calendar data specifically, see the <strong>Google User Data</strong> section below.</p>
  <h3>Usage Data</h3>
  <p>Usage Data is collected automatically when using the Service. It may include information such as your device's Internet Protocol address (e.g. IP address), browser type and version, the pages of the Service you visit, the time and date of your visit, and other diagnostic data. When you access the Service through a mobile device, we may automatically collect certain information such as the type of device, its unique ID, its IP address, and its operating system.</p>
  <h3>Cookies</h3>
  <p>VaultContext uses only strictly necessary cookies to keep you signed in and to maintain your session while you use the Service. These cookies are essential to authenticate you and to provide the features you have requested; without them, parts of the Service cannot function. We do <strong>not</strong> use advertising, remarketing, or analytics cookies.</p>
  <h3>Use of Your Personal Data</h3>
  <p>The Company may use Personal Data for the following purposes:</p>
  <ul>
    <li><strong>To provide and maintain the Service</strong>, including to monitor the usage of the Service.</li>
    <li><strong>To manage your Account</strong>: to manage your registration as a user of the Service and give you access to the functionalities available to registered users.</li>
    <li><strong>To detect scheduling conflicts and notify you</strong>, which is the core purpose of the Service (see the Google User Data section).</li>
    <li><strong>To contact you</strong> by email or other electronic communication regarding functionality, updates, or security notices related to the Service, when necessary or reasonable.</li>
    <li><strong>To manage your requests</strong>: to attend to and manage requests you make to us, including data-deletion requests.</li>
  </ul>
  <p>We do not use your Personal Data for advertising, marketing, or promotional purposes.</p>
  <h3>Sharing of Your Personal Data</h3>
  <p>We may share your Personal Data only in the following situations:</p>
  <ul>
    <li><strong>With Service Providers</strong>: We share Personal Data with the infrastructure providers that operate the Service — <strong>Supabase</strong> (database storage), <strong>Render</strong> (application hosting), <strong>Resend</strong> (email delivery), and <strong>ElevenLabs</strong> (text-to-speech generation of the spoken conflict alert) — who process it only to provide those services on our behalf.</li>
    <li><strong>With Google</strong>: We access your Google Calendar data through Google's APIs as described in the Google User Data section. We do not share your Google User Data with any third party except the Service Providers listed above.</li>
    <li><strong>For legal requirements</strong>: We may disclose your Personal Data if required to do so by law or in response to valid requests by public authorities.</li>
    <li><strong>With your consent</strong>: We may disclose your Personal Data for any other purpose with your consent.</li>
  </ul>
  <p>We do <strong>not</strong> sell your Personal Data. We do not share it with affiliates, business partners, or advertisers.</p>

  <hr>
  <h2>Google User Data</h2>
  <p>VaultContext accesses your Google Calendar data through the Google Calendar API. When you connect your Google account, you grant read-only permission using the <code>calendar.events.readonly</code> scope. VaultContext cannot create, edit, or delete any events on your calendar.</p>
  <p><strong>What we access.</strong> We read the titles and start and end times of events on your primary Google Calendar. We access this data only to detect scheduling conflicts — events that overlap, or events with less than 60 minutes of buffer time between them.</p>
  <p><strong>What we store.</strong> In our database (hosted on Supabase): your email address and the OAuth tokens that allow VaultContext to access your calendar on your behalf; technical data required to receive change notifications from Google (calendar identifier and notification channel details); and, for events that are part of a detected conflict only, the event titles and start times of the conflicting events together with a description of the conflict. We do <strong>not</strong> store your full calendar — events that are not part of a conflict are read, checked, and discarded, never saved.</p>
  <p><strong>How we use it.</strong> Solely to detect scheduling conflicts and notify you of them by email with a suggested conflict-free time. To include a spoken version of the alert, the text of the alert (event titles and times involved in the conflict) is sent to ElevenLabs to generate an audio file; this is used only to produce the voice alert and for no other purpose. No other use is made of your data.</p>
  <p><strong>What we never do.</strong> We do not sell your Google user data. We do not share it with third parties except the infrastructure providers that operate our service (Supabase for database storage, Render for hosting, Resend for email, ElevenLabs for voice-alert generation), who process it only to provide those services on our behalf. We do not use your Google user data for advertising.</p>
  <p><strong>Retention and deletion.</strong> You can disconnect VaultContext at any time from your Google Account's security settings, which revokes our access. You may also request deletion of your stored data via the in-app deletion form or by contacting us; on deletion, your tokens and conflict records are removed from our database.</p>
  <p><strong>Compliance.</strong> VaultContext's use of information received from Google APIs adheres to the <a href="https://developers.google.com/terms/api-services-user-data-policy">Google API Services User Data Policy</a>, including the Limited Use requirements.</p>

  <hr>
  <h2>Retention of Your Personal Data</h2>
  <p>The Company retains your Personal Data only for as long as is necessary for the purposes set out in this Privacy Policy.</p>
  <ul>
    <li><strong>Account and connection data</strong> (your email address and OAuth tokens) are retained for as long as your account remains connected to the Service. When you disconnect VaultContext or request deletion, this data is removed.</li>
    <li><strong>Conflict records</strong> (the titles, start times, and conflict descriptions of events involved in a detected conflict) are retained while your account is active and are removed on account deletion.</li>
    <li><strong>Usage Data</strong> is generally retained for a shorter period, except where it is needed for security, fraud prevention, or to comply with a legal obligation.</li>
  </ul>
  <p>We may retain certain information where we have a legal obligation or lawful basis to do so, or where necessary to establish, exercise, or defend legal claims. When retention is no longer necessary, we securely delete or anonymize the data.</p>

  <hr>
  <h2>Transfer of Your Personal Data</h2>
  <p>Your information, including Personal Data, is processed at the locations where our Service Providers operate, which may be outside your state, province, or country. Our infrastructure providers (Supabase, Render, Resend, ElevenLabs) may process data in jurisdictions whose data-protection laws differ from those in your jurisdiction. We take all steps reasonably necessary to ensure that your data is treated securely and in accordance with this Privacy Policy.</p>

  <hr>
  <h2>Delete Your Personal Data</h2>
  <p>You have the right to delete, or request that we delete, the Personal Data we have collected about you.</p>
  <p>You can request deletion of your data in either of the following ways:</p>
  <ul>
    <li>Using the in-app deletion form at https://vaultcontext.online/deleteRequest; or</li>
    <li>By emailing us at <strong>support@vaultcontext.online</strong>.</li>
  </ul>
  <p>Upon your request, we delete your OAuth tokens and your conflict records from our database (the <code>conflicts</code> and <code>calendar_connections</code> records associated with your email). You may also revoke VaultContext's access at any time directly from your Google Account's security settings, which prevents any further access to your calendar.</p>
  <p>Please note that we may need to retain certain information where we have a legal obligation or lawful basis to do so.</p>

  <hr>
  <h2>Disclosure of Your Personal Data</h2>
  <h3>Law enforcement</h3>
  <p>Under certain circumstances, the Company may be required to disclose your Personal Data if required to do so by law or in response to valid requests by public authorities (e.g. a court or a government agency).</p>
  <h3>Other legal requirements</h3>
  <p>The Company may disclose your Personal Data in the good-faith belief that such action is necessary to:</p>
  <ul>
    <li>Comply with a legal obligation</li>
    <li>Protect and defend the rights or property of the Company</li>
    <li>Prevent or investigate possible wrongdoing in connection with the Service</li>
    <li>Protect the personal safety of users of the Service or the public</li>
    <li>Protect against legal liability</li>
  </ul>

  <hr>
  <h2>Security of Your Personal Data</h2>
  <p>The security of your Personal Data is important to us, but remember that no method of transmission over the Internet, or method of electronic storage, is 100% secure. While we strive to use commercially reasonable means to protect your Personal Data, we cannot guarantee its absolute security.</p>

  <hr>
  <h2>Children's Privacy</h2>
  <p>Our Service does not address anyone under the age of 16. We do not knowingly collect personally identifiable information from anyone under the age of 16. If you are a parent or guardian and you are aware that your child has provided us with Personal Data, please contact us. If we become aware that we have collected Personal Data from anyone under the age of 16 without verification of parental consent, we take steps to remove that information from our servers.</p>

  <hr>
  <h2>Links to Other Websites</h2>
  <p>Our Service may contain links to other websites that are not operated by us. If you click on a third-party link, you will be directed to that third party's site. We strongly advise you to review the Privacy Policy of every site you visit. We have no control over, and assume no responsibility for, the content, privacy policies, or practices of any third-party sites or services.</p>

  <hr>
  <h2>Changes to this Privacy Policy</h2>
  <p>We may update this Privacy Policy from time to time. We will notify you of any changes by posting the new Privacy Policy on this page and updating the "Last updated" date at the top. You are advised to review this Privacy Policy periodically for any changes. Changes to this Privacy Policy are effective when they are posted on this page.</p>

  <hr>
  <h2>Contact Us</h2>
  <p>If you have any questions about this Privacy Policy, you can contact us:</p>
  <ul><li>By email: <strong>support@vaultcontext.online</strong></li></ul>

  <footer>
    <a href="/">Home</a> · <a href="/terms">Terms of Service</a> · Contact: support@vaultcontext.online
  </footer>
</div></body></html>`);
});

// --- Public Terms of Service (static, crawlable HTML) ---
app.get("/terms", (req, res) => {
  res.type("html").send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Terms of Service — VaultContext</title>
<style>
  body{margin:0;font-family:Arial,Helvetica,sans-serif;color:#1f2430;background:#f7f7fb;line-height:1.7}
  .wrap{max-width:760px;margin:0 auto;padding:48px 24px}
  h1{font-size:30px;margin:0 0 4px}
  h2{font-size:22px;margin:32px 0 8px}
  .updated{color:#5f6675;font-size:15px;margin-bottom:8px}
  ul{padding-left:22px}li{margin:6px 0}
  a{color:#5B4AE8}
  hr{border:none;border-top:1px solid #e3e5ee;margin:28px 0}
  footer{margin-top:40px;font-size:14px;color:#8a909c}
</style></head>
<body><div class="wrap">
  <h1>Terms of Service for VaultContext</h1>
  <p class="updated"><strong>Last updated: July 14, 2026</strong></p>
  <p>These Terms of Service ("Terms") govern your access to and use of VaultContext (the "Service"), a personal software project operated by an individual developer ("we", "us", or "our"). By accessing or using the Service, you agree to be bound by these Terms. If you do not agree to these Terms, do not use the Service.</p>

  <hr>
  <h2>1. The Service</h2>
  <p>VaultContext connects to your Google Calendar with read-only access and notifies you by email when it detects scheduling conflicts — events that overlap, or back-to-back events with less than 60 minutes of buffer between them. The Service reads your calendar events only to detect these conflicts. It never creates, edits, or deletes events on your calendar.</p>

  <hr>
  <h2>2. Eligibility and Accounts</h2>
  <p>You must be at least 16 years old to use the Service. You are responsible for maintaining the confidentiality of your account credentials and for all activity that occurs under your account. You agree to provide accurate information and to keep it up to date.</p>

  <hr>
  <h2>3. Google Account Access</h2>
  <p>To use the Service you connect your Google account and grant read-only access to your Google Calendar (the <code>calendar.events.readonly</code> scope). You may revoke this access at any time from your Google Account's security settings, which stops VaultContext from accessing your calendar. Our use of data received through Google APIs is described in our <a href="/privacy">Privacy Policy</a> and adheres to the <a href="https://developers.google.com/terms/api-services-user-data-policy">Google API Services User Data Policy</a>, including the Limited Use requirements.</p>

  <hr>
  <h2>4. Acceptable Use</h2>
  <p>You agree not to:</p>
  <ul>
    <li>Use the Service for any unlawful purpose or in violation of any applicable law or regulation;</li>
    <li>Attempt to gain unauthorized access to the Service, its systems, or other users' data;</li>
    <li>Interfere with, disrupt, or place an unreasonable load on the Service or its infrastructure;</li>
    <li>Reverse engineer, copy, or resell the Service except as permitted by law.</li>
  </ul>

  <hr>
  <h2>5. Service Availability</h2>
  <p>The Service is provided on a best-effort basis. We may modify, suspend, or discontinue the Service, in whole or in part, at any time and without notice. We do not guarantee that the Service will be uninterrupted, timely, secure, or error-free, or that every scheduling conflict will be detected.</p>

  <hr>
  <h2>6. No Warranty</h2>
  <p>The Service is provided "AS IS" and "AS AVAILABLE" without warranties of any kind, whether express or implied, including but not limited to implied warranties of merchantability, fitness for a particular purpose, and non-infringement. You use the Service at your own risk. VaultContext is a scheduling aid and is not a substitute for your own review of your calendar.</p>

  <hr>
  <h2>7. Limitation of Liability</h2>
  <p>To the maximum extent permitted by law, in no event shall VaultContext or its developer be liable for any indirect, incidental, special, consequential, or punitive damages, or for any loss of profits, data, or goodwill, arising out of or in connection with your use of (or inability to use) the Service — including any missed, duplicate, or incorrectly detected scheduling conflict — whether based on warranty, contract, tort, or any other legal theory.</p>

  <hr>
  <h2>8. Data and Privacy</h2>
  <p>Your use of the Service is also governed by our <a href="/privacy">Privacy Policy</a>, which explains what data we collect, how we use it, and your rights, including how to delete your data.</p>

  <hr>
  <h2>9. Termination</h2>
  <p>You may stop using the Service at any time by disconnecting VaultContext from your Google Account and requesting deletion of your data. We may suspend or terminate your access to the Service at any time if you violate these Terms or if we discontinue the Service.</p>

  <hr>
  <h2>10. Changes to These Terms</h2>
  <p>We may update these Terms from time to time. We will post the updated Terms on this page and update the "Last updated" date above. Your continued use of the Service after changes become effective constitutes your acceptance of the revised Terms.</p>

  <hr>
  <h2>11. Governing Law</h2>
  <p>These Terms are governed by the laws of Vietnam, without regard to its conflict-of-law provisions.</p>

  <hr>
  <h2>12. Contact Us</h2>
  <p>If you have any questions about these Terms, you can contact us:</p>
  <ul><li>By email: <strong>support@vaultcontext.online</strong></li></ul>

  <footer>
    <a href="/">Home</a> · <a href="/privacy">Privacy Policy</a> · Contact: support@vaultcontext.online
  </footer>
</div></body></html>`);
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

      // Skip all-day events. Google gives them start.date (a bare date, no
      // time) instead of start.dateTime. They're context, not commitments —
      // "Vacation" doesn't conflict with a 2pm meeting. Parsing the bare
      // date would also treat it as midnight UTC (a phantom 7am in Hanoi).
      if (!changed.start || !changed.start.dateTime) {
        console.log("Skipping all-day event:", changed.summary);
        continue;
      }
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
      const existingEvents = (nearby.data.items || [])
        .filter((ev) => ev.start && ev.start.dateTime)
        .map((ev) => ({
          id: ev.id,
          title: ev.summary,
          location: ev.location || null,
          startISO: ev.start.dateTime,
          endISO: ev.end ? ev.end.dateTime : null,
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