
const TEXT_MODEL = "@cf/google/gemma-4-26b-a4b-it";
const IMAGE_MODEL = "@cf/black-forest-labs/flux-1-schnell";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...cors, "Content-Type": "application/json" }
  });
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: cors });
    }

    const url = new URL(request.url);

    if (url.pathname === "/api/health") {
      return json({
        status: "online",
        aiConfigured: Boolean(env.AI),
        message: "Tips Cerdas AI is running."
      });
    }

    if (url.pathname !== "/api/generate" || request.method !== "POST") {
      return json({ error: "Endpoint tidak ditemukan." }, 404);
    }

    if (!env.AI) {
      return json({ error: "AI binding belum diaktifkan." }, 503);
    }

    try {
      const body = await request.json();
      const idea = String(body.idea || "").trim();
      const language = body.language === "en" ? "English" : "Indonesian";
      const style = String(body.style || "cinematic");
      const count = [5, 10, 15].includes(Number(body.scenes))
        ? Number(body.scenes) : 5;

      if (!idea || idea.length > 2000) {
        return json({ error: "Ide cerita wajib diisi (maksimal 2000 karakter)." }, 400);
      }

      const prompt = `
Create an original cinematic storyboard in ${language}.
Visual style: ${style}.
Story idea: ${idea}
Create exactly ${count} scenes.
Keep the main characters visually consistent in every scene.
Return ONLY valid JSON, without markdown fences, in this format:
{
  "title": "Story title",
  "logline": "Short story summary",
  "scenes": [
    {
      "title": "Scene title",
      "visualPrompt": "Detailed image generation description in English",
      "cameraDirection": "Camera angle and movement",
      "narration": "Narration in requested language",
      "sound": "Sound design description"
    }
  ]
}
Make every scene visually distinct and connected to the same story.
`;

      const textResult = await env.AI.run(TEXT_MODEL, {
        messages: [
          {
            role: "system",
            content: "You are a professional film screenwriter and storyboard artist. Return valid JSON only."
          },
          { role: "user", content: prompt }
        ],
        max_tokens: 6000,
        temperature: 0.7
      });

      let raw = textResult.response || textResult.result?.response || "";

      raw = raw.replace(/```json|```/g, "").trim();

      const start = raw.indexOf("{");
      const end = raw.lastIndexOf("}");

      if (start < 0 || end < start) {
        throw new Error("AI tidak menghasilkan format JSON yang benar.");
      }

      const story = JSON.parse(raw.slice(start, end + 1));

      if (!Array.isArray(story.scenes) || story.scenes.length === 0) {
        throw new Error("Adegan storyboard tidak ditemukan.");
      }

      story.scenes = story.scenes.slice(0, count);

      for (let i = 0; i < story.scenes.length; i++) {
        const scene = story.scenes[i];

        try {
          const imageResult = await env.AI.run(IMAGE_MODEL, {
            prompt: `Cinematic storyboard frame, ${style} visual style. ${scene.visualPrompt}. Beautiful composition, consistent characters, professional film lighting. No text, no watermark.`,
            steps: 4
          });

          if (imageResult.image) {
            scene.image = "data:image/jpeg;base64," + imageResult.image;
          } else {
            scene.imageError = "Gambar tidak tersedia.";
          }
        } catch (imageError) {
          scene.imageError = "Gagal membuat gambar adegan ini.";
        }
      }

      return json({
        success: true,
        title: story.title || "Untitled Storyboard",
        logline: story.logline || "",
        scenes: story.scenes
      });

    } catch (error) {
      return json({
        error: error.message || "Terjadi kesalahan pada server."
      }, 500);
    }
  }
};
