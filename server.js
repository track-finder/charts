// === Track Finder Charts Backend (v3.1) ===
// Auto-approve uploads; charts feed; voting; admin list+delete; pagination ready.

import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import multer from "multer";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import fetch from "node-fetch";
import { Resend } from "resend";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// --- CORS (Squarespace + TF domains; "*" for now to reduce CORS headaches) ---
app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "x-admin-token"]
}));

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// --- Multer: in-memory for files ---
const upload = multer({ storage: multer.memoryStorage() });

// --- Env sanity checks (non-fatal; we’ll log clearly) ---
const REQUIRED_VARS = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"];
REQUIRED_VARS.forEach((k) => {
  if (!process.env[k]) console.warn(`⚠️ ENV ${k} not set`);
});

// --- Supabase client ---
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// --- Resend (optional; won’t crash if key missing) ---
const resend = process.env.RESEND_API ? new Resend(process.env.RESEND_API) : null;
const FROM_EMAIL = process.env.FROM_EMAIL || "admin@trackfinder.co.uk";

// --- Simple health check ---
app.get("/health", (req, res) => {
  res.json({ ok: true, service: "Track Finder Charts", node: process.version });
});

// ============================================================================
// Helpers
// ============================================================================

// Upload a buffer to Supabase Storage
async function uploadToBucket(bucket, path, buffer, contentType) {
  const { data, error } = await supabase.storage
    .from(bucket)
    .upload(path, buffer, { contentType, upsert: true });
  if (error) {
    // Give a helpful hint when bucket is missing
    const hint = error?.message?.toLowerCase().includes("not found")
      ? `Storage bucket "${bucket}" not found. Create it in Supabase > Storage as a Public bucket.`
      : "";
    throw new Error(`${error.message}${hint ? ` – ${hint}` : ""}`);
  }
  const publicUrl = `${process.env.SUPABASE_URL}/storage/v1/object/public/${bucket}/${data.path}`;
  return { path: data.path, publicUrl };
}

// Try to find a token row by email in either 'email' or 'user_email' columns
async function verifyUploadToken(email, token) {
  // Try 'email'
  {
    const { data, error } = await supabase
      .from("upload_tokens")
      .select("*")
      .eq("email", email)
      .eq("token", token)
      .maybeSingle();
    if (!error && data) return data;
  }
  // Try 'user_email'
  {
    const { data, error } = await supabase
      .from("upload_tokens")
      .select("*")
      .eq("user_email", email)
      .eq("token", token)
      .maybeSingle();
    if (!error && data) return data;
  }
  return null;
}

// Email (optional)
async function sendEmailSafe(to, subject, html) {
  if (!resend) return;
  try {
    await resend.emails.send({ from: FROM_EMAIL, to, subject, html });
  } catch (e) {
    console.warn("Email send failed (non-fatal):", e.message);
  }
}

// ============================================================================
// Upload Track (auto-approve)
// Fields: email, token, artist, title, genre, allow_download ("true"/"false")
// Files: file (mp3/wav) [required], artwork [optional]
// Buckets required: "tracks", "artwork" (public)
// ============================================================================
app.post(
  "/api/upload-track",
  upload.fields([{ name: "file", maxCount: 1 }, { name: "artwork", maxCount: 1 }]),
  async (req, res) => {
    try {
      const { email, token, artist, title, genre, allow_download } = req.body;
      console.log("Incoming upload:", { email, token, artist, title, genre });

      // Validate request
      if (!email || !token || !artist || !title) {
        return res.status(400).json({ success: false, error: "Missing email, token, artist, or title." });
      }
      const trackFile = req.files?.file?.[0];
      if (!trackFile) {
        return res.status(400).json({ success: false, error: "No track file uploaded." });
      }

      // Validate token (email+token)
      const tokenRow = await verifyUploadToken(email, token);
      if (!tokenRow) {
        return res.status(400).json({ success: false, error: "Invalid email or token." });
      }

      // Upload track
      const safeName = `${Date.now()}_${trackFile.originalname.replace(/\s+/g, "_")}`;
      const trackUp = await uploadToBucket("tracks", `uploads/${safeName}`, trackFile.buffer, trackFile.mimetype);

      // Optional artwork
      let artwork_url = null;
      if (req.files?.artwork?.[0]) {
        const art = req.files.artwork[0];
        const artSafe = `${Date.now()}_${art.originalname.replace(/\s+/g, "_")}`;
        const artUp = await uploadToBucket("artwork", `art/${artSafe}`, art.buffer, art.mimetype);
        artwork_url = artUp.publicUrl;
      }

      // Build row (auto-approve)
      const row = {
        artist,
        title,
        genre,
        email,
        token,
        allow_download: String(allow_download).toLowerCase() === "true",
        track_url: trackUp.publicUrl,
        artwork_url,
        play_count: 0,
        average_rating: 0,
        total_votes: 0,
        approved: true,
        created_at: new Date().toISOString()
      };

      const { error: insertErr } = await supabase.from("tracks").insert([row]);
      if (insertErr) throw insertErr;

      // Optional confirm email
      await sendEmailSafe(
        email,
        "✅ Track Uploaded to Track Finder Charts",
        `<p>Thanks for your upload, <b>${artist}</b> – <i>${title}</i> is now live on the charts.</p>`
      );

      return res.json({ success: true, message: "Track uploaded successfully!" });
    } catch (err) {
      console.error("Upload error:", err.message);
      return res.status(500).json({ success: false, error: err.message || "Upload failed." });
    }
  }
);

