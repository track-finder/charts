import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import multer from "multer";
import fs from "fs";
import path from "path";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// === Middleware ===
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// === Supabase setup ===
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// === Multer setup (file uploads) ===
const upload = multer({ dest: "uploads/" });

// === Base route ===
app.get("/", (req, res) => {
  res.send("✅ Track Finder Charts backend running on port " + PORT);
});

// === Upload Track ===
app.post("/api/upload-track", upload.fields([{ name: "file" }, { name: "artwork" }]), async (req, res) => {
  try {
    const { email, token, artist, title, genre, allow_download } = req.body;
    console.log("Incoming upload:", { email, token, artist, title, genre });

    // Validate token
    const { data: tokenData, error: tokenError } = await supabase
      .from("upload_tokens")
      .select("*")
      .eq("email", email)
      .eq("token", token)
      .eq("used", false)
      .maybeSingle();

    if (tokenError || !tokenData) {
      console.error("Token validation failed:", tokenError);
      return res.status(400).json({ success: false, error: "Invalid or used upload token" });
    }

    const trackFile = req.files?.file?.[0];
    const artworkFile = req.files?.artwork?.[0];

    if (!trackFile) return res.status(400).json({ success: false, error: "No track file uploaded" });

    // === Upload track ===
    const trackExt = path.extname(trackFile.originalname);
    const trackName = `${Date.now()}_${artist}_${title}${trackExt}`;
    const trackBuffer = fs.readFileSync(trackFile.path);

    const { data: trackUpload, error: trackUploadError } = await supabase.storage
      .from("tracks")
      .upload(trackName, trackBuffer, { contentType: trackFile.mimetype });

    if (trackUploadError) throw trackUploadError;
    const { data: trackUrl } = supabase.storage.from("tracks").getPublicUrl(trackName);

    // === Upload artwork or fallback ===
    let artworkUrl = "https://images.squarespace-cdn.com/content/v1/68f697b5332bf833149a87f0/a589f65e-a612-4220-8ef8-320f1f6791d5/track+finder+logo.png?format=1500w";

    if (artworkFile) {
      const artworkExt = path.extname(artworkFile.originalname);
      const artworkName = `${Date.now()}_${artist}_${title}${artworkExt}`;
      const artworkBuffer = fs.readFileSync(artworkFile.path);

      const { data: artworkUpload, error: artworkUploadError } = await supabase.storage
        .from("artwork")
        .upload(artworkName, artworkBuffer, { contentType: artworkFile.mimetype });

      if (artworkUploadError) throw artworkUploadError;
      const { data: artworkUrlData } = supabase.storage.from("artwork").getPublicUrl(artworkName);
      artworkUrl = artworkUrlData.publicUrl;
    }

    // === Insert into database ===
    const { error: insertError } = await supabase.from("tracks").insert([
      {
        artist,
        title,
        genre,
        uploader_email: email,
        track_url: trackUrl.publicUrl,
        artwork_url: artworkUrl,
        allow_download: allow_download === "true",
        approved: true,
        play_count: 0,
        total_votes: 0,
        average_rating: 0,
        created_at: new Date().toISOString(),
      },
    ]);

    if (insertError) throw insertError;

    // Mark token as used
    await supabase.from("upload_tokens").update({ used: true }).eq("id", tokenData.id);

    fs.unlinkSync(trackFile.path);
    if (artworkFile) fs.unlinkSync(artworkFile.path);

    res.json({ success: true });
  } catch (err) {
    console.error("Upload error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// === Get All Tracks for Charts ===
app.get("/api/charts", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("tracks")
      .select("*")
      .eq("approved", true)
      .order("created_at", { ascending: false });

    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    console.error("Chart fetch error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// === Admin: Get All Tracks ===
app.get("/api/admin/tracks", async (req, res) => {
  try {
    const { data, error } = await supabase.from("tracks").select("*").order("created_at", { ascending: false });
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    console.error("Admin fetch error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// === Admin: Delete Track (with Authorization) ===
app.delete("/api/delete-track/:id", async (req, res) => {
  const { id } = req.params;
  const authHeader = req.headers["authorization"];
  const ADMIN_KEY = process.env.ADMIN_KEY;

  if (!authHeader || authHeader !== `Bearer ${ADMIN_KEY}`) {
    return res.status(403).json({ success: false, error: "Unauthorized" });
  }

  try {
    const { data: track, error: fetchError } = await supabase
      .from("tracks")
      .select("track_url, artwork_url")
      .eq("id", id)
      .single();

    if (fetchError || !track) {
      return res.status(404).json({ success: false, error: "Track not found" });
    }

    const trackPath = track.track_url.split("/").pop();
    const artworkPath = track.artwork_url?.split("/").pop();

    await supabase.storage.from("tracks").remove([trackPath]);
    if (artworkPath) await supabase.storage.from("artwork").remove([artworkPath]);

    const { error: deleteError } = await supabase.from("tracks").delete().eq("id", id);
    if (deleteError) throw deleteError;

    res.json({ success: true });
  } catch (err) {
    console.error("Delete error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.listen(PORT, () => console.log(`✅ Track Finder Charts backend running on port ${PORT}`));
