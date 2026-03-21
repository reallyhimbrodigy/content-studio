const { createClient } = require("@supabase/supabase-js");
const fs = require("fs");

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const styleGuide = fs.readFileSync("reference-videos/_last_style_guide.txt", "utf-8");

async function update() {
  const now = new Date();
  const validUntil = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

  const { error } = await supabase.from("trend_profiles").insert({
    profile_type: "general",
    sample_size: 5,
    computed_at: now.toISOString(),
    valid_until: validUntil.toISOString(),
    profile_json: {
      type: "style_guide",
      style_guide: styleGuide,
      sample_size: 5,
      computed_at: now.toISOString(),
      source: "manual_reference_videos",
    },
  });

  if (error) console.error("Failed:", error.message);
  else console.log("Style guide updated in Supabase");
}

update();