// ============================================================================
// Public Charts feed
// GET /api/charts?genre=all|House|...&page=0&limit=10
// ============================================================================
app.get("/api/charts", async (req, res) => {
  try {
    const genre = (req.query.genre || "all").trim();
    const page = Math.max(parseInt(req.query.page ?? "0", 10), 0);
    const limit = Math.min(Math.max(parseInt(req.query.limit ?? "20", 10), 1), 50);
    const from = page * limit;
    const to = from + limit - 1;

    let query = supabase
      .from("tracks")
      .select("*")
      .eq("approved", true)
      .order("created_at", { ascending: false })
      .range(from, to);

    if (genre !== "all") query = query.eq("genre", genre);

    const { data, error } = await query;
    if (error) throw error;

    res.json({ success: true, page, limit, tracks: data || [] });
  } catch (err) {
    console.error("Charts fetch error:", err.message);
    res.status(500).json({ success: false, error: "Failed to fetch charts" });
  }
});

// ============================================================================
// Voting
// POST { track_id, score: 1..10 }
// ============================================================================
app.post("/api/vote", async (req, res) => {
  try {
    const { track_id, score } = req.body;
    const s = Number(score);
    if (!track_id || !(s >= 1 && s <= 10)) {
      return res.status(400).json({ success: false, error: "Missing track_id or invalid score." });
    }

    const { data: track, error: fetchErr } = await supabase
      .from("tracks")
      .select("average_rating,total_votes")
      .eq("id", track_id)
      .maybeSingle();
    if (fetchErr) throw fetchErr;
    if (!track) return res.status(404).json({ success: false, error: "Track not found." });

    const newTotalVotes = (track.total_votes || 0) + 1;
    const newAverage = ((track.average_rating || 0) * (track.total_votes || 0) + s) / newTotalVotes;

    const { error: updateErr } = await supabase
      .from("tracks")
      .update({ average_rating: newAverage, total_votes: newTotalVotes })
      .eq("id", track_id);
    if (updateErr) throw updateErr;

    res.json({ success: true });
  } catch (err) {
    console.error("Vote error:", err.message);
    res.status(500).json({ success: false, error: "Vote failed" });
  }
});

// ============================================================================
// Admin listing (for dashboard) – requires x-admin-token header
// ============================================================================
function requireAdmin(req, res, next) {
  const token = req.headers["x-admin-token"];
  if (!token || token !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ success: false, error: "Unauthorized" });
  }
  next();
}

app.get("/api/tracks", requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("tracks")
      .select("*")
      .order("created_at", { ascending: false });
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    console.error("Admin list error:", err.message);
    res.status(500).json({ success: false, error: "Failed to load tracks" });
  }
});

// Delete a track by id (removes row; files remain unless you also stored file paths)
app.delete("/api/admin/delete-track/:id", requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { error } = await supabase.from("tracks").delete().eq("id", id);
    if (error) throw error;
    res.json({ success: true, message: "Track deleted" });
  } catch (err) {
    console.error("Delete error:", err.message);
    res.status(500).json({ success: false, error: "Failed to delete track" });
  }
});

// Winner finalize placeholder
app.post("/api/finalize-winners", async (req, res) => {
  res.json({ success: true, message: "Winner selection logic coming soon." });
});

// --- Start server ---
app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Track Finder Charts backend running on port ${PORT}`);
});
