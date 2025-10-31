// === Track Finder Charts Backend ===
// Version 6.0 – Stable Render Build
// Author: Jonathan Russell
import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import multer from "multer";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
dotenv.config();
const app = express();
const PORT = process.env.PORT || 3000;
app.use(cors({origin:["https://trackfinder.co.uk","https://www.trackfinder.co.uk"],credentials:true}));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({extended:true}));
const upload = multer({storage:multer.memoryStorage()});
const supabase=createClient(process.env.https://jonlbohqkvajrpwkhmtq.supabase.co,process.env.eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Impvbmxib2hxa3ZhanJwd2tobXRxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjE4NzA1MjksImV4cCI6MjA3NzQ0NjUyOX0.G2JkcqzjuSQHFMwLH1NRLI_RGwa47kaezX_LKJFjIJc);
const DEFAULT_LOGO="https://www.trackfinder.co.uk/assets/trackfinder-default-logo.png";
app.get("/",(r,s)=>s.send("✅ Track Finder Charts Backend Running"));
app.get("/health",(r,s)=>s.json({ok:true}));
app.post("/api/upload-track",upload.fields([{name:"track"},{name:"artwork"}]),async(req,res)=>{
 try{const{title,artist,genre,uploader_email}=req.body;
 if(!title||!artist||!req.files.track)return res.status(400).json({error:"Missing title, artist, or track"});
 const trackFile=req.files.track[0];
 const{data:trackData,error:trackErr}=await supabase.storage.from("tracks").upload(`uploads/${Date.now()}_${trackFile.originalname}`,trackFile.buffer,{contentType:trackFile.mimetype,upsert:true});
 if(trackErr)throw trackErr;
 let artworkUrl=DEFAULT_LOGO;
 if(req.files.artwork&&req.files.artwork[0]){
   const artFile=req.files.artwork[0];
   const{data:artData,error:artErr}=await supabase.storage.from("artworks").upload(`uploads/${Date.now()}_${artFile.originalname}`,artFile.buffer,{contentType:artFile.mimetype,upsert:true});
   if(!artErr)artworkUrl=`${process.env.SUPABASE_URL}/storage/v1/object/public/${artData.path}`;
 }
 const trackUrl=`${process.env.SUPABASE_URL}/storage/v1/object/public/${trackData.path}`;
 const{error:insErr}=await supabase.from("tracks").insert([{title,artist,genre,uploader_email,track_url:trackUrl,artwork_url:artworkUrl}]);
 if(insErr)throw insErr;res.json({success:true,message:"Track uploaded"});
 }catch(e){console.error(e.message);res.status(500).json({error:"Upload failed"});}});
app.get("/api/tracks",async(r,s)=>{try{const{data,error}=await supabase.from("tracks").select("*").order("created_at",{ascending:false});if(error)throw error;s.json(data);}catch(e){s.status(500).json({error:"Failed"});}});
app.post("/api/vote",async(r,s)=>{try{const{track_id,score}=r.body;if(!track_id||!score)return s.status(400).json({error:"Missing data"});
 await supabase.from("votes").insert([{track_id,score}]);
 const{data:votes}=await supabase.from("votes").select("score").eq("track_id",track_id);
 const total=votes.length;const avg=votes.reduce((a,v)=>a+v.score,0)/total;
 await supabase.from("tracks").update({total_votes:total,average_rating:avg}).eq("id",track_id);
 s.json({success:true});}catch(e){s.status(500).json({error:"Vote failed"});}});
app.post("/api/track-play/:id",async(r,s)=>{try{const{id}=r.params;
 const{data}=await supabase.from("tracks").select("play_count").eq("id",id).single();
 const newC=(data.play_count||0)+1;await supabase.from("tracks").update({play_count:newC}).eq("id",id);
 s.json({success:true,play_count:newC});}catch(e){s.status(500).json({error:"Play count failed"});}});
app.post("/api/finalize-winners",async(r,s)=>{try{const m=new Date().toISOString().slice(0,7);
 const{data:tracks}=await supabase.from("tracks").select("id,average_rating,total_votes,play_count").order("average_rating",{ascending:false});
 if(!tracks?.length)return s.json({message:"No tracks"});
 const w=tracks.sort((a,b)=>b.average_rating*b.total_votes+b.play_count-(a.average_rating*a.total_votes+a.play_count))[0];
 await supabase.from("winners").insert([{track_id:w.id,month_year:m}]);
 s.json({success:true,winner:w});}catch(e){s.status(500).json({error:"Finalize failed"});}});
app.get("/api/winners",async(r,s)=>{try{const{data,error}=await supabase.from("winners").select("*,tracks(title,artist,genre,artwork_url)").order("created_at",{ascending:false});
 if(error)throw error;s.json(data);}catch(e){s.status(500).json({error:"Fetch winners failed"});}});
app.listen(PORT,()=>console.log(`✅ Charts backend running on port ${PORT}`));
