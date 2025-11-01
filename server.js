// === Track Finder Charts Backend ===
// Complete working version with upload_tokens & dual file upload (track + artwork)

import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import multer from "multer";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";

dotenv.config();
const app = express();
const PORT = process.env.PORT || 3000;

// === Middleware ===
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// === Supabase ===
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// === Multer setup ===
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 100 * 1024 * 1024 }, // 100 MB limit
}).fields([
  { name: "file", maxCount: 1 },
  { name: "artwork", maxCount: 1 },
]);

// === Health check ===
app.get("/", (req, res) => {
  res.send("✅ Track Finder Charts backend is live");
});

// === Upload Track Route ===
app.post("/api/upload-track", upload, async (req, res) => {
  try {
    const { email, token, artist, title, genre, allow_download } = req.body;

    console.log("Incoming upload:", { email, token, artist, title, genre });

    // Validate token
    const { data: tokenRow, error: tokenError } = await supabase
      .from("upload_tokens")
      .select("*")
      .eq("email", email)
      .eq("token", token)
      .eq("used", false)
      .maybeSingle();

    if (tokenError || !tokenRow) {
      return res
        .status(400)
        .json({ success: false, error: "Invalid or already used token." });
    }

    const trackFile = req.files?.file?.[0];
    const artworkFile = req.files?.artwork?.[0];

    if (!trackFile) {
      return res
        .status(400)
        .json({ success: false, error: "Track file missing." });
    }

    // === Upload track file ===
    const trackName = `${Date.now()}_${trackFile.originalname}`;
    const { error: trackErr } = await supabase.storage
      .from("tracks")
      .upload(trackName, trackFile.buffer, {
        contentType: trackFile.mimetype,
      });

    if (trackErr) throw trackErr;

    const trackUrl = `${process.env.SUPABASE_URL}/storage/v1/object/public/tracks/${trackName}`;

    // === Upload artwork (optional) ===
    let artworkUrl =
      "https://YOUR_SUPABASE_URL/storage/v1/object/public/artwork/default.png";

    if (artworkFile) {
      const artworkName = `${Date.now()}_${artworkFile.originalname}`;
      const { error: artErr } = await supabase.storage
        .from("artwork")
        .upload(artworkName, artworkFile.buffer, {
          contentType: artworkFile.mimetype,
        });

      if (!artErr) {
        artworkUrl = `${process.env.SUPABASE_URL}/storage/v1/object/public/artwork/${artworkName}`;
      }
    }

    // === Insert track record ===
    const { error: insertErr } = await supabase.from("tracks").insert([
      {
        email,
        artist,
        title,
        genre,
        track_url: trackUrl,
        artwork_url: artworkUrl,
        allow_download: allow_download === "true",
        approved: true,
      },
    ]);

    if (insertErr) throw insertErr;

    // === Mark token as used ===
    await supabase
      .from("upload_tokens")
      .update({ used: true })
      .eq("email", email)
      .eq("token", token);

    res.json({ success: true, message: "Track uploaded successfully!" });
  } catch (err) {
    console.error("Upload error:", err.message);
    res.status(500).json({ success: false, error: "Upload failed" });
  }
});

// === Start Server ===
app.listen(PORT, () => {
  console.log(`✅ Track Finder Charts backend running on port ${PORT}`);
});
