// === Track Finder Charts Backend v4.0 ===
// Buckets: tracks, artwork  |  Auto-approve uploads  |  Infinite scroll ready

import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import multer from "multer";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { Resend } from "resend";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// --- CORS (relaxed to avoid Squarespace headaches) ---
app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "x-admin-token"]
}));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// --- Multer memory storage ---
const upload = multer({ storage: multer.memoryStorage() });

// --- Supabase ---
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.warn("⚠️ Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
}
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// --- Resend (optional) ---
const resend = process.env.RESEND_API ? new Resend(process.env.RESEND_API) : null;
const FROM_EMAIL = process.env.FROM_EMAIL || "admin@trackfinder.co.uk";

// --- Constants ---
const DEFAULT_ARTWORK_URL = "https://images.squarespace-cdn.com/content/v1/68f697b5332bf833149a87f0/a589f65e-a612-4220-8ef8-320f1f6791d5/track+finder+logo.png?format=1500w";

// --- Health ---
app.get("/health", (req, res) => res.json({ ok: true, service: "Track Finder Charts", node: process.version }));

// --- Helpers ---
async function uploadToBucket(bucket, path, buffer, contentType) {
  const { data, error } = await supabase.storage
    .from(bucket)
    .upload(path, buffer, { contentType, upsert: true });
  if (error) {
    const hint = error?.message?.toLowerCase().includes("not found")
      ? ` (Create public bucket "${bucket}" in Supabase > Storage)`
      : "";
    throw new Error(error.message + hint);
  }
  const { data: pub } = supabase.storage.from(bucket).getPublicUrl(path);
  return pub.publicUrl;
}

async function findTokenRow(email, token) {
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

async function sendEmailSafe(to, subject, html) {
  if (!resend) return;
  try { await resend.emails.send({ from: FROM_EMAIL, to, subject, html }); }
  catch (e) { console.warn("Email send failed (non-fatal):", e.message); }
}

// --- Upload Track (auto-approve) ---
// fields: email, token, artist, title, genre, allow_download ("true"/"false")
// files: file (required: mp3/wav), artwork (optional)
// buckets: tracks, artwork
app.post("/api/upload-track",
  upload.fields([{ name: "file", maxCount: 1 }, { name: "artwork", maxCount: 1 }]),
  async (req, res) => {
    try {
      const { email, token, artist, title, genre } = req.body;
      const allow_download = String(req.body.allow_download).toLowerCase() === "true";

      if (!email || !token || !artist || !title) {
        return res.status(400).json({ success: false, error: "Missing email, token, artist, or title." });
      }

      const trackFile = req.files?.file?.[0];
      if (!trackFile) return res.status(400).json({ success: false, error: "No track file uploaded." });

      // verify token (email + token)
      const tokenRow = await findTokenRow(email, token);
      if (!tokenRow) return res.status(400).json({ success: false, error: "Invalid email or token." });

      // Upload track
      const safeTrackName = `${Date.now()}_${trackFile.originalname.replace(/\s+/g, "_")}`;
      const trackPath = `uploads/${safeTrackName}`;
      const trackUrl = await uploadToBucket("tracks", trackPath, trackFile.buffer, trackFile.mimetype);

      // Artwork optional
      let artwork_url = DEFAULT_ARTWORK_URL;
      if (req.files?.artwork?.[0]) {
        const art = req.files.artwork[0];
        const safeArtName = `${Date.now()}_${art.originalname.replace(/\s+/g, "_")}`;
        const artPath = `art/${safeArtName}`;
        artwork_url = await uploadToBucket("artwork", artPath, art.buffer, art.mimetype);
      }

      // Insert row (approved true)
      const row = {
        email,
        artist,
        title,
        genre,
        track_url: trackUrl,
        artwork_url,
        allow_download,
        approved: true,
        play_count: 0,
        average_rating: 0,
        total_votes: 0,
        created_at: new Date().toISOString()
      };

      const { error: insertErr } = await supabase.from("tracks").insert([row]);
      if (insertErr) throw insertErr;

      await sendEmailSafe(
        email,
        "✅ Your track is live on Track Finder Charts",
        `<p>Thanks for your upload <b>${artist}</b> – <i>${title}</i> is now live!</p>`
      );

      res.json({ success: true, message: "Track uploaded successfully!" });
    } catch (err) {
      console.error("Upload error:", err.message);
      res.status(500).json({ success: false, error: err.message || "Upload failed." });
    }
  }
);

// --- Charts feed (newest first) ---
// Supports either: ?genre=all&offset=0&limit=20  or  ?genre=all&page=0&limit=20
app.get("/api/charts", async (req, res) => {
  try {
    const genre = (req.query.genre || "all").trim();
    const limit = Math.min(Math.max(parseInt(req.query.limit ?? "50", 10), 1), 50);
    let offset = parseInt(req.query.offset ?? "0", 10);
    if (Number.isNaN(offset)) {
      const page = Math.max(parseInt(req.query.page ?? "0", 10), 0);
      offset = page * limit;
    }

    let query = supabase
      .from("tracks")
      .select("*")
      .eq("approved", true)
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);

    if (genre !== "all") query = query.eq("genre", genre);

    const { data, error } = await query;
    if (error) throw error;

    res.json({ success: true, tracks: data || [] });
  } catch (err) {
    console.error("Charts fetch error:", err.message);
    res.status(500).json({ success: false, error: "Failed to fetch charts" });
  }
});

