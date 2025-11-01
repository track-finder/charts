import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import multer from "multer";
import fs from "fs";

dotenv.config();
const app = express();
const PORT = process.env.PORT || 3000;

// === Supabase setup ===
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// === Middleware ===
app.use(cors({
  origin: ["https://trackfinder.co.uk", "https://www.trackfinder.co.uk"],
  credentials: true
}));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// === Multer setup for uploads ===
const upload = multer({ dest: "uploads/" });

// === Health check ===
app.get("/", (req, res) => {
  res.send("✅ Track Finder Charts backend running on port " + PORT);
});

// === Verify Upload Token ===
app.post("/api/verify-token", async (req, res) => {
  try {
    const { email, token } = req.body;
    if (!email || !token)
      return res.status(400).json({ success: false, error: "Missing email or token" });

    const { data, error } = await supabase
      .from("upload_tokens")
      .select("*")
      .eq("email", email)
      .eq("token", token)
      .eq("used", false)
      .maybeSingle();

    if (error) throw error;
    if (!data) return res.status(401).json({ success: false, error: "Invalid or already used token" });

    res.json({ success: true, message: "Token verified" });
  } catch (err) {
    console.error("Token verification error:", err.message);
    res.status(500).json({ success: false, error: "Server error verifying token" });
  }
});

// === Upload Track ===
app.post("/api/upload-track", upload.single("audio"), async (req, res) => {
  try {
    const { artist, title, genre, email, token, allowDownload } = req.body;
    if (!req.file || !artist || !title || !genre || !email || !token)
      return res.status(400).json({ success: false, error: "Missing required fields" });

    // Verify upload token
    const { data: tokenRow, error: tokenErr } = await supabase
      .from("upload_tokens")
      .select("*")
      .eq("email", email)
      .eq("token", token)
      .eq("used", false)
      .maybeSingle();

    if (tokenErr) throw tokenErr;
    if (!tokenRow) return res.status(401).json({ success: false, error: "Invalid or used token" });

    // Upload file to Supabase storage
    const audioBuffer = fs.readFileSync(req.file.path);
    const fileName = `${Date.now()}_${req.file.originalname}`;

    const { data: storageData, error: uploadErr } = await supabase.storage
      .from("track_uploads")
      .upload(fileName, audioBuffer, {
        contentType: req.file.mimetype,
        upsert: false,
      });

    fs.unlinkSync(req.file.path); // Clean up local file
    if (uploadErr) throw uploadErr;

    const audioUrl = `${process.env.SUPABASE_URL}/storage/v1/object/public/track_uploads/${fileName}`;

    // Save track info
    const { error: insertErr } = await supabase
      .from("tracks")
      .insert([{
        artist,
        title,
        genre,
        track_url: audioUrl,
        allow_download: allowDownload === "true",
        play_count: 0,
        average_rating: 0,
        total_votes: 0
      }]);

    if (insertErr) throw insertErr;

    // Mark token as used
    await supabase
      .from("upload_tokens")
      .update({ used: true })
      .eq("id", tokenRow.id);

    res.json({ success: true, message: "✅ Track uploaded successfully" });
  } catch (err) {
    console.error("Upload error:", err.message);
    res.status(500).json({ success: false, error: "Upload failed: " + err.message });
  }
});

// === Start Server ===
app.listen(PORT, () => {
  console.log(`✅ Track Finder Charts backend running on port ${PORT}`);
});
