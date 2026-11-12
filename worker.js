
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

// Membaca berbagai format respons Gemma.
function extractText(result) {
  if (typeof result === "string") return result;
  if (!result || typeof result !== "object") return "";

  const content = result.choices?.[0]?.message?.content;

  const candidates = [
    content,
    result.response,
    result.output_text,
    result.text,
    result.result?.response,
    result.result?.choices?.[0]?.message?.content,
    result.message?.content
  ];

  for (const value of candidates) {
    if (typeof value === "string" && value.trim()) {
      return value;
    }

    if (Array.isArray(value)) {
      const combined = value
        .map(item => item?.text || "")
        .join("\n");

      if (combined.trim()) return combined;
    }
  }

  return "";
}

// Mengambil JSON object atau array dari respons AI.
function parseAIJSON(raw) {
  const cleaned = raw
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();

  const startObject = cleaned.indexOf("{");
  const startArray = cleaned.indexOf("[");

  let start;

  if (startObject === -1) start = startArray;
  else if (startArray === -1) start = startObject;
  else start = Math.min(startObject, startArray);

  if (start === -1) {
    throw new Error("Respons AI tidak berisi JSON.");
  }

  const stack = [];
  let inString = false;
  let escaped = false;

  for (let i = start; i < cleaned.length; i++) {
    const char = cleaned[i];

    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === "{" || char === "[") {
      stack.push(char);
      continue;
    }

    if (char === "}" || char === "]") {
      const opening = stack.pop();

      if (
        (char === "}" && opening !== "{") ||
        (char === "]" && opening !== "[")
      ) {
        break;
      }

      if (stack.length === 0) {
        return JSON.parse(cleaned.slice(start, i + 1));
      }
    }
  }

  throw new Error("Respons JSON AI tidak lengkap.");
}

// Mencari daftar adegan meskipun berada di dalam object lain.
function findScenes(data, depth = 0) {
  if (!data || depth > 7) return null;

  if (Array.isArray(data)) {
    const looksLikeScenes = data.some(item =>
      item &&
      typeof item === "object" &&
      (
        item.visualPrompt ||
        item.visual_prompt ||
        item.imagePrompt ||
        item.cameraDirection ||
        item.narration
      )
    );

    if (looksLikeScenes) return data;

    for (const item of data) {
      const found = findScenes(item, depth + 1);
      if (found) return found;
    }

    return null;
  }

  if (typeof data !== "object") return null;

  const keys = [
    "scenes",
    "storyboard",
    "shots",
    "episodes",
    "data",
    "output",
    "result",
    "response"
  ];

  for (const key of keys) {
    if (data[key] !== undefined) {
      const found = findScenes(data[key], depth + 1);
      if (found) return found;
    }
  }

  return null;
}

function findStoryInfo(data) {
  if (!data || typeof data !== "object") return {};

  if (Array.isArray(data)) return {};

  const title =
    data.title ||
    data.storyTitle ||
    data.story_title;

  const logline =
    data.logline ||
    data.summary ||
    data.description;

  if (title || logline) {
    return { title, logline };
  }

  for (const key of ["data", "output", "result", "response"]) {
    const found = findStoryInfo(data[key]);
    if (found.title || found.logline) return found;
  }

  return {};
}

function normalizeScene(scene, index) {
  return {
    title:
      scene.title ||
      scene.name ||
      `Adegan ${index + 1}`,

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

// Membuat satu gambar.
async function generateImage(env, scene, style) {
  if (!scene.visualPrompt) {
    return { imageError: "Deskripsi gambar kosong." };
  }

  try {
    const result = await env.AI.run(IMAGE_MODEL, {
      prompt: (
        `Cinematic storyboard frame, ${style} visual style. ` +
        `${scene.visualPrompt}. ` +
        "Professional lighting, beautiful composition, " +
        "consistent characters, no text, no watermark."
      ).slice(0, 2048),
      steps: 4
    });

    if (typeof result?.image === "string" && result.image) {
      return {
        image: "data:image/jpeg;base64," + result.image
      };
    }

    return {
      imageError: "Model tidak mengembalikan data gambar."
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
        body.language === "en"
          ? "English"
          : "Indonesian";

      const style = String(body.style || "cinematic");

      const count = [5, 10, 15].includes(Number(body.scenes))
        ? Number(body.scenes)
        : 5;

      if (!idea || idea.length > 2000) {
        return json({
          error: "Ide cerita wajib diisi, maksimal 2000 karakter."
        }, 400);
      }

      const prompt = `
Create a professional cinematic storyboard.

Story idea: ${idea}
Language: ${language}
Visual style: ${style}

Create exactly ${count} scenes.

Keep the main characters visually consistent.

Return ONLY valid JSON.
No markdown fences. No explanation.

Required structure:
{
  "title": "Story title",
  "logline": "Short story summary",
  "scenes": [
    {
      "title": "Scene title",
      "visualPrompt": "Detailed image description in English",
      "cameraDirection": "Camera angle and movement",
      "narration": "Narration in requested language",
      "sound": "Sound design"
    }
  ]
}

Every scene must contain all five fields.
`;

      // 1. Generate the complete story.
      const textResult = await env.AI.run(
        TEXT_MODEL,
        {
          messages: [
            {
              role: "system",
              content:
                "You are a professional screenwriter. Return valid JSON only."
            },
            {
              role: "user",
              content: prompt
            }
          ],
          max_tokens: 6000,
          temperature: 0.5,
          chat_template_kwargs: {
            enable_thinking: false
          }
        }
      );

      // 2. Read the actual model response.
      const raw = extractText(textResult);

      if (!raw) {
        throw new Error(
          "Respons teks AI kosong atau formatnya tidak dikenali."
        );
      }

      const parsed = parseAIJSON(raw);
      const scenes = findScenes(parsed);

      if (!scenes || scenes.length === 0) {
        throw new Error(
          "AI belum menghasilkan daftar adegan. Coba ulangi."
        );
      }

      const info = findStoryInfo(parsed);

      const story = {
        title: info.title || "Tips Cerdas Storyboard",
        logline: info.logline || "",
        scenes: scenes
          .slice(0, count)
          .map(normalizeScene)
      };

      // 3. Generate images in small batches.
      for (let i = 0; i < story.scenes.length; i += 2) {
        const batch = story.scenes.slice(i, i + 2);

        const images = await Promise.all(
          batch.map(scene =>
            generateImage(env, scene, style)
          )
        );

        images.forEach((imageData, index) => {
          Object.assign(batch[index], imageData);
        });
      }

      // 4. Return complete storyboard.
      return json({
        success: true,
        title: story.title,
        logline: story.logline,
        scenes: story.scenes
      });

    } catch (error) {
      return json({
        success: false,
        error: error.message ||
          "Terjadi kesalahan pada server."
      }, 500);
    }
  }
};