// --- Vote --- (weighted average; no total_score column needed)
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

    const newVotes = (track.total_votes || 0) + 1;
    const newAverage = ((track.average_rating || 0) * (track.total_votes || 0) + s) / newVotes;

    const { error: updateErr } = await supabase
      .from("tracks")
      .update({ total_votes: newVotes, average_rating: newAverage })
      .eq("id", track_id);
    if (updateErr) throw updateErr;

    res.json({ success: true, total_votes: newVotes, average_rating: newAverage });
  } catch (err) {
    console.error("Vote error:", err.message);
    res.status(500).json({ success: false, error: "Vote failed" });
  }
});

// --- Admin list (secure) ---
function requireAdmin(req, res, next) {
  const token = req.headers["x-admin-token"];
  if (!token || token !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ success: false, error: "Unauthorized" });
  }
  next();
}

app.get("/api/tracks-admin", requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("tracks")
      .select("*")
      .order("created_at", { ascending: false });
    if (error) throw error;
    res.json({ success: true, tracks: data || [] });
  } catch (err) {
    console.error("Admin list error:", err.message);
    res.status(500).json({ success: false, error: "Failed to load tracks" });
  }
});

// --- Delete track (secure) ---
app.delete("/api/delete-track/:id", requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    // fetch track to derive storage keys
    const { data: t, error: getErr } = await supabase.from("tracks").select("*").eq("id", id).maybeSingle();
    if (getErr) throw getErr;
    if (!t) return res.status(404).json({ success: false, error: "Track not found" });

    // Try to remove files (best-effort)
    try {
      if (t.track_url?.includes("/tracks/")) {
        const key = t.track_url.split("/tracks/")[1];
        if (key) await supabase.storage.from("tracks").remove([`uploads/${key}`]).catch(()=>{});
      }
      if (t.artwork_url?.includes("/artwork/")) {
        const key = t.artwork_url.split("/artwork/")[1];
        if (key) await supabase.storage.from("artwork").remove([`art/${key}`]).catch(()=>{});
      }
    } catch { /* non-fatal */ }

    const { error: delErr } = await supabase.from("tracks").delete().eq("id", id);
    if (delErr) throw delErr;

    res.json({ success: true, message: "Track deleted" });
  } catch (err) {
    console.error("Delete error:", err.message);
    res.status(500).json({ success: false, error: "Failed to delete track" });
  }
});

// --- Start ---
app.listen(PORT, "0.0.0.0", () =>
  console.log(`✅ Track Finder Charts backend running on port ${PORT}`)
);
