// === Track Finder Charts Backend (Full Build v6.0) ===
// Author: Jonathan Russell
// Purpose: Handles artist uploads, chart voting, and winner logic

import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import multer from "multer";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { Resend } from "resend";
import fs from "fs";
import ffmpeg from "fluent-ffmpeg";
import ffmpegPath from "ffmpeg-static";

dotenv.config();
const app = express();
const PORT = process.env.PORT || 10000;

ffmpeg.setFfmpegPath(ffmpegPath);

// === Middleware ===
app.use(
  cors({
    origin: ["https://www.trackfinder.co.uk", "https://trackfinder.co.uk"],
    credentials: true,
  })
);
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// === Supabase & Resend Setup ===
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);
const resend = new Resend(process.env.RESEND_API);
const FROM_EMAIL = process.env.FROM_EMAIL || "admin@trackfinder.co.uk";

// === Multer ===
const upload = multer({ dest: "uploads/" });

// === Health Check ===
app.get("/health", (req, res) => res.json({ ok: true, status: "running" }));

// === Verify Upload Token ===
async function verifyToken(email, token) {
  const { data, error } = await supabase
    .from("upload_tokens")
    .select("*")
    .eq("email", email)
    .eq("token", token)
    .eq("used", false)
    .maybeSingle();

  if (error) throw error;
  return data;
}

// === Send Email Helper ===
async function sendEmail(to, subject, html) {
  try {
    await resend.emails.send({ from: FROM_EMAIL, to, subject, html });
  } catch (err) {
    console.error("Email send failed:", err.message);
  }
}

// === Upload Track ===
app.post(
  "/api/upload-track",
  upload.fields([
    { name: "file", maxCount: 1 },
    { name: "artwork", maxCount: 1 },
  ]),
  async (req, res) => {
    try {
      const { artist, title, genre, email, token, allow_download } = req.body;

      if (!artist || !title || !genre || !email || !token || !req.files.file)
        return res
          .status(400)
          .json({ success: false, error: "Missing required fields." });

      const tokenData = await verifyToken(email, token);
      if (!tokenData)
        return res
          .status(403)
          .json({ success: false, error: "Invalid or used token." });

      const trackFile = req.files.file[0];
      const previewPath = `uploads/preview_${Date.now()}.mp3`;

      // === Create 1:00 → 2:30 preview ===
      await new Promise((resolve, reject) => {
        ffmpeg(trackFile.path)
          .setStartTime("00:01:00")
          .setDuration("00:01:30")
          .output(previewPath)
          .on("end", resolve)
          .on("error", reject)
          .run();
      });

      // === Upload Full + Preview to Supabase Storage ===
      const [fullUpload, previewUpload] = await Promise.all([
        supabase.storage
          .from("tracks")
          .upload(
            `full/${Date.now()}_${trackFile.originalname}`,
            fs.readFileSync(trackFile.path),
            { contentType: trackFile.mimetype }
          ),
        supabase.storage
          .from("tracks")
          .upload(
            `previews/preview_${Date.now()}.mp3`,
            fs.readFileSync(previewPath),
            { contentType: "audio/mpeg" }
          ),
      ]);

      // === Upload Artwork or Use Default ===
      let artworkUrl =
        "https://www.trackfinder.co.uk/s/track-finder-logo.png";
      if (req.files.artwork) {
        const art = req.files.artwork[0];
        const artUpload = await supabase.storage
          .from("artworks")
          .upload(
            `art_${Date.now()}_${art.originalname}`,
            fs.readFileSync(art.path),
            { contentType: art.mimetype }
          );
        if (!artUpload.error)
          artworkUrl = `${process.env.SUPABASE_URL}/storage/v1/object/public/${artUpload.data.path}`;
      }

      // === Save in Database ===
      const { error: insertErr } = await supabase.from("tracks").insert([
        {
          artist,
          title,
          genre,
          email,
          allow_download: allow_download === "true",
          file_url: `${process.env.SUPABASE_URL}/storage/v1/object/public/${fullUpload.data.path}`,
          preview_url: `${process.env.SUPABASE_URL}/storage/v1/object/public/${previewUpload.data.path}`,
          artwork_url: artworkUrl,
          created_at: new Date().toISOString(),
          total_votes: 0,
          average_rating: 0,
          play_count: 0,
        },
      ]);

      if (insertErr) throw insertErr;

      await supabase
        .from("upload_tokens")
        .update({ used: true })
        .eq("id", tokenData.id);

      fs.unlinkSync(trackFile.path);
      fs.unlinkSync(previewPath);
      if (req.files.artwork) fs.unlinkSync(req.files.artwork[0].path);

      await sendEmail(
        email,
        "🎵 Track Uploaded Successfully!",
        `<p>Hi ${artist},</p>
         <p>Your track <b>${title}</b> has been uploaded to Track Finder Charts.</p>
         <p>Preview: 1:00 – 2:30 | Genre: ${genre}</p>
         <p>Thank you for contributing!</p>`
      );

      res.json({ success: true, message: "Track uploaded successfully." });
    } catch (err) {
      console.error("Upload error:", err.message);
      res.status(500).json({ success: false, error: "Upload failed." });
    }
  }
);

// === Get Charts ===
app.get("/api/charts", async (req, res) => {
  try {
    const genre = req.query.genre || "all";
    const query = supabase
      .from("tracks")
      .select("*")
      .order("average_rating", { ascending: false });

    if (genre !== "all") query.eq("genre", genre);
    const { data, error } = await query;

    if (error) throw error;
    res.json({ tracks: data });
  } catch (err) {
    console.error("Charts fetch error:", err.message);
    res.status(500).json({ error: "Failed to fetch charts." });
  }
});

// === Voting ===
app.post("/api/vote", async (req, res) => {
  try {
    const { track_id, score } = req.body;
    if (!track_id || !score)
      return res.status(400).json({ error: "Missing fields" });

    const { data, error } = await supabase
      .from("tracks")
      .select("total_votes, average_rating")
      .eq("id", track_id)
      .single();

    if (error || !data) throw error;

    const total = (data.total_votes || 0) + 1;
    const avg =
      ((data.average_rating || 0) * (total - 1) + score) / total;

    await supabase
      .from("tracks")
      .update({ total_votes: total, average_rating: avg })
      .eq("id", track_id);

    res.json({ success: true });
  } catch (err) {
    console.error("Vote error:", err.message);
    res.status(500).json({ error: "Failed to vote." });
  }
});

// === Play Counter ===
app.post("/api/track-play/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { data, error } = await supabase
      .from("tracks")
      .select("play_count")
      .eq("id", id)
      .single();
    if (error) throw error;

    const newCount = (data.play_count || 0) + 1;
    await supabase
      .from("tracks")
      .update({ play_count: newCount })
      .eq("id", id);

    res.json({ success: true, play_count: newCount });
  } catch (err) {
    console.error("Play counter error:", err.message);
    res.status(500).json({ error: "Failed to update play count" });
  }
});

// === Start Server ===
app.listen(PORT, "0.0.0.0", () =>
  console.log(`✅ Track Finder Charts backend running on port ${PORT}`)
);
