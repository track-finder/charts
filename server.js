// === Track Finder Charts Backend (server.js) ===
// Version: 1.0.0 - Token Verified Uploads
// Author: Jonathan Russell

import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import multer from "multer";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import { Resend } from "resend";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 10001;

// === Middleware ===
app.use(
  cors({
    origin: ["https://trackfinder.co.uk", "https://www.trackfinder.co.uk"],
    credentials: true,
  })
);
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// === Multer (memory storage) ===
const upload = multer({ storage: multer.memoryStorage() });

// === Supabase ===
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// === Resend setup ===
const resend = new Resend(process.env.RESEND_API_KEY);
const FROM_EMAIL = process.env.FROM_EMAIL || "noreply@trackfinder.co.uk";

// === Health check ===
app.get("/health", (req, res) => {
  res.json({ ok: true, service: "Track Finder Charts", status: "running" });
});

// === ADMIN: Create upload token ===
app.post("/api/create-upload-token", async (req, res) => {
  try {
    const adminKey = req.headers["x-admin-token"];
    if (!adminKey || adminKey !== process.env.ADMIN_TOKEN)
      return res.status(401).json({ success: false, error: "Unauthorized" });

    const { email } = req.body;
    if (!email) return res.status(400).json({ success: false, error: "Email required" });

    const token = Math.random().toString(36).substring(2, 10).toUpperCase();

    const { error } = await supabase.from("upload_tokens").insert([{ email, token }]);
    if (error) throw error;

    await resend.emails.send({
      from: FROM_EMAIL,
      to: email,
      subject: "🎵 Your Track Finder Upload Token",
      html: `<p>Hi there,</p><p>Here is your upload token for Track Finder Charts:</p>
             <h2>${token}</h2>
             <p>Use it once to upload your track at <a href="https://trackfinder.co.uk/upload">Track Finder Upload Page</a>.</p>
             <p>Thanks,<br>Track Finder Team</p>`,
    });

    res.json({ success: true, message: "Token created and emailed", token });
  } catch (err) {
    console.error("Create token error:", err.message);
    res.status(500).json({ success: false, error: "Failed to create token" });
  }
});

// === Verify token ===
app.post("/api/verify-token", async (req, res) => {
  try {
    const { email, token } = req.body;
    if (!email || !token)
      return res.status(400).json({ success: false, error: "Email and token required" });

    const { data, error } = await supabase
      .from("upload_tokens")
      .select("*")
      .eq("email", email)
      .eq("token", token)
      .eq("used", false)
      .single();

    if (error || !data)
      return res.status(403).json({ success: false, error: "Invalid or already used token" });

    res.json({ success: true, message: "Token verified" });
  } catch (err) {
    console.error("Verify token error:", err.message);
    res.status(500).json({ success: false, error: "Server error verifying token" });
  }
});

// === Upload track ===
app.post("/api/upload-track", upload.single("file"), async (req, res) => {
  try {
    const { email, token, title, artist, genre } = req.body;
    const file = req.file;

    if (!email || !token || !title || !artist || !file)
      return res.status(400).json({ success: false, error: "Missing required fields" });

    // verify token
    const { data: validToken } = await supabase
      .from("upload_tokens")
      .select("*")
      .eq("email", email)
      .eq("token", token)
      .eq("used", false)
      .single();

    if (!validToken)
      return res.status(403).json({ success: false, error: "Invalid or used token" });

    // upload file to storage
    const { data: fileData, error: uploadErr } = await supabase.storage
      .from("tracks")
      .upload(`uploads/${Date.now()}_${file.originalname}`, file.buffer, {
        contentType: file.mimetype,
        upsert: true,
      });

    if (uploadErr) throw uploadErr;

    // store metadata in DB
    const { error: dbError } = await supabase.from("tracks").insert([
      {
        title,
        artist,
        genre,
        uploader_email: email,
        file_path: fileData.path,
        created_at: new Date().toISOString(),
      },
    ]);
    if (dbError) throw dbError;

    // mark token used
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

// === Get all tracks ===
app.get("/api/tracks", async (req, res) => {
  try {
    const { data, error } = await supabase.from("tracks").select("*").order("created_at", { ascending: false });
    if (error) throw error;
    res.json({ success: true, tracks: data });
  } catch (err) {
    console.error("Fetch tracks error:", err.message);
    res.status(500).json({ success: false, error: "Failed to fetch tracks" });
  }
});

// === Start server ===
app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Track Finder Charts backend running on port ${PORT}`);
});
