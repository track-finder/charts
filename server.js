import express from "express";
import cors from "cors";
import multer from "multer";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

dotenv.config();
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// === Supabase setup ===
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// === Multer setup for track + artwork ===
const storage = multer.memoryStorage();
const upload = multer({ storage });

// === API HEALTH CHECK ===
app.get("/health", (req, res) => res.json({ success: true, status: "Track Finder Charts backend running" }));

// === FETCH CHARTS ===
app.get("/api/charts", async (req, res) => {
  try {
    const genre = req.query.genre && req.query.genre !== "all" ? req.query.genre : null;
    let query = supabase.from("tracks").select("*").eq("approved", true).order("created_at", { ascending: false });
    if (genre) query = query.eq("genre", genre);
    const { data, error } = await query;

    if (error) throw error;
    res.json({ success: true, tracks: data || [] });
  } catch (err) {
    console.error("Charts fetch error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// === UPLOAD TRACK ===
app.post("/api/upload-track", upload.fields([{ name: "file" }, { name: "artwork" }]), async (req, res) => {
  try {
    const { email, token, artist, title, genre } = req.body;
    const allow_download = req.body.allow_download === "true";

    console.log("Incoming upload:", { email, token, artist, title, genre });

    // Validate token
    const { data: tokenRow, error: tokenErr } = await supabase
      .from("upload_tokens")
      .select("*")
      .eq("email", email)
      .eq("token", token)
      .single();

    if (tokenErr || !tokenRow) {
      return res.status(400).json({ success: false, error: "Invalid or expired upload token." });
    }

    // Upload track file to Supabase storage
    const trackFile = req.files?.file?.[0];
    if (!trackFile) throw new Error("No track file uploaded.");
    const trackPath = `tracks/${Date.now()}_${trackFile.originalname}`;
    await supabase.storage.from("tracks").upload(trackPath, trackFile.buffer, {
      contentType: trackFile.mimetype,
      upsert: true
    });
    const { data: trackPublic } = supabase.storage.from("tracks").getPublicUrl(trackPath);

    // Upload artwork or use default
    let artworkPublic = { publicUrl: "https://images.squarespace-cdn.com/content/v1/68f697b5332bf833149a87f0/a589f65e-a612-4220-8ef8-320f1f6791d5/track+finder+logo.png?format=1500w" };
    if (req.files?.artwork?.[0]) {
      const artworkFile = req.files.artwork[0];
      const artworkPath = `artworks/${Date.now()}_${artworkFile.originalname}`;
      await supabase.storage.from("artworks").upload(artworkPath, artworkFile.buffer, {
        contentType: artworkFile.mimetype,
        upsert: true
      });
      const { data: artworkData } = supabase.storage.from("artworks").getPublicUrl(artworkPath);
      artworkPublic = artworkData;
    }

    // Save to DB
    const { error: insertErr } = await supabase.from("tracks").insert([
      {
        email,
        artist,
        title,
        genre,
        track_url: trackPublic.publicUrl,
        artwork_url: artworkPublic.publicUrl,
        allow_download,
        approved: true,
        play_count: 0
      }
    ]);

    if (insertErr) throw insertErr;
    res.json({ success: true });
  } catch (err) {
    console.error("Upload error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// === DELETE TRACK (Admin only) ===
app.delete("/api/delete-track/:id", async (req, res) => {
  try {
    const adminToken = req.headers["x-admin-token"];
    if (adminToken !== "TRACKFINDER-ADMIN") {
      return res.status(403).json({ success: false, error: "Unauthorized" });
    }

    const { id } = req.params;
    if (!id) return res.status(400).json({ success: false, error: "Missing track ID" });

    // Find track to get storage paths
    const { data: track, error: fetchErr } = await supabase.from("tracks").select("*").eq("id", id).single();
    if (fetchErr || !track) throw new Error("Track not found.");

    // Extract storage file paths
    const trackFile = track.track_url?.split("/tracks/")[1];
    const artworkFile = track.artwork_url?.split("/artworks/")[1];

    // Delete storage files
    if (trackFile) await supabase.storage.from("tracks").remove([`tracks/${trackFile}`]);
    if (artworkFile) await supabase.storage.from("artworks").remove([`artworks/${artworkFile}`]);

    // Delete DB entry
    const { error: delErr } = await supabase.from("tracks").delete().eq("id", id);
    if (delErr) throw delErr;

    res.json({ success: true });
  } catch (err) {
    console.error("Delete track error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// === Start Server ===
app.listen(PORT, () => console.log(`✅ Track Finder Charts backend running on port ${PORT}`));
