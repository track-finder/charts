// === Track Finder Charts Backend (server.js) ===
// Version: 5.0
// Author: Jonathan Russell
// Purpose: Handle artist uploads, voting, and monthly chart logic.

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

// === Middleware ===
app.use(cors({
  origin: ["https://www.trackfinder.co.uk", "https://trackfinder.co.uk"],
  credentials: true,
}));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// === Supabase & Resend setup ===
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);
const resend = new Resend(process.env.RESEND_API);
const FROM_EMAIL = "admin@trackfinder.co.uk";

// === File upload setup ===
const upload = multer({ storage: multer.memoryStorage() });

// === Health check ===
app.get("/health", (req, res) => res.json({ ok: true, status: "running" }));

// === Helper: send email ===
async function sendEmail(to, subject, html) {
  try {
    await resend.emails.send({ from: FROM_EMAIL, to, subject, html });
  } catch (err) {
    console.error("Email send error:", err.message);
  }
}

// === Check Email / Token ===
app.post("/api/check-email", async (req, res) => {
  try {
    const { email } = req.body;
    if (!email)
      return res.status(400).json({ success: false, message: "Email required" });

    const { data, error } = await supabase
      .from("tokens")
      .select("*")
      .eq("user_email", email)
      .eq("used", false)
      .maybeSingle();

    if (error) throw error;

    if (!data) {
      return res.status(403).json({ success: false, message: "Invalid or used token" });
    }

    res.json({ success: true, message: "Email verified" });
  } catch (err) {
    console.error("Email verification error:", err.message);
    res.status(500).json({ success: false, message: "Server error checking email" });
  }
});

// === Upload Track ===
app.post("/api/upload-track", upload.single("file"), async (req, res) => {
  try {
    const { title, artist, genre, email, token, allow_download } = req.body;
    const file = req.file;

    if (!title || !artist || !file || !email || !token)
      return res.status(400).json({ success: false, message: "Missing required fields" });

    // Verify token
    const { data: tokenData, error: tokenError } = await supabase
      .from("tokens")
      .select("*")
      .eq("user_email", email)
      .eq("token", token)
      .eq("used", false)
      .maybeSingle();

    if (tokenError) throw tokenError;
    if (!tokenData)
      return res.status(403).json({ success: false, message: "Invalid or used token" });

    // Upload audio file
    const { data: uploadData, error: uploadError } = await supabase.storage
      .from("tracks")
      .upload(`uploads/${Date.now()}_${file.originalname}`, file.buffer, {
        contentType: file.mimetype,
        upsert: true,
      });

    if (uploadError) throw uploadError;

    const trackUrl = `${process.env.SUPABASE_URL}/storage/v1/object/public/${uploadData.path}`;

    // Save metadata
    const { error: insertError } = await supabase.from("tracks").insert([
      {
        title,
        artist,
        genre,
        uploader_email: email,
        file_path: trackUrl,
        allow_download: allow_download === "true",
        play_count: 0,
        average_rating: 0,
        total_votes: 0,
        created_at: new Date().toISOString(),
      },
    ]);

    if (insertError) throw insertError;

    // Mark token as used
    await supabase
      .from("tokens")
      .update({ used: true, used_at: new Date().toISOString() })
      .eq("id", tokenData.id);

    // Send confirmation email
    await sendEmail(
      email,
      "🎶 Your Track Has Been Uploaded!",
      `<p>Hi ${artist},</p>
      <p>Your track <b>${title}</b> has been successfully uploaded to the Track Finder charts.</p>
      <p>Thank you for contributing to the underground community!</p>
      <br><p>— Track Finder Team</p>`
    );

    res.json({ success: true, message: "Track uploaded successfully!" });
  } catch (err) {
    console.error("Upload error:", err.message);
    res.status(500).json({ success: false, message: "Upload failed" });
  }
});

// === Get Tracks ===
app.get("/api/tracks", async (req, res) => {
  try {
    const genre = req.query.genre;
    let query = supabase.from("tracks").select("*").order("created_at", { ascending: false });
    if (genre && genre !== "all") query = query.eq("genre", genre);

    const { data, error } = await query;
    if (error) throw error;

    res.json({ success: true, tracks: data });
  } catch (err) {
    console.error("Fetch tracks error:", err.message);
    res.status(500).json({ success: false, message: "Failed to fetch tracks" });
  }
});

// === Vote ===
app.post("/api/vote", async (req, res) => {
  try {
    const { track_id, score } = req.body;
    if (!track_id || !score) return res.status(400).json({ success: false, message: "Missing fields" });

    const { data: track, error: fetchError } = await supabase
      .from("tracks")
      .select("average_rating, total_votes")
      .eq("id", track_id)
      .maybeSingle();

    if (fetchError) throw fetchError;
    if (!track) return res.status(404).json({ success: false, message: "Track not found" });

    const newTotalVotes = (track.total_votes || 0) + 1;
    const newAvgRating =
      ((track.average_rating || 0) * (track.total_votes || 0) + Number(score)) / newTotalVotes;

    const { error: updateError } = await supabase
      .from("tracks")
      .update({ average_rating: newAvgRating, total_votes: newTotalVotes })
      .eq("id", track_id);

    if (updateError) throw updateError;
    res.json({ success: true });
  } catch (err) {
    console.error("Vote error:", err.message);
    res.status(500).json({ success: false, message: "Failed to vote" });
  }
});

// === Finalize Winners (cron monthly) ===
app.post("/api/finalize-winners", async (req, res) => {
  try {
    const adminToken = req.headers["x-admin-token"];
    if (adminToken !== process.env.ADMIN_TOKEN)
      return res.status(401).json({ success: false, message: "Unauthorized" });

    const { data: tracks, error } = await supabase
      .from("tracks")
      .select("*")
      .order("average_rating", { ascending: false })
      .limit(10);

    if (error) throw error;

    for (const t of tracks) {
      await supabase.from("winners").insert([
        {
          track_id: t.id,
          title: t.title,
          artist: t.artist,
          average_rating: t.average_rating,
          total_votes: t.total_votes,
          created_at: new Date().toISOString(),
        },
      ]);
    }

    res.json({ success: true, message: "Winners finalized" });
  } catch (err) {
    console.error("Finalize winners error:", err.message);
    res.status(500).json({ success: false, message: "Failed to finalize winners" });
  }
});

// === Start Server ===
app.listen(PORT, "0.0.0.0", () =>
  console.log(`✅ Track Finder Charts backend running on port ${PORT}`)
);
