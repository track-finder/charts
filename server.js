import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 10001;

// === Middleware ===
app.use(cors({
  origin: [
    "https://www.trackfinder.co.uk",
    "https://trackfinder.co.uk",
  ],
  credentials: true,
}));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// === Supabase setup ===
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// === Health route ===
app.get("/health", (req, res) => {
  res.json({ success: true, message: "Track Finder Charts backend running." });
});

// === Upload route (requires email + token) ===
app.post("/api/upload", async (req, res) => {
  try {
    const { artist, title, genre, email, token, track_url, artwork_url } = req.body;
    if (!artist || !title || !genre || !email || !token || !track_url) {
      return res.status(400).json({ success: false, error: "Missing required fields." });
    }

    // Check token validity
    const { data: tokenData, error: tokenErr } = await supabase
      .from("upload_tokens")
      .select("*")
      .eq("email", email)
      .eq("token", token)
      .eq("used", false)
      .single();

    if (tokenErr || !tokenData) {
      return res.status(403).json({ success: false, error: "Invalid or used upload token." });
    }

    // Insert track
    const { error: insertErr } = await supabase.from("tracks").insert([{
      artist,
      title,
      genre,
      email,
      track_url,
      artwork_url: artwork_url || "https://www.trackfinder.co.uk/s/track-finder-logo.png",
      play_count: 0,
      average_rating: 0,
      total_votes: 0
    }]);

    if (insertErr) throw insertErr;

    // Mark token as used
    await supabase
      .from("upload_tokens")
      .update({ used: true })
      .eq("id", tokenData.id);

    res.json({ success: true, message: "Track uploaded successfully." });
  } catch (err) {
    console.error("Upload error:", err.message);
    res.status(500).json({ success: false, error: "Failed to upload track." });
  }
});

// === Fetch all tracks ===
app.get("/api/charts", async (req, res) => {
  try {
    const genre = req.query.genre || "all";
    let query = supabase.from("tracks").select("*").order("average_rating", { ascending: false });
    if (genre !== "all") query = query.eq("genre", genre);

    const { data, error } = await query;
    if (error) throw error;
    res.json({ success: true, tracks: data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// === Voting route ===
app.post("/api/vote", async (req, res) => {
  try {
    const { track_id, score } = req.body;
    if (!track_id || !score) return res.status(400).json({ success: false, error: "Missing parameters." });

    const { data: track, error: fetchErr } = await supabase
      .from("tracks")
      .select("average_rating, total_votes")
      .eq("id", track_id)
      .single();

    if (fetchErr || !track) throw new Error("Track not found.");

    const newTotalVotes = track.total_votes + 1;
    const newAverage = ((track.average_rating * track.total_votes) + score) / newTotalVotes;

    const { error: updateErr } = await supabase
      .from("tracks")
      .update({ average_rating: newAverage, total_votes: newTotalVotes })
      .eq("id", track_id);

    if (updateErr) throw updateErr;

    res.json({ success: true, message: "Vote counted successfully." });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// === Finalize monthly winners ===
app.post("/api/finalize-winners", async (req, res) => {
  try {
    const { data: tracks, error } = await supabase
      .from("tracks")
      .select("*")
      .order("average_rating", { ascending: false })
      .limit(10);

    if (error) throw error;

    for (const t of tracks) {
      await supabase.from("winners").insert({
        track_id: t.id,
        artist: t.artist,
        title: t.title,
        genre: t.genre,
        month: new Date().toISOString().slice(0, 7)
      });
    }

    res.json({ success: true, message: "Winners finalized successfully." });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// === Start server ===
app.listen(PORT, () => console.log(`✅ Track Finder Charts backend running on port ${PORT}`));
