
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
    headers: {
      ...cors,
      "Content-Type": "application/json"
    }
  });
}

function getText(result) {
  if (typeof result === "string") return result;

  if (!result || typeof result !== "object") return "";

  const candidates = [
    result.response,
    result.output_text,
    result.text,
    result.result?.response,
    result.result?.text,
    result.content?.[0]?.text
  ];

  for (const item of candidates) {
    if (typeof item === "string" && item.trim()) {
      return item;
    }
  }

  return JSON.stringify(result);
}

function parseAIJSON(raw) {
  const cleaned = raw
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();

  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");

  if (start === -1 || end <= start) {
    throw new Error("AI tidak memberikan format JSON yang benar.");
  }

  return JSON.parse(cleaned.slice(start, end + 1));
}

function normalizeScenes(data) {
  if (Array.isArray(data.scenes)) return data.scenes;

  const alternatives = [
    data.storyboard,
    data.shots,
    data.episodes,
    data.data?.scenes,
    data.output?.scenes,
    data.result?.scenes,
    data.response?.scenes
  ];

  return alternatives.find(Array.isArray) || [];
}

function normalizeScene(scene, index) {
  return {
    title: scene.title || scene.name || `Adegan ${index + 1}`,
    visualPrompt:
      scene.visualPrompt ||
      scene.visual_prompt ||
      scene.imagePrompt ||
      scene.description ||
      "",
    cameraDirection:
      scene.cameraDirection ||
      scene.camera_direction ||
      scene.camera ||
      "",
    narration:
      scene.narration ||
      scene.voiceover ||
      scene.dialogue ||
      "",
    sound:
      scene.sound ||
      scene.soundDesign ||
      scene.audio ||
      ""
  };
}

async function generateImage(env, scene, style) {
  if (!scene.visualPrompt) {
    return {
      imageError: "Prompt gambar tidak tersedia."
    };
  }

  try {
    const result = await env.AI.run(IMAGE_MODEL, {
      prompt:
        `Cinematic storyboard frame, ${style} style. ` +
        `${scene.visualPrompt}. ` +
        "Professional composition, cinematic lighting, " +
        "consistent characters, no text, no watermark.",
      steps: 4
    });

    if (result && typeof result.image === "string") {
      return {
        image: "data:image/jpeg;base64," + result.image
      };
    }

    return {
      imageError: "Model gambar tidak mengembalikan gambar."
    };
  } catch (error) {
    return {
      imageError: error.message || "Gagal membuat gambar."
    };
  }
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

    if (
      url.pathname !== "/api/generate" ||
      request.method !== "POST"
    ) {
      return json({
        error: "Endpoint tidak ditemukan."
      }, 404);
    }

    if (!env.AI) {
      return json({
        error: "AI binding belum diaktifkan."
      }, 503);
    }

    try {
      const body = await request.json();

      const idea = String(body.idea || "").trim();
      const language =
        body.language === "en" ? "English" : "Indonesian";
      const style = String(body.style || "cinematic");

      const count = [5, 10, 15].includes(Number(body.scenes))
        ? Number(body.scenes)
        : 5;

      if (!idea || idea.length > 2000) {
        return json({
          error: "Masukkan ide cerita maksimal 2000 karakter."
        }, 400);
      }

      const prompt = `
Create a professional cinematic storyboard.

Story idea: ${idea}
Language: ${language}
Visual style: ${style}

Create exactly ${count} connected scenes.
Keep all characters visually consistent.

Return ONLY valid JSON in this format:
{
  "title": "Story title",
  "logline": "Short story summary",
  "scenes": [
    {
      "title": "Scene title",
      "visualPrompt": "Detailed visual description in English",
      "cameraDirection": "Camera angle and movement",
      "narration": "Narration in requested language",
      "sound": "Sound design"
    }
  ]
}

Every scene must contain all five fields.
Do not include markdown or explanations.
`;

      const textResult = await env.AI.run(TEXT_MODEL, {
        messages: [
          {
            role: "system",
            content:
              "You are a professional film screenwriter and storyboard artist. Return valid JSON only."
          },
          {
            role: "user",
            content: prompt
          }
        ],
        max_tokens: 6000,
        temperature: 0.7
      });

      const parsed = parseAIJSON(getText(textResult));
      const scenes = normalizeScenes(parsed);

      if (!scenes.length) {
        throw new Error(
          "AI belum menghasilkan daftar adegan. Coba lagi."
        );
      }

      const story = {
        title: parsed.title || "Untitled Storyboard",
        logline: parsed.logline || parsed.summary || "",
        scenes: scenes.slice(0, count).map(normalizeScene)
      };

      // Generate images in small batches.
      const batchSize = 3;

      for (
        let start = 0;
        start < story.scenes.length;
        start += batchSize
      ) {
        const batch = story.scenes.slice(
          start,
          start + batchSize
        );

        const images = await Promise.all(
          batch.map(scene =>
            generateImage(env, scene, style)
          )
        );

        batch.forEach((imageData, index) => {
          Object.assign(batch[index], imageData);
        });
      }

      return json({
        success: true,
        title: story.title,
        logline: story.logline,
        scenes: story.scenes
      });

    } catch (error) {
      return json({
        error: error.message ||
          "Terjadi kesalahan pada server."
      }, 500);
    }
  }
};
