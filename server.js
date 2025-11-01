// === Track Finder Charts Backend (v2.5) ===
// Author: Jonathan Russell
// Purpose: Handles track uploads, tokens, charts, and voting.

import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import multer from "multer";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { Resend } from "resend";
import fetch from "node-fetch";

dotenv.config();
const app = express();
const PORT = process.env.PORT || 3000;

// === Middleware ===
app.use(cors({
  origin: ["https://trackfinder.co.uk", "https://www.trackfinder.co.uk"],
  credentials: true,
}));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// === Supabase Setup ===
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// === Resend Setup ===
const resend = new Resend(process.env.RESEND_API);
const FROM_EMAIL = process.env.FROM_EMAIL || "admin@trackfinder.co.uk";

// === File Upload (Multer memory storage) ===
const upload = multer({ storage: multer.memoryStorage() });

// === Health Check ===
app.get("/health", (req, res) => res.json({ ok: true, service: "Track Finder Charts" }));

// === Upload Track ===
app.post("/api/upload-track", upload.fields([
  { name: "file", maxCount: 1 },
  { name: "artwork", maxCount: 1 }
]), async (req, res) => {
  try {
    const { email, token, artist, title, genre, allow_download } = req.body;
    console.log("Incoming upload:", req.body);

    // === Validate token ===
    const { data: tokenData, error: tokenErr } = await supabase
      .from("upload_tokens")
      .select("*")
      .eq("email", email)
      .eq("token", token)
      .maybeSingle();

    if (tokenErr) throw tokenErr;
    if (!tokenData) return res.status(400).json({ success: false, error: "Invalid token or email." });

    const trackFile = req.files?.file?.[0];
    if (!trackFile) return res.status(400).json({ success: false, error: "No track file uploaded." });

    // === Upload track ===
    const { data: trackUpload, error: uploadError } = await supabase.storage
      .from("tracks")
      .upload(`uploads/${Date.now()}_${trackFile.originalname}`, trackFile.buffer, {
        contentType: trackFile.mimetype,
        upsert: true,
      });
    if (uploadError) throw uploadError;

    // === Optional artwork upload ===
    let artworkUrl = null;
    if (req.files?.artwork?.[0]) {
      const artworkFile = req.files.artwork[0];
      const { data: artUp, error: artErr } = await supabase.storage
        .from("artwork")
        .upload(`art/${Date.now()}_${artworkFile.originalname}`, artworkFile.buffer, {
          contentType: artworkFile.mimetype,
          upsert: true,
        });
      if (artErr) throw artErr;
      artworkUrl = artUp?.path
        ? `${process.env.SUPABASE_URL}/storage/v1/object/public/artwork/${artUp.path}`
        : null;
    }

    // === Build track record ===
    const trackData = {
      artist,
      title,
      genre,
      email,
      token,
      allow_download: allow_download === "true",
      track_url: `${process.env.SUPABASE_URL}/storage/v1/object/public/tracks/${trackUpload.path}`,
      artwork_url: artworkUrl,
      play_count: 0,
      average_rating: 0,
      total_votes: 0,
      approved: true,
      created_at: new Date().toISOString(),
    };

    const { error: insertErr } = await supabase.from("tracks").insert([trackData]);
    if (insertErr) throw insertErr;

    res.json({ success: true, message: "Track uploaded successfully!" });
  } catch (err) {
    console.error("Upload error:", err.message);
    res.status(500).json({ success: false, error: err.message || "Upload failed." });
  }
});

// === Charts Route (Frontend) ===
app.get("/api/charts", async (req, res) => {
  try {
    const genre = req.query.genre || "all";

    let query = supabase
      .from("tracks")
      .select("*")
      .eq("approved", true)
      .order("created_at", { ascending: false });

    if (genre !== "all") query = query.eq("genre", genre);

    const { data, error } = await query;
    if (error) throw error;

    res.json({ success: true, tracks: data });
  } catch (err) {
    console.error("Charts fetch error:", err.message);
    res.status(500).json({ success: false, error: "Failed to fetch charts" });
  }
});

// === Voting System ===
app.post("/api/vote", async (req, res) => {
  try {
    const { track_id, score } = req.body;
    if (!track_id || !score) return res.status(400).json({ success: false, error: "Missing fields" });

    // Fetch track
    const { data: track, error: fetchErr } = await supabase
      .from("tracks")
      .select("average_rating,total_votes")
      .eq("id", track_id)
      .single();
    if (fetchErr) throw fetchErr;

    const newTotalVotes = (track.total_votes || 0) + 1;
    const newAverage = ((track.average_rating || 0) * (track.total_votes || 0) + Number(score)) / newTotalVotes;

    // Update
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

// === Winner Finalization Placeholder ===
app.post("/api/finalize-winners", async (req, res) => {
  try {
    res.json({ success: true, message: "Winner selection logic coming soon." });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// === Start Server ===
app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Track Finder Charts backend running on port ${PORT}`);
});
